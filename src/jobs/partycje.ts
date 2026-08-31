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
 * 1. Wiadomość w 'claimed' bez zdarzenia 'sending': worker padł między zajęciem partii
 *    a bramką. Nic nie wyszło do dostawcy, więc powrót do 'queued' jest bezpieczny,
 *    a bramka canSendTo i tak sprawdzi się ponownie przy następnym podejściu.
 *    Wiadomości w 'sending' NIE ruszamy automatem: mogły wyjść do dostawcy i wymagają
 *    wyjaśnienia po idempotencyKey, nie ślepego ponowienia (AD-23).
 * 2. Zadanie w 'running' z locked_at starszym niż kwadrans: wraca do 'pending'.
 */
export async function odzyskajZombie() {
  const pool = getPool();
  const wiadomosci = await pool.query(
    `update messages m set current_state = 'queued'
      where m.current_state = 'claimed'
        and not exists (select 1 from message_events e
                         where e.message_id = m.id and e.event_type = 'sending')
        and m.created_at < now() - interval '15 minutes'
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
