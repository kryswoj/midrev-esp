import { getPool } from "../adapters/db/pool";

/**
 * Atrybucja przychodu (AD-14, AD-28, FR57).
 *
 * Model: last-touch click-based. Zamówienie dostaje przychód przypisany do OSTATNIEGO
 * kliknięcia tego profilu w oknie reguły przed datą zamówienia. Otwarcia nie istnieją
 * w tym modelu w ogóle: połowa otwarć to Apple MPP i nie znaczą nic.
 *
 * Źródło przychodu (0018): kampania ALBO automatyzacja. Ostatni klik wybierany jest
 * spośród kliknięć w wiadomości obu rodzajów naraz, więc jedno zamówienie ma w przebiegu
 * dokładnie jedno źródło — to, w które profil kliknął jako ostatni. Liczenie kampanii
 * i automatyzacji osobnymi zapytaniami dałoby to samo zamówienie obu stronom i suma
 * rozbicia przekroczyłaby przychód przypisany. Wiadomości testowe (`source_type = 'test'`)
 * nie zarabiają: klik w podgląd wysłany do siebie nie jest klikiem klienta.
 *
 * Przeliczenie tworzy NOWY przebieg (attribution_run) zamiast kasować poprzednie liczby.
 * Liczba pokazana wczoraj klientowi musi być do odtworzenia co do grosza, nawet jeśli
 * dziś zmieniło się okno.
 *
 * Co się zmieniło po podpięciu redirectu pod `zapiszZaangazowanie` (Blok A, A1): tabela
 * `clicks` przestała być zapisem WSZYSTKICH wejść w link, a stała się zapisem wejść
 * uznanych za LUDZKIE. Klik skanera bezpieczeństwa bramki pocztowej — a taki skaner
 * klika każdy link w mailu, zanim zobaczy go człowiek — zostaje w `message_engagement`
 * z werdyktem `automat = true` i do `clicks` nie trafia w ogóle. To jest jedyny sposób,
 * żeby ostatnie kliknięcie przed zamówieniem było kliknięciem KUPUJĄCEGO, a nie
 * kliknięciem maszyny, które przypadkiem wypadło później.
 *
 * Konsekwencja dla danych sprzed tej zmiany: kliknięcia zapisane wcześniejszą wersją
 * `/r` nie mają żadnego werdyktu i siedzą w `clicks` razem z ruchem maszynowym.
 * Przeliczenie atrybucji ich nie odróżni i nie ma jak odróżnić po fakcie — user agentów
 * tamta wersja nie klasyfikowała. Przy pierwszym prawdziwym wdrożeniu to jest argument
 * za wyjściem od pustej tabeli, a nie za migracją historii.
 */
/** Źródła, które mogą zarabiać. `test` świadomie poza listą (patrz nagłówek). */
const ZRODLA_PRZYCHODU = ["campaign", "journey"] as const;
export type ZrodloPrzychodu = (typeof ZRODLA_PRZYCHODU)[number];

export interface SumaZrodla {
  zamowien: number;
  przychodMinor: number;
}

export interface WynikPrzeliczenia {
  runId: string;
  /** Liczba wierszy ODCZYTANYCH z bazy po zapisie dla tego przebiegu, nie liczba prób. */
  przypisanych: number;
  oknoGodzin: number;
  kampanie: SumaZrodla;
  automatyzacje: SumaZrodla;
}

export async function przeliczAtrybucje(tenantId: string): Promise<WynikPrzeliczenia> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    // Jeden przebieg na tenanta naraz (blokada zwalnia się z końcem transakcji). Bez niej
    // dwa równoległe PIERWSZE przebiegi oba nie znalazłyby reguły i oba wstawiłyby domyślną.
    await client.query("select pg_advisory_xact_lock(hashtextextended('atrybucja:' || $1::text, 0))", [tenantId]);

    // reguła: ostatnia obowiązująca; gdy żadnej nie ma, tworzymy domyślną 120h (5 dni).
    // Czas porównania to clock_timestamp() PO zdobyciu blokady, nie now() (start transakcji):
    // inaczej przebieg czekający na blokadę nie widziałby reguły wstawionej przez poprzedni
    // i wstawiłby drugą domyślną.
    // Jeden odczyt zegara na cały wybór: ten sam moment jest granicą wyszukania reguły
    // i datą wejścia w życie reguły domyślnej, więc domyślna nie przykryje reguły
    // zaplanowanej na chwilę między dwoma odczytami zegara.
    const { rows: zegar } = await client.query("select clock_timestamp() as teraz");
    const teraz: Date = zegar[0].teraz;
    let { rows: reguly } = await client.query(
      `select id, window_hours from attribution_rules
        where tenant_id = $1 and effective_from <= $2
        order by effective_from desc, id desc limit 1`,
      [tenantId, teraz],
    );
    if (!reguly.length) {
      ({ rows: reguly } = await client.query(
        `insert into attribution_rules (tenant_id, effective_from)
         values ($1, $2) returning id, window_hours`,
        [tenantId, teraz],
      ));
    }
    const regula = reguly[0];

    const { rows: przebiegi } = await client.query(
      // clock_timestamp(), nie now(): now() to start TRANSAKCJI, a przebieg, który czekał
      // na blokadę, dostałby czas sprzed zakończenia poprzedniego przebiegu.
      `insert into attribution_runs (tenant_id, rule_id, note, started_at)
       values ($1, $2, 'przeliczenie pełne', clock_timestamp()) returning id`,
      [tenantId, regula.id],
    );
    const runId: string = przebiegi[0].id;

    // Jedno zapytanie: dla każdego opłaconego zamówienia ostatni LUDZKI klik profilu w oknie
    // [zamówienie - okno, zamówienie], po wiadomościach z kampanii i z automatyzacji razem.
    // Kliki botów nie istnieją w `clicks` (zostają w `message_engagement`), więc nie mogą
    // wygrać. Remis czasu rozstrzyga id kliknięcia (uuidv7), żeby dwa przebiegi na tych
    // samych danych wybrały ten sam klik. Daty to wyłącznie daty ze źródła: `occurred_at`
    // zamówienia ze sklepu i `occurred_at` kliknięcia z redirectu.
    const { rows: wstawione } = await client.query(
      `insert into attributions (tenant_id, run_id, order_id, message_id, click_id, amount_minor,
                                 source_type, source_id, campaign_id, journey_id)
       select o.tenant_id, $2, o.id, k.message_id, k.id, o.total_minor,
              k.source_type, k.source_id,
              case when k.source_type = 'campaign' then k.source_id end,
              case when k.source_type = 'journey' then k.source_id end
         from orders o
         join lateral (
           select c.id, c.message_id, m.source_type, m.source_id
             from clicks c
             join messages m on m.tenant_id = c.tenant_id and m.id = c.message_id
            where c.tenant_id = o.tenant_id
              and c.profile_id = o.profile_id
              and m.source_type = any($4::text[])
              and c.occurred_at <= o.occurred_at
              and c.occurred_at >= o.occurred_at - make_interval(hours => $3::int)
            order by c.occurred_at desc, c.id desc
            limit 1
         ) k on true
        where o.tenant_id = $1
          and o.profile_id is not null
          and o.status in ('completed', 'processing')
       returning id`,
      [tenantId, runId, regula.window_hours, ZRODLA_PRZYCHODU],
    );

    // Weryfikacja czyta ZAPISANE wiersze tego przebiegu (run_id), nie wynik zapytania wyżej.
    const { rows: zapisane } = await client.query(
      `select source_type, count(*)::int as zamowien,
              coalesce(sum(amount_minor), 0)::text as przychod_minor
         from attributions
        where tenant_id = $1 and run_id = $2
        group by source_type`,
      [tenantId, runId],
    );
    const suma = (typ: ZrodloPrzychodu): SumaZrodla => {
      const w = zapisane.find((r: { source_type: string }) => r.source_type === typ);
      return { zamowien: w ? w.zamowien : 0, przychodMinor: w ? Number(w.przychod_minor) : 0 };
    };
    const kampanie = suma("campaign");
    const automatyzacje = suma("journey");
    const przypisanych = zapisane.reduce((n: number, r: { zamowien: number }) => n + r.zamowien, 0);
    if (przypisanych !== wstawione.length) {
      throw new Error(
        `atrybucja: przebieg ${runId} zapisał ${przypisanych} wierszy, a zapytanie zwróciło ${wstawione.length}`,
      );
    }

    // Raporty biorą "najnowszy zakończony" po finished_at, więc to musi być realny moment
    // zakończenia (clock_timestamp), a nie start transakcji (now()) — patrz wyżej.
    await client.query(
      "update attribution_runs set finished_at = clock_timestamp() where tenant_id = $1 and id = $2",
      [tenantId, runId],
    );
    await client.query("commit");
    return { runId, przypisanych, oknoGodzin: regula.window_hours, kampanie, automatyzacje };
  } catch (blad) {
    await client.query("rollback");
    throw blad;
  } finally {
    client.release();
  }
}

/** Raport przychodu per kampania z NAJNOWSZEGO zakończonego przebiegu (FR59). */
export async function raportKampanii(tenantId: string, campaignId: string) {
  const pool = getPool();
  const { rows } = await pool.query(
    `with ostatni_przebieg as (
       select id from attribution_runs
        where tenant_id = $1 and finished_at is not null
        order by finished_at desc, id desc limit 1
     )
     select
       -- wyslane liczone ze ZDARZENIA sent, nie ze stanu koncowego: mail, ktory potem
       -- odbil albo dostal skarge, NADAL zostal wyslany i raport ma to pokazywac
       (select count(*)::int from message_events e
         join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
        where e.tenant_id = $1 and e.event_type = 'sent'
          and m.source_type = 'campaign' and m.source_id = $2) as wyslane,
       (select count(*)::int from messages m
         where m.tenant_id = $1 and m.source_type = 'campaign' and m.source_id = $2
           and m.current_state in ('suppressed', 'held')) as zatrzymane,
       (select count(distinct c.message_id)::int from clicks c
         join messages m on m.tenant_id = c.tenant_id and m.id = c.message_id
        where c.tenant_id = $1 and m.source_type = 'campaign' and m.source_id = $2) as klikniecia,
       (select coalesce(sum(a.amount_minor), 0)::text from attributions a
        where a.tenant_id = $1 and a.campaign_id = $2 and a.run_id = (select id from ostatni_przebieg)) as przychod_minor,
       (select count(*)::int from attributions a
        where a.tenant_id = $1 and a.campaign_id = $2 and a.run_id = (select id from ostatni_przebieg)) as zamowien`,
    [tenantId, campaignId],
  );
  return rows[0];
}

/**
 * Raport jednej automatyzacji z NAJNOWSZEGO zakończonego przebiegu. Ten sam zestaw liczb
 * co `raportKampanii` plus `przebieg_at`: `null` znaczy „atrybucji nie liczono", i wtedy
 * `przychod_minor = '0'` nie jest wynikiem, tylko brakiem wyniku.
 */
export async function raportAutomatyzacji(tenantId: string, journeyId: string) {
  const { rows } = await getPool().query(
    `with ostatni_przebieg as (
       select id, finished_at from attribution_runs
        where tenant_id = $1 and finished_at is not null
        order by finished_at desc, id desc limit 1
     )
     select
       (select count(*)::int from message_events e
         join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
        where e.tenant_id = $1 and e.event_type = 'sent'
          and m.source_type = 'journey' and m.source_id = $2) as wyslane,
       (select count(*)::int from messages m
         where m.tenant_id = $1 and m.source_type = 'journey' and m.source_id = $2
           and m.current_state in ('suppressed', 'held')) as zatrzymane,
       (select count(distinct c.message_id)::int from clicks c
         join messages m on m.tenant_id = c.tenant_id and m.id = c.message_id
        where c.tenant_id = $1 and m.source_type = 'journey' and m.source_id = $2) as klikniecia,
       (select coalesce(sum(a.amount_minor), 0)::text from attributions a
        where a.tenant_id = $1 and a.journey_id = $2 and a.run_id = (select id from ostatni_przebieg)) as przychod_minor,
       (select count(*)::int from attributions a
        where a.tenant_id = $1 and a.journey_id = $2 and a.run_id = (select id from ostatni_przebieg)) as zamowien,
       (select finished_at from ostatni_przebieg) as przebieg_at`,
    [tenantId, journeyId],
  );
  return rows[0] as {
    wyslane: number;
    zatrzymane: number;
    klikniecia: number;
    przychod_minor: string;
    zamowien: number;
    przebieg_at: Date | null;
  };
}

export interface PrzychodAutomatyzacji {
  /** Moment zakończenia przebiegu, z którego są liczby. `null` = atrybucji nie liczono. */
  przebiegAt: Date | null;
  /**
   * Przychód per automatyzacja. Automatyzacji bez przypisanych zamówień NIE MA w mapie:
   * przy `przebiegAt !== null` brak wpisu znaczy 0, przy `null` znaczy „nie wiadomo".
   */
  perAutomatyzacja: Record<string, SumaZrodla>;
}

/** Przychód wszystkich automatyzacji tenanta jednym zapytaniem, pod listę automatyzacji. */
export async function przychodAutomatyzacji(tenantId: string): Promise<PrzychodAutomatyzacji> {
  const { rows } = await getPool().query(
    `with ostatni_przebieg as (
       select id, finished_at from attribution_runs
        where tenant_id = $1 and finished_at is not null
        order by finished_at desc, id desc limit 1
     )
     select p.finished_at as przebieg_at, a.journey_id,
            count(a.id)::int as zamowien,
            coalesce(sum(a.amount_minor), 0)::text as przychod_minor
       from ostatni_przebieg p
       left join attributions a
         on a.tenant_id = $1 and a.run_id = p.id and a.source_type = 'journey'
      group by p.finished_at, a.journey_id`,
    [tenantId],
  );
  const perAutomatyzacja: Record<string, SumaZrodla> = {};
  for (const r of rows) {
    if (r.journey_id) {
      perAutomatyzacja[r.journey_id] = { zamowien: r.zamowien, przychodMinor: Number(r.przychod_minor) };
    }
  }
  return { przebiegAt: rows[0]?.przebieg_at ?? null, perAutomatyzacja };
}
