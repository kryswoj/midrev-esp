import type { Pool } from "pg";
import { getPool } from "../adapters/db/pool";

/**
 * Heartbeat procesu workera (0029, `worker_heartbeats`). Healthcheck `/api/zdrowie`
 * czyta z niego, czy KTOKOLWIEK przetwarza kolejkę: wszystkie zadania cykliczne,
 * wysyłka, odbicia i atrybucja stoją, kiedy stoi worker, a panel tego nie widzi.
 *
 * Czas zawsze z zegara bazy (`now()`), bo healthcheck porównuje go z `now()` tej samej
 * bazy: rozjazd zegarów serwerów nie może udawać martwego workera.
 */
export const ODSTEP_HEARTBEATU_MS = 30_000;

export async function zapiszHeartbeat(workerId: string, opcje: { start?: boolean } = {}, pool: Pool = getPool()): Promise<void> {
  if (opcje.start) {
    // Start procesu: wiersz zawsze od nowa. Losowy identyfikator mógł trafić w wiersz
    // martwego procesu (stopping_at ustawione) — bez resetu nowy, żywy worker wyglądałby
    // w healthchecku na zamykany (review Codeksa r1).
    await pool.query(
      `insert into worker_heartbeats (worker_id, started_at, last_seen_at, stopping_at)
       values ($1, now(), now(), null)
       on conflict (worker_id) do update set started_at = now(), last_seen_at = now(), stopping_at = null`,
      [workerId],
    );
    return;
  }
  // Tik: nie wskrzesza wiersza oznaczonego przy SIGTERM (spóźniony tik w trakcie zamykania).
  await pool.query(
    `insert into worker_heartbeats (worker_id, started_at, last_seen_at)
     values ($1, now(), now())
     on conflict (worker_id) do update set last_seen_at = now()
       where worker_heartbeats.stopping_at is null`,
    [workerId],
  );
}

/** SIGTERM przyjęty: proces kończy bieżącą pracę. Healthcheck nie liczy go jako żywego. */
export async function oznaczZamykanieWorkera(workerId: string, pool: Pool = getPool()): Promise<void> {
  await pool.query("update worker_heartbeats set stopping_at = now() where worker_id = $1", [workerId]);
}

/** Wiersze martwych procesów (restarty, deploye) sprzątane po tygodniu. */
export async function sprzatnijHeartbeaty(pool: Pool = getPool()): Promise<number> {
  const wynik = await pool.query("delete from worker_heartbeats where last_seen_at < now() - interval '7 days'");
  return wynik.rowCount ?? 0;
}
