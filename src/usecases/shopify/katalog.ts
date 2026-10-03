import type { PoolClient } from "pg";
import type { ProduktShopify } from "../../adapters/store/shopify/mapowanie";

/**
 * Katalog Shopify we wspólnych tabelach `products` / `product_variants` (0044, plan E.4),
 * z `store_id` sklepu. Upsert z webhooka i z importu bulk tym samym kodem. Webhook starszy od
 * zapisanego (`source_updated_at`) nie cofa danych (kolejność dostaw nie jest gwarantowana).
 * Usunięty produkt dostaje active=false, nigdy DELETE (stare maile i zdarzenia go wskazują).
 */
export async function zapiszProduktyShopify(
  klient: PoolClient,
  tenantId: string,
  storeId: string,
  produkty: ProduktShopify[],
  o: { zrodlo: "api" | "webhook"; waluta: string; znacznik: Date },
): Promise<{ produkty: number; warianty: number }> {
  let ileP = 0;
  let ileW = 0;
  for (const p of produkty) {
    const ceny = p.warianty.map((w) => w.cenaMinor).filter((c): c is number => c !== null);
    const najnizsza = ceny.length ? Math.min(...ceny) : null;
    const wariantNajtanszy = p.warianty.find((w) => w.cenaMinor === najnizsza) ?? null;
    const stan = p.warianty.reduce<number | null>((s, w) => (w.stan === null ? s : (s ?? 0) + w.stan), null);
    const { rows } = await klient.query<{ id: string }>(
      `insert into products (tenant_id, store_id, external_id, source, title, url, image_url, description_short,
                             price_minor, compare_at_minor, currency, categories, brand, in_stock, stock_qty, active,
                             source_updated_at, synced_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       on conflict (tenant_id, store_id, external_id) do update set
         source = excluded.source, title = excluded.title, url = coalesce(excluded.url, products.url),
         image_url = excluded.image_url, description_short = excluded.description_short, price_minor = excluded.price_minor,
         compare_at_minor = excluded.compare_at_minor, currency = excluded.currency, categories = excluded.categories,
         brand = excluded.brand, in_stock = excluded.in_stock, stock_qty = excluded.stock_qty, active = excluded.active,
         source_updated_at = excluded.source_updated_at, synced_at = excluded.synced_at
       where excluded.source_updated_at is null or products.source_updated_at is null
          or excluded.source_updated_at >= products.source_updated_at
       returning id`,
      [
        tenantId,
        storeId,
        p.externalId,
        o.zrodlo,
        p.tytul,
        p.url,
        p.obraz,
        p.opis,
        najnizsza,
        wariantNajtanszy?.porownawczaMinor ?? null,
        o.waluta,
        p.kategorie,
        p.marka,
        stan === null ? null : stan > 0,
        stan,
        p.aktywny,
        p.zmieniony,
        o.znacznik,
      ],
    );
    const id = rows[0]?.id;
    if (!id) continue;
    ileP++;
    for (const [n, w] of p.warianty.entries()) {
      await klient.query(
        `insert into product_variants (tenant_id, product_id, external_id, sku, ean, title, url, image_url, price_minor,
                                       compare_at_minor, currency, in_stock, stock_qty, is_default, active, synced_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15)
         on conflict (tenant_id, product_id, external_id) do update set
           sku = excluded.sku, ean = excluded.ean, title = excluded.title, url = excluded.url, image_url = excluded.image_url,
           price_minor = excluded.price_minor, compare_at_minor = excluded.compare_at_minor, currency = excluded.currency,
           in_stock = excluded.in_stock, stock_qty = excluded.stock_qty, is_default = excluded.is_default, active = true,
           synced_at = excluded.synced_at`,
        [
          tenantId,
          id,
          w.externalId,
          w.sku,
          w.ean,
          w.tytul,
          p.url ? `${p.url}?variant=${encodeURIComponent(w.externalId)}` : null,
          w.obraz ?? p.obraz,
          w.cenaMinor,
          w.porownawczaMinor,
          o.waluta,
          w.stan === null ? null : w.stan > 0,
          w.stan,
          n === 0,
          o.znacznik,
        ],
      );
      ileW++;
    }
    // warianty usunięte w Shopify: nieaktywne (tylko tego produktu, tylko starsze niż ten zapis)
    await klient.query(
      `update product_variants set active = false
        where tenant_id = $1 and product_id = $2 and active and synced_at < $3`,
      [tenantId, id, o.znacznik],
    );
  }
  return { produkty: ileP, warianty: ileW };
}

export async function wylaczProduktShopify(klient: PoolClient, tenantId: string, storeId: string, externalId: string): Promise<number> {
  const { rowCount } = await klient.query(
    `update products set active = false, synced_at = now()
      where tenant_id = $1 and store_id = $2 and external_id = $3 and active`,
    [tenantId, storeId, externalId],
  );
  return rowCount ?? 0;
}
