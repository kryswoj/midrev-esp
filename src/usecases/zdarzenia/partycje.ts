import type { Pool } from "pg";
import { getPool } from "../../adapters/db/pool";

/**
 * Partycje miesięczne strumienia `metric_events` (AD-45: BEZ partycji DEFAULT).
 *
 * Jedna implementacja zakładania jest w bazie (`metric_events_zapewnij_partycje`, 0030):
 * migracja, job dobowy workera i zapis zdarzenia z miesiąca bez partycji wołają tę samą
 * funkcję. `zapewnijPartycjeMiesiaca` idzie OSOBNYM połączeniem z krótkim limitem blokady
 * i jest dla wołających, którzy NIE są jeszcze w transakcji zapisu (worker API przed
 * otwarciem transakcji): `create table … partition of` bierze silną blokadę rodzica
 * i blokady tabel z kluczy obcych (metrics, profiles), więc w środku transakcji, która
 * pisała profil, czekałoby na samą siebie. Wewnątrz transakcji ratuje zapiszZdarzenie.
 */

/** Klucz miesiąca UTC 'YYYY_MM' — tak jak nazwa partycji. */
export function miesiacUtc(d: Date): string {
  return `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Miesiące, o których ten proces WIE, że partycja istnieje. Partycji nie usuwamy (brak
// retencji, plan 1.4), więc raz potwierdzona zostaje; cache oszczędza zapytanie przy
// każdym zapisie. Niepotwierdzony miesiąc = sprawdzenie w bazie.
const znane = new Set<string>();

export async function zapewnijPartycjeMiesiaca(kiedy: Date, pool: Pool = getPool()): Promise<void> {
  const klucz = miesiacUtc(kiedy);
  if (znane.has(klucz)) return;
  const klient = await pool.connect();
  try {
    const { rows } = await klient.query<{ jest: boolean }>(
      "select to_regclass($1) is not null as jest",
      [`metric_events_${klucz}`],
    );
    if (!rows[0].jest) {
      await klient.query("begin");
      try {
        await klient.query("set local lock_timeout = '5s'");
        await klient.query("set local statement_timeout = '30s'");
        await klient.query("select metric_events_zapewnij_partycje($1, $1)", [kiedy]);
        await klient.query("commit");
      } catch (blad) {
        await klient.query("rollback").catch(() => {});
        throw blad;
      }
    }
    znane.add(klucz);
  } finally {
    klient.release();
  }
}

/** Czy błąd Postgresa to „brak partycji dla wiersza” (23514 z komunikatem o partycji). */
export function toBrakPartycji(blad: unknown): boolean {
  const b = blad as { code?: string; message?: string } | null;
  return b?.code === "23514" && /no partition of relation/i.test(String(b.message ?? ""));
}

export interface WynikUtrzymania {
  zalozone: number;
  blad: string | null;
}

/**
 * Job dobowy (worker): partycje od poprzedniego miesiąca do +12 miesięcy. Błąd NIE rzuca:
 * wraca w `blad`, a worker zamienia go w alert (lista kontrolna, pkt 10).
 */
export async function utrzymajPartycjeMetryk(pool: Pool = getPool()): Promise<WynikUtrzymania> {
  const klient = await pool.connect();
  try {
    await klient.query("begin");
    await klient.query("set local lock_timeout = '5s'");
    await klient.query("set local statement_timeout = '60s'");
    const { rows } = await klient.query<{ n: number }>(
      "select metric_events_zapewnij_partycje(now() - interval '1 month', now() + interval '12 months') as n",
    );
    await klient.query("commit");
    return { zalozone: rows[0].n, blad: null };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    return { zalozone: 0, blad: String((blad as Error)?.message ?? blad).slice(0, 300) };
  } finally {
    klient.release();
  }
}

/** Test/diagnostyka: zapomnij potwierdzone miesiące. */
export function wyczyscCachePartycji(): void {
  znane.clear();
}
