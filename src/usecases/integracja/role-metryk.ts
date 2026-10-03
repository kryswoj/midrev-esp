import type { Pool, PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";
import { METRYKI_STRONY } from "../../domain/integracja/metryki-strony";
import { ROLE_ZAMOWIEN, type PlatformaSklepu, type RolaMetryki } from "../../domain/store/contract";
import { metrykaZamowienia } from "../../domain/zdarzenia/kontrakt";
import { metrykaPoKluczu } from "../zdarzenia/metryki";

/**
 * Role metryk (plan integracji E.3, tabela `metric_mappings`): szablon flow wskazuje rolę
 * („porzucony checkout” = rola started_checkout), a podłączenie sklepu ustawia, która
 * metryka ją pełni. Custom: metryki przeglądarki pod integracją `midrev`.
 *
 * Nie nadpisuje roli ustawionej wcześniej przez inną integrację (np. Shopify ma Started
 * Checkout z webhooka serwerowego, lepszy niż z przeglądarki).
 */
const ROLE_STRONY: [string, string][] = [
  ["viewed_product", METRYKI_STRONY.ogladanyProdukt],
  ["added_to_cart", METRYKI_STRONY.dodanoDoKoszyka],
  ["started_checkout", METRYKI_STRONY.rozpoczetoZamowienie],
  ["active_on_site", METRYKI_STRONY.aktywnyNaStronie],
];

export async function ustawRoleMetrykStrony(tenantId: string): Promise<number> {
  const pool = getPool();
  let ustawione = 0;
  for (const [rola, nazwa] of ROLE_STRONY) {
    const m = await metrykaPoKluczu(pool, tenantId, { integracja: "midrev", nazwa }, { utworz: true, wbudowana: true, mozeWyzwalac: true, ukryta: false });
    if (!m) continue;
    const { rowCount } = await pool.query(
      `insert into metric_mappings (tenant_id, role, metric_id) values ($1, $2, $3) on conflict (tenant_id, role) do nothing`,
      [tenantId, rola, m.id],
    );
    ustawione += rowCount ?? 0;
  }
  return ustawione;
}

/**
 * Role zamówień przy podłączeniu sklepu (port „Sklep”): placed_order, ordered_product,
 * fulfilled/cancelled/refunded wskazują metryki platformy. Sklep jest źródłem prawdy o
 * zamówieniach, więc NADPISUJE rolę ustawioną wcześniej (np. przez API); drugi sklep tego
 * samego tenanta przejmuje role (ostatnio podłączony wygrywa, jak w Klaviyo „primary store”).
 */
export async function ustawRoleSklepu(db: Pool | PoolClient, tenantId: string, platforma: Exclude<PlatformaSklepu, "custom"> | "custom"): Promise<number> {
  let ustawione = 0;
  for (const rola of ROLE_ZAMOWIEN) {
    const def = metrykaZamowienia(platforma, rola);
    const m = await metrykaPoKluczu(db, tenantId, def, { utworz: true, wbudowana: true, mozeWyzwalac: true, ukryta: false });
    if (!m) continue;
    const { rowCount } = await db.query(
      `insert into metric_mappings (tenant_id, role, metric_id) values ($1, $2, $3)
       on conflict (tenant_id, role) do update set metric_id = excluded.metric_id, updated_at = now()
       where metric_mappings.metric_id is distinct from excluded.metric_id`,
      [tenantId, rola, m.id],
    );
    ustawione += rowCount ?? 0;
  }
  return ustawione;
}

/** Metryka pełniąca rolę: klucz naturalny (integracja, nazwa) albo null, gdy rola nieustawiona. */
export async function metrykaRoli(db: Pool | PoolClient, tenantId: string, rola: RolaMetryki): Promise<{ id: string; integracja: string; nazwa: string } | null> {
  const { rows } = await db.query<{ id: string; integration_key: string; name: string }>(
    `select m.id, m.integration_key, m.name from metric_mappings mm
       join metrics m on m.tenant_id = mm.tenant_id and m.id = mm.metric_id
      where mm.tenant_id = $1 and mm.role = $2`,
    [tenantId, rola],
  );
  return rows[0] ? { id: rows[0].id, integracja: rows[0].integration_key, nazwa: rows[0].name } : null;
}

export async function rolaMetryki(tenantId: string, rola: string): Promise<string | null> {
  const { rows } = await getPool().query<{ metric_id: string }>("select metric_id from metric_mappings where tenant_id = $1 and role = $2", [tenantId, rola]);
  return rows[0]?.metric_id ?? null;
}
