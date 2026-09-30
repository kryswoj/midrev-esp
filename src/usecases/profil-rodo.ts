import type { PoolClient } from "pg";
import { getPool } from "../adapters/db/pool";
import { hashAdresu, hashIdentyfikatora, zaslepkaWykluczenia } from "../adapters/hash-adresu";
import { telefonE164 } from "../domain/zdarzenia/telefon";
import { ZASLEPKA_PAYLOADU } from "./przetworz-zdarzenie";
import { anonimizujOdbicia, eksportujOdbicia, pozostaleDaneOdbic } from "./wysylka/odbicia";
import { anonimizujWImporcie } from "./import-klaviyo/zadania";
import { METRYKI_WBUDOWANE } from "../domain/zdarzenia/kontrakt";
import { zapiszZdarzenie } from "./zdarzenia/zapisz-zdarzenie";

// Żądanie podmiotu danych: eksport (FR21) i usunięcie (FR22).
//
// Dwie decyzje, które trzymają ten moduł:
//
// 1. USUNIĘCIE TO ANONIMIZACJA, NIE `delete`. Zamówienie tej osoby zostaje z kwotą,
//    statusem i datą, bo na nim stoi raport przychodu klienta; znika wszystko, co
//    wskazuje na człowieka (adres, telefon, imię, nazwisko, surowy JSON ze sklepu
//    z adresem dostawy). Fizyczny DELETE rozjechałby raporty finansowe wstecz -
//    a raport, który zmienia się po fakcie, jest gorszy niż brak raportu.
//
// 2. OPERACJA ZOSTAWIA ŚLAD. Wpis 'rodo.anonimizacja' w `events` mówi kto, kiedy
//    i na czyje żądanie. Bez tego za pół roku nie da się udowodnić, że żądanie
//    zostało obsłużone.
//
// Miejsca z danymi osoby, które audyt 24.09 (#10) zastał nietknięte: `raw_events.payload`
// (pełny JSON zamówienia ze sklepu: adres dostawy, telefon), `message_engagement.ip`
// i `user_agent`, `tenant_suppressions.email` oraz globalne `suppressions.email`. Eksport
// je wydaje, anonimizacja czyści, a kontrola zwrotna przed commitem sprawdza, że nic
// nie zostało - inaczej wpis w logu "zrobione" byłby nieprawdą.
//
// Globalne wykluczenie (odbicie, skarga) NIE jest kasowane: to wspólna pula reputacji
// wszystkich klientów agencji. Adres zamienia się na zaślepkę, a blokadę trzyma
// kluczowany hasz adresu (0022, `adapters/hash-adresu.ts`), który bramka wysyłki
// sprawdza obok adresu. Osoba wracająca z nową zgodą na odbity adres dalej nie dostanie maila.
//
// Liczniki w wyniku są czytane ZWROTNIE z bazy po zapisie, nie zliczane z prób
// (lista kontrolna zapisu do produkcji, punkt 3 i 4).

/** Adres-zaślepka: `messages.email` i `tenant_suppressions.email` są NOT NULL, a historia ma zostać. */
const ADRES_PO_USUNIECIU = "usuniety@rodo.invalid";

/**
 * Surowe zdarzenia TEJ osoby: po identyfikatorach jej zamówień (4. człon klucza
 * `woocommerce:{tenant}:{byt}:{id}:{wersja}`) i po e-mailu w payloadzie (klient Woo
 * ma `email`, zamówienie `billing.email`). Predykat współdzielony przez eksport,
 * anonimizację i kontrolę zwrotną - trzy różne definicje "jej zdarzeń" rozjechałyby się.
 */
const PREDYKAT_SUROWYCH = `
  r.tenant_id = $1 and (
    (split_part(r.idempotency_key, ':', 3) = 'order'
     and (r.store_id, split_part(r.idempotency_key, ':', 4)) in (
       select o.store_id, o.external_id from orders o
        where o.tenant_id = $1 and o.profile_id = $2))
    or ($3::text is not null and (
       lower(btrim(r.payload -> 'billing' ->> 'email')) = lower(btrim($3))
       or lower(btrim(r.payload ->> 'email')) = lower(btrim($3))))
  )`;

/**
 * Surowe żądania API zdarzeń (channel 'api') TEJ osoby: po profilu przypisanym przez worker
 * (`payload.meta.profile_id`), po id profilu w ciele albo po KAŻDYM identyfikatorze osoby
 * w ciele żądania (e-mail, telefon E.164, external_id, anonymous_id) - zdarzenie jeszcze
 * nieprzetworzone nie może przeżyć anonimizacji i odtworzyć osoby (review Codeksa R1).
 * Parametry: $1 tenant, $2 profil, $3 e-mail, $4 telefon E.164, $5 external_id, $6 anonymous_id.
 */
const PREDYKAT_SUROWYCH_API = `
  (r.tenant_id = $1 and r.channel = 'api' and not (r.payload ? 'anonimizowano') and (
    r.payload -> 'meta' ->> 'profile_id' = $2::text
    or r.payload #>> '{body,data,attributes,profile,data,id}' = $2::text
    or ($3::text is not null and lower(btrim(r.payload #>> '{body,data,attributes,profile,data,attributes,email}')) = lower(btrim($3)))
    or ($4::text is not null and midrev_telefon_e164(r.payload #>> '{body,data,attributes,profile,data,attributes,phone_number}') = $4::text)
    or ($5::text is not null and r.payload #>> '{body,data,attributes,profile,data,attributes,external_id}' = $5::text)
    or ($6::text is not null and r.payload #>> '{body,data,attributes,profile,data,attributes,anonymous_id}' = $6::text)
  ))`;

/** Wzorce danych osoby w wolnym tekście: adres e-mail i numer telefonu. */
const WZOR_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const WZOR_TELEFON = /(?:\+?\d[\s-]?){9,}/;

/**
 * Powód żądania trafia do logu RODO, który ma przeżyć anonimizację. Operator, który
 * wpisze tam usuwany adres albo telefon, odwróciłby całą operację jednym polem.
 * Zwraca opis błędu albo null. Eksportowane dla akcji formularza (ta sama reguła
 * na ekranie i w use-case).
 */
export function sprawdzPowodRodo(powod: string | null): string | null {
  if (!powod) return null;
  if (WZOR_EMAIL.test(powod)) return "Powód nie może zawierać adresu e-mail - to pole zostaje w logu po usunięciu danych";
  if (WZOR_TELEFON.test(powod)) return "Powód nie może zawierać numeru telefonu - to pole zostaje w logu po usunięciu danych";
  if (powod.length > 200) return "Powód ma najwyżej 200 znaków";
  return null;
}

export interface EksportProfilu {
  wyeksportowano: string;
  sklep: { id: string; nazwa: string };
  profil: Record<string, unknown>;
  zgody: unknown[];
  wykluczenia: { globalne: unknown[]; sklepu: unknown[] };
  zamowienia: unknown[];
  wiadomosci: unknown[];
  klikniecia: unknown[];
  /** Otwarcia i kliknięcia z adresem IP i user agentem (message_engagement). */
  zaangazowanie: unknown[];
  zdarzenia: unknown[];
  /** Zdarzenia ze strumienia metryk (metric_events) z nazwą metryki i właściwościami. */
  zdarzeniaMetryk: unknown[];
  /** Surowe dokumenty ze sklepu (webhooki i import) dotyczące tej osoby. */
  suroweZdarzenia: unknown[];
  /** Raporty odbić ze skrzynki zwrotnej (adres, temat, klasyfikacja). */
  odbicia: unknown[];
  /** Wiersze importu z błędem dotyczące tego adresu. */
  bledyImportu: unknown[];
  listy: unknown[];
}

/**
 * Komplet danych osoby w jednym pliku JSON. Wszystko, co o niej trzymamy, łącznie
 * z rejestrem zgód i historią wysyłek - to jest odpowiedź na żądanie dostępu, a nie
 * skrót dla wygody operatora.
 */
export async function eksportujProfil(
  tenantId: string,
  profileId: string,
): Promise<EksportProfilu | null> {
  const pool = getPool();
  const { rows: profile } = await pool.query(
    `select p.id, p.email, p.phone, p.first_name, p.last_name, p.created_at, p.properties,
            p.external_id, p.anonymous_id, p.organization, p.title, p.locale, p.location, p.updated_at,
            t.name as sklep_nazwa
       from profiles p join tenants t on t.id = p.tenant_id
      where p.tenant_id = $1 and p.id = $2`,
    [tenantId, profileId],
  );
  const profil = profile[0];
  if (!profil) return null;
  const { sklep_nazwa, ...daneProfilu } = profil;
  const email: string | null = profil.email ? String(profil.email) : null;

  const [zgody, globalne, sklepowe, zamowienia, wiadomosci, klikniecia, zaangazowanie, zdarzenia, surowe, odbicia, bledyImportu, listy, zdarzeniaMetryk] =
    await Promise.all([
      pool.query(
        `select channel, state, source, wording, occurred_at, recorded_at
           from consents where tenant_id = $1 and profile_id = $2 order by occurred_at`,
        [tenantId, profileId],
      ),
      email
        ? pool.query(
            "select email, reason, created_at from suppressions where lower(btrim(email)) = lower(btrim($1)) or email_hash = $2",
            [email, hashAdresu(email)],
          )
        : { rows: [] },
      email
        ? pool.query(
            `select action, reason, actor, occurred_at from tenant_suppressions
              where tenant_id = $1 and lower(btrim(email)) = lower(btrim($2)) order by occurred_at`,
            [tenantId, email],
          )
        : { rows: [] },
      pool.query(
        `select id, external_id, number, status, total_minor::text, currency, occurred_at, raw
           from orders where tenant_id = $1 and profile_id = $2 order by occurred_at`,
        [tenantId, profileId],
      ),
      pool.query(
        `select m.id, m.subject, m.email, m.source_type, m.source_id, m.current_state, m.created_at,
                coalesce(
                  (select jsonb_agg(jsonb_build_object('stan', me.event_type, 'kiedy', me.occurred_at,
                                                       'odpowiedz_dostawcy', me.provider_reason)
                                    order by me.occurred_at)
                     from message_events me
                    where me.tenant_id = m.tenant_id and me.message_id = m.id),
                  '[]'::jsonb) as przebieg
           from messages m
          where m.tenant_id = $1 and m.profile_id = $2 order by m.created_at`,
        [tenantId, profileId],
      ),
      pool.query(
        `select url, occurred_at, user_agent from clicks
          where tenant_id = $1 and profile_id = $2 order by occurred_at`,
        [tenantId, profileId],
      ),
      pool.query(
        `select e.message_id, e.kind, e.source, e.automat, e.automat_powod, e.url,
                host(e.ip) as ip, e.user_agent, e.occurred_at
           from message_engagement e
           join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
          where e.tenant_id = $1 and m.profile_id = $2 order by e.occurred_at`,
        [tenantId, profileId],
      ),
      pool.query(
        `select event_type, payload, occurred_at, recorded_at from events
          where tenant_id = $1 and profile_id = $2 order by occurred_at`,
        [tenantId, profileId],
      ),
      pool.query(
        `select r.idempotency_key, r.received_at, r.payload from raw_events r
          where ${PREDYKAT_SUROWYCH} or ${PREDYKAT_SUROWYCH_API}
          order by r.received_at`,
        [tenantId, profileId, email, telefonE164(profil.phone), profil.external_id ?? null, profil.anonymous_id ?? null],
      ),
      // raporty odbić: funkcja właściciela modułu skrzynki zwrotnej (jedna definicja "jej odbić")
      eksportujOdbicia(tenantId, profileId, email, pool).then((rows) => ({ rows })),
      email
        ? pool.query(
            `select e.file, e.line_no, e.email, e.reason from import_job_errors e
              where e.tenant_id = $1 and lower(btrim(e.email)) = lower(btrim($2)) order by e.line_no`,
            [tenantId, email],
          )
        : { rows: [] },
      pool.query(
        `select l.name, m.source, m.added_at from list_members m
           join lists l on l.tenant_id = m.tenant_id and l.id = m.list_id
          where m.tenant_id = $1 and m.profile_id = $2 order by m.added_at`,
        [tenantId, profileId],
      ),
      pool.query(
        `select mt.name as metryka, mt.integration_key as integracja, e.occurred_at, e.recorded_at,
                e.unique_id, e.value_minor::text as value_minor, e.value_currency, e.source, e.properties
           from metric_events e
           join metrics mt on mt.tenant_id = e.tenant_id and mt.id = e.metric_id
          where e.tenant_id = $1 and e.profile_id = $2 order by e.occurred_at, e.id`,
        [tenantId, profileId],
      ),
    ]);

  return {
    wyeksportowano: new Date().toISOString(),
    sklep: { id: tenantId, nazwa: sklep_nazwa },
    profil: daneProfilu,
    zgody: zgody.rows,
    wykluczenia: { globalne: globalne.rows, sklepu: sklepowe.rows },
    zamowienia: zamowienia.rows,
    wiadomosci: wiadomosci.rows,
    klikniecia: klikniecia.rows,
    zaangazowanie: zaangazowanie.rows,
    zdarzenia: zdarzenia.rows,
    zdarzeniaMetryk: zdarzeniaMetryk.rows,
    suroweZdarzenia: surowe.rows,
    odbicia: odbicia.rows,
    bledyImportu: bledyImportu.rows,
    listy: listy.rows,
  };
}

/** Ślad w logu, że dane wydano. Żądanie dostępu też jest obsłużeniem żądania. */
export async function zapiszSladEksportu(
  tenantId: string,
  profileId: string,
  aktor: string,
): Promise<void> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    await zapiszZdarzenie(
      klient,
      {
        tenantId,
        metryka: METRYKI_WBUDOWANE.rodoEksport,
        profileId,
        occurredAt: new Date(),
        properties: { aktor },
        source: "system",
      },
      { lustro: { eventType: "rodo.eksport", payload: { aktor } } },
    );
    await klient.query("commit");
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

export interface WynikAnonimizacji {
  /** odczytane ZWROTNIE po zapisie, nie policzone z prób */
  zamowien: number;
  przychodMinor: string;
  wiadomosci: number;
  zgodyWycofane: number;
  usunieteZList: number;
  /** surowe zdarzenia ze sklepu, w których payload zastąpiono zaślepką */
  suroweZdarzenia: number;
  /** wpisy zaangażowania (otwarcia/kliknięcia), z których zdjęto IP i user agent */
  zaangazowanie: number;
  /** wpisy wykluczeń sklepu, w których adres zastąpiono zaślepką */
  wykluczeniaSklepu: number;
  /** wpisy globalnej listy wykluczeń (odbicia, skargi), w których adres zastąpiono zaślepką z haszem */
  wykluczeniaGlobalne: number;
  /** wpisy zdarzeń wiadomości, z których zdjęto surową odpowiedź serwera pocztowego */
  odpowiedziDostawcy: number;
  /** raporty odbić ze skrzynki zwrotnej zanonimizowane */
  odbicia: number;
  /** wiersze raportu błędów importu z zaślepką zamiast adresu */
  bledyImportu: number;
  /** przebiegi importu, z których próbek wycięto wiersze osoby */
  probkiImportu: number;
  /** żądania API zdarzeń (raw_events kanału api) z zaślepką zamiast ciała */
  suroweApi: number;
  /** zdarzenia strumienia metryk, z których zdjęto właściwości i unique_id */
  zdarzeniaMetryk: number;
  /** klucze deduplikacji zdarzeń (event_keys) usunięte */
  kluczeZdarzen: number;
  /** FAKTYCZNY wynik kontroli zwrotnej po zapisie (false = nic nie zostało; przy true transakcja jest wycofana i leci błąd) */
  danePozostaly: boolean;
}

/**
 * Anonimizacja profilu z zachowaniem przychodu.
 *
 * Co znika: adres, telefon, imię i nazwisko na profilu; surowy JSON zamówienia ze
 * sklepu (tam siedzi adres dostawy i dane rozliczeniowe) - zarówno w `orders.raw`, jak
 * i w `raw_events.payload` (zostaje id i kwota, żeby raporty i idempotencja dalej
 * działały); adres na wysłanych wiadomościach; user agent przy kliknięciach; IP i user
 * agent przy zaangażowaniu; członkostwo w listach; adres na wykluczeniach sklepu;
 * wpis na globalnej liście wykluczeń.
 *
 * Co zostaje: zamówienia z kwotą, walutą, statusem i datą (raport przychodu),
 * rejestr zgód (dowód, że zgoda była, zanim ją wycofano), treść wysłanych
 * wiadomości (dowód, co dokładnie poszło), wpis w logu RODO.
 *
 * Globalne wykluczenie (odbicie, skarga) zostaje z zaślepką zamiast adresu i z haszem
 * (0022): blokada przeżywa anonimizację, a adres nie. Powód i data zostają w logu RODO.
 *
 * Wycofanie zgody na końcu nie jest ozdobą: bramka wysyłki pyta rejestr zgód,
 * więc bez tego wpisu anonimowy profil dalej kwalifikowałby się do kampanii.
 */
export async function anonimizujProfil(
  tenantId: string,
  profileId: string,
  opcje: { aktor: string; powod: string | null },
): Promise<WynikAnonimizacji | null> {
  const bladPowodu = sprawdzPowodRodo(opcje.powod);
  if (bladPowodu) throw new Error(bladPowodu);

  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    // blokada wiersza na czas operacji; przy okazji to jest sprawdzenie, czy profil
    // w ogóle należy do tego tenanta (AD-2) - bez niej literówka w identyfikatorze
    // trafiłaby w cudzą, równie prawdziwą osobę. Adres znormalizowany PO STRONIE SQL
    // tym samym wyrażeniem co indeksy (JS `trim` ≠ PG `btrim`).
    const { rows: profile } = await klient.query<{ email: string | null; phone: string | null; external_id: string | null; anonymous_id: string | null }>(
      `select lower(btrim(email)) as email, phone, external_id, anonymous_id
         from profiles where tenant_id = $1 and id = $2 for update`,
      [tenantId, profileId],
    );
    if (!profile[0]) {
      await klient.query("rollback");
      return null;
    }
    const email = profile[0].email;
    const hash = email ? hashAdresu(email) : null;
    // identyfikatory z API (0033): po nich pending żądania API i przyszłe zdarzenia
    // odtworzyłyby osobę, więc biorą udział w zaślepianiu i w nagrobkach
    const telefon = telefonE164(profile[0].phone);
    const externalId = profile[0].external_id;
    const anonymousId = profile[0].anonymous_id;
    const nagrobkiId = [
      ["phone_number", telefon],
      ["external_id", externalId],
      ["anonymous_id", anonymousId],
    ].filter((x): x is [string, string] => Boolean(x[1]));
    for (const [rodzaj, wartosc] of nagrobkiId) {
      await klient.query(
        `insert into rodo_nagrobki_identyfikatorow (tenant_id, rodzaj, hash)
         values ($1, $2, $3) on conflict do nothing`,
        [tenantId, rodzaj, hashIdentyfikatora(rodzaj, wartosc)],
      );
    }

    // Nagrobek (0024) PRZED czymkolwiek: identyfikatory kont w sklepie zbieramy z surowych
    // zdarzeń customer.*, dopóki jeszcze niosą adres. Bez nagrobka następny webhook
    // `customer.updated` odtworzyłby profil z pełnymi danymi (review #1).
    if (hash) {
      await klient.query(
        `insert into rodo_nagrobki (tenant_id, email_hash, store_id, external_customer_ids)
         select $1, $4, k.store_id, k.ids
           from (
             select r.store_id, array_agg(distinct split_part(r.idempotency_key, ':', 4)) as ids
               from raw_events r
              where ${PREDYKAT_SUROWYCH} and split_part(r.idempotency_key, ':', 3) = 'customer'
              group by r.store_id
              union all
             select null::uuid, '{}'::text[]
              where not exists (
                select 1 from raw_events r
                 where ${PREDYKAT_SUROWYCH} and split_part(r.idempotency_key, ':', 3) = 'customer')
           ) k
          limit 1
         on conflict (tenant_id, email_hash) do update
           set external_customer_ids = (
             select array_agg(distinct x) from unnest(rodo_nagrobki.external_customer_ids || excluded.external_customer_ids) x),
               store_id = coalesce(excluded.store_id, rodo_nagrobki.store_id)`,
        [tenantId, profileId, email, hash],
      );
    }

    // Surowe zdarzenia PRZED profilem: predykat po e-mailu potrzebuje adresu, który
    // za chwilę zniknie z profilu. Zostaje id bytu i kwota - klucz idempotencji dalej
    // odrzuci powtórkę tego samego webhooka, a raport zgodności dalej ma co liczyć.
    // Zdarzenie NIEPRZETWORZONE dostaje processed_at + process_error: zaślepki nie da
    // się zmapować i bez tego krążyłaby w kolejce (review #5).
    const surowe = await klient.query(
      `update raw_events r
          set payload = ${ZASLEPKA_PAYLOADU.replace(/\bpayload\b/g, "r.payload").replace(/\bidempotency_key\b/g, "r.idempotency_key")},
              processed_at = coalesce(r.processed_at, now()),
              process_error = 'anonimizowano'
        where ${PREDYKAT_SUROWYCH}
          and not (r.payload ? 'anonimizowano')`,
      [tenantId, profileId, email],
    );

    // Surowe żądania API zdarzeń tej osoby (ciało JSON:API z adresem, telefonem, właściwościami).
    // Zaślepka bez niczego, co wskazuje osobę; nieprzetworzone dostają processed_at, żeby
    // worker nie odtworzył z nich profilu.
    const suroweApi = await klient.query(
      `update raw_events r
          set payload = jsonb_build_object('anonimizowano', true),
              processed_at = coalesce(r.processed_at, now()),
              process_error = 'anonimizowano'
        where ${PREDYKAT_SUROWYCH_API}`,
      [tenantId, profileId, email, telefon, externalId, anonymousId],
    );

    // Strumień metryk (1.5): właściwości zdarzeń i unique_id (z API bywa pochodną adresu)
    // znikają; metryka, czas, kwota i źródło zostają (raporty i przychód się nie zmieniają).
    // Ślady operacji RODO (metryki rodo.*) zostają: to dowód obsłużenia żądania.
    const strumien = await klient.query(
      `update metric_events e
          set properties = '{}'::jsonb, unique_id = 'rodo:' || e.id::text
         from metrics m
        where e.tenant_id = $1 and e.profile_id = $2
          and m.tenant_id = e.tenant_id and m.id = e.metric_id
          and not (m.integration_key = 'midrev' and m.name like 'rodo.%')
          and (e.properties <> '{}'::jsonb or e.unique_id not like 'rodo:%')`,
      [tenantId, profileId],
    );
    const klucze = await klient.query(
      "delete from event_keys where tenant_id = $1 and profile_id = $2",
      [tenantId, profileId],
    );

    await klient.query(
      `update profiles set email = null, phone = null, first_name = null, last_name = null,
              properties = '{}'::jsonb, source_updated_at = null,
              external_id = null, anonymous_id = null, organization = null, title = null,
              locale = null, location = '{}'::jsonb, updated_at = now()
        where tenant_id = $1 and id = $2`,
      [tenantId, profileId],
    );

    // Surowy dokument ze sklepu to najgęstsze skupisko danych osobowych w bazie
    // (adres dostawy, telefon, notatki). Kolumny, na których stoi raport przychodu -
    // total_minor, currency, status, occurred_at - zostają nietknięte.
    await klient.query(
      `update orders set raw = jsonb_build_object('zanonimizowane', true)
        where tenant_id = $1 and profile_id = $2`,
      [tenantId, profileId],
    );

    await klient.query(
      "update messages set email = $3 where tenant_id = $1 and profile_id = $2",
      [tenantId, profileId, ADRES_PO_USUNIECIU],
    );

    await klient.query(
      "update clicks set user_agent = null where tenant_id = $1 and profile_id = $2",
      [tenantId, profileId],
    );

    // IP i user agent przy otwarciach/kliknięciach: werdykt (automat czy człowiek)
    // zostaje, bo to statystyka dostarczalności, nie dane osoby
    const zaangazowanie = await klient.query(
      `update message_engagement e set ip = null, user_agent = null
         from messages m
        where e.tenant_id = $1 and m.tenant_id = e.tenant_id and m.id = e.message_id
          and m.profile_id = $2 and (e.ip is not null or e.user_agent is not null)`,
      [tenantId, profileId],
    );

    // surowa odpowiedź serwera pocztowego (DSN) cytuje adres odbiorcy
    const odpowiedzi = await klient.query(
      `update message_events e set provider_reason = null
         from messages m
        where e.tenant_id = $1 and m.tenant_id = e.tenant_id and m.id = e.message_id
          and m.profile_id = $2 and e.provider_reason is not null`,
      [tenantId, profileId],
    );

    // raporty odbić ze skrzynki zwrotnej (adres, temat DSN cytujący adres, Message-ID):
    // funkcja modułu odbić, w tej samej transakcji
    const odbicia = await anonimizujOdbicia(tenantId, profileId, email, klient);
    let bledyImportu = 0;
    let probkiImportu = 0;
    if (email) {
      // Próbki wierszy CSV z importu Klaviyo: wiersz z tą osobą niesie też nazwisko, miasto,
      // tagi - zamiana samej komórki z adresem (anonimizujWImporcie) zostawiłaby resztę
      // wiersza. Dlatego NAJPIERW wycinamy z próbek całe wiersze zawierające adres (podgląd
      // pliku traci jeden wiersz, nic więcej), potem funkcja modułu importu czyści raport
      // błędów (zaślepka z haszem) i to, co zostało w próbkach.
      const probki = await klient.query(
        `update import_jobs j set
           sample = coalesce((select jsonb_agg(w order by i) from jsonb_array_elements(j.sample) with ordinality x(w, i)
                               where w::text not ilike '%' || $2 || '%'), '[]'::jsonb),
           suppression_sample = case when j.suppression_sample is null then null else
             coalesce((select jsonb_agg(w order by i) from jsonb_array_elements(j.suppression_sample) with ordinality x(w, i)
                        where w::text not ilike '%' || $2 || '%'), '[]'::jsonb) end
         where j.tenant_id = $1
           and (j.sample::text ilike '%' || $2 || '%' or coalesce(j.suppression_sample::text, '') ilike '%' || $2 || '%')`,
        [tenantId, email],
      );
      const wImporcie = await anonimizujWImporcie(tenantId, email, klient);
      bledyImportu = wImporcie.bledy;
      probkiImportu = (probki.rowCount ?? 0) + wImporcie.probki;
    }

    const usunieteZList = await klient.query(
      "delete from list_members where tenant_id = $1 and profile_id = $2",
      [tenantId, profileId],
    );

    let wykluczeniaSklepu = 0;
    let wykluczeniaGlobalne = 0;
    let powodyGlobalne: unknown[] = [];
    if (email && hash) {
      const sklepowe = await klient.query(
        "update tenant_suppressions set email = $3 where tenant_id = $1 and lower(btrim(email)) = lower(btrim($2))",
        [tenantId, email, ADRES_PO_USUNIECIU],
      );
      wykluczeniaSklepu = sklepowe.rowCount ?? 0;
      // Zaślepka z haszem zamiast DELETE: unikalność po lower(btrim(email)) zostaje
      // spełniona (16 znaków hasza), a bramka wysyłki trafia w wiersz po `email_hash`.
      // Gdy zaślepka z tym haszem JUŻ istnieje (osoba anonimizowana wcześniej, potem
      // kolejne odbicie dopisało jawny wiersz), jawne duplikaty usuwamy - drugi update
      // w unikalny indeks wywróciłby całą anonimizację (review H1).
      const zaslepka = zaslepkaWykluczenia(hash);
      const istnieje = await klient.query<{ reason: string }>(
        "select reason from suppressions where email_hash = $1 and email like 'anonimizowano:%'",
        [hash],
      );
      const globalne = istnieje.rowCount
        ? await klient.query<{ reason: string }>(
            "delete from suppressions where lower(btrim(email)) = lower(btrim($1)) returning reason",
            [email],
          )
        : await klient.query<{ reason: string }>(
            `update suppressions set email = $2, email_hash = $3
              where lower(btrim(email)) = lower(btrim($1)) returning reason`,
            [email, zaslepka, hash],
          );
      wykluczeniaGlobalne = (globalne.rowCount ?? 0) + (istnieje.rowCount ?? 0);
      // powód bez daty: data pozwalałaby złączyć log z wierszem-zaślepką (review R7)
      powodyGlobalne = [...istnieje.rows, ...globalne.rows].map((r) => ({ powod: r.reason }));
    }

    // Wycofanie zgody tam, gdzie zgoda była aktualna. Wpis, nie kasowanie (AD-16):
    // historia zgody jest dowodem, że wysyłka sprzed usunięcia była legalna.
    const wycofane = await klient.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, wording, occurred_at)
       select $1, $2, o.channel, 'withdrawn', 'rodo:usuniecie_danych',
              'Wycofanie zgody z urzędu przy realizacji żądania usunięcia danych', now()
         from (
           select distinct on (channel) channel, state
             from consents
            where tenant_id = $1 and profile_id = $2
            order by channel, occurred_at desc
         ) o
        where o.state = 'granted'`,
      [tenantId, profileId],
    );

    const sladAnonimizacji = {
      aktor: opcje.aktor,
      powod: opcje.powod,
      ...(powodyGlobalne.length ? { zamaskowaneWykluczeniaGlobalne: powodyGlobalne } : {}),
    };
    await zapiszZdarzenie(
      klient,
      {
        tenantId,
        metryka: METRYKI_WBUDOWANE.rodoAnonimizacja,
        profileId,
        occurredAt: new Date(),
        properties: sladAnonimizacji,
        source: "system",
      },
      { lustro: { eventType: "rodo.anonimizacja", payload: sladAnonimizacji } },
    );

    // Odczyt ZWROTNY w tej samej transakcji: licznik ma mówić, co jest w bazie po
    // zapisie, a nie co zamierzaliśmy zrobić. Tu wychodzi też, czy przychód ocalał.
    const stan = await kontrolaZwrotna(klient, tenantId, profileId, email, [externalId, anonymousId].filter((x): x is string => Boolean(x)));
    stan.pozostalosci["raporty odbić tej osoby (moduł odbić)"] = await pozostaleDaneOdbic(tenantId, profileId, email, klient);
    const pozostalosci = Object.entries(stan.pozostalosci).filter(([, ile]) => ile > 0);
    const danePozostaly =
      Boolean(stan.email || stan.phone || stan.first_name || stan.last_name) || pozostalosci.length > 0;
    if (danePozostaly) {
      // rozjazd między zamiarem a stanem bazy nie może skończyć się cichym "gotowe"
      await klient.query("rollback");
      throw new Error(
        `Anonimizacja profilu ${profileId} nie usunęła wszystkich danych - transakcja wycofana (` +
          pozostalosci.map(([gdzie, ile]) => `${gdzie}: ${ile}`).join(", ") +
          ")",
      );
    }

    await klient.query("commit");
    return {
      zamowien: stan.zamowien,
      przychodMinor: stan.przychod_minor,
      wiadomosci: stan.wiadomosci,
      zgodyWycofane: wycofane.rowCount ?? 0,
      usunieteZList: usunieteZList.rowCount ?? 0,
      suroweZdarzenia: surowe.rowCount ?? 0,
      zaangazowanie: zaangazowanie.rowCount ?? 0,
      wykluczeniaSklepu,
      wykluczeniaGlobalne,
      odpowiedziDostawcy: odpowiedzi.rowCount ?? 0,
      odbicia,
      bledyImportu,
      probkiImportu,
      suroweApi: suroweApi.rowCount ?? 0,
      zdarzeniaMetryk: strumien.rowCount ?? 0,
      kluczeZdarzen: klucze.rowCount ?? 0,
      danePozostaly,
    };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

/**
 * Kontrola zwrotna: FAKTYCZNY stan bazy po zapisie, liczony NIEZALEŻNIE od predykatów,
 * których użyły UPDATE-y (kontrola tym samym predykatem co zapis to tautologia - review R6).
 * Surowe zdarzenia i zdarzenia wiadomości szukane po tekście z adresem, profil po kolumnach,
 * reszta po powiązaniu z profilem.
 */
async function kontrolaZwrotna(klient: PoolClient, tenantId: string, profileId: string, email: string | null, identyfikatory: string[] = []) {
  const { rows } = await klient.query<{
    email: string | null;
    phone: string | null;
    first_name: string | null;
    last_name: string | null;
    zamowien: number;
    przychod_minor: string;
    wiadomosci: number;
    p_wlasciwosci: number;
    p_surowe_zamowien: number;
    p_surowe_zdarzenia: number;
    p_wiadomosci_adres: number;
    p_klikniecia_ua: number;
    p_zaangazowanie: number;
    p_odpowiedzi_dostawcy: number;
    p_listy: number;
    p_wykluczenia_sklepu: number;
    p_wykluczenia_globalne: number;
    p_odbicia: number;
    p_bledy_importu: number;
    p_probki_importu: number;
    p_zdarzenia_metryk: number;
    p_klucze_zdarzen: number;
    p_surowe_api: number;
    p_identyfikatory: number;
  }>(
    `select p.email, p.phone, p.first_name, p.last_name,
            (select count(*)::int from orders o
              where o.tenant_id = p.tenant_id and o.profile_id = p.id) as zamowien,
            coalesce((select sum(o.total_minor) from orders o
                       where o.tenant_id = p.tenant_id and o.profile_id = p.id
                         and o.status in ('completed','processing')), 0)::text as przychod_minor,
            (select count(*)::int from messages m
              where m.tenant_id = p.tenant_id and m.profile_id = p.id) as wiadomosci,
            (case when p.properties <> '{}'::jsonb then 1 else 0 end) as p_wlasciwosci,
            (select count(*)::int from orders o
              where o.tenant_id = p.tenant_id and o.profile_id = p.id
                and o.raw <> jsonb_build_object('zanonimizowane', true)) as p_surowe_zamowien,
            (select count(*)::int from raw_events r
              where r.tenant_id = $1 and $3::text is not null
                and r.payload::text ilike '%' || lower(btrim($3)) || '%') as p_surowe_zdarzenia,
            (select count(*)::int from messages m
              where m.tenant_id = $1 and m.profile_id = $2 and m.email <> $4) as p_wiadomosci_adres,
            (select count(*)::int from clicks c
              where c.tenant_id = $1 and c.profile_id = $2 and c.user_agent is not null) as p_klikniecia_ua,
            (select count(*)::int from message_engagement e
               join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
              where e.tenant_id = $1 and m.profile_id = $2
                and (e.ip is not null or e.user_agent is not null)) as p_zaangazowanie,
            (select count(*)::int from message_events e
               join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
              where e.tenant_id = $1 and m.profile_id = $2 and e.provider_reason is not null) as p_odpowiedzi_dostawcy,
            (select count(*)::int from list_members lm
              where lm.tenant_id = $1 and lm.profile_id = $2) as p_listy,
            (select count(*)::int from tenant_suppressions ts
              where ts.tenant_id = $1 and $3::text is not null
                and lower(btrim(ts.email)) = lower(btrim($3))) as p_wykluczenia_sklepu,
            (select count(*)::int from suppressions s
              where $3::text is not null and lower(btrim(s.email)) = lower(btrim($3))) as p_wykluczenia_globalne,
            (select count(*)::int from bounce_reports b
              where b.tenant_id = $1 and $3::text is not null
                and (b.recipient ilike '%' || lower(btrim($3)) || '%' or b.subject ilike '%' || lower(btrim($3)) || '%')) as p_odbicia,
            (select count(*)::int from import_job_errors e
              where e.tenant_id = $1 and $3::text is not null and lower(btrim(e.email)) = lower(btrim($3))) as p_bledy_importu,
            (select count(*)::int from import_jobs j
              where j.tenant_id = $1 and $3::text is not null
                and (j.sample::text ilike '%' || lower(btrim($3)) || '%'
                     or j.suppression_sample::text ilike '%' || lower(btrim($3)) || '%')) as p_probki_importu,
            (select count(*)::int from metric_events e
               join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
              where e.tenant_id = $1 and e.profile_id = $2
                and not (m.integration_key = 'midrev' and m.name like 'rodo.%')
                and (e.properties <> '{}'::jsonb or e.unique_id not like 'rodo:%')) as p_zdarzenia_metryk,
            (select count(*)::int from event_keys k where k.tenant_id = $1 and k.profile_id = $2) as p_klucze_zdarzen,
            (select count(*)::int from raw_events r
              where r.tenant_id = $1 and r.channel = 'api' and not (r.payload ? 'anonimizowano') and (
                r.payload -> 'meta' ->> 'profile_id' = $2::text
                or r.payload::text ilike '%' || $2::text || '%'
                or ($3::text is not null and r.payload::text ilike '%' || lower(btrim($3)) || '%')
                -- identyfikatory bywają krótkie ("7"): dokładne pole, nie wyszukiwanie w tekście
                or r.payload #>> '{body,data,attributes,profile,data,attributes,external_id}' = any($5::text[])
                or r.payload #>> '{body,data,attributes,profile,data,attributes,anonymous_id}' = any($5::text[]))) as p_surowe_api,
            (case when p.external_id is not null or p.anonymous_id is not null or p.organization is not null
                       or p.title is not null or p.locale is not null or p.location <> '{}'::jsonb then 1 else 0 end) as p_identyfikatory
       from profiles p where p.tenant_id = $1 and p.id = $2`,
    [tenantId, profileId, email, ADRES_PO_USUNIECIU, identyfikatory],
  );
  const w = rows[0];
  return {
    email: w.email,
    phone: w.phone,
    first_name: w.first_name,
    last_name: w.last_name,
    zamowien: w.zamowien,
    przychod_minor: w.przychod_minor,
    wiadomosci: w.wiadomosci,
    pozostalosci: <Record<string, number>>{
      "właściwości profilu": w.p_wlasciwosci,
      "surowe zamówienia": w.p_surowe_zamowien,
      "surowe zdarzenia z adresem": w.p_surowe_zdarzenia,
      "wiadomości z adresem": w.p_wiadomosci_adres,
      "user agent kliknięć": w.p_klikniecia_ua,
      "IP/UA zaangażowania": w.p_zaangazowanie,
      "odpowiedzi dostawcy": w.p_odpowiedzi_dostawcy,
      "członkostwa w listach": w.p_listy,
      "wykluczenia sklepu z adresem": w.p_wykluczenia_sklepu,
      "wykluczenia globalne z adresem": w.p_wykluczenia_globalne,
      "raporty odbić z adresem": w.p_odbicia,
      "błędy importu z adresem": w.p_bledy_importu,
      "próbki importu z adresem": w.p_probki_importu,
      "właściwości zdarzeń strumienia metryk": w.p_zdarzenia_metryk,
      "klucze deduplikacji zdarzeń": w.p_klucze_zdarzen,
      "surowe żądania API zdarzeń": w.p_surowe_api,
      "identyfikatory i dane profilu (external_id, lokalizacja…)": w.p_identyfikatory,
    },
  };
}
