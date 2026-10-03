import type { PoolClient } from "pg";

/**
 * Zgoda marketingowa e-mail ZE SKLEPU → rejestr `consents` (plan E.6, R9). Reguły wspólne:
 *   1. nowszy wypis wygrywa: zapis ze sklepu z datą równą albo starszą od naszego ostatniego
 *      wycofania albo wykluczenia sklepu (link wypisu) NIE przywraca zgody,
 *   2. konto w sklepie albo zakup to nie zgoda (tej funkcji woła się tylko z jawnym stanem
 *      zgody platformy: `subscribed` / checkbox zgody w checkoucie),
 *   3. zgoda bez treści klauzuli: źródło, data i poziom opt-in w `method_detail`,
 *   4. bez duplikatów: ten sam stan co ostatni wpis = nic nie zapisujemy.
 * Rejestr jest append-only; o tym, czy wolno wysłać, decyduje i tak `canSendTo`.
 *
 * Punkt scalenia z portem „Sklep” (agent Woo, R9): ta funkcja jest platformowo neutralna
 * (`zrodlo`), więc może zostać przeniesiona do wspólnego modułu bez zmian w Shopify.
 */
export async function zapiszZgodeZeSklepu(
  klient: PoolClient,
  w: {
    tenantId: string;
    profileId: string;
    stan: "granted" | "withdrawn";
    zrodlo: "shopify" | "woocommerce" | "shoper";
    kiedy: Date;
    szczegol: string;
  },
): Promise<"zapisana" | "pominieta"> {
  // blokada profilu: dwa równoległe webhooki zgody nie przeplotą odczytu i zapisu
  const { rows: p } = await klient.query<{ email: string | null }>(
    "select email from profiles where tenant_id = $1 and id = $2 for update",
    [w.tenantId, w.profileId],
  );
  if (!p[0]) return "pominieta";
  const { rows } = await klient.query<{ state: string | null; occurred_at: Date | null; wypis: Date | null }>(
    `select (select c.state from consents c where c.tenant_id = $1 and c.profile_id = $2 and c.channel = 'email'
              order by c.occurred_at desc, c.recorded_at desc limit 1) as state,
            (select c.occurred_at from consents c where c.tenant_id = $1 and c.profile_id = $2 and c.channel = 'email'
              order by c.occurred_at desc, c.recorded_at desc limit 1) as occurred_at,
            greatest(
              (select max(c.occurred_at) from consents c
                where c.tenant_id = $1 and c.profile_id = $2 and c.channel = 'email' and c.state = 'withdrawn'),
              (select max(ts.occurred_at) from tenant_suppressions ts
                where ts.tenant_id = $1 and ts.action = 'suppressed' and $3::text is not null
                  and lower(btrim(ts.email)) = lower(btrim($3)))
            ) as wypis`,
    [w.tenantId, w.profileId, p[0].email],
  );
  const ostatni = rows[0];
  if (ostatni.state === w.stan) return "pominieta";
  if (ostatni.occurred_at && ostatni.occurred_at.getTime() > w.kiedy.getTime()) return "pominieta";
  if (w.stan === "granted" && ostatni.wypis && ostatni.wypis.getTime() >= w.kiedy.getTime()) return "pominieta";
  await klient.query(
    `insert into consents (tenant_id, profile_id, channel, state, source, method_detail, occurred_at)
     values ($1, $2, 'email', $3, $4, $5, $6)`,
    [w.tenantId, w.profileId, w.stan, w.zrodlo, w.szczegol.slice(0, 500), w.kiedy],
  );
  return "zapisana";
}
