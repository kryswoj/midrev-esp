import { getPool } from "../../adapters/db/pool";
import { ocenAutomat, type PowodAutomatu } from "../../domain/email/klasyfikacja";
import { wyslijAlert } from "../../jobs/alerty";

/**
 * Zapis zdarzeń POWTARZALNYCH: otwarć, kliknięć i opóźnień dostarczenia (Blok A, A4).
 *
 * Dlaczego osobno od `message_events`: tamta tabela ma unique (message_id, event_type)
 * i jest to decyzja AD-22, której nie ruszamy — dzięki niej wyścig workera z webhookiem
 * nie może po cichu nadpisać stanu. Ale otwarcia i kliknięcia z definicji przychodzą
 * wiele razy dla jednej wiadomości. Wrzucone tam kończyłyby się `do nothing`, czyli
 * cichym zgubieniem wszystkiego poza pierwszym zdarzeniem.
 *
 * To jest JEDYNE miejsce, które zapisuje zaangażowanie: i własny pixel z redirectem,
 * i (po Bloku D) handler zdarzeń SES wchodzą tędy. Dzięki temu decyzja o tym, czy
 * zdarzenie jest maszynowe, i bramka na zgodę są w jednym miejscu, a nie w dwóch,
 * które się rozjadą.
 */

export type RodzajZaangazowania = "open" | "click" | "delivery_delay";

export interface ZdarzenieZaangazowania {
  rodzaj: RodzajZaangazowania;
  /**
   * Data zdarzenia ZE ŹRÓDŁA, obowiązkowa (AD-10). Otwarcie sprzed godziny, o którym
   * dowiadujemy się teraz, ma mieć datę otwarcia, nie datę zapisu. Kolumna w bazie nie
   * ma domyślnej wartości właśnie po to, żeby tego nie dało się pominąć.
   */
  kiedy: Date;
  /** `wlasne` = nasz pixel i redirect, `dostawca` = event publishing dostawcy. */
  zrodlo: "wlasne" | "dostawca";
  url?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** rodzaj opóźnienia z DeliveryDelay (SpamDetected, IPFailure, MailboxFull, ...) */
  delayType?: string | null;
  /** identyfikator zdarzenia u dostawcy — podstawa idempotencji przy dostarczeniu at-least-once */
  providerEventId?: string | null;
  /** `isBotEvent` dostawcy zrzutowane na bool; `undefined` = dostawca nic nie powiedział */
  flagaDostawcy?: boolean;
}

export type PowodOdrzucenia =
  | "brak_wiadomosci"
  | "sledzenie_otwarc_niedozwolone"
  | "sledzenie_klikniec_niedozwolone"
  | "brak_daty_zdarzenia";

export interface WynikZapisu {
  zapisane: boolean;
  /** true, gdy to samo zdarzenie dostawcy przyszło drugi raz i zostało odrzucone przez idempotencję */
  duplikat: boolean;
  automat: boolean | null;
  powodAutomatu: PowodAutomatu | null;
  powodOdrzucenia?: PowodOdrzucenia;
}

/**
 * Opóźnienia, które mówią o NASZEJ reputacji, a nie o skrzynce odbiorcy. Cisza w tym
 * miejscu oznacza, że o problemie z pulą IP dowiadujemy się z wstrzymanego konta.
 */
const OPOZNIENIA_REPUTACYJNE = new Set(["SpamDetected", "IPFailure"]);

export async function zapiszZaangazowanie(
  tenantId: string,
  messageId: string,
  zdarzenie: ZdarzenieZaangazowania,
): Promise<WynikZapisu> {
  const pusty = { zapisane: false, duplikat: false, automat: null, powodAutomatu: null } as const;

  if (!(zdarzenie.kiedy instanceof Date) || Number.isNaN(zdarzenie.kiedy.getTime())) {
    return { ...pusty, powodOdrzucenia: "brak_daty_zdarzenia" };
  }

  const pool = getPool();
  // Źródło wiadomości przepisujemy z `messages`, a nie przyjmujemy od wołającego:
  // handler webhooka zna tylko identyfikator dostawcy i nie ma prawa zgadywać kampanii.
  // Zapytanie jest zawężone tenantem, więc identyfikator wiadomości z cudzego tenanta
  // nie znajdzie niczego (izolacja, a nie tylko filtr).
  const { rows } = await pool.query(
    `select source_type, source_id, profile_id, open_tracking_allowed, click_tracking_allowed
       from messages where tenant_id = $1 and id = $2`,
    [tenantId, messageId],
  );
  const wiadomosc = rows[0];
  if (!wiadomosc) return { ...pusty, powodOdrzucenia: "brak_wiadomosci" };

  // Bramka na zgodę czytana z MIGAWKI na wiadomości, nie z rejestru zgód (AD-32).
  // Mail, który wyszedł bez pixela, ma zostać bez pixela: zgoda dopisana jutro nie
  // może wstecznie zalegalizować śledzenia maila sprzed tygodnia, a wycofana jutro
  // nie może unieważnić kliknięcia, które legalnie zarejestrowaliśmy wczoraj.
  if (zdarzenie.rodzaj === "open" && !wiadomosc.open_tracking_allowed) {
    return { ...pusty, powodOdrzucenia: "sledzenie_otwarc_niedozwolone" };
  }
  if (zdarzenie.rodzaj === "click" && !wiadomosc.click_tracking_allowed) {
    return { ...pusty, powodOdrzucenia: "sledzenie_klikniec_niedozwolone" };
  }

  const werdykt = ocenAutomat({
    kind: zdarzenie.rodzaj,
    userAgent: zdarzenie.userAgent,
    ip: zdarzenie.ip,
    flagaDostawcy: zdarzenie.flagaDostawcy,
  });

  const klient = await pool.connect();
  try {
    await klient.query("begin");
    const zapis = await klient.query(
      `insert into message_engagement
         (tenant_id, message_id, source_type, source_id, kind, source,
          automat, automat_powod, url, ip, user_agent, delay_type, provider_event_id, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::inet, $11, $12, $13, $14)
       on conflict (tenant_id, source, provider_event_id) where provider_event_id is not null
         do nothing
       returning id, occurred_at, automat, automat_powod`,
      [
        tenantId,
        messageId,
        wiadomosc.source_type,
        wiadomosc.source_id,
        zdarzenie.rodzaj,
        zdarzenie.zrodlo,
        werdykt.automat,
        werdykt.powod,
        zdarzenie.rodzaj === "click" ? (zdarzenie.url ?? null) : null,
        zdarzenie.ip ?? null,
        zdarzenie.userAgent ? zdarzenie.userAgent.slice(0, 300) : null,
        zdarzenie.rodzaj === "delivery_delay" ? (zdarzenie.delayType ?? null) : null,
        zdarzenie.providerEventId ?? null,
        zdarzenie.kiedy,
      ],
    );

    if (!zapis.rowCount) {
      await klient.query("commit");
      return { zapisane: false, duplikat: true, automat: werdykt.automat, powodAutomatu: werdykt.powod };
    }

    // Weryfikacja czyta ZAPISANY REKORD, nie dane wejściowe. Sens tego sprawdzenia:
    // gdyby kolumnie `occurred_at` ktoś kiedyś przywrócił `default now()`, albo gdyby
    // sterownik zgubił strefę, import historii zapisałby daty importu i nikt by tego
    // nie zauważył — bo dane wejściowe byłyby poprawne.
    const zapisany = zapis.rows[0];
    const roznica = Math.abs(new Date(zapisany.occurred_at).getTime() - zdarzenie.kiedy.getTime());
    if (roznica > 1000) {
      await klient.query("rollback");
      await wyslijAlert(
        `zaangazowanie: wiadomość ${messageId} (tenant ${tenantId}) — data zapisana w bazie ` +
          `(${new Date(zapisany.occurred_at).toISOString()}) rozjeżdża się z datą ze źródła ` +
          `(${zdarzenie.kiedy.toISOString()}) o ${roznica} ms. Zapis wycofany.`,
      );
      return { ...pusty, automat: werdykt.automat, powodAutomatu: werdykt.powod };
    }

    // Klik człowieka idzie DODATKOWO do `clicks`, bo to na tej tabeli stoi atrybucja
    // przychodu (0007). Klik bota nie idzie tam nigdy: doliczenie skanera bezpieczeństwa
    // do atrybucji przypisałoby kampanii przychód, którego nie wygenerowała.
    if (zdarzenie.rodzaj === "click" && werdykt.automat !== true && zdarzenie.url) {
      await klient.query(
        `insert into clicks (tenant_id, message_id, profile_id, url, occurred_at, user_agent)
         values ($1, $2, $3, $4, $5, left($6, 300))`,
        [
          tenantId,
          messageId,
          wiadomosc.profile_id,
          zdarzenie.url,
          zdarzenie.kiedy,
          zdarzenie.userAgent ?? "",
        ],
      );
    }

    await klient.query("commit");
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }

  if (zdarzenie.rodzaj === "delivery_delay" && OPOZNIENIA_REPUTACYJNE.has(zdarzenie.delayType ?? "")) {
    // Alert POZA transakcją: nieudany webhook alertu nie może wywrócić zapisu zdarzenia.
    await wyslijAlert(
      `opóźnienie dostarczenia typu ${zdarzenie.delayType} (tenant ${tenantId}, wiadomość ${messageId}) — ` +
        `to sygnał o reputacji nadawcy, nie o skrzynce odbiorcy`,
    );
  }

  return { zapisane: true, duplikat: false, automat: werdykt.automat, powodAutomatu: werdykt.powod };
}

export interface MetrykiZaangazowania {
  otwarcia: number;
  otwarciaLudzkie: number;
  otwarciaUnikalne: number;
  klikniecia: number;
  kliknieciaLudzkie: number;
  kliknieciaUnikalne: number;
  opoznienia: number;
}

/**
 * Metryki zaangażowania jednej kampanii albo automatyzacji. Czyta wyłącznie indeks
 * (tenant_id, source_type, source_id, kind, occurred_at) z 0014, więc nie skanuje
 * zaangażowania pozostałych kampanii tenanta.
 *
 * Rozdział na "wszystkie" i "ludzkie" jest po to, żeby dało się pokazać obie liczby
 * naraz. `automat is not true` zamiast `automat = false` celowo: NULL znaczy "nie wiemy"
 * i takie zdarzenie ma wejść do liczby ludzkiej razem z zastrzeżeniem, a nie zniknąć.
 */
export async function metrykiZaangazowania(
  tenantId: string,
  sourceType: "campaign" | "journey" | "test",
  sourceId: string,
): Promise<MetrykiZaangazowania> {
  const { rows } = await getPool().query(
    `select
       count(*) filter (where kind = 'open')::int as otwarcia,
       count(*) filter (where kind = 'open' and automat is not true)::int as otwarcia_ludzkie,
       count(distinct message_id) filter (where kind = 'open' and automat is not true)::int as otwarcia_unikalne,
       count(*) filter (where kind = 'click')::int as klikniecia,
       count(*) filter (where kind = 'click' and automat is not true)::int as klikniecia_ludzkie,
       count(distinct message_id) filter (where kind = 'click' and automat is not true)::int as klikniecia_unikalne,
       count(*) filter (where kind = 'delivery_delay')::int as opoznienia
     from message_engagement
     where tenant_id = $1 and source_type = $2 and source_id = $3`,
    [tenantId, sourceType, sourceId],
  );
  const w = rows[0];
  return {
    otwarcia: w.otwarcia,
    otwarciaLudzkie: w.otwarcia_ludzkie,
    otwarciaUnikalne: w.otwarcia_unikalne,
    klikniecia: w.klikniecia,
    kliknieciaLudzkie: w.klikniecia_ludzkie,
    kliknieciaUnikalne: w.klikniecia_unikalne,
    opoznienia: w.opoznienia,
  };
}

export interface WskaznikiReputacji {
  wyslane: number;
  dostarczone: number;
  odbiciaTwarde: number;
  odbiciaMiekkie: number;
  odrzuconePrzedWysylka: number;
  skargi: number;
  /**
   * Na czym stoi mianownik (audyt 24.09, #3):
   *   `delivered` — dostawca potwierdza dostarczenia (SES, webhooki): odbicia liczone
   *     do (dostarczone + twarde), skargi do dostarczonych, wg SES-BYOD-SPEC sekcja 5.
   *   `sent` — własny serwer SMTP klienta: NIKT nie raportuje „delivered", więc mianownik
   *     z dostarczonych byłby zerem na zawsze i progi B5 nigdy by się nie zapaliły.
   *     Wtedy podstawą jest liczba wiadomości PRZEKAZANYCH serwerowi (`sent`), która
   *     zawiera te odbite — to ta sama definicja co „bounce rate = odbicia / wysłane"
   *     u Postmarka i Mailguna.
   * Wybór jest automatyczny: `delivered` dopiero, gdy potwierdzeń jest co najmniej połowa
   * przekazanych (triaż A, P2 #4). Dotąd wystarczało jedno: przy własnym SMTP garść DSN
   * o sukcesie (NOTIFY=SUCCESS, część serwerów odsyła je sama) przerzucała mianownik
   * z tysięcy przekazanych na kilka dostarczonych i wskaźnik odbić skakał o rzędy
   * wielkości — fałszywe wstrzymanie sklepu.
   */
  podstawa: "delivered" | "sent";
  mianownikOdbic: number;
  mianownikSkarg: number;
  /** odbicia twarde / mianownikOdbic */
  wskaznikOdbicTwardych: number;
  /** skargi / mianownikSkarg */
  wskaznikSkarg: number;
}

/**
 * Wskaźniki reputacji per tenant na oknie kroczącym. Trzy różne liczby zamiast jednego
 * `bounce_rate`: `dropped` mówi o higienie listy i konfiguracji, twarde odbicia o jakości
 * adresów, miękkie o chwilowych problemach skrzynek. Zlepienie ich w jeden wskaźnik
 * zabija diagnostykę — i dokładnie to jest powodem istnienia A2.
 *
 * Do licznika wchodzą wyłącznie zdarzenia z `counts_to_rate = true`, czyli decyzja
 * podjęta i zapisana w chwili klasyfikacji, a nie odtwarzana zapytaniem po fakcie.
 */
export async function wskaznikiReputacji(
  tenantId: string,
  oknoGodzin = 24,
): Promise<WskaznikiReputacji> {
  const { rows } = await getPool().query(
    `select
       count(*) filter (where event_type = 'sent')::int as wyslane,
       count(*) filter (where event_type = 'delivered')::int as dostarczone,
       count(*) filter (where event_type = 'bounced' and bounce_class = 'hard' and counts_to_rate)::int as twarde,
       count(*) filter (where event_type = 'bounced' and bounce_class = 'soft')::int as miekkie,
       count(*) filter (where event_type = 'dropped')::int as odrzucone,
       count(*) filter (where event_type = 'complained' and counts_to_rate)::int as skargi
     from message_events
     where tenant_id = $1 and occurred_at >= now() - make_interval(hours => $2::int)`,
    [tenantId, oknoGodzin],
  );
  const w = rows[0];
  const podstawa: WskaznikiReputacji["podstawa"] =
    w.dostarczone > 0 && w.dostarczone * 2 >= w.wyslane ? "delivered" : "sent";
  // Przy podstawie `delivered` mianownik nie może spaść PONIŻEJ przekazanych (review A2
  // #7): przy połowie potwierdzeń (dostarczone + twarde) bywa o połowę mniejsze niż
  // wysłane, co podwaja wskaźnik i wstrzymuje sklep bez powodu.
  const mianownikOdbic = podstawa === "delivered" ? Math.max(w.wyslane, w.dostarczone + w.twarde) : w.wyslane;
  const mianownikSkarg = podstawa === "delivered" ? w.dostarczone : w.wyslane;
  return {
    wyslane: w.wyslane,
    dostarczone: w.dostarczone,
    odbiciaTwarde: w.twarde,
    odbiciaMiekkie: w.miekkie,
    odrzuconePrzedWysylka: w.odrzucone,
    skargi: w.skargi,
    podstawa,
    mianownikOdbic,
    mianownikSkarg,
    wskaznikOdbicTwardych: mianownikOdbic === 0 ? 0 : w.twarde / mianownikOdbic,
    wskaznikSkarg: mianownikSkarg === 0 ? 0 : w.skargi / mianownikSkarg,
  };
}
