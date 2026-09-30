import { getPool } from "../adapters/db/pool";

/**
 * Stan systemu dla healthchecku (`/api/zdrowie`, zewnętrzny monitor). Bez danych
 * osobowych i bez identyfikatorów tenantów: same liczby i wiek heartbeatu.
 *
 * „Zdrowy" = baza odpowiada ORAZ żyje co najmniej jeden worker (heartbeat świeży i nie
 * w trakcie zamykania). Worker jest warunkiem, bo bez niego stoi wszystko, co panel
 * zleca: wysyłka, flowy, odbicia, atrybucja — a panel dalej wygląda na działający.
 * Kolejka i held to informacja dla człowieka, nie powód 503: długi import potrafi
 * uczciwie trzymać kolejkę, a held rozstrzyga człowiek (alert idzie osobno).
 */
export const MAKS_WIEK_HEARTBEATU_S = 120;

export interface StanZdrowia {
  ok: boolean;
  baza: boolean;
  worker: boolean;
  /** tylko ze szczegółami */
  szczegoly?: {
    wiekHeartbeatuS: number | null;
    zadaniaGotowe: number;
    zadaniaOpoznione: number;
    zadaniaWDefault: number;
    wiadomosciHeld: number;
    wiadomosciWKolejce: number;
  };
}

export async function stanZdrowia(opcje: { szczegoly: boolean }): Promise<StanZdrowia> {
  let klient: import("pg").PoolClient;
  try {
    // pula bez connectionTimeoutMillis czekałaby bez końca na zawieszoną bazę
    const polaczenie = getPool().connect();
    const limit = new Promise<never>((_, odrzuc) => setTimeout(() => odrzuc(new Error("timeout")), 3000).unref());
    klient = await Promise.race([polaczenie, limit]).catch((blad) => {
      // połączenie, które przyjdzie po czasie, wraca do puli, zamiast wisieć
      polaczenie.then((k) => k.release()).catch(() => {});
      throw blad;
    });
  } catch {
    return { ok: false, baza: false, worker: false };
  }
  try {
    await klient.query("begin read only");
    // healthcheck nie może trzymać połączenia dłużej niż monitor czeka na odpowiedź
    await klient.query("set local statement_timeout = 3000");
    const { rows: hb } = await klient.query<{ wiek: number | null }>(
      `select extract(epoch from now() - max(last_seen_at))::int as wiek
         from worker_heartbeats where stopping_at is null`,
    );
    const wiek = hb[0]?.wiek ?? null;
    const worker = wiek !== null && wiek <= MAKS_WIEK_HEARTBEATU_S;
    let szczegoly: StanZdrowia["szczegoly"];
    if (opcje.szczegoly) {
      // liczniki z sufitem: healthcheck nie liczy milionów wierszy przy każdym odpytaniu
      const { rows } = await klient.query(
        `select
           (select count(*) from (select 1 from jobs where status = 'pending' and run_after <= now() limit 10000) x)::int as gotowe,
           (select count(*) from (select 1 from jobs where status = 'pending' and run_after < now() - interval '10 minutes' limit 10000) x)::int as opoznione,
           (select count(*) from (select 1 from jobs_default limit 10000) x)::int as w_default,
           (select count(*) from (select 1 from messages where current_state = 'held' limit 10000) x)::int as held,
           (select count(*) from (select 1 from messages where current_state = 'queued' limit 100000) x)::int as w_kolejce`,
      );
      szczegoly = {
        wiekHeartbeatuS: wiek,
        zadaniaGotowe: rows[0].gotowe,
        zadaniaOpoznione: rows[0].opoznione,
        zadaniaWDefault: rows[0].w_default,
        wiadomosciHeld: rows[0].held,
        wiadomosciWKolejce: rows[0].w_kolejce,
      };
    }
    await klient.query("commit");
    return { ok: worker, baza: true, worker, ...(szczegoly ? { szczegoly } : {}) };
  } catch {
    await klient.query("rollback").catch(() => {});
    return { ok: false, baza: false, worker: false };
  } finally {
    klient.release();
  }
}
