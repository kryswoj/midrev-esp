import { getPool } from "../../adapters/db/pool";

/**
 * Limit dobowy wysyłki tenanta (FR52) — odczyt i zapis z ekranu „Wysyłka i domeny".
 *
 * Do tej pory limit żył wyłącznie w silniku (`tenant_send_limits`, domyślnie 500) i nikt
 * w panelu go nie widział: kampania Black Friday do 10 tys. osób rozkładała się na 20 dni
 * bez żadnego komunikatu (audyt 24.09, #5). Tu jest jedno miejsce, które mówi, ile dziś
 * wolno, ile już poszło i jak limit rampować.
 *
 * Wiążący jest nadal silnik: rezerwacja miejsca w `tenant_send_usage` w transakcji
 * przejścia queued → sending. Ten plik tylko ustawia liczbę, którą tamta rezerwacja
 * porównuje.
 */

export const LIMIT_DOMYSLNY = 500;
export const LIMIT_MAKSYMALNY = 200_000;

/**
 * Plan rampowania dla nowej domeny/serwera (rozgrzewka). Liczby z praktyki dostawców
 * skrzynek: Gmail i Microsoft oceniają nadawcę po pierwszych dniach wolumenu i skokowy
 * start z zera do dziesięciu tysięcy kończy się w spamie na tygodnie. Tabela jest
 * PODPOWIEDZIĄ na ekranie, nie automatem — operator ustawia limit ręcznie i widzi,
 * gdzie w rampie jest.
 */
export const RAMPA = [
  { dzien: "1–2", limit: 500 },
  { dzien: "3–4", limit: 1_000 },
  { dzien: "5–6", limit: 2_000 },
  { dzien: "7–9", limit: 5_000 },
  { dzien: "10–13", limit: 10_000 },
  { dzien: "14+", limit: 20_000 },
] as const;

export interface WidokLimitu {
  limit: number;
  /** true, gdy tenant nie ma własnego wiersza i obowiązuje wartość domyślna silnika */
  domyslny: boolean;
  zuzyteDzis: number;
  wolneDzis: number;
  /** ile wiadomości czeka w kolejce tenanta (queued) — razem z limitem daje „ile dni" */
  wKolejce: number;
  zmienionoAt: Date | null;
}

export async function odczytajLimit(tenantId: string): Promise<WidokLimitu> {
  const { rows } = await getPool().query(
    `select l.daily_limit, l.updated_at,
            coalesce((select used from tenant_send_usage u where u.tenant_id = $1 and u.day = current_date), 0)::int as zuzyte,
            (select count(*)::int from messages m where m.tenant_id = $1 and m.current_state = 'queued') as w_kolejce
       from (select 1) x
       left join tenant_send_limits l on l.tenant_id = $1`,
    [tenantId],
  );
  const w = rows[0];
  const limit: number = w?.daily_limit ?? LIMIT_DOMYSLNY;
  const zuzyte: number = w?.zuzyte ?? 0;
  return {
    limit,
    domyslny: w?.daily_limit == null,
    zuzyteDzis: zuzyte,
    wolneDzis: Math.max(0, limit - zuzyte),
    wKolejce: w?.w_kolejce ?? 0,
    zmienionoAt: w?.updated_at ?? null,
  };
}

/** Zapis z odczytem zwrotnym. Wartość poza zakresem to komunikat, nie cichy „clamp". */
export async function zapiszLimit(
  tenantId: string,
  surowy: string,
): Promise<{ ok: true; limit: number } | { ok: false; blad: string }> {
  const tekst = surowy.replace(/\s/g, "");
  if (!/^\d{1,7}$/.test(tekst)) return { ok: false, blad: "Limit dobowy musi być liczbą całkowitą, np. 2000." };
  const limit = Number(tekst);
  if (limit < 1) return { ok: false, blad: "Limit dobowy musi być większy od zera. Żeby zatrzymać wysyłkę, wstrzymaj kampanię albo sklep." };
  if (limit > LIMIT_MAKSYMALNY) {
    return { ok: false, blad: `Limit dobowy nie może przekraczać ${LIMIT_MAKSYMALNY.toLocaleString("pl-PL")} — powyżej tego dostawcy skrzynek i tak dławią nadawcę.` };
  }
  const pool = getPool();
  await pool.query(
    `insert into tenant_send_limits (tenant_id, daily_limit, updated_at) values ($1, $2, now())
     on conflict (tenant_id) do update set daily_limit = excluded.daily_limit, updated_at = now()`,
    [tenantId, limit],
  );
  const { rows } = await pool.query("select daily_limit from tenant_send_limits where tenant_id = $1", [tenantId]);
  if (rows[0]?.daily_limit !== limit) {
    return { ok: false, blad: "Zapis limitu nie zgadza się z odczytem z bazy." };
  }
  return { ok: true, limit };
}
