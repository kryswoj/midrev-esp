import { klientDla, sklepShopify } from "./sklep";

/**
 * Liczba zamówień w Shopify od daty (ekran i job zgodności danych, FR14). GraphQL `ordersCount`
 * z filtrem `created_at:>=`. Bez `read_all_orders` Shopify widzi tylko 60 dni, więc okno
 * zgodności (krótsze) jest bezpieczne.
 */
export async function policzZamowieniaShopify(tenantId: string, storeId: string, od: Date): Promise<number> {
  const sklep = await sklepShopify(tenantId, storeId);
  if (!sklep) throw new Error("sklep Shopify nie istnieje w tym tenancie");
  const d = await klientDla(sklep).zapytanie<{ ordersCount: { count: number } | null }>(
    `query ($q: String!) { ordersCount(query: $q, limit: null) { count } }`,
    { q: `created_at:>='${od.toISOString()}'` },
    2,
  );
  const n = d.ordersCount?.count;
  if (typeof n !== "number") throw new Error("Shopify nie podał liczby zamówień");
  return n;
}
