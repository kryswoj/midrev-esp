import { getPool } from "../adapters/db/pool";

/**
 * Utrzymanie partycji dziennych kolejki (AD-31). Migracja 0002 założyła partycje tylko
 * na dzień własnego uruchomienia i następny; bez tego joba trzeciego dnia zapisy lecą
 * do partycji domyślnej, która jest alarmem, nie miejscem pracy.
 *
 * Odłączanie: partycja może odejść WYŁĄCZNIE, gdy nie ma w niej zadań pending/running.
 * Zadanie utworzone dziś, a odłożone o dwa tygodnie, wciąż mieszka w dzisiejszej
 * partycji i skasowanie jej po samym wieku zabiłoby je przed wykonaniem.
 */
export async function utrzymajPartycje(dniWprzod = 3, retencjaDni = 14) {
  const pool = getPool();
  for (let i = 0; i <= dniWprzod; i++) {
    await pool.query(
      `do $$
       declare
         d date := current_date + ${i};
         nazwa text := 'jobs_' || to_char(current_date + ${i}, 'YYYY_MM_DD');
       begin
         if to_regclass(nazwa) is null then
           execute format('create table %I partition of jobs for values from (%L) to (%L)',
                          nazwa, d::timestamptz, (d + 1)::timestamptz);
           execute format('alter table %I set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01)', nazwa);
         end if;
       end $$`,
    );
  }

  const { rows: stare } = await pool.query(
    `select c.relname from pg_class c
      join pg_inherits i on i.inhrelid = c.oid
      join pg_class p on p.oid = i.inhparent
     where p.relname = 'jobs' and c.relname ~ '^jobs_\\d{4}_\\d{2}_\\d{2}$'
       and to_date(substring(c.relname from 6), 'YYYY_MM_DD') < current_date - $1::int`,
    [retencjaDni],
  );
  let odlaczone = 0;
  for (const { relname } of stare) {
    const { rows } = await pool.query(
      `select count(*)::int as aktywne from ${relname} where status in ('pending', 'running')`,
    );
    if (rows[0].aktywne > 0) continue; // aktywne zadania trzymają partycję przy życiu
    await pool.query(`alter table jobs detach partition ${relname}`);
    await pool.query(`drop table ${relname}`);
    odlaczone++;
  }
  return { odlaczone };
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
