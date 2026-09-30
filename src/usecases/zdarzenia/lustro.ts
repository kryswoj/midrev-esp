import type { Pool } from "pg";
import { getPool } from "../../adapters/db/pool";

/**
 * Okno deployu (AD-46): między migracją 0031 a startem nowego kodu STARY kod pisze jeszcze
 * tylko do `events`. Worker przy starcie przepuszcza takie wiersze przez tę samą funkcję
 * SQL co backfill 0031 (`metryki_dosynchronizuj_events`): mapowanie, daty ze źródła,
 * `backfill = true`. Wiersze zapisane przez nowy kod mają już lustro o tym samym id
 * i nie są kopiowane drugi raz.
 */
export async function dosynchronizujStareZdarzenia(dni = 7, pool: Pool = getPool()): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "select metryki_dosynchronizuj_events(now() - make_interval(days => $1::int)) as n",
    [dni],
  );
  return rows[0].n;
}
