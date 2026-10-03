import type { PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";
import { adapterSklepu } from "../../adapters/store/fabryka";
import { adresHttp } from "../../domain/katalog/feed";
import type { ProduktSklepu } from "../../domain/store/contract";

/**
 * Katalog z podłączonego sklepu (port „Sklep”, plan integracji E.4): `products` +
 * `product_variants` z `store_id` sklepu, źródło `api` (sync) albo `webhook` (product.*).
 *
 *   - produkt wycofany / szkic / usunięty = `active=false`, nigdy kasowanie (stare maile i
 *     zdarzenia go wskazują),
 *   - zapis tylko nowszą wersją ze źródła (`source_updated_at`), więc spóźniony webhook nie
 *     cofa ceny ustawionej przez nowszy sync,
 *   - adresy i obrazy wyłącznie http(s) (XSS/`javascript:` w nazwie albo linku nie przejdzie
 *     do bloku produktu), nazwy i opisy przycięte do limitów kolumn.
 */

const PACZKA = 200;

function przytnij(v: string | null | undefined, maks: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return t ? t.slice(0, maks) : null;
}

export async function zapiszProduktySklepu(
  klient: PoolClient,
  tenantId: string,
  storeId: string,
  produkty: ProduktSklepu[],
  zrodlo: "api" | "webhook",
): Promise<{ produkty: number; warianty: number }> {
  let ileP = 0;
  let ileW = 0;
  for (let i = 0; i < produkty.length; i += PACZKA) {
    const paczka = produkty.slice(i, i + PACZKA).map((p) => ({
      external_id: przytnij(p.externalId, 255),
      title: przytnij(p.nazwa, 500) ?? `Produkt ${p.externalId}`,
      url: adresHttp(p.url ?? null),
      image_url: adresHttp(p.obrazUrl ?? null),
      description_short: przytnij(p.opisKrotki ?? null, 5000),
      price_minor: Number.isFinite(p.cenaMinor) && p.cenaMinor >= 0 ? String(Math.round(p.cenaMinor)) : null,
      compare_at_minor: p.cenaPrzedMinor !== null && p.cenaPrzedMinor !== undefined && p.cenaPrzedMinor >= 0 ? String(Math.round(p.cenaPrzedMinor)) : null,
      currency: /^[A-Z]{3}$/.test(p.waluta) ? p.waluta : null,
      categories: (p.kategorie ?? []).map((k) => przytnij(k, 255)).filter((k): k is string => Boolean(k)).slice(0, 20),
      brand: przytnij(p.marka ?? null, 255),
      in_stock: p.wMagazynie ?? null,
      stock_qty: p.stan ?? null,
      active: p.aktywny !== false,
      source_updated_at: p.zmodyfikowaneAt ? p.zmodyfikowaneAt.toISOString() : null,
    })).filter((p) => p.external_id);
    if (!paczka.length) continue;
    const { rows } = await klient.query<{ id: string; external_id: string }>(
      `insert into products (tenant_id, store_id, external_id, source, title, url, image_url, description_short,
                             price_minor, compare_at_minor, currency, categories, brand, in_stock, stock_qty, active,
                             source_updated_at, synced_at)
       select $1, $2, x.external_id, $4, x.title, x.url, x.image_url, x.description_short,
              x.price_minor::bigint, x.compare_at_minor::bigint, x.currency, coalesce(x.categories, '{}'), x.brand,
              x.in_stock, x.stock_qty, x.active, x.source_updated_at, now()
         from jsonb_to_recordset($3::jsonb) as x(external_id text, title text, url text, image_url text, description_short text,
                                                 price_minor text, compare_at_minor text, currency text, categories text[],
                                                 brand text, in_stock boolean, stock_qty numeric, active boolean,
                                                 source_updated_at timestamptz)
       on conflict (tenant_id, store_id, external_id) do update set
         source = excluded.source, title = excluded.title, url = excluded.url, image_url = excluded.image_url,
         description_short = excluded.description_short, price_minor = excluded.price_minor,
         compare_at_minor = excluded.compare_at_minor, currency = excluded.currency, categories = excluded.categories,
         brand = excluded.brand, in_stock = excluded.in_stock, stock_qty = excluded.stock_qty, active = excluded.active,
         source_updated_at = excluded.source_updated_at, synced_at = excluded.synced_at
       -- payload bez wersji nie nadpisuje wiersza z wersją (review r1): inaczej cofałby katalog
       -- i zerował kursor, a każdy kolejny stary payload wygrywałby dalej
       where products.source_updated_at is null
          or (excluded.source_updated_at is not null and excluded.source_updated_at >= products.source_updated_at)
       returning id, external_id`,
      [tenantId, storeId, JSON.stringify(paczka), zrodlo],
    );
    ileP += rows.length;
    const idPo = new Map(rows.map((r) => [r.external_id, r.id]));
    for (const p of produkty.slice(i, i + PACZKA)) {
      const productId = idPo.get(p.externalId);
      if (!productId || !p.warianty) continue;
      const warianty = p.warianty
        .map((v) => ({
          external_id: przytnij(v.externalId, 255),
          sku: przytnij(v.sku, 255),
          title: przytnij(v.tytul, 500),
          url: adresHttp(v.url),
          image_url: adresHttp(v.obrazUrl),
          price_minor: v.cenaMinor !== null && v.cenaMinor >= 0 ? String(Math.round(v.cenaMinor)) : null,
          compare_at_minor: v.cenaPrzedMinor !== null && v.cenaPrzedMinor >= 0 ? String(Math.round(v.cenaPrzedMinor)) : null,
          in_stock: v.wMagazynie,
          stock_qty: v.stan,
          active: v.aktywny,
        }))
        .filter((v) => v.external_id);
      // warianty, których sklep już nie zwraca, wyłączamy (nie kasujemy)
      await klient.query(
        `update product_variants set active = false, synced_at = now()
          where tenant_id = $1 and product_id = $2 and not (external_id = any($3::text[]))`,
        [tenantId, productId, warianty.map((v) => v.external_id)],
      );
      if (!warianty.length) continue;
      const { rowCount } = await klient.query(
        `insert into product_variants (tenant_id, product_id, external_id, sku, title, url, image_url, price_minor,
                                       compare_at_minor, currency, in_stock, stock_qty, active, synced_at)
         select $1, $2, x.external_id, x.sku, x.title, x.url, x.image_url, x.price_minor::bigint, x.compare_at_minor::bigint,
                $4, x.in_stock, x.stock_qty, x.active, now()
           from jsonb_to_recordset($3::jsonb) as x(external_id text, sku text, title text, url text, image_url text,
                                                   price_minor text, compare_at_minor text, in_stock boolean, stock_qty numeric, active boolean)
         on conflict (tenant_id, product_id, external_id) do update set
           sku = excluded.sku, title = excluded.title, url = excluded.url, image_url = excluded.image_url,
           price_minor = excluded.price_minor, compare_at_minor = excluded.compare_at_minor, currency = excluded.currency,
           in_stock = excluded.in_stock, stock_qty = excluded.stock_qty, active = excluded.active, synced_at = excluded.synced_at`,
        [tenantId, productId, JSON.stringify(warianty), /^[A-Z]{3}$/.test(p.waluta) ? p.waluta : null],
      );
      ileW += rowCount ?? 0;
    }
  }
  return { produkty: ileP, warianty: ileW };
}

export interface WynikSynchronizacjiKatalogu {
  produkty: number;
  warianty: number;
  /** produkty z tego sklepu w bazie po synchronizacji (odczyt zwrotny) */
  wBazie: number;
  /** pełna = cały katalog; przyrost = od ostatniego kursora */
  tryb: "pelna" | "przyrost";
}

/**
 * Synchronizacja katalogu sklepu (pełna przy połączeniu, potem przyrostowa po dacie
 * modyfikacji ze źródła; kursor w `stores.sync_state.katalog`). Kursor przesuwamy na
 * MOMENT STARTU przebiegu, nie na koniec: produkt zmieniony w trakcie wejdzie w następnym.
 */
export async function synchronizujKatalogSklepu(
  tenantId: string,
  storeId: string,
  opcje: { pelna?: boolean; naStrone?: number } = {},
): Promise<WynikSynchronizacjiKatalogu> {
  const pool = getPool();
  const { adapter } = await adapterSklepu(tenantId, storeId);
  const { rows: st } = await pool.query<{ kursor: string | null }>(
    "select sync_state #>> '{katalog,kursor}' as kursor from stores where tenant_id = $1 and id = $2",
    [tenantId, storeId],
  );
  const kursor = !opcje.pelna && st[0]?.kursor ? new Date(st[0].kursor) : null;
  const start = new Date();
  const naStrone = opcje.naStrone ?? 50;
  let produkty = 0;
  let warianty = 0;
  for (let strona = 1; strona <= 10_000; strona++) {
    const wynik = await adapter.pobierzProdukty(strona, naStrone, kursor ? { zmienioneOd: kursor } : {});
    if (wynik.pozycje.length) {
      const klient = await pool.connect();
      try {
        await klient.query("begin");
        const w = await zapiszProduktySklepu(klient, tenantId, storeId, wynik.pozycje, "api");
        await klient.query("commit");
        produkty += w.produkty;
        warianty += w.warianty;
      } catch (b) {
        await klient.query("rollback").catch(() => {});
        throw b;
      } finally {
        klient.release();
      }
    }
    if (strona >= wynik.stron || wynik.pozycje.length === 0) break;
  }
  await pool.query(
    `update stores set sync_state = jsonb_set(sync_state, '{katalog}', $3::jsonb, true)
      where tenant_id = $1 and id = $2`,
    [tenantId, storeId, JSON.stringify({ kursor: start.toISOString(), ostatnio: new Date().toISOString(), produkty })],
  );
  const { rows } = await pool.query<{ n: number }>(
    "select count(*)::int as n from products where tenant_id = $1 and store_id = $2",
    [tenantId, storeId],
  );
  return { produkty, warianty, wBazie: rows[0].n, tryb: kursor ? "przyrost" : "pelna" };
}
