import { z } from "zod";
import { jestWykluczonyGlobalnie } from "../../adapters/db/wykluczenia";
import { getPool } from "../../adapters/db/pool";
import { v7 as uuidv7 } from "uuid";
import { METRYKI_WBUDOWANE } from "../../domain/zdarzenia/kontrakt";
import { zapiszZdarzenie } from "../zdarzenia/zapisz-zdarzenie";

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
export const schematZgloszenia = z.object({
  email: z.string().trim().min(3).max(320).email(),
  imie: z.string().trim().max(120).optional(),
  zgoda: z.literal(true),
  wersjaKlauzuli: z.number().int().min(1).max(1_000_000),
});

export type Zgloszenie = z.infer<typeof schematZgloszenia>;

/**
 * Jak dlugo po zmianie klauzuli przyjmujemy zgloszenie z POPRZEDNIA wersja. Osoba mogla miec
 * otwarta strone ze starym tekstem (skrypt w cache 60 s, karta otwarta dluzej). Zgode zapisujemy
 * wtedy z tekstem, ktory naprawde widziala. Starsza wersja = odmowa (skrypt prosi o odswiezenie).
 */
export const OKNO_STAREJ_WERSJI_H = 24;

export class KlauzulaNieaktualna extends Error {}export interface WynikZgloszenia {
  ok: true;
  profileId: string;
  /** kod rabatowy do pokazania osobie po zapisie; null gdy popup go nie ma */
  discountCode: string | null;
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
  const { rows: popupy } = await pool.query(
    "select id, tenant_id, name, discount_code, list_id, consent_version from popups where id = $1 and active",
    [popupId],
  );
  const popup = popupy[0];
  if (!popup) return null;
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
      [popup.tenant_id, dane.email, dane.imie ?? null],
    );
    const { rows: profile } = await klient.query(
      `select id from profiles
        where tenant_id = $1 and lower(btrim(email)) = lower(btrim($2))`,
      [popup.tenant_id, dane.email],
    );
    const profileId: string = profile[0].id;

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

    // Zdarzenie idzie przez JEDYNY punkt zapisu strumienia (AD-36): metryka „Submitted
    // Form” w metric_events + lustro `popup.submitted` w starej tabeli events (to samo id),
    // z ktorej na czas przejscia czyta silnik automatyzacji i licznik zgloszen w panelu.
    // Czas = teraz (zdarzenie na zywo), zrodlo 'client' (przegladarka). Adresu e-mail
    // w properties nie ma: zdarzenie zyje dluzej niz profil (sciezka RODO).
    const idZdarzenia = uuidv7();
    await zapiszZdarzenie(
      klient,
      {
        tenantId: popup.tenant_id,
        metryka: METRYKI_WBUDOWANE.zgloszenieFormularza,
        profileId,
        occurredAt: new Date(),
        id: idZdarzenia,
        uniqueId: `form:${popup.id}:${idZdarzenia}`,
        properties: { form_id: popup.id, form_name: popup.name },
        source: "client",
      },
      { lustro: { eventType: "popup.submitted", payload: { popup_id: popup.id, popup_name: popup.name } } },
    );

    await klient.query("commit");
    return { ok: true, profileId, discountCode: popup.discount_code ?? null };
  } catch (blad) {
    await klient.query("rollback");
    throw blad;
  } finally {
    klient.release();
  }
}
