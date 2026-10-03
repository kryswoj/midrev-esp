import { z } from "zod";
import { jestWykluczonyGlobalnie } from "../../adapters/db/wykluczenia";
import { getPool } from "../../adapters/db/pool";
import { v7 as uuidv7 } from "uuid";
import { METRYKI_WBUDOWANE } from "../../domain/zdarzenia/kontrakt";
import { zapiszZdarzenie } from "../zdarzenia/zapisz-zdarzenie";
import type { PoolClient } from "pg";
import { hashIdentyfikatora } from "../../adapters/hash-adresu";
import { sprawdzToken, wystawToken } from "../../adapters/token-formularza";
import { kodyZDefinicji, pytaniaDefinicji, type DefinicjaFormularza } from "../../domain/formularze/model";
import { telefonE164 } from "../../domain/zdarzenia/telefon";
import { formularzPubliczny } from "./formularze";

// Przyjecie zgloszenia z popupu (Epik F). To jedyna sciezka w systemie, ktora
// tworzy profil BEZ udzialu operatora: dane przychodza z publicznego internetu,
// wiec walidacja jest tu czescia kontraktu, nie uprzejmoscia.
//
// SQL siedzi w tym pliku, a nie w repozytoria.ts, bo Epik F powstaje rownolegle
// z innymi zmianami i nie wolno mu dotykac wspolnych plikow. Po scaleniu te
// zapytania moga wrocic do repozytoriow (AD-18) jednym mechanicznym przenosinami.

/**
 * Kontrakt publicznego zgloszenia. Limity dlugosci sa twarde, bo endpoint nie ma
 * auth i kazdy bajt trafia do bazy: bez limitu jeden bot zapelnia dysk formularzem.
 *
 * CELOWO nie ma tu pola z TRESCIA zgody: consents.wording to material dowodowy,
 * a tresc przyslana z publicznego internetu moglby podstawic kazdy i zatruc
 * historie zgod (znalezisko review). Przegladarka odsyla wylacznie NUMER wersji
 * klauzuli, ktora wyswietlila (0041), a tekst do dowodu bierzemy z bazy.
 *
 * `zgoda: true` jest obowiazkowe: pole wyboru w popupie jest domyslnie niezaznaczone,
 * a zgloszenie bez jawnego zaznaczenia odrzucamy takze tu, nie tylko w skrypcie
 * (stary skrypt z cache albo zapytanie spoza przegladarki nie omina wymogu).
 */
const schematPol = z.record(
  z.string().max(64),
  z.union([z.string().max(80), z.array(z.string().max(80)).max(12)]),
).refine((o) => Object.keys(o).length <= 20);

export const schematZgloszenia = z.object({
  email: z.string().trim().min(3).max(320).email(),
  imie: z.string().trim().max(120).optional(),
  zgoda: z.literal(true),
  wersjaKlauzuli: z.number().int().min(1).max(1_000_000),
  // Builder formularzy (0043), skrypt 2.x. Wszystko opcjonalne: skrypt 1.1 z cache dalej działa.
  telefon: z.string().trim().max(40).optional(),
  /** odpowiedzi na pytania z kroków (klucz = właściwość profilu); serwer przyjmuje tylko te z definicji */
  pola: schematPol.optional(),
  /** identyfikator tej próby zapisu z przeglądarki: ponowienie tego samego zgłoszenia nie dubluje zgody */
  zgloszenie: z.string().regex(/^[a-z0-9]{16,64}$/).optional(),
  /** krok, z którego przyszło zgłoszenie (diagnostyka) */
  krok: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
});

/** Kolejny krok PO zapisie (zapis cząstkowy): token z odpowiedzi na krok z e-mailem. */
export const schematKroku = z.object({
  token: z.string().min(10).max(400),
  krok: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  imie: z.string().trim().max(120).optional(),
  telefon: z.string().trim().max(40).optional(),
  pola: schematPol.optional(),
});

export type Zgloszenie = z.infer<typeof schematZgloszenia>;

/**
 * Jak dlugo po zmianie klauzuli przyjmujemy zgloszenie z POPRZEDNIA wersja. Osoba mogla miec
 * otwarta strone ze starym tekstem (skrypt w cache 60 s, karta otwarta dluzej). Zgode zapisujemy
 * wtedy z tekstem, ktory naprawde widziala. Starsza wersja = odmowa (skrypt prosi o odswiezenie).
 */
export const OKNO_STAREJ_WERSJI_H = 24;

export class KlauzulaNieaktualna extends Error {}
export interface WynikZgloszenia {
  ok: true;
  profileId: string;
  /** kod rabatowy do pokazania osobie po zapisie; null gdy popup go nie ma */
  discountCode: string | null;
  /** kody z kroku sukcesu (id bloku → kod), skrypt 2.x */
  kody: Record<string, string>;
  /** token zapisu cząstkowego dla kolejnych kroków */
  token: string;
  /** true: to samo zgłoszenie przyszło drugi raz (ponowienie), nic nie dopisano */
  powtorzone: boolean;
}

/**
 * Odpowiedzi z formularza przefiltrowane przez OPUBLIKOWANĄ definicję: tylko klucze pytań,
 * które formularz faktycznie zadaje, i tylko odpowiedzi z listy. Reszta jest odrzucana po
 * cichu (formularz mógł się zmienić między wyświetleniem a zapisem), więc publiczny
 * endpoint nie zapisze do profilu niczego, czego operator nie przewidział.
 */
export function przefiltrujPola(def: DefinicjaFormularza, pola: Record<string, string | string[]> | undefined): Record<string, string | string[]> {
  const wynik: Record<string, string | string[]> = {};
  if (!pola) return wynik;
  const pytania = pytaniaDefinicji(def);
  for (const [klucz, wartosc] of Object.entries(pola)) {
    const p = pytania.get(klucz);
    if (!p) continue;
    if (Array.isArray(wartosc)) {
      if (!p.wielokrotny) continue;
      const ok = [...new Set(wartosc.map((x) => String(x).trim()))].filter((x) => p.opcje.has(x));
      if (ok.length) wynik[klucz] = ok;
    } else {
      const x = String(wartosc).trim();
      if (p.opcje.has(x)) wynik[klucz] = p.wielokrotny ? [x] : x;
    }
  }
  return wynik;
}

/**
 * Uzupełnienie profilu z formularza: imię i telefon TYLKO tam, gdzie profil ich nie ma
 * (formularz nie nadpisuje danych, które operator już prowadzi), właściwości z pytań
 * scalane (odpowiedź z formularza jest najświeższą deklaracją osoby, jak w Klaviyo).
 * Telefon z nagrobkiem RODO (0033) nie wraca do profilu.
 */
async function uzupelnijProfil(
  klient: PoolClient,
  tenantId: string,
  profileId: string,
  dane: { imie?: string; telefon?: string; pola: Record<string, string | string[]> },
): Promise<void> {
  const imie = dane.imie?.trim() || null;
  let telefon = dane.telefon ? telefonE164(dane.telefon) : null;
  if (telefon) {
    const { rows } = await klient.query<{ jest: boolean }>(
      "select exists (select 1 from rodo_nagrobki_identyfikatorow where tenant_id = $1 and rodzaj = 'phone_number' and hash = $2) as jest",
      [tenantId, hashIdentyfikatora("phone_number", telefon)],
    );
    if (rows[0].jest) telefon = null;
  }
  const maPola = Object.keys(dane.pola).length > 0;
  if (!imie && !telefon && !maPola) return;
  const w = await klient.query(
    `update profiles
        set first_name = coalesce(first_name, $3),
            phone = coalesce(phone, $4),
            properties = case when $5::jsonb = '{}'::jsonb then properties else properties || $5::jsonb end,
            updated_at = now()
      where tenant_id = $1 and id = $2`,
    [tenantId, profileId, imie, telefon, JSON.stringify(dane.pola)],
  );
  if (w.rowCount !== 1) throw new Error("uzupelnijProfil: profil nie istnieje");
}

/**
 * Przyjmuje zgloszenie do popupu o danym id. Zwraca null, gdy popup nie istnieje
 * ALBO jest wylaczony: wylaczenie popupu w panelu musi faktycznie odwolywac
 * publiczny endpoint, inaczej stary popupId zbieralby dane w nieskonczonosc
 * (znalezisko review).
 *
 * Tenant NIE przychodzi z zewnatrz: publiczny formularz zna tylko id popupu,
 * a tenant_id czytamy z wiersza popupu. Kazde kolejne zapytanie ma juz jawny
 * predykat tenant_id (AD-2), wiec zgloszenie nie moze zapisac danych u innego
 * tenanta nawet przy bledzie w kodzie wyzej.
 */
export async function przyjmijZgloszenie(
  popupId: string,
  dane: Zgloszenie,
): Promise<WynikZgloszenia | null> {
  const pool = getPool();
  // walidacja takze tutaj (nie tylko w trasie): use-case jest kontraktem, nie trasa
  const wejscie = schematZgloszenia.safeParse(dane);
  if (!wejscie.success) throw new Error("przyjmijZgloszenie: zgloszenie bez zgody albo bez wersji klauzuli");
  // Opublikowana definicja (0043) albo stary popup przełożony w locie: z niej biorą się
  // dozwolone pytania i kody z kroku sukcesu. Szkic NIGDY nie decyduje o zapisie.
  const formularz = await formularzPubliczny(popupId);
  if (!formularz) return null;
  const popup = formularz.wiersz;
  const pola = przefiltrujPola(formularz.definicja, wejscie.data.pola);
  const kody = kodyZDefinicji(formularz.definicja);
  // Wersja klauzuli, ktora wyswietlil skrypt: biezaca albo zastapiona w ostatnich 24 h.
  // Tekst do dowodu idzie z TEJ wersji (z bazy), nigdy z zapytania.
  const { rows: wersje } = await pool.query(
    `select id, version, wording, privacy_url from popup_consent_versions
      where tenant_id = $1 and popup_id = $2 and version = $3
        and (version = $4 or superseded_at > now() - make_interval(hours => $5))`,
    [popup.tenant_id, popup.id, dane.wersjaKlauzuli, popup.consent_version, OKNO_STAREJ_WERSJI_H],
  );
  const klauzula = wersje[0];
  if (!klauzula) throw new KlauzulaNieaktualna("klauzula nieaktualna albo nieznana");

  const klient = await pool.connect();
  try {
    await klient.query("begin");

    // Profil po znormalizowanym adresie: ten sam wzorzec unikalnosci, ktory od 0001
    // pilnuje, ze "a@x.com" i " A@x.com " to jedna osoba. `do nothing` zamiast
    // `do update`, bo zgloszenie z popupu nie ma prawa nadpisac danych profilu,
    // ktory operator juz prowadzi (np. imienia z zamowienia).
    await klient.query(
      `insert into profiles (tenant_id, email, first_name)
       values ($1, btrim($2), $3)
       on conflict (tenant_id, (lower(btrim(email)))) where email is not null do nothing`,
      [popup.tenant_id, dane.email, dane.imie || null],
    );
    const { rows: profile } = await klient.query(
      `select id from profiles
        where tenant_id = $1 and lower(btrim(email)) = lower(btrim($2))`,
      [popup.tenant_id, dane.email],
    );
    const profileId: string = profile[0].id;

    // Zdarzenie NAJPIERW: przy identyfikatorze zgłoszenia z przeglądarki unique_id jest
    // stały (`form:<popup>:<zgłoszenie>`), więc ponowienie tego samego zapisu (sieć, podwójny
    // klik) trafia w deduplikację strumienia (AD-38) i NIE dopisuje drugiej zgody ani drugiego
    // zdarzenia. Stary skrypt (bez identyfikatora) zachowuje się jak dotąd.
    // Zdarzenie idzie przez JEDYNY punkt zapisu strumienia (AD-36): metryka „Submitted
    // Form” w metric_events + lustro `popup.submitted` w starej tabeli events (to samo id),
    // z ktorej na czas przejscia czyta silnik automatyzacji i licznik zgloszen w panelu.
    // Czas = teraz (zdarzenie na zywo), zrodlo 'client' (przegladarka). Adresu e-mail
    // w properties nie ma: zdarzenie zyje dluzej niz profil (sciezka RODO).
    const idZdarzenia = uuidv7();
    const zdarzenie = await zapiszZdarzenie(
      klient,
      {
        tenantId: popup.tenant_id,
        metryka: METRYKI_WBUDOWANE.zgloszenieFormularza,
        profileId,
        occurredAt: new Date(),
        id: idZdarzenia,
        uniqueId: `form:${popup.id}:${dane.zgloszenie ?? idZdarzenia}`,
        properties: { form_id: popup.id, form_name: popup.name, form_type: formularz.definicja.typ },
        source: "client",
      },
      { lustro: { eventType: "popup.submitted", payload: { popup_id: popup.id, popup_name: popup.name } } },
    );
    if (zdarzenie.duplikat) {
      await klient.query("commit");
      return { ok: true, profileId, discountCode: popup.discount_code ?? null, kody, token: wystawToken(popup.id, profileId), powtorzone: true };
    }

    // imię, telefon i odpowiedzi z kroków przed e-mailem (bez nadpisywania danych operatora)
    await uzupelnijProfil(klient, popup.tenant_id, profileId, { imie: dane.imie, telefon: dane.telefon, pola });

    // Adres wykluczony (globalnie albo wypisany z tego sklepu) NIE dostaje nowego
    // wpisu 'granted': publiczny endpoint bez auth nie moze byc furtka, ktora
    // kazdy "ponownie zapisze" osobe po jej wypisaniu (znalezisko review).
    // Zdjecie wykluczenia to swiadoma decyzja administratora (FR30), nie POST z
    // internetu. Zgloszenie i tak konczy sie ok, zeby odpowiedz nie zdradzala,
    // czy adres jest na liscie wykluczen.
    const { rows: wykluczenia } = await klient.query(
      `select
         coalesce((
           select ts.action = 'suppressed' from tenant_suppressions ts
            where ts.tenant_id = $1 and lower(btrim(ts.email)) = lower(btrim($2))
            order by ts.occurred_at desc limit 1
         ), false) as sklepowe`,
      [popup.tenant_id, dane.email],
    );
    // globalne: JEDNA definicja (adres albo hasz, 0022) - ta sama co w bramce wysylki
    const globalne = await jestWykluczonyGlobalnie(dane.email, klient);
    const wykluczony = globalne || wykluczenia[0].sklepowe;

    if (!wykluczony) {
      // Zgoda jest DOPISYWANA, nigdy nadpisywana (AD-16). Drugi zapis tej samej
      // osoby daje drugi wpis 'granted' i to jest poprawne: historia ma pokazywac
      // kazde zdarzenie zgody, a stan liczy sie z ostatniego wpisu.
      // occurred_at = now(), bo to zdarzenie dzieje sie TERAZ - to nie import
      // historii, wiec data zdarzenia i data zapisu sa ta sama chwila.
      // wording = PELNY tekst wersji, ktora osoba widziala przy polu wyboru; wskazanie na
      // wersje (0041) i szczegol metody: ktory formularz, ktora wersja, jaki link do polityki.
      const szczegol = `formularz ${popup.id}, wersja klauzuli ${klauzula.version}${klauzula.privacy_url ? `, polityka prywatności: ${klauzula.privacy_url}` : ""}`;
      await klient.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, wording, method_detail, popup_consent_version_id, occurred_at)
         values ($1, $2, 'email', 'granted', $3, $4, $5, $6, now())`,
        [popup.tenant_id, profileId, `popup:${popup.name}`, klauzula.wording, szczegol, klauzula.id],
      );
      // Lista docelowa popupu: zrodlo 'formularz:<popupId>' to dodanie POJEDYNCZE
      // (ZRODLA_POJEDYNCZE), wiec odpala wyzwalacz "dolaczenie do listy". Osoba juz na liscie
      // zostaje (do nothing): ponowny zapis nie uruchamia powitania drugi raz. Wykluczonych
      // nie dopisujemy, tak jak nie dopisujemy im zgody.
      if (popup.list_id) {
        await klient.query(
          `insert into list_members (tenant_id, list_id, profile_id, source, added_at)
           values ($1, $2, $3, $4, now())
           on conflict (list_id, profile_id) do nothing`,
          [popup.tenant_id, popup.list_id, profileId, `formularz:${popup.id}`],
        );
      }
    }

    await klient.query("commit");
    return { ok: true, profileId, discountCode: popup.discount_code ?? null, kody, token: wystawToken(popup.id, profileId), powtorzone: false };
  } catch (blad) {
    await klient.query("rollback");
    throw blad;
  } finally {
    klient.release();
  }
}

export type WynikKroku = { ok: true } | { ok: false; powod: "nie_znaleziono" | "token" | "krok" };

/**
 * Kolejny krok PO kroku z e-mailem (zapis cząstkowy): uzupełnia profil wskazany tokenem.
 * Nie tworzy profilu, nie dopisuje zgody, nie zapisuje na listę i nie wyzwala automatyzacji:
 * to wszystko zrobił już krok z e-mailem. Token wiąże formularz i profil (podpis HMAC),
 * a tenant pochodzi z wiersza formularza, nigdy z zapytania.
 */
export async function przyjmijKrok(popupId: string, dane: z.infer<typeof schematKroku>): Promise<WynikKroku> {
  const wejscie = schematKroku.safeParse(dane);
  if (!wejscie.success) return { ok: false, powod: "krok" };
  const formularz = await formularzPubliczny(popupId);
  if (!formularz) return { ok: false, powod: "nie_znaleziono" };
  const profileId = sprawdzToken(wejscie.data.token, formularz.id);
  if (!profileId) return { ok: false, powod: "token" };
  const def = formularz.definicja;
  const indeks = def.kroki.findIndex((k) => k.id === wejscie.data.krok);
  // tylko kroki PO kroku z e-mailem; wcześniejsze odpowiedzi szły razem z e-mailem
  const krokEmail = def.kroki.findIndex((k) => k.bloki.some((b) => b.typ === "email"));
  if (indeks < 0 || indeks <= krokEmail) return { ok: false, powod: "krok" };
  const pola = przefiltrujPola(def, wejscie.data.pola);
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    // profil musi należeć do tenanta formularza (token z innej bazy/tenanta nic nie zmieni)
    const { rows } = await klient.query("select 1 from profiles where tenant_id = $1 and id = $2 for update", [formularz.tenantId, profileId]);
    if (!rows[0]) {
      await klient.query("rollback");
      return { ok: false, powod: "token" };
    }
    await uzupelnijProfil(klient, formularz.tenantId, profileId, { imie: wejscie.data.imie, telefon: wejscie.data.telefon, pola });
    await klient.query("commit");
    return { ok: true };
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}
