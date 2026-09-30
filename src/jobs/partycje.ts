import type { Pool } from "pg";
import { getPool } from "../adapters/db/pool";

/**
 * Utrzymanie partycji dziennych kolejki (AD-31). Migracja 0002 założyła partycje tylko
 * na dzień własnego uruchomienia i następny; bez tego joba zapisy lecą do partycji
 * domyślnej, która jest alarmem, nie miejscem pracy.
 *
 * Pułapka, którą to naprawia (audyt 28.09, P1-8): Postgres NIE pozwala założyć partycji
 * na zakres, dla którego `jobs_default` ma już wiersze. Worker wyłączony dłużej niż
 * zapas partycji (dawniej 3 dni) albo panel kolejkujący joby przed pierwszym startem
 * workera = wiersze w `jobs_default`, a po powrocie `create table … partition of`
 * rzucał na top-level `await` przy starcie i worker restartował się w kółko.
 *
 * Teraz:
 *   1. partycje zakładane z zapasem 14 dni (panel może kolejkować dwa tygodnie bez workera),
 *   2. dzień, który ma wiersze w `jobs_default`, dostaje partycję ZE ZWOLNIENIEM default:
 *      w jednej transakcji pod blokadą `jobs_default` wiersze tego dnia przechodzą do
 *      nowej tabeli, a ta jest dołączana jako partycja. Tożsamość zadania (id,
 *      created_at) się nie zmienia, więc worker trzymający zadanie domknie je dalej,
 *   3. błąd jednego dnia NIE przerywa reszty i NIE wywraca startu: wraca w `bledy`,
 *      a worker zamienia go w alert. Kolejka działa dalej, bo default przyjmuje zapisy.
 *
 * Odłączanie: partycja może odejść WYŁĄCZNIE, gdy nie ma w niej zadań pending/running.
 * Zadanie utworzone dziś, a odłożone o dwa tygodnie, wciąż mieszka w dzisiejszej
 * partycji i skasowanie jej po samym wieku zabiłoby je przed wykonaniem.
 */
export interface WynikPartycji {
  zalozone: number;
  /** wiersze przeniesione z jobs_default do właściwych partycji */
  przeniesione: number;
  odlaczone: number;
  /** błędy per dzień (tekst dla człowieka); pusta lista = wszystko w porządku */
  bledy: string[];
}

export async function utrzymajPartycje(
  opcje: { dniWprzod?: number; retencjaDni?: number; pool?: Pool } = {},
): Promise<WynikPartycji> {
  const pool = opcje.pool ?? getPool();
  const dniWprzod = Math.max(1, Math.floor(opcje.dniWprzod ?? 14));
  const retencjaDni = Math.max(1, Math.floor(opcje.retencjaDni ?? 14));
  const wynik: WynikPartycji = { zalozone: 0, przeniesione: 0, odlaczone: 0, bledy: [] };

  // Dni do obsłużenia: zapas do przodu ORAZ każdy dzień, który ma wiersze w default.
  // Daty liczone w tej samej sesji co granice partycji (d::timestamptz), więc strefa
  // czasowa sesji jest spójna po obu stronach.
  const { rows: dni } = await pool.query<{ dzien: string }>(
    `select to_char(d, 'YYYY-MM-DD') as dzien from (
       select current_date + i as d from generate_series(0, $1::int) as i
       union
       select distinct created_at::date from jobs_default
     ) x
     where to_regclass('jobs_' || to_char(d, 'YYYY_MM_DD')) is null
     order by 1`,
    [dniWprzod],
  );

  for (const { dzien } of dni) {
    const nazwa = `jobs_${dzien.replace(/-/g, "_")}`;
    // nazwa i data pochodzą z to_char w bazie; sprawdzenie formatu zamyka drogę
    // do wstrzyknięcia DDL, gdyby ktoś kiedyś zmienił źródło listy
    if (!/^jobs_\d{4}_\d{2}_\d{2}$/.test(nazwa) || !/^\d{4}-\d{2}-\d{2}$/.test(dzien)) {
      wynik.bledy.push(`niepoprawna nazwa partycji ${nazwa}`);
      continue;
    }
    const klient = await pool.connect();
    try {
      await klient.query("begin");
      // Krótki limit czekania na blokadę i na całą operację (review Codeksa r1): długa
      // kolejka zapytań za ACCESS EXCLUSIVE zatrzymałaby zajmowanie zadań. Przekroczenie =
      // błąd tego dnia (alert), kolejka pracuje dalej na default, próba za godzinę.
      await klient.query("set local lock_timeout = '3s'");
      await klient.query("set local statement_timeout = '60s'");
      // Blokada default na czas przeniesienia: nowy wiersz tego dnia wpadający do default
      // między DELETE a ATTACH wywróciłby dołączenie. Inserty i odczyty kolejki czekają
      // chwilę (transakcja jest krótka), nic nie ginie.
      await klient.query("lock table jobs_default in access exclusive mode");
      const { rows: juz } = await klient.query("select to_regclass($1) is not null as jest", [nazwa]);
      if (juz[0].jest) {
        await klient.query("commit");
        continue;
      }
      await klient.query(`create table ${nazwa} (like jobs including defaults including constraints including storage)`);
      await klient.query(
        `alter table ${nazwa} set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01)`,
      );
      const przeniesienie = await klient.query(
        `with zabrane as (
           delete from jobs_default
            where created_at >= $1::date::timestamptz and created_at < ($1::date + 1)::timestamptz
           returning *
         )
         insert into ${nazwa} select * from zabrane`,
        [dzien],
      );
      await klient.query(
        `alter table jobs attach partition ${nazwa} for values from ('${dzien}'::date::timestamptz) to (('${dzien}'::date + 1)::timestamptz)`,
      );
      await klient.query("commit");
      wynik.zalozone++;
      wynik.przeniesione += przeniesienie.rowCount ?? 0;
    } catch (blad) {
      await klient.query("rollback").catch(() => {});
      wynik.bledy.push(`partycja ${nazwa}: ${String((blad as Error)?.message ?? blad).slice(0, 300)}`);
    } finally {
      klient.release();
    }
  }

  const { rows: stare } = await pool.query(
    `select c.relname from pg_class c
      join pg_inherits i on i.inhrelid = c.oid
      join pg_class p on p.oid = i.inhparent
     where p.relname = 'jobs' and c.relname ~ '^jobs_\\d{4}_\\d{2}_\\d{2}$'
       and to_date(substring(c.relname from 6), 'YYYY_MM_DD') < current_date - $1::int`,
    [retencjaDni],
  );
  for (const { relname } of stare) {
    if (!/^jobs_\d{4}_\d{2}_\d{2}$/.test(relname)) continue;
    // Krótka transakcja z limitami (review Codeksa r2): DETACH czekający na blokadę `jobs`
    // ustawiłby za sobą w kolejce zajmowanie zadań i zapytania panelu.
    const klient = await pool.connect();
    try {
      await klient.query("begin");
      await klient.query("set local lock_timeout = '3s'");
      await klient.query("set local statement_timeout = '60s'");
      const { rows } = await klient.query(
        `select count(*)::int as aktywne from ${relname} where status in ('pending', 'running')`,
      );
      if (rows[0].aktywne > 0) {
        // aktywne zadania trzymają partycję przy życiu
        await klient.query("rollback");
        continue;
      }
      await klient.query(`alter table jobs detach partition ${relname}`);
      await klient.query(`drop table ${relname}`);
      await klient.query("commit");
      wynik.odlaczone++;
    } catch (blad) {
      await klient.query("rollback").catch(() => {});
      wynik.bledy.push(`retencja ${relname}: ${String((blad as Error)?.message ?? blad).slice(0, 300)}`);
    } finally {
      klient.release();
    }
  }
  return wynik;
}

/**
 * Odzyskiwanie po śmierci workera. Dwa rodzaje zombie:
 * 1. Wiadomość w 'claimed': worker padł między zajęciem partii a commitem przejścia
 *    w 'sending'. Stan 'claimed' GWARANTUJE, że dostawca nie był wołany w tej próbie,
 *    bo wywołanie dostawcy następuje dopiero po commicie, który przestawia stan na
 *    'sending' — więc powrót do 'queued' jest bezpieczny, a bramka canSendTo i tak
 *    sprawdzi się ponownie. (Zdarzenie 'sending' w historii NIE dyskwalifikuje: może
 *    pochodzić z poprzedniej próby zakończonej błędem przejściowym przed przyjęciem.)
 *    Wiadomości w 'sending' NIE ruszamy automatem: mogły wyjść do dostawcy — nimi
 *    zajmuje się rekoncyliacja, która przenosi je w 'held' i alarmuje (AD-23).
 * 2. Zadanie w 'running' z locked_at starszym niż kwadrans: wraca do 'pending'.
 *    Worker odświeża locked_at heartbeatem co minutę, więc kwadrans bez heartbeatu
 *    naprawdę znaczy martwy proces, a nie handler pracujący długo.
 *
 * Zegarem wiadomości jest claimed_at (moment zajęcia partii), nie created_at:
 * wiadomość zbudowana wczoraj (limit dobowy przerwał wysyłkę) była cofana do queued
 * w trakcie, gdy inny worker właśnie ją przetwarzał — i wychodziła dwa razy.
 * coalesce z created_at obsługuje wiadomości zajęte przed migracją 0011.
 */
export async function odzyskajZombie() {
  const pool = getPool();
  const wiadomosci = await pool.query(
    `update messages m set current_state = 'queued', claimed_at = null
      where m.current_state = 'claimed'
        and coalesce(m.claimed_at, m.created_at) < now() - interval '15 minutes'
      returning m.id`,
  );
  const zadania = await pool.query(
    `update jobs set status = 'pending', locked_at = null, locked_by = null
      where status = 'running' and locked_at < now() - interval '15 minutes'
      returning id`,
  );
  if (wiadomosci.rowCount || zadania.rowCount) {
    console.warn(
      `[zombie] odzyskano: ${wiadomosci.rowCount} wiadomości do queued, ${zadania.rowCount} zadań do pending`,
    );
  }
  return { wiadomosci: wiadomosci.rowCount ?? 0, zadania: zadania.rowCount ?? 0 };
}
