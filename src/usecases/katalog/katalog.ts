import type { PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";
import { BladPobierania, pobierzBezpiecznie, type OpcjePobierania } from "../../adapters/pobierz-bezpiecznie";
import { adresHttp, BladFeedu, parsujFeed, produktyZPozycji, type ProduktZFeedu } from "../../domain/katalog/feed";
import { naMinor } from "../../domain/zdarzenia/limity";

/**
 * Katalog produktów (plan integracji E.4): `products` + `product_variants`, wspólne dla
 * wszystkich źródeł. Tu: custom bez sklepu (`store_id IS NULL`):
 *   - feed Google Merchant odpytywany cyklicznie przez worker (domyślnie co 6 h),
 *   - uzupełnienie z Viewed Product z przeglądarki, gdy produktu jeszcze nie ma
 *     (nigdy nie nadpisuje wiersza z feedu).
 */

export const MAKS_BAJTOW_FEEDU = 25 * 1024 * 1024;
const PACZKA = 500;

export interface Feed {
  id: string;
  url: string;
  coIleGodzin: number;
  nastepne: Date;
  ostatnio: Date | null;
  status: "ok" | "blad" | "bez_zmian" | null;
  blad: string | null;
  produkty: number | null;
  warianty: number | null;
}

export async function feedTenanta(tenantId: string): Promise<Feed | null> {
  const { rows } = await getPool().query(
    `select id, url, interval_hours, next_run_at, last_run_at, last_status, last_error, last_products, last_variants
       from product_feeds where tenant_id = $1`,
    [tenantId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    url: r.url,
    coIleGodzin: r.interval_hours,
    nastepne: r.next_run_at,
    ostatnio: r.last_run_at,
    status: r.last_status,
    blad: r.last_error,
    produkty: r.last_products,
    warianty: r.last_variants,
  };
}

export class BladUstawienFeedu extends Error {}

/** Zapis adresu feedu (pusty = usunięcie). Nowy adres = pobranie przy najbliższym tiku workera. */
export async function zapiszFeed(tenantId: string, surowyUrl: string | null): Promise<Feed | null> {
  const url = surowyUrl?.trim() || null;
  if (!url) {
    await getPool().query("delete from product_feeds where tenant_id = $1", [tenantId]);
    return null;
  }
  if (!adresHttp(url) || url.length > 2000) throw new BladUstawienFeedu("Adres feedu musi zaczynać się od https:// (albo http://).");
  const u = new URL(url);
  if (u.username || u.password) throw new BladUstawienFeedu("Adres feedu nie może zawierać loginu ani hasła.");
  await getPool().query(
    `insert into product_feeds (tenant_id, url) values ($1, $2)
     on conflict (tenant_id) do update set
       url = excluded.url,
       next_run_at = case when product_feeds.url = excluded.url then product_feeds.next_run_at else now() end,
       etag = case when product_feeds.url = excluded.url then product_feeds.etag else null end,
       last_modified = case when product_feeds.url = excluded.url then product_feeds.last_modified else null end,
       updated_at = now()`,
    [tenantId, url],
  );
  return feedTenanta(tenantId);
}

export interface WynikImportuFeedu {
  status: "ok" | "blad" | "bez_zmian";
  produkty: number;
  warianty: number;
  wylaczone: number;
  pominiete: number;
  blad?: string;
}

async function walutaTenanta(tenantId: string): Promise<string> {
  const { rows } = await getPool().query<{ currency: string | null }>("select currency from tenants where id = $1", [tenantId]);
  return rows[0]?.currency ?? "PLN";
}

/** Zapis produktów z feedu: upsert paczkami, potem wyłączenie (active=false) tego, czego w feedzie już nie ma. */
export async function zapiszProduktyZFeedu(
  tenantId: string,
  produkty: ProduktZFeedu[],
): Promise<{ produkty: number; warianty: number; wylaczone: number }> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    await klient.query("select pg_advisory_xact_lock(hashtextextended('katalog-feed:' || $1::text, 0))", [tenantId]);
    const { rows: znacznik } = await klient.query<{ t: Date }>("select clock_timestamp() as t");
    const przebieg = znacznik[0].t;
    let ileProduktow = 0;
    let ileWariantow = 0;
    for (let i = 0; i < produkty.length; i += PACZKA) {
      const paczka = produkty.slice(i, i + PACZKA);
      const { rows } = await klient.query<{ id: string; external_id: string }>(
        `insert into products (tenant_id, store_id, external_id, source, title, url, image_url, description_short,
                               price_minor, compare_at_minor, currency, categories, brand, in_stock, active, synced_at)
         select $1, null, x.external_id, 'feed', x.title, x.url, x.image_url, x.description_short,
                x.price_minor::bigint, x.compare_at_minor::bigint, x.currency, coalesce(x.categories, '{}'), x.brand, x.in_stock, true, $3
           from jsonb_to_recordset($2::jsonb) as x(external_id text, title text, url text, image_url text, description_short text,
                                                   price_minor text, compare_at_minor text, currency text, categories text[], brand text, in_stock boolean)
         on conflict (tenant_id, store_id, external_id) do update set
           source = 'feed', title = excluded.title, url = excluded.url, image_url = excluded.image_url,
           description_short = excluded.description_short, price_minor = excluded.price_minor,
           compare_at_minor = excluded.compare_at_minor, currency = excluded.currency, categories = excluded.categories,
           brand = excluded.brand, in_stock = excluded.in_stock, active = true, synced_at = excluded.synced_at
         returning id, external_id`,
        [
          tenantId,
          JSON.stringify(
            paczka.map((p) => ({
              external_id: p.externalId,
              title: p.tytul,
              url: p.link,
              image_url: p.obraz,
              description_short: p.opis,
              price_minor: p.cenaMinor?.toString() ?? null,
              compare_at_minor: p.cenaPorownawczaMinor?.toString() ?? null,
              currency: p.waluta,
              categories: p.kategorie,
              brand: p.marka,
              in_stock: p.dostepny,
            })),
          ),
          przebieg,
        ],
      );
      ileProduktow += rows.length;
      const idPo = new Map(rows.map((r) => [r.external_id, r.id]));
      const warianty = paczka.flatMap((p) =>
        p.warianty.map((w, n) => ({
          product_id: idPo.get(p.externalId),
          external_id: w.externalId,
          sku: w.sku,
          ean: w.ean,
          title: w.tytul,
          url: w.link,
          image_url: w.obraz,
          price_minor: w.cenaMinor?.toString() ?? null,
          compare_at_minor: w.cenaPorownawczaMinor?.toString() ?? null,
          currency: w.waluta,
          in_stock: w.dostepny,
          is_default: n === 0,
        })),
      );
      const { rowCount } = await klient.query(
        `insert into product_variants (tenant_id, product_id, external_id, sku, ean, title, url, image_url, price_minor,
                                       compare_at_minor, currency, in_stock, is_default, active, synced_at)
         select $1, x.product_id, x.external_id, x.sku, x.ean, x.title, x.url, x.image_url, x.price_minor::bigint,
                x.compare_at_minor::bigint, x.currency, x.in_stock, x.is_default, true, $3
           from jsonb_to_recordset($2::jsonb) as x(product_id uuid, external_id text, sku text, ean text, title text, url text,
                                                   image_url text, price_minor text, compare_at_minor text, currency text,
                                                   in_stock boolean, is_default boolean)
          where x.product_id is not null
         on conflict (tenant_id, product_id, external_id) do update set
           sku = excluded.sku, ean = excluded.ean, title = excluded.title, url = excluded.url, image_url = excluded.image_url,
           price_minor = excluded.price_minor, compare_at_minor = excluded.compare_at_minor, currency = excluded.currency,
           in_stock = excluded.in_stock, is_default = excluded.is_default, active = true, synced_at = excluded.synced_at`,
        [tenantId, JSON.stringify(warianty), przebieg],
      );
      ileWariantow += rowCount ?? 0;
    }
    // Czego nie ma w tym przebiegu: active=false (nie kasujemy, stare maile je wskazują).
    // Zakres: TYLKO wiersze z feedu tego tenanta bez sklepu (punkt 7 listy kontrolnej).
    const { rowCount: wylaczone } = await klient.query(
      `update products set active = false
        where tenant_id = $1 and store_id is null and source = 'feed' and active and synced_at < $2`,
      [tenantId, przebieg],
    );
    await klient.query(
      `update product_variants v set active = false
         from products p
        where p.tenant_id = $1 and p.store_id is null and p.source = 'feed'
          and v.tenant_id = p.tenant_id and v.product_id = p.id and v.active and v.synced_at < $2`,
      [tenantId, przebieg],
    );
    await klient.query("commit");
    return { produkty: ileProduktow, warianty: ileWariantow, wylaczone: wylaczone ?? 0 };
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}

/**
 * Pobranie i import feedu jednego tenanta. Wynik (także błąd) zapisany w `product_feeds`
 * odczytem zwrotnym liczności z bazy, nie z liczby prób (lista kontrolna, pkt 4).
 */
export async function importujFeed(
  tenantId: string,
  opcjePobierania: Partial<OpcjePobierania> = {},
): Promise<WynikImportuFeedu | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ url: string; interval_hours: number; etag: string | null; last_modified: string | null }>(
    "select url, interval_hours, etag, last_modified from product_feeds where tenant_id = $1",
    [tenantId],
  );
  const feed = rows[0];
  if (!feed) return null;
  const zapiszStan = async (w: WynikImportuFeedu, etag?: string | null, lastModified?: string | null) => {
    await pool.query(
      `update product_feeds set last_run_at = now(), next_run_at = now() + make_interval(hours => interval_hours),
              last_status = $2, last_error = $3,
              last_products = case when $2 = 'ok' then $4 else last_products end,
              last_variants = case when $2 = 'ok' then $5 else last_variants end,
              etag = coalesce($6, etag), last_modified = coalesce($7, last_modified), updated_at = now()
        where tenant_id = $1 and url = $8`,
      [tenantId, w.status, w.blad?.slice(0, 500) ?? null, w.produkty, w.warianty, etag ?? null, lastModified ?? null, feed.url],
    );
  };
  try {
    const naglowki: Record<string, string> = {};
    if (feed.etag) naglowki["If-None-Match"] = feed.etag;
    if (feed.last_modified) naglowki["If-Modified-Since"] = feed.last_modified;
    const odp = await pobierzBezpiecznie(feed.url, { maksBajtow: MAKS_BAJTOW_FEEDU, limitCzasuMs: 60_000, naglowki, ...opcjePobierania });
    if (odp.status === 304) {
      const w: WynikImportuFeedu = { status: "bez_zmian", produkty: 0, warianty: 0, wylaczone: 0, pominiete: 0 };
      await zapiszStan(w);
      return w;
    }
    if (odp.status < 200 || odp.status >= 300) throw new BladFeedu(`Serwer feedu odpowiedział ${odp.status}.`);
    const wynik = parsujFeed(odp.tresc.toString("utf8"), await walutaTenanta(tenantId));
    if (wynik.pozycje.length === 0) throw new BladFeedu("Feed nie zawiera żadnego produktu z identyfikatorem i nazwą.");
    const zapis = await zapiszProduktyZFeedu(tenantId, produktyZPozycji(wynik.pozycje));
    // odczyt zwrotny: ile aktywnych produktów z feedu jest teraz w bazie
    const { rows: stan } = await pool.query<{ p: number; v: number }>(
      `select (select count(*)::int from products where tenant_id = $1 and store_id is null and source = 'feed' and active) as p,
              (select count(*)::int from product_variants v join products p on p.tenant_id = v.tenant_id and p.id = v.product_id
                where v.tenant_id = $1 and p.store_id is null and p.source = 'feed' and v.active) as v`,
      [tenantId],
    );
    const w: WynikImportuFeedu = {
      status: "ok",
      produkty: stan[0].p,
      warianty: stan[0].v,
      wylaczone: zapis.wylaczone,
      pominiete: wynik.pominiete,
      ...(wynik.obciety ? { blad: `Feed ma więcej niż ${wynik.pozycje.length} pozycji; wczytaliśmy pierwsze ${wynik.pozycje.length}.` } : {}),
    };
    const etag = typeof odp.naglowki.etag === "string" ? odp.naglowki.etag.slice(0, 300) : null;
    const lm = typeof odp.naglowki["last-modified"] === "string" ? odp.naglowki["last-modified"].slice(0, 100) : null;
    await zapiszStan(w, etag, lm);
    return w;
  } catch (b) {
    if (!(b instanceof BladPobierania) && !(b instanceof BladFeedu)) {
      const w: WynikImportuFeedu = { status: "blad", produkty: 0, warianty: 0, wylaczone: 0, pominiete: 0, blad: "Błąd wewnętrzny przy imporcie feedu." };
      await zapiszStan(w).catch(() => {});
      throw b;
    }
    const w: WynikImportuFeedu = { status: "blad", produkty: 0, warianty: 0, wylaczone: 0, pominiete: 0, blad: b.message };
    await zapiszStan(w);
    return w;
  }
}

/** Tik workera: feedy, którym minął termin (najwyżej `limit` na tik, pojedynczo). */
export async function tikFeedow(limit = 5): Promise<{ sprawdzone: number; bledy: number }> {
  const { rows } = await getPool().query<{ tenant_id: string }>(
    "select tenant_id from product_feeds where next_run_at <= now() order by next_run_at limit $1",
    [limit],
  );
  let bledy = 0;
  for (const r of rows) {
    try {
      const w = await importujFeed(r.tenant_id);
      if (w?.status === "blad") bledy++;
    } catch (b) {
      bledy++;
      console.error(`[katalog] feed tenanta ${r.tenant_id}: ${b instanceof Error ? b.message : "błąd"}`);
    }
  }
  return { sprawdzone: rows.length, bledy };
}

export async function statystykiKatalogu(tenantId: string): Promise<{ zFeedu: number; zPrzegladarki: number }> {
  const { rows } = await getPool().query<{ feed: number; viewed: number }>(
    `select count(*) filter (where source = 'feed')::int as feed, count(*) filter (where source = 'viewed')::int as viewed
       from products where tenant_id = $1 and store_id is null and active`,
    [tenantId],
  );
  return { zFeedu: rows[0].feed, zPrzegladarki: rows[0].viewed };
}

// ── Uzupełnienie z przeglądarki (Viewed Product) ────────────────────────────────────

function napis(v: unknown, maks: number): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return t ? t.slice(0, maks) : null;
}

/**
 * Viewed Product z przeglądarki zakłada produkt (source 'viewed'), gdy katalog go nie ma.
 * Dane pochodzą od dowolnej przeglądarki, więc: tylko adresy http(s), twarde długości, i NIGDY
 * nie nadpisujemy wiersza z innego źródła (feed/api/webhook). Wiersz 'viewed' odświeżamy
 * najwyżej raz na godzinę (ostatni widziany wygrywa: cena się zmienia).
 */
export async function uzupelnijKatalogZPrzegladarki(
  klient: PoolClient,
  tenantId: string,
  p: Record<string, unknown>,
  waluta: string | null,
): Promise<boolean> {
  const id = napis(p.ProductID ?? p.ItemId ?? p.product_id, 255);
  const tytul = napis(p.ProductName ?? p.Title ?? p.Name, 500);
  if (!id || !tytul) return false;
  let kod = (waluta ?? napis(p.Currency, 3) ?? "").toUpperCase();
  if (!kod) {
    const { rows } = await klient.query<{ currency: string }>("select currency from tenants where id = $1", [tenantId]);
    kod = rows[0]?.currency ?? "PLN";
  }
  const cena = /^[A-Z]{3}$/.test(kod) ? naMinor(p.Price ?? p.$value, kod) : null;
  const porownawcza = /^[A-Z]{3}$/.test(kod) ? naMinor(p.CompareAtPrice, kod) : null;
  const kategorie = Array.isArray(p.Categories)
    ? p.Categories.map((k) => napis(k, 120)).filter((k): k is string => Boolean(k)).slice(0, 20)
    : [];
  const { rowCount } = await klient.query(
    `insert into products (tenant_id, store_id, external_id, source, title, url, image_url, price_minor, compare_at_minor,
                           currency, categories, brand, active, synced_at)
     values ($1, null, $2, 'viewed', $3, $4, $5, $6, $7, $8, $9, $10, true, now())
     on conflict (tenant_id, store_id, external_id) do update set
       title = excluded.title, url = coalesce(excluded.url, products.url), image_url = coalesce(excluded.image_url, products.image_url),
       price_minor = coalesce(excluded.price_minor, products.price_minor), compare_at_minor = excluded.compare_at_minor,
       currency = coalesce(excluded.currency, products.currency), categories = excluded.categories,
       brand = coalesce(excluded.brand, products.brand), synced_at = now()
     where products.source = 'viewed' and products.synced_at < now() - interval '1 hour'`,
    [
      tenantId,
      id,
      tytul,
      adresHttp(napis(p.URL ?? p.Url ?? p.url, 2000)),
      adresHttp(napis(p.ImageURL ?? p.ImageUrl ?? p.image_url, 2000)),
      cena !== null && cena >= 0n ? cena.toString() : null,
      porownawcza !== null && porownawcza >= 0n ? porownawcza.toString() : null,
      cena !== null ? kod : null,
      kategorie,
      napis(p.Brand, 255),
    ],
  );
  return (rowCount ?? 0) > 0;
}
