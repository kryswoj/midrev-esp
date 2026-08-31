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
  opcje: { opoznienieSek?: number } = {},
) {
  const { rows } = await getPool().query(
    `insert into jobs (tenant_id, kind, payload, run_after)
     values ($1, $2, $3, now() + make_interval(secs => $4::int))
     returning id, created_at::text as token`,
    [tenantId, kind, JSON.stringify(payload), opcje.opoznienieSek ?? 0],
  );
  return rows[0] as { id: string; token: string };
}

export async function zajmijZadanie(workerId: string): Promise<Zadanie | null> {
  const { rows } = await getPool().query(
    `update jobs set status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
      where (id, created_at) in (
        select id, created_at from jobs
         where status = 'pending' and run_after <= now()
         order by run_after
         for update skip locked
         limit 1
      )
     returning id, created_at::text as token, tenant_id, kind, payload, attempts, max_attempts`,
    [workerId],
  );
  return (rows[0] as Zadanie) ?? null;
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
