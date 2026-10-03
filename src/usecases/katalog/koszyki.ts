import type { PoolClient } from "pg";
import { hostWDomenach } from "../../adapters/token-mx";
import { adresHttp } from "../../domain/katalog/feed";
import { METRYKI_STRONY } from "../../domain/integracja/metryki-strony";
import { naMinor } from "../../domain/zdarzenia/limity";

/**
 * Stan koszyka i checkoutu z przeglądarki (plan integracji E.5, tabela `carts`) dla custom.
 *
 *   - Added to Cart: pozycja dodana scalana z koszykiem (ilość sumowana po ProductID),
 *     etap `cart` (koszyk po checkoutcie nie cofa się do `cart`),
 *   - Started Checkout: `Items` to pełna zawartość, zastępuje pozycje; etap `checkout`.
 *
 * Token koszyka: `CartToken`/`$cart_token` ze sklepu, inaczej identyfikator przeglądarki,
 * inaczej profil. `recovery_url` (CheckoutURL) przyjmujemy WYŁĄCZNIE na domenach strony
 * tenanta: obca przeglądarka nie może wstawić do maila „wróć do koszyka” linku phishingowego.
 */

const MAKS_POZYCJI = 50;

interface Pozycja {
  product_id: string;
  variant_id: string | null;
  title: string;
  qty: number;
  price_minor: string | null;
  image_url: string | null;
  url: string | null;
}

function napis(v: unknown, maks: number): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return t ? t.slice(0, maks) : null;
}

function ilosc(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 1;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 9999) : 1;
}

function pozycjaZ(o: Record<string, unknown>, waluta: string, prefiks = ""): Pozycja | null {
  const id = napis(o[`${prefiks}ProductID`], 255);
  const tytul = napis(o[`${prefiks}ProductName`], 500);
  if (!id || !tytul) return null;
  const cena = naMinor(o[`${prefiks}ItemPrice`] ?? o[`${prefiks}Price`], waluta);
  return {
    product_id: id,
    variant_id: napis(o[`${prefiks}VariantID`] ?? o[`${prefiks}SKU`], 255),
    title: tytul,
    qty: ilosc(o[`${prefiks}Quantity`]),
    price_minor: cena !== null && cena >= 0n ? cena.toString() : null,
    image_url: adresHttp(napis(o[`${prefiks}ImageURL`], 2000)),
    url: adresHttp(napis(o[`${prefiks}ProductURL`] ?? o[`${prefiks}URL`], 2000)),
  };
}

export async function zapiszKoszykZPrzegladarki(
  klient: PoolClient,
  w: {
    tenantId: string;
    profileId: string;
    anonymousId: string | null;
    metryka: string;
    properties: Record<string, unknown>;
    waluta: string;
    domeny: readonly string[];
    kiedy: Date;
  },
): Promise<boolean> {
  if (w.metryka !== METRYKI_STRONY.dodanoDoKoszyka && w.metryka !== METRYKI_STRONY.rozpoczetoZamowienie) return false;
  const p = w.properties;
  const token =
    napis(p.CartToken ?? p.$cart_token ?? p.CartID, 200) ??
    (w.anonymousId ? `przegladarka:${w.anonymousId.slice(0, 200)}` : `profil:${w.profileId}`);
  const checkout = w.metryka === METRYKI_STRONY.rozpoczetoZamowienie;
  const elementy = Array.isArray(p.Items) ? (p.Items as unknown[]) : [];
  const pelne = elementy
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x))
    .map((x) => pozycjaZ(x, w.waluta))
    .filter((x): x is Pozycja => x !== null)
    .slice(0, MAKS_POZYCJI);
  const dodana = checkout ? null : pozycjaZ(p, w.waluta, "AddedItem");
  if (!checkout && !dodana && pelne.length === 0) return false;
  const wartosc = naMinor(p.$value, w.waluta);
  const powrot = adresHttp(napis(p.CheckoutURL, 2000));
  const powrotDozwolony = powrot && hostWDomenach(new URL(powrot).hostname, w.domeny) ? powrot : null;

  const { rows } = await klient.query<{ items: Pozycja[]; stage: string }>(
    "select items, stage from carts where tenant_id = $1 and store_id is null and platform_token = $2 for update",
    [w.tenantId, token],
  );
  let pozycje: Pozycja[];
  if (checkout || (pelne.length > 0 && !dodana)) pozycje = pelne;
  else {
    pozycje = [...(rows[0]?.stage === "ordered" ? [] : (rows[0]?.items ?? []))];
    const i = pozycje.findIndex((x) => x.product_id === dodana!.product_id && x.variant_id === dodana!.variant_id);
    if (i >= 0) pozycje[i] = { ...pozycje[i], qty: Math.min(9999, pozycje[i].qty + dodana!.qty) };
    else pozycje.push(dodana!);
    pozycje = pozycje.slice(-MAKS_POZYCJI);
  }
  const etap = checkout ? "checkout" : rows[0]?.stage === "checkout" ? "checkout" : "cart";
  await klient.query(
    `insert into carts (tenant_id, store_id, platform_token, profile_id, anonymous_id, stage, items, value_minor, currency,
                        recovery_url, source_updated_at, updated_at)
     values ($1, null, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, now())
     on conflict (tenant_id, store_id, platform_token) do update set
       profile_id = excluded.profile_id, anonymous_id = coalesce(excluded.anonymous_id, carts.anonymous_id),
       stage = excluded.stage, items = excluded.items, value_minor = coalesce(excluded.value_minor, carts.value_minor),
       currency = excluded.currency, recovery_url = coalesce(excluded.recovery_url, carts.recovery_url),
       order_external_id = null, source_updated_at = excluded.source_updated_at, updated_at = now()`,
    [
      w.tenantId,
      token,
      w.profileId,
      w.anonymousId ? w.anonymousId.slice(0, 255) : null,
      etap,
      JSON.stringify(pozycje),
      wartosc !== null && wartosc >= 0n ? wartosc.toString() : null,
      w.waluta,
      powrotDozwolony,
      w.kiedy,
    ],
  );
  return true;
}

// ── Koszyki sklepu (port „Sklep”, E.5): wtyczka Woo, webhook Shopify `checkouts/*` ────────

/**
 * Stan koszyka zgłoszony przez SERWER sklepu (nie przeglądarkę). Klucz `(tenant, store, token)`.
 * Zapis tylko nowszym stanem (`source_updated_at`), więc spóźniona dostawa nie cofa koszyka.
 * Koszyk zamknięty zakupem (`ordered`) nie wraca do `cart` tym samym tokenem: sklep po zakupie
 * zakłada nowy token, a zaległe zdarzenie sprzed zakupu nie może „odkupić” koszyka.
 * `linkPowrotu` tylko na domenie sklepu (`hostSklepu`): obcy link w mailu „wróć do koszyka” to
 * phishing nawet przy podpisanym źródle (błąd w sklepie, przejęta wtyczka).
 */
export async function zapiszKoszykSklepu(
  klient: PoolClient,
  w: {
    tenantId: string;
    storeId: string;
    profileId: string | null;
    email: string | null;
    koszyk: import("../../domain/store/contract").KoszykSklepu;
    hostSklepu: string;
  },
): Promise<{ zapisany: boolean; cartId: string | null }> {
  const k = w.koszyk;
  let powrot: string | null = null;
  if (k.linkPowrotu) {
    try {
      const u = new URL(k.linkPowrotu);
      if ((u.protocol === "https:" || u.protocol === "http:") && hostWDomenach(u.hostname, [w.hostSklepu]) && k.linkPowrotu.length <= 2000) {
        powrot = u.toString();
      }
    } catch {
      powrot = null;
    }
  }
  // adres produktu tylko na domenie sklepu (review r1: podpisany payload nie wstawi obcego linku
  // do bloku „Produkty z koszyka”); obraz może być z CDN, ale wyłącznie http(s)
  const naDomenieSklepu = (v: string | null) => {
    const a = adresHttp(v);
    return a && hostWDomenach(new URL(a).hostname, [w.hostSklepu]) ? a : null;
  };
  const pozycje = k.pozycje.slice(0, MAKS_POZYCJI).map((p) => ({
    ...p,
    image_url: adresHttp(p.image_url),
    url: naDomenieSklepu(p.url),
  }));
  const { rows } = await klient.query<{ id: string }>(
    `insert into carts (tenant_id, store_id, platform_token, profile_id, email, stage, items, value_minor, currency,
                        recovery_url, source_updated_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, now())
     on conflict (tenant_id, store_id, platform_token) do update set
       profile_id = coalesce(excluded.profile_id, carts.profile_id),
       email = coalesce(excluded.email, carts.email),
       stage = case when carts.stage = 'checkout' and excluded.stage = 'cart' then 'checkout' else excluded.stage end,
       items = excluded.items, value_minor = excluded.value_minor, currency = coalesce(excluded.currency, carts.currency),
       recovery_url = coalesce(excluded.recovery_url, carts.recovery_url),
       source_updated_at = excluded.source_updated_at, updated_at = now()
     where carts.stage not in ('ordered', 'expired') and excluded.source_updated_at >= carts.source_updated_at
     returning id`,
    [
      w.tenantId,
      w.storeId,
      k.token,
      w.profileId,
      w.email,
      k.etap,
      JSON.stringify(pozycje),
      k.wartoscMinor !== null && k.wartoscMinor >= 0 ? String(k.wartoscMinor) : null,
      k.waluta,
      powrot,
      k.zmodyfikowaneAt,
    ],
  );
  return { zapisany: Boolean(rows[0]), cartId: rows[0]?.id ?? null };
}

/**
 * Zakup zamyka koszyk (E.5): dokładnie ten, którego token przyszedł z zamówieniem, oraz
 * otwarte koszyki tej osoby W TYM SAMYM SKLEPIE zmienione NIE PÓŹNIEJ niż złożenie zamówienia
 * (zakup z innego urządzenia albo bez tokenu). Koszyk w innym sklepie tenanta zostaje (review
 * r1), koszyk zmieniony po zamówieniu też (E2E: webhook spóźniony o kilka minut zamykał nowy
 * koszyk założony zaraz po zakupie, więc mail o nim by nie wyszedł). To dodatkowe, szybkie wyjście obok filtra E4b
 * „Placed Order od startu flow”: koszyk `ordered` nie trafi do bloku w mailu.
 */
export async function zamknijKoszykiZamowieniem(
  klient: PoolClient,
  tenantId: string,
  w: { storeId: string | null; profileId: string | null; token: string | null; orderExternalId: string; kiedy: Date },
): Promise<number> {
  if (!w.token && !w.profileId) return 0;
  const { rowCount } = await klient.query(
    `update carts set stage = 'ordered', order_external_id = $5, updated_at = now()
      where tenant_id = $1 and stage in ('cart', 'checkout')
        and (($3::text is not null and store_id is not distinct from $2::uuid and platform_token = $3)
             or ($4::uuid is not null and profile_id = $4 and store_id is not distinct from $2::uuid
                 and source_updated_at <= $6::timestamptz))`,
    [tenantId, w.storeId, w.token, w.profileId, w.orderExternalId, w.kiedy],
  );
  return rowCount ?? 0;
}
