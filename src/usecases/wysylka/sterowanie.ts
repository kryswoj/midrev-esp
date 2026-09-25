import type { PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";
import { wyslijAlert } from "../../jobs/alerty";
import { dodajZadanie } from "../../jobs/kolejka";
import { stanWysylkiTenanta } from "./reputacja";

/**
 * B1 i B2 z PLAN-DOWIEZIENIA-2026-09-22: harmonogram i hamulec.
 *
 * B1 — dispatcher zaplanowanych kampanii. `scheduled_at` leży w bazie od 0004 i panel ją
 *      pokazuje, ale nic jej nie czytało: operator planował wysyłkę na wtorek 10:00 i we
 *      wtorek nie działo się nic. To jest najgorsza klasa błędu, bo widać ją dopiero wtedy,
 *      gdy ktoś zdążył zaufać.
 * B2 — wstrzymanie, wznowienie i odwołanie. Jedyny ratunek po zauważeniu błędu w wysłanej
 *      połowie kampanii.
 *
 * Wspólna zasada obu: stanem rozstrzygającym jest KOLUMNA W BAZIE sprawdzana w tej samej
 * instrukcji, która zmienia stan. Nie flaga w pamięci procesu (nie przeżyje restartu
 * workera) i nie SELECT przed UPDATE-em (przepuszcza wyścig dwóch workerów).
 */

/**
 * Ile najwyżej może się spóźnić plan, żeby dispatcher jeszcze go wykonał.
 *
 * Powód istnienia tej granicy: kampania czeka na akceptację klienta, a `scheduled_at`
 * ustawia się PRZED akceptacją. Klient akceptuje w czwartek plan na wtorek — bez tej
 * granicy wysyłka ruszyłaby w tej samej sekundzie, z terminem sprzed dwóch dni, którego
 * nikt już nie pamięta. Jedna doba zapasu pokrywa nocne opóźnienia i przestój workera,
 * a nie pokrywa "zapomnianego" planu sprzed tygodnia.
 *
 * Kampania, która przekroczyła to okno, NIE wychodzi po cichu i nie znika po cichu:
 * idzie alert (raz, przez znacznik w bazie), a panel pokazuje powód przy przycisku.
 */
export const OKNO_SPOZNIENIA_GODZIN = 24;

export interface StanKampanii {
  status: string;
  wszystkie: number;
  /** wiadomości z zapisanym zdarzeniem 'sent' — przekazane dostawcy, czyli NIEODWRACALNE */
  przekazane: number;
  wKolejce: number;
  /** zajęte przez workera albo czekające na potwierdzenie dostawcy */
  wLocie: number;
  zatrzymane: number;
}

/**
 * Liczby, które muszą być na ekranie PRZED decyzją o odwołaniu. Czytane z zapisanych
 * rekordów, nie z licznika przebiegu: licznik mówi, co zrobił jeden job, a pytanie brzmi,
 * co się stało z całą kampanią.
 */
export async function stanKampanii(tenantId: string, campaignId: string): Promise<StanKampanii | null> {
  const pool = getPool();
  const { rows: kampanie } = await pool.query(
    "select status from campaigns where tenant_id = $1 and id = $2",
    [tenantId, campaignId],
  );
  if (!kampanie[0]) return null;
  const { rows } = await pool.query(
    `select
       count(*)::int as wszystkie,
       count(*) filter (where e.message_id is not null)::int as przekazane,
       count(*) filter (where m.current_state = 'queued')::int as w_kolejce,
       count(*) filter (where m.current_state in ('claimed', 'sending'))::int as w_locie,
       count(*) filter (where m.current_state in ('suppressed', 'dropped', 'failed'))::int as zatrzymane
     from messages m
     left join message_events e
       on e.tenant_id = m.tenant_id and e.message_id = m.id and e.event_type = 'sent'
     where m.tenant_id = $1 and m.source_type = 'campaign' and m.source_id = $2`,
    [tenantId, campaignId],
  );
  const w = rows[0];
  return {
    status: kampanie[0].status,
    wszystkie: w.wszystkie,
    przekazane: w.przekazane,
    wKolejce: w.w_kolejce,
    wLocie: w.w_locie,
    zatrzymane: w.zatrzymane,
  };
}

// ── B1. Dispatcher ────────────────────────────────────────────────────────────

export interface WynikDispatchera {
  uruchomione: { tenantId: string; campaignId: string }[];
  /** plany, które przeterminowały okno spóźnienia i NIE zostały wykonane */
  przeterminowane: number;
}

/**
 * Jeden przebieg dispatchera. Wołany co minutę z KAŻDEGO workera, więc musi być odporny
 * na to, że dwa procesy robią to samo w tej samej sekundzie.
 *
 * Jak zamknięty jest wyścig dwóch workerów:
 *   1. Start kampanii to JEDEN `update ... where status = 'approved' ... returning`.
 *      Drugi worker blokuje się na wierszu, a po zwolnieniu blokady Postgres w READ
 *      COMMITTED ponownie sprawdza warunek WHERE na świeżej wersji wiersza: widzi już
 *      'sending' i nie dostaje niczego. Nie ma więc momentu, w którym obaj "wygrywają".
 *   2. Zmiana statusu i wpis do kolejki idą w JEDNEJ transakcji. Awaria między jednym
 *      a drugim zostawiłaby kampanię w 'sending' bez joba, czyli wysyłkę, która nigdy
 *      się nie zacznie i o której panel mówi, że trwa.
 *   3. Bramka akceptacji klienta (FR41) jest powtórzona TUTAJ, a nie odziedziczona po
 *      przycisku "Wyślij teraz". Harmonogram jest drugim wejściem do wysyłki i musi
 *      bronić się sam — dokładnie tak, jak server action broni się mimo ukrytego
 *      przycisku w panelu.
 *   4. Tenant wstrzymany (B5) nie startuje niczego nowego. Kampania zostaje w 'approved'
 *      z terminem w przeszłości, a nie wchodzi w 'sending', żeby po chwili stanąć.
 */
export async function wypchnijZaplanowane(): Promise<WynikDispatchera> {
  const pool = getPool();
  const klient = await pool.connect();
  let uruchomione: { tenantId: string; campaignId: string }[] = [];
  try {
    await klient.query("begin");
    const { rows } = await klient.query(
      `update campaigns c set status = 'sending', updated_at = now()
        where c.status = 'approved'
          and c.scheduled_at is not null
          and c.scheduled_at <= now()
          and c.scheduled_at > now() - make_interval(hours => $1::int)
          and exists (select 1 from tenants t
                       where t.id = c.tenant_id and t.sending_paused_at is null)
          and (select a.decision from campaign_approvals a
                where a.tenant_id = c.tenant_id and a.campaign_id = c.id
                  and a.decided_at is not null
                order by a.decided_at desc limit 1) = 'approved'
        returning c.id, c.tenant_id`,
      [OKNO_SPOZNIENIA_GODZIN],
    );
    for (const wiersz of rows) {
      await dodajZadanie(wiersz.tenant_id, "wyslij_kampanie", { campaignId: wiersz.id }, { przez: klient });
    }
    await klient.query("commit");
    uruchomione = rows.map((w) => ({ tenantId: w.tenant_id, campaignId: w.id }));
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }

  const przeterminowane = await zglosPrzeterminowanePlany();
  return { uruchomione, przeterminowane };
}

/**
 * Plan, którego dispatcher już nie wykona. Alert idzie DOKŁADNIE RAZ na kampanię:
 * znacznik `schedule_missed_alert_at` stawiany jest atomowym UPDATE-em z warunkiem
 * `is null`, więc ani drugi worker, ani następna minuta nie powtórzą powiadomienia.
 * Bez tego dławika alert szedłby co minutę z każdego procesu i po dniu nikt by go
 * nie czytał — czyli tyle samo, co cisza, tylko głośniej.
 */
async function zglosPrzeterminowanePlany(): Promise<number> {
  const { rows } = await getPool().query(
    `update campaigns set schedule_missed_alert_at = now()
      where status = 'approved'
        and scheduled_at is not null
        and scheduled_at <= now() - make_interval(hours => $1::int)
        and schedule_missed_alert_at is null
      returning id, tenant_id, name, scheduled_at`,
    [OKNO_SPOZNIENIA_GODZIN],
  );
  for (const w of rows) {
    await wyslijAlert(
      `kampania „${w.name}" (tenant ${w.tenant_id}, id ${w.id}) miała zaplanowaną wysyłkę na ` +
        `${new Date(w.scheduled_at).toISOString()} i NIE wyszła: termin minął o więcej niż ` +
        `${OKNO_SPOZNIENIA_GODZIN} h. Dispatcher nie wysyła planów spóźnionych ponad to okno ` +
        `(kampania mogła czekać na akceptację klienta). Zaplanuj na nowo albo wyślij ręcznie.`,
    );
  }
  return rows.length;
}

/**
 * Ustawienie albo zdjęcie planu. Plan wolno ustawić wyłącznie PRZED wysyłką — kampania
 * w 'sending' już idzie, a w 'sent' poszła, więc data w przyszłości byłaby tam napisem
 * bez znaczenia.
 */
export async function zaplanujKampanie(
  tenantId: string,
  campaignId: string,
  kiedy: Date | null,
): Promise<{ ok: true; kiedy: Date | null } | { ok: false; blad: string }> {
  if (kiedy && Number.isNaN(kiedy.getTime())) {
    return { ok: false, blad: "Nie rozumiem tej daty. Podaj dzień i godzinę wysyłki." };
  }
  if (kiedy && kiedy.getTime() <= Date.now()) {
    return {
      ok: false,
      blad: "Termin w przeszłości to nie plan. Wybierz przyszłą godzinę albo użyj „Wyślij teraz\".",
    };
  }
  // Znacznik alertu zeruje się razem z planem: nowy termin ma prawo do własnego
  // powiadomienia, gdyby i on został przegapiony.
  const { rows } = await getPool().query(
    `update campaigns set scheduled_at = $3, schedule_missed_alert_at = null, updated_at = now()
      where tenant_id = $1 and id = $2
        and status in ('draft', 'awaiting_approval', 'approved')
      returning scheduled_at`,
    [tenantId, campaignId, kiedy],
  );
  if (!rows.length) {
    return { ok: false, blad: "Kampania w tym stanie nie przyjmuje planu wysyłki." };
  }
  // weryfikacja czyta ZAPISANY rekord, nie wejście
  return { ok: true, kiedy: rows[0].scheduled_at ?? null };
}

// ── B2. Wstrzymanie, wznowienie, odwołanie ────────────────────────────────────

/**
 * Wstrzymanie kampanii w trakcie. Zatrzymuje wysyłkę MIĘDZY PARTIAMI, nie w środku partii:
 *   - pętla workera sprawdza status kampanii po każdej partii i wychodzi,
 *   - zajmowanie partii (`wyslijPartie`) w ogóle nie bierze wiadomości kampanii, która
 *     nie jest w 'sending' — i to jest ważniejszy z tych dwóch mechanizmów, bo
 *     `wyslijPartie` opróżnia kolejkę CAŁEGO tenanta: bez warunku przy zajmowaniu
 *     wiadomości wstrzymanej kampanii wychodziłyby dalej z joba SĄSIEDNIEJ kampanii.
 *
 * Czego wstrzymanie NIE robi: nie cofa partii już zajętej. Te wiadomości (najwyżej
 * rozmiar partii) są w drodze do dostawcy i odebranie ich oznaczałoby albo podwójną
 * wysyłkę, albo wiadomość porzuconą w stanie zajętym. Panel mówi o tym wprost liczbą.
 */
export async function wstrzymajKampanie(
  tenantId: string,
  campaignId: string,
): Promise<{ ok: true; stan: StanKampanii } | { ok: false; blad: string }> {
  const { rows } = await getPool().query(
    `update campaigns set status = 'paused', paused_at = now(), updated_at = now()
      where tenant_id = $1 and id = $2 and status = 'sending'
      returning id`,
    [tenantId, campaignId],
  );
  if (!rows.length) {
    const stan = await stanKampanii(tenantId, campaignId);
    if (!stan) return { ok: false, blad: "Nie znaleziono kampanii" };
    return {
      ok: false,
      blad:
        stan.status === "paused"
          ? "Kampania jest już wstrzymana."
          : `Wstrzymać można wyłącznie kampanię w wysyłce. Ta jest w stanie: ${stan.status}.`,
    };
  }
  const stan = await stanKampanii(tenantId, campaignId);
  return { ok: true, stan: stan! };
}

/**
 * Wznowienie. Przejście 'paused' -> 'sending' i wpis do kolejki w JEDNEJ transakcji,
 * tym samym wzorcem co dispatcher: nie wolno zostawić kampanii w 'sending' bez joba.
 * Dwa kliknięcia pod rząd nie tworzą dwóch jobów — drugie nie znajduje już 'paused'.
 */
export async function wznowKampanie(
  tenantId: string,
  campaignId: string,
): Promise<{ ok: true } | { ok: false; blad: string }> {
  const tenant = await stanWysylkiTenanta(tenantId);
  if (tenant.wstrzymany) {
    return {
      ok: false,
      blad: `Wysyłka całego sklepu jest wstrzymana (${tenant.powod ?? "bez podanego powodu"}). Najpierw wznów wysyłkę sklepu.`,
    };
  }
  const pool = getPool();
  const klient = await pool.connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query(
      `update campaigns set status = 'sending', paused_at = null, updated_at = now()
        where tenant_id = $1 and id = $2 and status = 'paused'
        returning id`,
      [tenantId, campaignId],
    );
    if (!rows.length) {
      await klient.query("rollback");
      return { ok: false, blad: "Wznowić można wyłącznie kampanię wstrzymaną." };
    }
    await dodajZadanie(tenantId, "wyslij_kampanie", { campaignId }, { przez: klient });
    await klient.query("commit");
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
  return { ok: true };
}

/**
 * Odwołanie kampanii. Wolno z każdego stanu PRZED wysyłką oraz ze wstrzymania — nigdy
 * wprost z 'sending'. To nie jest formalizm: przejście przez wstrzymanie wymusza, żeby
 * operator zobaczył liczbę wiadomości, które już poszły, ZANIM podejmie decyzję, której
 * nie da się cofnąć.
 *
 * Wiadomości czekające w kolejce dostają stan terminalny 'suppressed' z powodem
 * 'kampania_odwolana'. Zostawienie ich w 'queued' byłoby miną: wystarczyłaby jedna
 * zmiana statusu kampanii, żeby tydzień później wyszły.
 *
 * Wiadomości ZAJĘTE (claimed/sending) nie są ruszane. Są już w drodze do dostawcy i
 * nadpisanie ich stanu terminalnym 'suppressed' skończyłoby się rekordem, który kłamie
 * (mail wyszedł, a w bazie stoi "zatrzymany") — projekcja stanu jest monotoniczna, więc
 * późniejsze 'sent' o niższej randze już by go nie poprawiło.
 */
export async function odwolajKampanie(
  tenantId: string,
  campaignId: string,
): Promise<{ ok: true; stan: StanKampanii; zatrzymaneTeraz: number } | { ok: false; blad: string }> {
  const pool = getPool();
  const klient = await pool.connect();
  let zatrzymaneTeraz = 0;
  try {
    await klient.query("begin");
    const { rows } = await klient.query(
      `update campaigns set status = 'cancelled', cancelled_at = now(), updated_at = now()
        where tenant_id = $1 and id = $2
          and status in ('draft', 'awaiting_approval', 'approved', 'scheduled', 'paused')
        returning id`,
      [tenantId, campaignId],
    );
    if (!rows.length) {
      await klient.query("rollback");
      const stan = await stanKampanii(tenantId, campaignId);
      if (!stan) return { ok: false, blad: "Nie znaleziono kampanii" };
      return {
        ok: false,
        blad:
          stan.status === "sending"
            ? "Kampanię w wysyłce najpierw wstrzymaj — dopiero wtedy widać, ile wiadomości już poszło."
            : stan.status === "cancelled"
              ? "Kampania jest już odwołana."
              : "Kampanii po zakończonej wysyłce nie da się odwołać. Wysyłka jest nieodwracalna.",
      };
    }
    zatrzymaneTeraz = await zatrzymajKolejkeKampanii(klient, tenantId, campaignId);
    await klient.query("commit");
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
  const stan = await stanKampanii(tenantId, campaignId);
  return { ok: true, stan: stan!, zatrzymaneTeraz };
}

/**
 * Domknięcie wiadomości czekających w kolejce odwołanej kampanii.
 *
 * `for update` bez SKIP LOCKED jest tu zamierzone: wiersz zajmowany w tej chwili przez
 * workera ma zostać PRZEPUSZCZONY, a nie zatrzymany. Po zwolnieniu blokady Postgres
 * ponownie sprawdza warunek `current_state = 'queued'` — wiadomość jest już 'claimed'
 * i wypada ze zbioru. Gdyby zamiast tego ominąć ją przez SKIP LOCKED, wróciłaby do
 * 'queued' przy pierwszym błędzie przejściowym i została w kolejce na stałe.
 */
async function zatrzymajKolejkeKampanii(
  klient: PoolClient,
  tenantId: string,
  campaignId: string,
): Promise<number> {
  const { rows } = await klient.query(
    `select id from messages
      where tenant_id = $1 and source_type = 'campaign' and source_id = $2
        and current_state = 'queued'
      for update`,
    [tenantId, campaignId],
  );
  if (!rows.length) return 0;
  const idy = rows.map((w) => w.id);
  // Data zdarzenia jawnie z zegara BAZY (`now()`), tak samo jak przy `kiedy: "teraz"`
  // w zapiszZdarzenie: po tej dacie liczy się okno wskaźników, a rozjazd zegara
  // serwera aplikacji przesunąłby zdarzenie między dobami.
  await klient.query(
    `insert into message_events (tenant_id, message_id, event_type, payload, occurred_at)
     select $1, id, 'suppressed', jsonb_build_object('powod', 'kampania_odwolana'), now()
       from unnest($2::uuid[]) as id
     on conflict (message_id, event_type) do nothing`,
    [tenantId, idy],
  );
  const { rowCount } = await klient.query(
    // rank 3 = stan terminalny, zgodnie z tabelą RANGI w wyslij-kampanie.ts. Warunek
    // `current_rank < 3` powtarza regułę monotoniczności projekcji: gdyby wiadomość
    // zdążyła w międzyczasie dostać stan wyższy, nie wolno go cofnąć.
    `update messages set current_state = 'suppressed', current_rank = 3, claimed_at = null
      where tenant_id = $1 and id = any($2::uuid[]) and current_state = 'queued' and current_rank < 3`,
    [tenantId, idy],
  );
  return rowCount ?? 0;
}

/**
 * Sprzątanie po odwołaniu: wiadomość zajęta w chwili odwołania mogła wrócić do 'queued'
 * (limit dobowy, błąd przejściowy, odzyskanie zombie) już PO tym, jak odwołanie przeszło.
 * Zajmowanie partii jej nie weźmie (kampania nie jest w 'sending'), ale zostałaby
 * w kolejce na zawsze jako wiersz, który kłamie o stanie kampanii. Dispatcher zamiata
 * to co minutę — idempotentnie, bo pracuje wyłącznie na 'queued'.
 */
export async function domknijOdwolane(): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    `select m.tenant_id, m.source_id as campaign_id
       from messages m
       join campaigns c on c.tenant_id = m.tenant_id and c.id = m.source_id
      where m.source_type = 'campaign' and m.current_state = 'queued'
        and c.status = 'cancelled'
      group by m.tenant_id, m.source_id`,
  );
  let domkniete = 0;
  for (const w of rows) {
    const klient = await pool.connect();
    try {
      await klient.query("begin");
      domkniete += await zatrzymajKolejkeKampanii(klient, w.tenant_id, w.campaign_id);
      await klient.query("commit");
    } catch (blad) {
      await klient.query("rollback").catch(() => {});
      throw blad;
    } finally {
      klient.release();
    }
  }
  return domkniete;
}
