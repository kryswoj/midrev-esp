import { getPool } from "../../adapters/db/pool";
import { METRYKI_STRONY } from "../../domain/integracja/metryki-strony";
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

export async function rolaMetryki(tenantId: string, rola: string): Promise<string | null> {
  const { rows } = await getPool().query<{ metric_id: string }>("select metric_id from metric_mappings where tenant_id = $1 and role = $2", [tenantId, rola]);
  return rows[0]?.metric_id ?? null;
}
