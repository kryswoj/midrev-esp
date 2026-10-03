import type { PoolClient } from "pg";
import { hostWDomenach } from "../../adapters/token-mx";

/**
 * Dane bloku „Produkty z koszyka” (plan integracji E.5, R6) dla maila automatyzacji:
 *
 *   cart     = otwarty koszyk osoby z `carts` (token ze zdarzenia wyzwalającego ma pierwszeństwo),
 *              aktualny W CHWILI WYSYŁKI; koszyk zamknięty zakupem (`ordered`) = brak bloku,
 *   products = produkt(y) ze zdarzenia wyzwalającego (Viewed Product: `ProductID`, Added to Cart:
 *              `Items[]`), uzupełnione z katalogu.
 *
 * Produkt z katalogu oznaczony `active=false` (wycofany) nie trafia do maila. Adresy: z katalogu
 * albo z koszyka sklepu (zapisane po walidacji domeny); adres produktu wzięty WPROST ze zdarzenia
 * (custom: przeglądarka z kluczem publicznym) tylko na domenach strony/sklepu tenanta, żeby nikt
 * nie wstawił do maila linku phishingowego.
 */

export interface PozycjaMaila {
  title: string;
  qty: number;
  price: string;
  image_url: string | null;
  url: string | null;
}

export interface KontekstSklepuMaila {
  cart?: { items: PozycjaMaila[]; url: string | null; total: string } | null;
  products?: { items: PozycjaMaila[]; url: string | null } | null;
}

function kwota(minor: string | number | null | undefined, waluta: string | null): string {
  if (minor === null || minor === undefined || minor === "") return "";
  const n = Number(minor);
  if (!Number.isFinite(n)) return "";
  const kod = waluta && /^[A-Z]{3}$/.test(waluta) ? waluta : "PLN";
  const exp = kod === "JPY" || kod === "KRW" ? 0 : 2;
  try {
    return new Intl.NumberFormat("pl-PL", { style: "currency", currency: kod }).format(n / 10 ** exp);
  } catch {
    return (n / 10 ** exp).toFixed(exp);
  }
}

function http(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

interface WierszKatalogu {
  store_id: string | null;
  external_id: string;
  title: string;
  url: string | null;
  image_url: string | null;
  price_minor: string | null;
  currency: string | null;
  active: boolean;
}

async function katalog(klient: PoolClient, tenantId: string, ids: string[]): Promise<WierszKatalogu[]> {
  if (!ids.length) return [];
  const { rows } = await klient.query<WierszKatalogu>(
    `select store_id, external_id, title, url, image_url, price_minor::text, currency, active
       from products where tenant_id = $1 and external_id = any($2::text[])`,
    [tenantId, ids.slice(0, 50)],
  );
  return rows;
}

async function domenyTenanta(klient: PoolClient, tenantId: string): Promise<string[]> {
  const { rows } = await klient.query<{ d: string }>(
    `select unnest(link_domains) as d from site_keys where tenant_id = $1 and revoked_at is null
     union
     select regexp_replace(split_part(split_part(base_url, '://', 2), '/', 1), '^www\\.|:[0-9]+$', '', 'g') from stores where tenant_id = $1`,
    [tenantId],
  );
  return rows.map((r) => r.d).filter(Boolean);
}

export async function kontekstSklepuMaila(
  klient: PoolClient,
  tenantId: string,
  profileId: string,
  zdarzenie: Record<string, unknown> | null,
  potrzebne: { cart: boolean; products: boolean },
): Promise<KontekstSklepuMaila> {
  const wynik: KontekstSklepuMaila = {};
  if (potrzebne.cart) {
    const token = typeof zdarzenie?.$cart_token === "string" ? zdarzenie.$cart_token : null;
    const { rows } = await klient.query<{
      store_id: string | null;
      items: { product_id: string; title: string; qty: number; price_minor: string | null; image_url: string | null; url: string | null }[];
      value_minor: string | null;
      currency: string | null;
      recovery_url: string | null;
      base_url: string | null;
    }>(
      `select c.store_id, c.items, c.value_minor::text, c.currency, c.recovery_url, s.base_url
         from carts c left join stores s on s.tenant_id = c.tenant_id and s.id = c.store_id
        where c.tenant_id = $1 and c.profile_id = $2 and c.stage in ('cart', 'checkout')
          and c.updated_at > now() - interval '30 days'
        order by (c.platform_token = $3) desc, c.source_updated_at desc limit 1`,
      [tenantId, profileId, token],
    );
    const c = rows[0];
    if (c) {
      const kat = await katalog(klient, tenantId, (c.items ?? []).map((p) => String(p.product_id)));
      const items: PozycjaMaila[] = [];
      for (const p of c.items ?? []) {
        const k = kat.find((x) => x.external_id === String(p.product_id) && x.store_id === c.store_id);
        if (k && !k.active) continue;
        items.push({
          title: p.title || k?.title || "",
          qty: Number(p.qty) || 1,
          price: kwota(p.price_minor ?? k?.price_minor ?? null, c.currency ?? k?.currency ?? null),
          image_url: http(p.image_url) ?? http(k?.image_url),
          url: http(k?.url) ?? http(p.url),
        });
      }
      const sklep = c.base_url ? `${c.base_url.replace(/\/+$/, "")}/cart/` : null;
      wynik.cart = items.length ? { items, url: http(c.recovery_url) ?? http(sklep), total: kwota(c.value_minor, c.currency) } : null;
    } else {
      wynik.cart = null;
    }
  }
  if (potrzebne.products && zdarzenie) {
    const zEventu: Record<string, unknown>[] = Array.isArray(zdarzenie.Items)
      ? (zdarzenie.Items as unknown[]).filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
      : zdarzenie.ProductID !== undefined
        ? [zdarzenie]
        : [];
    const ids = zEventu.map((p) => String(p.ProductID ?? "")).filter(Boolean);
    const kat = await katalog(klient, tenantId, ids);
    const domeny = await domenyTenanta(klient, tenantId);
    const naDomenie = (u: unknown) => {
      const a = http(u);
      return a && hostWDomenach(new URL(a).hostname, domeny) ? a : null;
    };
    const items: PozycjaMaila[] = [];
    for (const p of zEventu) {
      const k = kat.find((x) => x.external_id === String(p.ProductID ?? ""));
      if (k && !k.active) continue;
      const tytul = k?.title ?? (typeof p.ProductName === "string" ? p.ProductName : "");
      if (!tytul) continue;
      const cena = typeof p.Price === "number" ? kwota(Math.round(p.Price * 100), "PLN") : typeof p.ItemPrice === "number" ? kwota(Math.round(p.ItemPrice * 100), "PLN") : "";
      items.push({
        title: tytul.slice(0, 500),
        qty: Number(p.Quantity) || 1,
        price: k?.price_minor ? kwota(k.price_minor, k.currency) : cena,
        image_url: http(k?.image_url) ?? naDomenie(p.ImageURL),
        url: http(k?.url) ?? naDomenie(p.URL ?? p.ProductURL),
      });
    }
    wynik.products = items.length ? { items: items.slice(0, 10), url: items[0].url } : null;
  }
  return wynik;
}
