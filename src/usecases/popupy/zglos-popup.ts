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
 * CELOWO nie ma tu pola z trescia zgody: consents.wording to material dowodowy,
 * a tresc przyslana z publicznego internetu moglby podstawic kazdy i zatruc
 * historie zgod (znalezisko review). Brzmienie zgody jest stala serwera.
 */
export const schematZgloszenia = z.object({
  email: z.string().trim().min(3).max(320).email(),
  imie: z.string().trim().max(120).optional(),
});

export type Zgloszenie = z.infer<typeof schematZgloszenia>;

/** Brzmienie zgody zapisywane przy kazdym zgloszeniu; skrypt pokazuje formularz zapisu. */
export const STANDARDOWA_ZGODA =
  "Zapisuje sie na newsletter i zgadzam sie na otrzymywanie wiadomosci e-mail od tego sklepu.";

export interface WynikZgloszenia {
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
  const { rows: popupy } = await pool.query(
    "select id, tenant_id, name, discount_code from popups where id = $1 and active",
    [popupId],
  );
  const popup = popupy[0];
  if (!popup) return null;

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
      await klient.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, wording, occurred_at)
         values ($1, $2, 'email', 'granted', $3, $4, now())`,
        [popup.tenant_id, profileId, `popup:${popup.name}`, STANDARDOWA_ZGODA],
      );
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
