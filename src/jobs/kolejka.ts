import type { Pool, PoolClient } from "pg";
import { getPool } from "../adapters/db/pool";

/**
 * Kolejka na Postgresie (AD-5, AD-31).
 *
 * Zajęcie zadania to JEDEN atomowy UPDATE, nie select-a-potem-update. Tożsamość zadania
 * to para (id, created_at) i created_at krąży jako TEKST prosto z bazy: Postgres trzyma
 * mikrosekundy, JavaScriptowy Date tylko milisekundy, więc przejście przez Date psuje
 * klucz i zadanie nie daje się domknąć. To jest wykryte testem, nie teorią.
 */
export interface Zadanie {
  id: string;
  token: string;
  tenant_id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function dodajZadanie(
  tenantId: string,
  kind: string,
  payload: Record<string, unknown> = {},
  // `przez` pozwala dopisać job w CUDZEJ transakcji (np. webhook: zapis surowego
  // zdarzenia i job muszą wejść albo razem, albo wcale - inaczej retry nadawcy
  // trafia w idempotencję zapisu i zdarzenie zostaje bez jobu na zawsze)
  opcje: { opoznienieSek?: number; przez?: Pool | PoolClient } = {},
) {
  const wykonawca = opcje.przez ?? getPool();
  const { rows } = await wykonawca.query(
    `insert into jobs (tenant_id, kind, payload, run_after)
     values ($1, $2, $3, now() + make_interval(secs => $4::int))
     returning id, created_at::text as token`,
    [tenantId, kind, JSON.stringify(payload), opcje.opoznienieSek ?? 0],
  );
  return rows[0] as { id: string; token: string };
}

export async function zajmijZadanie(workerId: string): Promise<Zadanie | null> {
  const { rows } = await getPool().query(
    // CTE MATERIALIZED zamiast `in (subquery)`: przy planie z Nested Loop podzapytanie z
    // LIMIT + SKIP LOCKED wykonuje sie wielokrotnie i zajmuje wiecej niz jedno zadanie;
    // nadmiarowe zostawaly `running` bez wykonawcy az do odzyskania zombie.
    `with kandydat as materialized (
        select id, created_at from jobs
         where status = 'pending' and run_after <= now()
         order by run_after
         for update skip locked
         limit 1
      )
     update jobs set status = 'running', locked_at = now(), locked_by = $1, attempts = jobs.attempts + 1
       from kandydat k
      where jobs.id = k.id and jobs.created_at = k.created_at
     returning jobs.id, jobs.created_at::text as token, jobs.tenant_id, jobs.kind, jobs.payload, jobs.attempts, jobs.max_attempts`,
    [workerId],
  );
  return (rows[0] as Zadanie) ?? null;
}

/**
 * Heartbeat zadania (W5): worker co minutę odświeża locked_at swojego running.
 * Dzięki temu recovery zombie może po locked_at odróżnić martwy worker od handlera,
 * który po prostu pracuje długo (kampania z partiami przez SMTP idzie godzinami).
 * Zwraca false, gdy zadanie nie należy już do tego workera (odzyskane jako zombie).
 */
export async function odswiezHeartbeat(zadanie: Zadanie, workerId: string): Promise<boolean> {
  const wynik = await getPool().query(
    `update jobs set locked_at = now()
      where id = $1 and created_at = $2::timestamptz and status = 'running' and locked_by = $3`,
    [zadanie.id, zadanie.token, workerId],
  );
  return (wynik.rowCount ?? 0) > 0;
}

export async function domknijZadanie(zadanie: Zadanie, workerId: string) {
  // guard wlasciciela: zombie odzyskany przez inny worker nie moze zostac domkniety
  // przez proces, ktory go dawno stracil (znalezisko z review)
  await getPool().query(
    `update jobs set status = 'done', locked_at = null
      where id = $1 and created_at = $2::timestamptz and status = 'running' and locked_by = $3`,
    [zadanie.id, zadanie.token, workerId],
  );
}

export async function odlozZadanie(zadanie: Zadanie, blad: string, workerId: string) {
  const wyczerpane = zadanie.attempts >= zadanie.max_attempts;
  // rosnacy odstep z twardym sufitem doby i jitterem: bez capa 4^n przelewa int4,
  // a bez jittera wszystkie ponowienia wracaja jedna fala (znalezisko z review)
  const surowy = 30 * Math.pow(4, Math.min(zadanie.attempts - 1, 8));
  const odstepSek = Math.min(surowy + Math.floor(Math.random() * 15), 86_400);
  await getPool().query(
    `update jobs set status = $3, locked_at = null, last_error = $4,
            run_after = now() + make_interval(secs => $5::int)
      where id = $1 and created_at = $2::timestamptz and status = 'running' and locked_by = $6`,
    [zadanie.id, zadanie.token, wyczerpane ? "failed" : "pending", blad, wyczerpane ? 0 : odstepSek, workerId],
  );
  return wyczerpane;
}

/**
 * Oddanie zadania do kolejki BEZ zużycia próby (zamykanie workera, SIGTERM). Zajęcie
 * podbiło `attempts`, więc je cofamy: przerwanie przez deploy to nie jest porażka
 * zadania, a pięć restartów w trakcie kampanii nie może jej zabić „wyczerpanymi próbami".
 * Guard właściciela jak w domknijZadanie: zadanie odzyskane przez innego workera
 * nie jest ruszane.
 */
export async function zwolnijZadanie(zadanie: Zadanie, workerId: string): Promise<boolean> {
  const wynik = await getPool().query(
    `update jobs set status = 'pending', locked_at = null, locked_by = null,
            attempts = greatest(attempts - 1, 0), run_after = now()
      where id = $1 and created_at = $2::timestamptz and status = 'running' and locked_by = $3`,
    [zadanie.id, zadanie.token, workerId],
  );
  return (wynik.rowCount ?? 0) > 0;
}
