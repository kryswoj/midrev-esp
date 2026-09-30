import { randomBytes } from "node:crypto";
import { getPool } from "../../adapters/db/pool";
import { hashAdresu } from "../../adapters/hash-adresu";
import { adresSledzenia, config } from "../../config";
import type { DostawcaWysylki } from "../../domain/email/port";
import { klasyfikujOdpowiedzSmtp, type Klasyfikacja } from "../../domain/email/klasyfikacja";
import { canSendTo } from "./can-send-to";
import { tokenOtwarcia, zlozWiadomosc } from "./renderuj";
import { politykaSledzenia } from "./zgody";
import { policzOdbiorcow } from "../policz-odbiorcow";
import { adresNadawcyTenanta, wybierzWysylke } from "../wysylka-konfiguracja/nadawca";
import { wyslijAlert } from "../../jobs/alerty";
import { czyZamykanie } from "../../jobs/zamykanie";

/**
 * Rangi stanów wiadomości (AD-22). Projekcja current_state na messages jest aktualizowana
 * WYŁĄCZNIE monotonicznie: UPDATE ... WHERE current_rank < nowa ranga. Dzięki temu webhook
 * dostawcy z "delivered" nie zostanie nadpisany przez spóźnione "sent" workera.
 */
const RANGI: Record<string, number> = {
  queued: 0,
  claimed: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  bounced: 3,
  // `dropped` (mail nie opuścił naszej strony) jest stanem TERMINALNYM tak samo jak
  // `failed` — rozdział tych dwóch dotyczy przyczyny, nie tego, czy sprawa jest zamknięta.
  dropped: 3,
  failed: 3,
  suppressed: 3,
  held: 3,
  complained: 4,
};

export type TypZdarzeniaWiadomosci =
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "dropped"
  | "failed"
  | "suppressed"
  | "held";

export interface OpcjeZdarzenia {
  /**
   * Data zdarzenia. Podawana ZAWSZE jawnie, bo 0014 zdjęło z kolumny `default now()`
   * (AD-10, ten sam ruch, który 0002 zrobiło na `events`).
   *   `Date`    — zdarzenie zaraportowane przez dostawcę: data pochodzi OD NIEGO,
   *               a nie z chwili, w której webhook do nas dotarł.
   *   `"teraz"` — przejście stanu, które dzieje się w tej chwili. Datę stawia zegar
   *               BAZY, nie serwera aplikacji: po tej samej dacie liczy się limit
   *               dobowy i rozjazd zegarów przesunąłby wysyłkę między dobami.
   */
  kiedy: Date | "teraz";
  payload?: Record<string, unknown>;
  /** Klasyfikacja odbicia (A2). Przy `bounced` wymagana także przez CHECK w bazie. */
  klasyfikacja?: Klasyfikacja;
  /**
   * Czy twarde odbicie / skarga ma trafić także na wykluczenia GLOBALNE (cała platforma).
   * Domyślnie tak. `false` dla raportów bez dowodu tożsamości wiadomości (skrzynka
   * zwrotna jest publiczna: sfałszowany DSN dopasowany po samym adresie nie może
   * wykluczyć adresu wszystkim tenantom; sklepowe wykluczenie zostaje, bo jest
   * odwracalne z panelu i widoczne w rejestrze raportów).
   */
  wykluczenieGlobalne?: boolean;
}

export async function zapiszZdarzenie(
  klient: import("pg").PoolClient,
  tenantId: string,
  messageId: string,
  typ: TypZdarzeniaWiadomosci,
  opcje: OpcjeZdarzenia,
) {
  const k = opcje.klasyfikacja;
  // Zdarzenie jest append-only z unikalnością (message_id, event_type): powtórka
  // (np. ponowiony job) nie tworzy drugiego wpisu i nie przesuwa stanu wstecz.
  const zapis = await klient.query(
    `insert into message_events
       (tenant_id, message_id, event_type, payload, occurred_at,
        bounce_class, bounce_category, smtp_code, provider_reason, add_exclusion, counts_to_rate)
     values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $6, $7, $8, $9, $10, $11)
     on conflict (message_id, event_type) do nothing
     returning id`,
    [
      tenantId,
      messageId,
      typ,
      JSON.stringify(opcje.payload ?? {}),
      opcje.kiedy === "teraz" ? null : opcje.kiedy,
      k?.klasa ?? null,
      k?.kategoria ?? null,
      k?.kodSmtp ?? null,
      k?.powodDostawcy ?? null,
      k?.wykluczAdres ?? null,
      k?.liczySieDoWskaznika ?? null,
    ],
  );
  await klient.query(
    `update messages set current_state = $3, current_rank = $4
      where tenant_id = $1 and id = $2 and current_rank < $4`,
    [tenantId, messageId, typ, RANGI[typ] ?? 0],
  );

  // Decyzja `add_exclusion` zapisana w zdarzeniu ma być WYKONANA, nie tylko odnotowana.
  // Warunek na rowCount: gdy zdarzenie było duplikatem, wykluczenie już wcześniej
  // powstało i drugi wpis tylko zaśmieciłby log (tenant_suppressions nie ma unikalności).
  if (k?.wykluczAdres && zapis.rowCount) {
    const powod = `odbicie:${k.kategoria ?? "unclassified"}${k.kodSmtp ? ` (${k.kodSmtp})` : ""}`;
    const { rows: adres } = await klient.query<{ email: string }>(
      "select email from messages where tenant_id = $1 and id = $2",
      [tenantId, messageId],
    );
    const email = adres[0]?.email ?? null;
    // Spóźniony raport do wiadomości już ZANONIMIZOWANEJ (RODO, art. 17): adres to
    // zaślepka `usuniety@rodo.invalid`. Wpis wykluczenia z zaślepką nikogo nie chroni,
    // a wykluczenie osoby, która zażądała usunięcia, i tak stoi po haszu w `suppressions`.
    if (email && !czyZaslepkaRodo(email)) {
      await klient.query(
        `insert into tenant_suppressions (tenant_id, email, action, reason, actor, occurred_at)
         values ($1, $2, 'suppressed', $3, 'system', coalesce($4::timestamptz, now()))`,
        [tenantId, email, powod, opcje.kiedy === "teraz" ? null : opcje.kiedy],
      );
      // Wykluczenie GLOBALNE tylko przy martwym adresie i przy skardze: to chroni
      // reputację całej platformy (0001). Miękkie odbicie zostaje przy jednym sklepie.
      // `email_hash` od razu (0022/0023): wpis przeżyje anonimizację, a dedup po haszu
      // nie dopisze jawnie adresu, który już siedzi na liście jako sama zaślepka.
      if ((k.klasa === "hard" || k.typZdarzenia === "complained") && opcje.wykluczenieGlobalne !== false) {
        await klient.query(
          `insert into suppressions (email, reason, email_hash)
           select $1, $2, $3
            where not exists (select 1 from suppressions s where s.email_hash = $3 or lower(btrim(s.email)) = lower(btrim($1)))
           on conflict do nothing`,
          [email, powod, hashAdresu(email)],
        );
      }
    }
  }
}

/** Adres-zaślepka po anonimizacji RODO (profil-rodo.ts) albo zaślepka globalnej listy (0022). */
function czyZaslepkaRodo(email: string): boolean {
  return email === "usuniety@rodo.invalid" || email.startsWith("anonimizowano:");
}

function token(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Domena wysyłkowa użyta przy tej wiadomości (A3). Rozstrzygana z adresu nadawcy, bo
 * to on decyduje, spod której tożsamości mail wychodzi. `null`, gdy tenant nie ma
 * jeszcze wiersza w `sending_domains` — tak jest dziś przy Mailpicie i tak zostanie do
 * Bloku D, w którym dochodzi twarda bramka "bez zweryfikowanej domeny nie wysyłamy".
 * Zapisujemy to, co wiemy, zamiast nie zapisywać nic.
 */
async function domenaWysylkowa(tenantId: string, adresOd: string): Promise<string | null> {
  const domena = adresOd.split("@")[1]?.trim().toLowerCase();
  if (!domena) return null;
  const { rows } = await getPool().query(
    "select id from sending_domains where tenant_id = $1 and lower(domain) = $2",
    [tenantId, domena],
  );
  return rows[0]?.id ?? null;
}

/**
 * Faza 1: budowa wiadomości dla kampanii. Idempotentna dzięki unikalności
 * (tenant_id, source_type, source_id, profile_id) z AD-26: drugie uruchomienie
 * nie tworzy duplikatów, tylko dokłada brakujących odbiorców.
 *
 * Jeden `INSERT … SELECT` na całą kampanię zamiast SELECT + SELECT + INSERT per profil
 * (audyt 24.09, #5: przy 10 tys. odbiorców to było 30 tys. zapytań). Zasady, które
 * zostały DOKŁADNIE te same, tylko przeniesione do SQL:
 *   - adres z profilu w chwili budowy, profil bez adresu pomijany,
 *   - zgoda na śledzenie otwarć i kliknięć rozstrzygana per odbiorca tą samą regułą co
 *     `zgodyNaSledzenie` (ostatni wpis w rejestrze, polityka tenanta) i UTRWALANA na
 *     wiadomości (A5, AD-32),
 *   - HTML per wiadomość z jej własnymi tokenami (klik, wypis, pixel), identyczny z tym,
 *     co daje `zlozWiadomosc` dla tych tokenów (test regresji porównuje bajt w bajt).
 * Tokeny powstają w Node (CSPRNG), nie w bazie: `gen_random_bytes` wymaga pgcrypto, a
 * hash pixela i tak liczymy tutaj. Do bazy idą jako tablice do `unnest`.
 */
export async function zbudujWiadomosciKampanii(tenantId: string, campaignId: string, opcje: { porcja?: number } = {}) {
  const pool = getPool();
  const { rows: kampanie } = await pool.query(
    `select c.name, c.subject, c.content, t.name as nazwa_sklepu,
            t.sender_company_name, t.sender_postal_address, t.sender_tax_id
       from campaigns c join tenants t on t.id = c.tenant_id
      where c.tenant_id = $1 and c.id = $2`,
    [tenantId, campaignId],
  );
  const kampania = kampanie[0];
  if (!kampania) throw new Error("Kampania nie istnieje w tym tenancie");
  const trescHtml: string = (kampania.content as { html?: string } | null)?.html ?? "";
  if (!trescHtml.trim()) throw new Error("Kampania nie ma treści");
  if (!kampania.subject) throw new Error("Kampania nie ma tematu");

  const odbiorcy = await policzOdbiorcow(tenantId, campaignId);
  if (odbiorcy.doceloweIds.length === 0) return { utworzone: 0, kandydatow: 0 };
  // adres nadawcy TEGO tenanta (własny serwer SMTP albo domyślny MAIL_FROM)
  const sendingDomainId = await domenaWysylkowa(tenantId, await adresNadawcyTenanta(tenantId));
  // polityka śledzenia raz na kampanię, nie raz na odbiorcę
  const polityka = await politykaSledzenia(pool, tenantId);

  // Cztery szablony HTML (śledzenie kliknięć × otwarć) z ZNACZNIKAMI zamiast tokenów.
  // Znaczniki są losowe per wywołanie, więc nie da się ich trafić treścią kampanii.
  const znacznikKlik = `KLIK-${token()}`;
  const znacznikWypis = `WYPIS-${token()}`;
  const znacznikPixel = tokenOtwarcia(znacznikKlik);
  const szablon = (klikniecia: boolean, otwarcia: boolean) =>
    zlozWiadomosc({
      trescHtml,
      clickToken: znacznikKlik,
      unsubscribeToken: znacznikWypis,
      nazwaSklepu: kampania.nazwa_sklepu,
      nadawca: { firma: kampania.sender_company_name, adres: kampania.sender_postal_address, nip: kampania.sender_tax_id },
      sledzKlikniecia: klikniecia,
      sledzOtwarcia: otwarcia,
    });
  const zKlikZOtw = szablon(true, true);
  const zKlikBezOtw = szablon(true, false);
  const bezKlikZOtw = szablon(false, true);
  const bezKlikBezOtw = szablon(false, false);

  // Porcjami po PORCJA_BUDOWY odbiorców (triaż A, P3): jedno zapytanie na 50 tys.
  // odbiorców to cztery tablice po 50 tys. elementów w parametrach i jedna długa
  // transakcja trzymająca blokady. Każda porcja jest sama w sobie idempotentna (ON
  // CONFLICT), więc awaria w połowie zostawia część wiadomości, a ponowienie dokłada resztę.
  let utworzone = 0;
  const porcja = Math.max(1, Math.floor(opcje.porcja ?? PORCJA_BUDOWY));
  for (let od = 0; od < odbiorcy.doceloweIds.length; od += porcja) {
    const ids = odbiorcy.doceloweIds.slice(od, od + porcja);
    const clickTokeny = ids.map(() => token());
    const unsubTokeny = ids.map(() => token());
    const pixelTokeny = clickTokeny.map((t) => tokenOtwarcia(t));

    const wynik = await pool.query(
      `with polityka as (
         select $12::text as otwarcia, $13::text as klikniecia
       ),
       odbiorca as (
         select d.profile_id, d.click_token, d.unsub_token, d.pixel_token, p.email
           from unnest($3::uuid[], $4::text[], $5::text[], $6::text[])
                  as d(profile_id, click_token, unsub_token, pixel_token)
           join profiles p on p.tenant_id = $1 and p.id = d.profile_id
          where p.email is not null
       ),
       wpisy as (
         -- ostatni wpis w rejestrze per kanał (AD-16): occurred_at, potem recorded_at
         select o.profile_id,
                (select (c.state = 'granted' and (c.valid_until is null or c.valid_until > now()))
                   from consents c
                  where c.tenant_id = $1 and c.profile_id = o.profile_id and c.channel = 'email_open_tracking'
                  order by c.occurred_at desc, c.recorded_at desc limit 1) as otwarcia_wpis,
                (select (c.state = 'granted' and (c.valid_until is null or c.valid_until > now()))
                   from consents c
                  where c.tenant_id = $1 and c.profile_id = o.profile_id and c.channel = 'email_click_tracking'
                  order by c.occurred_at desc, c.recorded_at desc limit 1) as klikniecia_wpis
           from odbiorca o
       ),
       zgody as (
         -- ta sama reguła co zgodyNaSledzenie: 'wymaga_zgody' = tylko jawna ważna zgoda,
         -- 'dozwolone' = blokuje wyłącznie jawny wpis, który nie uprawnia
         select w.profile_id,
                case when pl.otwarcia is null then false
                     when pl.otwarcia = 'wymaga_zgody' then coalesce(w.otwarcia_wpis, false)
                     else coalesce(w.otwarcia_wpis, true) end as otwarcia,
                case when pl.klikniecia is null then false
                     when pl.klikniecia = 'wymaga_zgody' then coalesce(w.klikniecia_wpis, false)
                     else coalesce(w.klikniecia_wpis, true) end as klikniecia
           from wpisy w cross join polityka pl
       )
       insert into messages (tenant_id, profile_id, source_type, source_id, email, subject,
                             body_html, click_token, unsubscribe_token, links,
                             sending_domain_id, open_tracking_allowed, click_tracking_allowed)
       select $1, o.profile_id, 'campaign', $2, o.email, $7,
              replace(replace(replace(
                case when z.klikniecia and z.otwarcia then $8
                     when z.klikniecia then $9
                     when z.otwarcia then $10
                     else $11 end,
                $14, o.pixel_token), $15, o.click_token), $16, o.unsub_token),
              o.click_token, o.unsub_token,
              case when z.klikniecia then $17::jsonb else '[]'::jsonb end,
              $18, z.otwarcia, z.klikniecia
         from odbiorca o join zgody z on z.profile_id = o.profile_id
       -- cel z predykatem: do 0036 arbitrem jest tez stary constraint (te same kolumny),
       -- po 0036 tylko unikalnosc czesciowa messages_zrodlo_uq; semantyka bez zmian
       on conflict (tenant_id, source_type, source_id, profile_id) where source_type <> 'journey' do nothing`,
      [
        tenantId, campaignId, ids, clickTokeny, unsubTokeny, pixelTokeny,
        kampania.subject,
        zKlikZOtw.html, zKlikBezOtw.html, bezKlikZOtw.html, bezKlikBezOtw.html,
        polityka?.otwarcia ?? null, polityka?.klikniecia ?? null,
        // kolejność podmian: NAJPIERW pixel (hash znacznika kliku), potem klik, potem wypis —
        // inaczej podmiana kliku zniszczyłaby hash, który go zawiera w formie skrótu
        znacznikPixel, znacznikKlik, znacznikWypis,
        JSON.stringify(zKlikZOtw.linki), sendingDomainId,
      ],
    );
    utworzone += wynik.rowCount ?? 0;
  }
  return { utworzone, kandydatow: odbiorcy.doceloweIds.length };
}

/** Ilu odbiorców na jedno zapytanie budowy wiadomości. */
export const PORCJA_BUDOWY = 1000;

/**
 * Ile miejsc z limitu dobowego tenant już ZAREZERWOWAŁ dzisiaj (FR52).
 * Licznikiem prawdy jest tenant_send_usage, nie zliczanie zdarzeń 'sent': rezerwacja
 * obejmuje też wiadomości w locie i spalone próby, więc równoległe procesy nie mogą
 * razem przekroczyć limitu. Rezerwacji nie zwalniamy przy niejasnym wyniku dostawcy.
 */
async function zuzycieDzisiaj(tenantId: string): Promise<number> {
  const { rows } = await getPool().query(
    "select used from tenant_send_usage where tenant_id = $1 and day = current_date",
    [tenantId],
  );
  return rows[0]?.used ?? 0;
}

/** Po tylu nieudanych próbach przejściowych wiadomość dostaje trwałe failed. */
const MAX_PROB_WIADOMOSCI = 5;

/**
 * Klasyfikacja błędu dostawcy wg tego, co WIADOMO o losie wiadomości:
 *   przejsciowy — dostawca NA PEWNO nie przyjął: jawna odpowiedź SMTP 4xx (RFC 5321: odmowa tymczasowa,
 *     także po DATA oznacza nieprzyjęcie) -> bezpieczny powrót do queued.
 *   trwaly — jawna odpowiedź SMTP 5xx: dostawca odmówił na stałe -> failed.
 *   nieznany — zerwane połączenie, timeout (ECONNRESET/EPIPE/ETIMEDOUT): mogły zajść
 *     już PO kropce kończącej DATA, więc mail mógł wyjść. Wiadomość zostaje w sending
 *     i rozstrzyga ją rekoncyliacja (held + alert), nie ślepe ponowienie (NFR15).
 */
function klasaBledu(blad: unknown): "przejsciowy" | "trwaly" | "nieznany" | "nadawca" {
  const kod = (blad as { code?: unknown })?.code;
  // Błąd ETAPU NADAWCY (triaż A, P1): logowanie, TLS, EHLO, MAIL FROM, błąd API dostawcy.
  // Do rozmowy o odbiorcy nie doszło, więc mail NA PEWNO nie wyszedł, a ten sam błąd
  // spotka każdą następną wiadomość partii. Adapter oznacza go kodem `ENADAWCA`.
  if (kod === "ENADAWCA") return "nadawca";
  // Odmowa ZESTAWIENIA połączenia (serwer leży, DNS nie zna hosta): do serwera nic nie
  // poszło, a ta sama odmowa spotka każdą wiadomość partii. Dotąd był to „przejściowy"
  // z attempts++ na każdej wiadomości — po pięciu przebiegach cała kolejka szła w failed
  // (review A2). Teraz jak błąd nadawcy: partia wraca do kolejki bez zużycia prób.
  if (typeof kod === "string" && ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND"].includes(kod)) {
    return "nadawca";
  }
  const tresc = blad instanceof Error ? blad.message : String(blad);
  const odpowiedz = tresc.match(/dostano: (\d)\d\d/);
  if (odpowiedz) return odpowiedz[1] === "4" ? "przejsciowy" : "trwaly";
  return "nieznany";
}

/**
 * Trwała odmowa dostawcy przy przekazaniu wiadomości to `dropped`, a NIE `bounced` (A2):
 * mail nigdy nie dotarł do serwera odbiorcy, więc nie mówi nic o naszej reputacji u niego
 * i nie ma prawa wchodzić do bounce rate. Klasyfikacja hard/soft i decyzja o wykluczeniu
 * adresu powstają tutaj, z kodu SMTP, i lądują w samym zdarzeniu — bo surowej odpowiedzi
 * serwera nikt nie przechowa drugi raz.
 */
function klasyfikujOdmowe(blad: unknown): Klasyfikacja {
  const tresc = blad instanceof Error ? blad.message : String(blad);
  return klasyfikujOdpowiedzSmtp(tresc, "dropped");
}

/**
 * Dlaczego partia się skończyła, gdy skończyła się NIE dlatego, że zabrakło wiadomości.
 * Wołający musi umieć to rozróżnić: limit dobowy wraca jutro sam, wstrzymanie tenanta
 * czeka na człowieka, a brak wiadomości to normalne domknięcie kampanii.
 */
export type PowodZatrzymania = "limit_dobowy" | "wstrzymanie_tenanta" | "blokada_nadawcy" | "zamykanie" | null;

/**
 * Faza 2: wysyłka partii. Cykl JEDNEJ wiadomości wg AD-23:
 *   tx1: wiążące canSendTo + przejście queued -> sending, commit PRZED wywołaniem dostawcy
 *   wywołanie dostawcy z idempotencyKey = id wiadomości
 *   tx2: zapis sent + identyfikator u dostawcy
 * Partia NIGDY nie jest jedną transakcją: awaria w środku zostawia domknięte pojedyncze
 * wiadomości, a nie połowicznie wysłaną partię bez śladu.
 */
export async function wyslijPartie(
  tenantId: string,
  opcje: { limit?: number; dostawca?: DostawcaWysylki; dns?: import("../wysylka-konfiguracja/domeny").OpcjeDns } = {},
) {
  const pool = getPool();
  const limitPartii = opcje.limit ?? 50;
  // Proces się zamyka (SIGTERM): nowej partii nie zajmujemy. Nic nie jest claimed,
  // więc nic nie utknie; kolejka poczeka na następny proces.
  if (czyZamykanie()) {
    return { wyslane: 0, odmowy: 0, bledy: 0, powodZatrzymania: "zamykanie" as const, powodOpis: null };
  }

  // Limit dobowy i stan wstrzymania tenanta jednym zapytaniem: to sa dwie odpowiedzi na
  // to samo pytanie "czy temu tenantowi wolno teraz wysylac", zadawane przed kazda partia.
  const { rows: ustawienia } = await pool.query(
    `select l.daily_limit, t.sending_paused_at, t.sending_pause_reason
       from tenants t left join tenant_send_limits l on l.tenant_id = t.id
      where t.id = $1`,
    [tenantId],
  );
  const limitDobowy = ustawienia[0]?.daily_limit ?? 500;

  // B5: wstrzymanie tenanta sprawdzane MIEDZY PARTIAMI, nie w srodku partii. Partia juz
  // zajeta idzie do konca (jej wiadomosci sa w drodze do dostawcy), a nastepna nie rusza.
  // Czytane z bazy przy kazdej partii, a nie raz na starcie joba: wstrzymanie ma zadzialac
  // takze na kampanie, ktora akurat trwa godzine.
  if (ustawienia[0]?.sending_paused_at) {
    return {
      wyslane: 0,
      odmowy: 0,
      bledy: 0,
      powodZatrzymania: "wstrzymanie_tenanta" as const,
      powodOpis: String(ustawienia[0].sending_pause_reason ?? ""),
    };
  }
  // Wstępny odczyt służy TYLKO doborowi rozmiaru partii; wiążąca jest rezerwacja
  // per wiadomość w transakcji przejścia w sending (poniżej).
  const zuzyte = await zuzycieDzisiaj(tenantId);
  const wolneMiejsce = Math.max(0, limitDobowy - zuzyte);
  if (wolneMiejsce === 0) {
    return { wyslane: 0, odmowy: 0, bledy: 0, powodZatrzymania: "limit_dobowy" as const, powodOpis: null };
  }

  // Wybór dostawcy i nadawcy per tenant (moduł „Wysyłka i domeny"). Tylko gdy jest co
  // wysłać: wybór potrafi zapytać DNS i otworzyć połączenie SMTP, a tik automatyzacji
  // woła tę funkcję także przy pustej kolejce. Pusta kolejka kończy się dokładnie tym
  // samym wynikiem co wcześniej (zero zajętych wiadomości).
  // Ten sam filtr co przy zajmowaniu partii (review flow, runda 2, #11): wiadomości
  // wstrzymanej/odwołanej kampanii i wstrzymanej/wyłączonej automatyzacji nie są „czymś do
  // wysłania". Bez tego tik co minutę pytał DNS i łączył się z SMTP dla partii, która i tak
  // nic nie zajmie.
  const { rows: kolejka } = await pool.query(
    `select exists (
       select 1 from messages m
        where m.tenant_id = $1 and m.current_state = 'queued'
          and not exists (
            select 1 from campaigns c
             where m.source_type = 'campaign'
               and c.tenant_id = m.tenant_id and c.id = m.source_id
               and c.status in ('paused', 'cancelled')
          )
          and not exists (
            select 1 from journeys j
              join flows f on f.tenant_id = j.tenant_id and f.id = j.flow_id
             where m.source_type = 'journey'
               and j.tenant_id = m.tenant_id and j.id = m.source_id
               and f.status <> 'wlaczony'
          )
     ) as jest`,
    [tenantId],
  );
  if (!kolejka[0]?.jest) {
    return { wyslane: 0, odmowy: 0, bledy: 0, powodZatrzymania: null, powodOpis: null };
  }
  const wybor = await wybierzWysylke(tenantId, { dostawca: opcje.dostawca, dns: opcje.dns });
  if (wybor.rodzaj === "blokada") {
    // FR45 albo niesprawdzony/niedostępny serwer klienta: NIC nie jest zajmowane, więc
    // nic nie utknie w claimed/sending. Wiadomości czekają w queued na naprawę.
    console.warn(`[wysylka] tenant ${tenantId}: wysyłka zablokowana — ${wybor.powod}`);
    return {
      wyslane: 0,
      odmowy: 0,
      bledy: 0,
      powodZatrzymania: "blokada_nadawcy" as const,
      powodOpis: wybor.powod,
    };
  }
  const { dostawca, nadawca } = wybor;
  // wersja konfiguracji SMTP, z którą ruszyła partia: błąd nadawcy unieważnia wynik testu
  // TYLKO tej wersji (spóźniony błąd starej konfiguracji nie nadpisze testu nowej)
  const wersjaSerwera = wybor.wersjaSerwera ?? null;

  // Zajęcie partii tym samym wzorcem co kolejka: atomowy UPDATE przez SKIP LOCKED.
  // Bez tego dwa workery pracujące naraz wybrałyby te same wiadomości w stanie queued
  // i każda wyszłaby dwa razy, a podwójna wysyłka jest nieodwracalna (NFR15).
  // claimed_at pełni dwie role: zegar recovery (zombie liczy timeout od zajęcia,
  // nie od utworzenia) i TOKEN WŁASNOŚCI partii — krąży jako tekst prosto z bazy
  // (mikrosekundy; przejście przez Date psuje wartość, jak przy tożsamości jobów).
  // Sam stan 'claimed' nie wystarcza za dowód własności: po odzyskaniu zombie inny
  // proces mógł zająć tę samą wiadomość na nowo i też widzieć 'claimed'.
  const { rows: doWyslania } = await pool.query(
    `update messages set current_state = 'claimed', claimed_at = now()
      where (tenant_id, id) in (
        select m.tenant_id, m.id from messages m
         where m.tenant_id = $1 and m.current_state = 'queued'
           -- B2: wiadomosci kampanii WSTRZYMANEJ albo ODWOLANEJ nie sa zajmowane.
           -- Warunek stoi tutaj, a nie tylko w petli workera, bo wyslijPartie oprozni
           -- kolejke CALEGO tenanta: bez tego wiadomosci wstrzymanej kampanii wychodzily
           -- dalej z joba sasiedniej kampanii albo z tiku automatyzacji, a operator
           -- widzialby w panelu "wstrzymana" i rosnacy licznik wyslanych.
           and not exists (
             select 1 from campaigns c
              where m.source_type = 'campaign'
                and c.tenant_id = m.tenant_id and c.id = m.source_id
                and c.status in ('paused', 'cancelled')
           )
           -- To samo dla automatyzacji (review flow 24.09, B#2): wstrzymana albo wyłączona
           -- automatyzacja nie może wypuszczać maili, które zdążyły trafić do kolejki
           -- (np. czekały na limit dobowy). Inaczej panel mówi „zatrzymane", a maile idą.
           and not exists (
             select 1 from journeys j
               join flows f on f.tenant_id = j.tenant_id and f.id = j.flow_id
              where m.source_type = 'journey'
                and j.tenant_id = m.tenant_id and j.id = m.source_id
                and f.status <> 'wlaczony'
           )
         order by m.created_at
         for update skip locked
         limit $2
      )
     returning id, profile_id, email, subject, body_html, unsubscribe_token,
               claimed_at::text as claim_token`,
    [tenantId, Math.min(limitPartii, wolneMiejsce)],
  );

  let wyslane = 0;
  let odmowy = 0;
  let bledy = 0;
  let powodZatrzymania: PowodZatrzymania = null;
  let powodOpis: string | null = null;

  try {
  for (let i = 0; i < doWyslania.length; i++) {
    const wiadomosc = doWyslania[i];
    if (czyZamykanie()) {
      // SIGTERM w środku partii: bieżąca wiadomość (poprzednia iteracja) jest już
      // rozliczona, a ta i dalsze są w `claimed` — dostawca NIE był dla nich wołany, więc
      // powrót do queued nie grozi duplikatem (AD-26). Warunek na token partii: nie
      // cofamy świeżych claimów innego workera, który przejął je po odzyskaniu zombie.
      await pool.query(
        `update messages set current_state = 'queued', claimed_at = null
          where tenant_id = $1 and id = any($2) and current_state = 'claimed'
            and claimed_at = $3::timestamptz`,
        [tenantId, doWyslania.slice(i).map((w) => w.id), wiadomosc.claim_token],
      );
      powodZatrzymania = "zamykanie";
      break;
    }
    const klient = await pool.connect();
    let wolnoWysylac = false;
    let limitOdmowil = false;
    let utracona = false;
    let dzienRezerwacji: string | null = null;
    try {
      await klient.query("begin");
      // Potwierdzenie własności pod blokadą wiersza: stan musi być 'claimed' I token
      // (claimed_at) musi być NASZ. Jeśli recovery zombie cofnął wiadomość do queued
      // i inny proces zajął ją na nowo, stan znów jest 'claimed', ale token inny —
      // wtedy NIE wolno ani wołać dostawcy, ani zapisywać suppressed.
      // porównanie tokenu jako WARTOŚCI w bazie (wzorzec z kolejki), nie tekst-do-tekstu
      // w JS: rendering timestamptz zależy od ustawień sesji, wartość nie
      const { rows: wlasnosc } = await klient.query(
        `select current_state, (claimed_at = $3::timestamptz) as nasz_claim
           from messages where tenant_id = $1 and id = $2 for update`,
        [tenantId, wiadomosc.id, wiadomosc.claim_token],
      );
      if (wlasnosc[0]?.current_state !== "claimed" || !wlasnosc[0]?.nasz_claim) {
        utracona = true;
      } else {
        // wiążące sprawdzenie w tej samej transakcji co przejście stanu (AD-25)
        const bramka = wiadomosc.profile_id
          ? await canSendTo(klient, tenantId, wiadomosc.profile_id)
          : { wolno: true as const };
        if (!bramka.wolno) {
          await zapiszZdarzenie(klient, tenantId, wiadomosc.id, "suppressed", {
            kiedy: "teraz",
            payload: { powod: (bramka as any).powod },
          });
          odmowy++;
        } else {
          // Rezerwacja limitu dobowego W TEJ SAMEJ transakcji co przejście w sending:
          // warunek `used + 1 <= limit` w bazie zamyka wyścig dwóch równoległych procesów.
          // Odmowa = brak zaktualizowanego wiersza; wtedy nic z tej transakcji nie wchodzi.
          const rezerwacja = await klient.query(
            `insert into tenant_send_usage (tenant_id, day, used) values ($1, current_date, 1)
             on conflict (tenant_id, day) do update set used = tenant_send_usage.used + 1
             where tenant_send_usage.used + 1 <= $2
             returning used, day::text as dzien`,
            [tenantId, limitDobowy],
          );
          if (!rezerwacja.rowCount) {
            limitOdmowil = true;
          } else {
            dzienRezerwacji = rezerwacja.rows[0].dzien;
            await zapiszZdarzenie(klient, tenantId, wiadomosc.id, "sending", { kiedy: "teraz" });
            // Zegar TEJ próby (triaż A, P2 #2): rekoncyliacja liczy kwadrans od claimed_at.
            // Wspólny znacznik partii starzał się przez całą partię — przy stu
            // wiadomościach i wolnym SMTP ostatnie przechodziły w sending z claimed_at
            // sprzed kwadransa i rekoncyliacja brała je za zawieszone W TRAKCIE wysyłki.
            // Odświeżamy tylko tę jedną wiadomość; reszta partii zachowuje token partii,
            // po którym działa zbiorczy requeue niżej.
            await klient.query(
              "update messages set claimed_at = now() where tenant_id = $1 and id = $2",
              [tenantId, wiadomosc.id],
            );
            wolnoWysylac = true;
          }
        }
      }
      if (limitOdmowil || utracona) await klient.query("rollback");
      else await klient.query("commit");
    } catch (blad) {
      await klient.query("rollback").catch(() => {});
      klient.release();
      throw blad;
    }
    klient.release();
    if (utracona) continue;

    if (limitOdmowil) {
      // Limit wyczerpany: ta wiadomość i cała reszta zajętej partii wracają do queued,
      // partia kończy się powodem limit_dobowy. Nic nie poszło do dostawcy.
      // Warunek na token własności: bez niego zbiorczy requeue starej partii mógłby
      // cofnąć świeże claimy innego workera, który przejął te wiadomości po recovery.
      const pozostale = doWyslania.slice(i).map((w) => w.id);
      await pool.query(
        `update messages set current_state = 'queued', claimed_at = null
          where tenant_id = $1 and id = any($2) and current_state = 'claimed'
            and claimed_at = $3::timestamptz`,
        [tenantId, pozostale, wiadomosc.claim_token],
      );
      powodZatrzymania = "limit_dobowy";
      break;
    }
    if (!wolnoWysylac) continue;

    let wynik;
    try {
      wynik = await dostawca.wyslij({
        do: wiadomosc.email,
        od: nadawca.od,
        odNazwa: nadawca.odNazwa,
        odpowiedzDo: nadawca.odpowiedzDo,
        temat: wiadomosc.subject,
        html: wiadomosc.body_html,
        adresWypisania: `${adresSledzenia()}/u/${wiadomosc.unsubscribe_token}`,
        idempotencyKey: wiadomosc.id,
      });
    } catch (blad) {
      // Błąd DOSTAWCY. Rezerwacji limitu nie zwalniamy w żadnym z przypadków —
      // lepiej wysłać mniej niż przekroczyć limit przy niejasnym wyniku.
      bledy++;
      const opisBledu = blad instanceof Error ? blad.message : String(blad);
      const klasa = klasaBledu(blad);
      if (klasa === "nieznany") {
        // Stan u dostawcy nieznany (np. zerwane połączenie po DATA): wiadomość
        // zostaje w sending, rozstrzygnie ją rekoncyliacja (held + alert), nie
        // ślepe ponowienie (AD-23, NFR15).
        console.error(`[wysylka] wiadomość ${wiadomosc.id}: wynik u dostawcy nieznany, zostaje w sending: ${opisBledu}`);
        continue;
      }
      if (klasa === "nadawca") {
        await zatrzymajPartiePoBledzieNadawcy({
          tenantId,
          biezaca: wiadomosc.id,
          pozostale: doWyslania.slice(i + 1).map((w) => w.id),
          tokenPartii: wiadomosc.claim_token,
          dzienRezerwacji,
          wersjaSerwera,
          opisBledu,
        });
        console.warn(`[wysylka] tenant ${tenantId}: błąd nadawcy, partia wraca do kolejki: ${opisBledu}`);
        powodZatrzymania = "blokada_nadawcy";
        powodOpis = opisBledu;
        break;
      }
      const k3 = await pool.connect();
      try {
        await k3.query("begin");
        // Guard stanu pod blokadą: jeśli w międzyczasie rekoncyliacja albo webhook
        // rozstrzygnęły los wiadomości (held/delivered/...), nie wolno jej ruszać.
        const { rows: stan } = await k3.query(
          "select current_state from messages where tenant_id = $1 and id = $2 for update",
          [tenantId, wiadomosc.id],
        );
        if (stan[0]?.current_state !== "sending") {
          await k3.query("rollback");
        } else if (klasa === "przejsciowy") {
          const { rows: proby } = await k3.query(
            "update messages set attempts = attempts + 1 where tenant_id = $1 and id = $2 returning attempts",
            [tenantId, wiadomosc.id],
          );
          if ((proby[0]?.attempts ?? MAX_PROB_WIADOMOSCI) >= MAX_PROB_WIADOMOSCI) {
            // Wyczerpane próby to awaria BEZ rozstrzygniętej klasy odbicia: serwer
            // odbiorcy nic nam nie odpowiedział, więc `failed`, nie `bounced`.
            await zapiszZdarzenie(k3, tenantId, wiadomosc.id, "failed", {
              kiedy: "teraz",
              payload: { blad: opisBledu, powod: "wyczerpane_proby" },
              klasyfikacja: {
                typZdarzenia: "failed",
                klasa: null,
                kategoria: null,
                kodSmtp: null,
                powodDostawcy: opisBledu.slice(0, 2000),
                wykluczAdres: false,
                liczySieDoWskaznika: false,
              },
            });
          } else {
            // Kontrolowane cofnięcie projekcji (rank w dół): zdarzenie 'sending' z tej
            // próby zostaje w historii, a wiadomość wraca do gry przy następnej partii.
            await k3.query(
              `update messages set current_state = 'queued', current_rank = 0, claimed_at = null
                where tenant_id = $1 and id = $2`,
              [tenantId, wiadomosc.id],
            );
          }
          await k3.query("commit");
        } else {
          const klasyfikacja = klasyfikujOdmowe(blad);
          await zapiszZdarzenie(k3, tenantId, wiadomosc.id, "dropped", {
            kiedy: "teraz",
            payload: { blad: opisBledu },
            klasyfikacja,
            // adres odrzucony przez NASZĄ walidację składni (review A2 #9): wykluczenie
            // w sklepie tak, globalne nie — nie ma na to dowodu od serwera odbiorcy
            wykluczenieGlobalne: (blad as { code?: unknown })?.code !== "EADRES_ODBIORCY",
          });
          await k3.query("commit");
        }
      } catch (bladZapisu) {
        await k3.query("rollback").catch(() => {});
        throw bladZapisu;
      } finally {
        k3.release();
      }
      continue;
    }

    const k2 = await pool.connect();
    try {
      await k2.query("begin");
      // Pola diagnostyczne (A3) zapisujemy RAZEM z identyfikatorem u dostawcy, w tej samej
      // transakcji co zdarzenie `sent`. Dołożenie ich osobnym UPDATE-em znaczyłoby, że przy
      // awarii między jednym a drugim mamy wiadomość bez śladu, którędy poszła.
      await k2.query(
        `update messages
            set provider_id = $3, provider = $4, ip_pool = $5, sending_ip = $6::inet,
                handed_off_at = $7, provider_message_id = $8
          where tenant_id = $1 and id = $2`,
        [
          tenantId,
          wiadomosc.id,
          wynik.providerId,
          dostawca.nazwa,
          wynik.ipPool ?? null,
          wynik.sendingIp ?? null,
          // gdy dostawca nie podaje momentu przekazania, źródłem jest chwila, w której
          // przyjął wiadomość — wciąż data zdarzenia, a nie domyślne `now()` bazy
          wynik.handedOffAt ?? new Date(),
          // ID nadany przez dostawcę (SES nadpisuje Message-ID): klucz dopasowania odbić
          wynik.providerMessageId ?? null,
        ],
      );
      await zapiszZdarzenie(k2, tenantId, wiadomosc.id, "sent", {
        kiedy: "teraz",
        payload: { provider: dostawca.nazwa, ipPool: wynik.ipPool ?? null, sendingIp: wynik.sendingIp ?? null },
      });
      await k2.query("commit");
      wyslane++;
    } catch (blad) {
      // Dostawca PRZYJĄŁ, a zapis 'sent' padł: wiadomość zostaje w sending i NIE wraca
      // do queued (ponowienie = podwójna wysyłka). Rekoncyliacja oznaczy ją jako held
      // i zaalarmuje człowieka (AD-23, NFR15).
      await k2.query("rollback").catch(() => {});
      bledy++;
      console.error(
        `[wysylka] wiadomość ${wiadomosc.id}: dostawca przyjął, zapis sent nie przeszedł:`,
        blad,
      );
    } finally {
      k2.release();
    }
  }
  } finally {
    // Pula połączeń SMTP żyje dokładnie jedną partię (patrz AdapterNodemailer.zamknij):
    // zamykana także po wyjątku, żeby nie zostawić wiszącego połączenia do serwera klienta.
    await dostawca.zamknij?.();
  }

  return { wyslane, odmowy, bledy, powodZatrzymania, powodOpis };
}

/**
 * Błąd nadawcy w środku partii (triaż A, P1; review A2). Wszystko w JEDNEJ transakcji,
 * żeby partia nie została w połowie cofnięta:
 *   1. bieżąca wiadomość wraca z `sending` do `queued` BEZ `attempts++` — nie wyszła,
 *      a próby liczą się odbiorcy, nie awarii konfiguracji. Osłona stanu pod blokadą:
 *      jeśli rekoncyliacja albo webhook zdążyły ją rozstrzygnąć, nie ruszamy jej;
 *   2. TYLKO gdy to cofnięcie faktycznie zaszło: zwrot jej miejsca w limicie dobowym
 *      (`used - 1` dla dnia rezerwacji). Mail na pewno nie wyszedł, a bez zwrotu każdy
 *      tik przy np. MAIL FROM 421 zjadał miejsce — limit 500 znikał po kilku godzinach
 *      awarii i po naprawie sklep stał do północy;
 *   3. reszta zajętej partii wraca do `queued` po TOKENIE partii (claimed_at), więc nie
 *      cofniemy świeżych claimów innego workera, który przejął je po odzyskaniu zombie;
 *   4. unieważniamy pamięć podręczną testu połączenia (`last_tested_at = null`) — z
 *      warunkiem na wersję konfiguracji, z którą ruszyła partia — żeby następna partia
 *      zaczęła od `verify()` i przy dalej złym haśle stanęła PRZED zajęciem czegokolwiek;
 *   5. dławik alertu (tenants.sender_block_alert_at): alert krytyczny raz na godzinę
 *      albo od razu po zmianie konfiguracji SMTP. Wysyłany PO commicie — to efekt uboczny,
 *      a nie część transakcji. Bez alertu kolejka sklepu stawała po cichu.
 */
async function zatrzymajPartiePoBledzieNadawcy(a: {
  tenantId: string;
  biezaca: string;
  pozostale: string[];
  tokenPartii: string;
  dzienRezerwacji: string | null;
  wersjaSerwera: string | null;
  opisBledu: string;
}) {
  const { tenantId, biezaca, pozostale, tokenPartii, dzienRezerwacji, wersjaSerwera, opisBledu } = a;
  const klient = await getPool().connect();
  let alertowac = false;
  try {
    await klient.query("begin");
    const { rows: stan } = await klient.query(
      "select current_state from messages where tenant_id = $1 and id = $2 for update",
      [tenantId, biezaca],
    );
    if (stan[0]?.current_state === "sending") {
      // kontrolowane cofnięcie projekcji jak przy błędzie przejściowym, tylko bez próby
      const cofniecie = await klient.query(
        `update messages set current_state = 'queued', current_rank = 0, claimed_at = null
          where tenant_id = $1 and id = $2 and current_state = 'sending'`,
        [tenantId, biezaca],
      );
      if (cofniecie.rowCount && dzienRezerwacji) {
        await klient.query(
          `update tenant_send_usage set used = used - 1
            where tenant_id = $1 and day = $2::date and used > 0`,
          [tenantId, dzienRezerwacji],
        );
      }
    }
    if (pozostale.length) {
      await klient.query(
        `update messages set current_state = 'queued', claimed_at = null
          where tenant_id = $1 and id = any($2) and current_state = 'claimed'
            and claimed_at = $3::timestamptz`,
        [tenantId, pozostale, tokenPartii],
      );
    }
    if (wersjaSerwera) {
      await klient.query(
        `update tenant_smtp_configs set last_tested_at = null, last_test_error = $2
          where tenant_id = $1 and updated_at = $3::timestamptz`,
        [tenantId, opisBledu.slice(0, 1000), wersjaSerwera],
      );
    }
    const dlawik = await klient.query(
      `update tenants t set sender_block_alert_at = now()
        where t.id = $1
          and (t.sender_block_alert_at is null
               or t.sender_block_alert_at < now() - interval '1 hour'
               or t.sender_block_alert_at < (select c.updated_at from tenant_smtp_configs c where c.tenant_id = t.id))`,
      [tenantId],
    );
    alertowac = Boolean(dlawik.rowCount);
    await klient.query("commit");
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
  if (alertowac) {
    await wyslijAlert(
      `wysyłka sklepu STOI: serwer nadawcy odmawia (${opisBledu.slice(0, 400)}). Wiadomości czekają w kolejce ` +
        `bez zużycia prób i ruszą same po naprawie. Sprawdź Ustawienia → Wysyłka i domeny → „Testuj połączenie”.`,
      { poziom: "krytyczny", tenantId },
    );
  }
}
