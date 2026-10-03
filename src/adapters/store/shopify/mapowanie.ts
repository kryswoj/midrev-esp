import type { KlientSklepu, PozycjaZamowienia, ZamowienieSklepu } from "../../../domain/store/contract";
import { naMinor } from "../../../domain/zdarzenia/limity";

/**
 * Mapowanie Shopify → wspólny kontrakt sklepu (AD-8). Dwa kształty wejścia:
 *   - webhook (JSON w kształcie REST: `id`, `created_at`, `line_items`, ceny jako napisy),
 *   - Bulk Operations / GraphQL (`legacyResourceId`, `createdAt`, `...Set.shopMoney.amount`).
 * Oba kończą w tych samych typach domenowych, z datami ZE ŹRÓDŁA (AD-10): brak daty = błąd
 * mapowania, nigdy `now()`.
 *
 * Status zamówienia sprowadzamy do słownika, którego używa reszta systemu (przychód liczy
 * `completed` + `processing` w raportach, segmentach, atrybucji i warunkach flow):
 *   anulowane (cancelled_at / voided)         → cancelled
 *   w pełni zwrócone (refunded)               → refunded
 *   opłacone (paid / partially_refunded)      → completed (wysłane w całości) albo processing
 *   reszta (pending, authorized, expired...)  → pending
 * Surowy status Shopify zostaje w `surowe`.
 */

export class BladMapowaniaShopify extends Error {}

function data(v: unknown, pole: string, id: string): Date {
  if (typeof v !== "string" || !v) throw new BladMapowaniaShopify(`Shopify ${id}: brak ${pole} - nie zapisuję bez daty ze źródła`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BladMapowaniaShopify(`Shopify ${id}: nieczytelne ${pole}`);
  return d;
}

function minor(v: unknown, waluta: string): number {
  const m = naMinor(typeof v === "number" ? v : typeof v === "string" ? v : "0", waluta);
  return m === null ? 0 : Number(m);
}

function minorAlboNull(v: unknown, waluta: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const m = naMinor(v, waluta);
  return m === null ? null : Number(m);
}

const napis = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** id z GID (`gid://shopify/Order/123`) albo liczby → "123". */
export function idZGid(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string" || !v) return null;
  const m = /\/(\d+)(?:\?.*)?$/.exec(v);
  return m ? m[1] : /^\d+$/.test(v) ? v : null;
}

export function statusZamowienia(o: { anulowane: boolean; finansowy: string | null; wysylka: string | null }): string {
  const f = (o.finansowy ?? "").toLowerCase();
  const w = (o.wysylka ?? "").toLowerCase();
  if (o.anulowane || f === "voided") return "cancelled";
  if (f === "refunded") return "refunded";
  if (f === "paid" || f === "partially_refunded") return w === "fulfilled" ? "completed" : "processing";
  return "pending";
}

// ── webhook (kształt REST) ────────────────────────────────────────────────────────────

/** orders/create|updated|paid|fulfilled|cancelled */
export function zamowienieZWebhooka(z: any): ZamowienieSklepu {
  const id = idZGid(z?.id);
  if (!id) throw new BladMapowaniaShopify("zamówienie Shopify bez id");
  const waluta = napis(z.currency) ?? napis(z.presentment_currency) ?? "PLN";
  const utworzone = data(z.created_at, "created_at", `zamówienie ${id}`);
  const zmienione = z.updated_at ? data(z.updated_at, "updated_at", `zamówienie ${id}`) : utworzone;
  const pozycje: PozycjaZamowienia[] = (Array.isArray(z.line_items) ? z.line_items : []).map((p: any, i: number) => {
    const ilosc = Number(p?.quantity ?? 1);
    const cena = minor(p?.price, waluta);
    const rabat = minorAlboNull(p?.total_discount, waluta) ?? 0;
    return {
      sku: napis(p?.sku),
      nazwa: napis(p?.name) ?? napis(p?.title) ?? `pozycja ${i + 1}`,
      ilosc: Number.isFinite(ilosc) ? ilosc : 1,
      cenaMinor: cena,
      lineId: idZGid(p?.id),
      productId: idZGid(p?.product_id),
      sumaMinor: Math.max(0, cena * (Number.isFinite(ilosc) ? ilosc : 1) - rabat),
    };
  });
  const klient = z.customer ?? {};
  const rozliczenie = z.billing_address ?? {};
  return {
    externalId: id,
    numer: napis(z.name) ?? napis(z.order_number),
    status: statusZamowienia({ anulowane: Boolean(z.cancelled_at), finansowy: napis(z.financial_status), wysylka: napis(z.fulfillment_status) }),
    email: napis(z.email) ?? napis(z.contact_email) ?? napis(klient.email),
    imie: napis(klient.first_name) ?? napis(rozliczenie.first_name),
    nazwisko: napis(klient.last_name) ?? napis(rozliczenie.last_name),
    // bieżąca suma (po zwrotach i edycjach); brak = suma pierwotna
    sumaMinor: minor(z.current_total_price ?? z.total_price, waluta),
    waluta,
    occurredAt: utworzone,
    zmodyfikowaneAt: zmienione,
    pozycje,
    surowe: z,
  };
}

/** customers/create|update */
export function klientZWebhooka(k: any): KlientSklepu {
  const id = idZGid(k?.id);
  if (!id) throw new BladMapowaniaShopify("klient Shopify bez id");
  const utworzony = data(k.created_at, "created_at", `klient ${id}`);
  return {
    externalId: id,
    email: napis(k.email),
    imie: napis(k.first_name),
    nazwisko: napis(k.last_name),
    telefon: napis(k.phone) ?? napis(k.default_address?.phone),
    occurredAt: utworzony,
    zmodyfikowaneAt: k.updated_at ? data(k.updated_at, "updated_at", `klient ${id}`) : utworzony,
    surowe: k,
  };
}

// ── zgody ─────────────────────────────────────────────────────────────────────────────

export type StanZgodyShopify = "granted" | "withdrawn" | null;

/**
 * Stan zgody e-mail Shopify → nasz rejestr. `subscribed` = zgoda; `unsubscribed` i
 * `redacted` = wycofanie; `not_subscribed`, `pending` (czeka na potwierdzenie double opt-in),
 * `invalid` = brak decyzji (nic nie zapisujemy). Wielkość liter bez znaczenia (GraphQL: SUBSCRIBED).
 */
export function stanZgody(stan: unknown): StanZgodyShopify {
  const s = typeof stan === "string" ? stan.toLowerCase() : "";
  if (s === "subscribed") return "granted";
  if (s === "unsubscribed" || s === "redacted") return "withdrawn";
  return null;
}

export interface ZgodaShopify {
  customerId: string | null;
  email: string | null;
  stan: StanZgodyShopify;
  poziom: string | null;
  kiedy: Date | null;
}

/** customers_email_marketing_consent/update: {customer_id, email_address, email_marketing_consent{...}} */
export function zgodaZWebhooka(p: any): ZgodaShopify {
  const z = p?.email_marketing_consent ?? {};
  const kiedy = typeof z.consent_updated_at === "string" ? new Date(z.consent_updated_at) : null;
  return {
    customerId: idZGid(p?.customer_id ?? p?.id),
    email: napis(p?.email_address) ?? napis(p?.email),
    stan: stanZgody(z.state),
    poziom: napis(z.opt_in_level),
    kiedy: kiedy && !Number.isNaN(kiedy.getTime()) ? kiedy : null,
  };
}

// ── checkout i koszyk ─────────────────────────────────────────────────────────────────

export interface PozycjaKoszyka {
  product_id: string;
  variant_id: string | null;
  title: string;
  qty: number;
  price_minor: string | null;
  image_url: string | null;
  url: string | null;
}

export interface CheckoutShopify {
  token: string;
  cartToken: string | null;
  email: string | null;
  imie: string | null;
  nazwisko: string | null;
  customerId: string | null;
  zgodaMarketingowa: boolean;
  /** link powrotu do porzuconego checkoutu, wyłącznie https na domenie sklepu (sprawdza wołający) */
  linkPowrotu: string | null;
  pozycje: PozycjaKoszyka[];
  wartoscMinor: number | null;
  waluta: string;
  utworzony: Date;
  zmieniony: Date;
  zakonczony: boolean;
}

function adresHttps(v: unknown): string | null {
  const t = napis(v);
  if (!t || t.length > 2000) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function pozycjeKoszyka(lista: unknown, waluta: string): PozycjaKoszyka[] {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((p: any): PozycjaKoszyka | null => {
      const produkt = idZGid(p?.product_id);
      const tytul = napis(p?.title) ?? napis(p?.name);
      if (!produkt || !tytul) return null;
      const ilosc = Number(p?.quantity ?? 1);
      const cena = minorAlboNull(p?.price, waluta);
      return {
        product_id: produkt,
        variant_id: idZGid(p?.variant_id),
        title: tytul.slice(0, 500),
        qty: Number.isFinite(ilosc) && ilosc > 0 ? Math.min(9999, Math.floor(ilosc)) : 1,
        price_minor: cena === null ? null : String(cena),
        image_url: adresHttps(p?.image_url ?? p?.image),
        url: null,
      };
    })
    .filter((x): x is PozycjaKoszyka => x !== null)
    .slice(0, 50);
}

/** checkouts/create|update */
export function checkoutZWebhooka(c: any): CheckoutShopify {
  const token = napis(c?.token);
  if (!token || token.length > 200) throw new BladMapowaniaShopify("checkout Shopify bez tokenu");
  const waluta = napis(c.currency) ?? napis(c.presentment_currency) ?? "PLN";
  const utworzony = data(c.created_at, "created_at", `checkout ${token.slice(0, 8)}`);
  const klient = c.customer ?? {};
  return {
    token,
    cartToken: napis(c.cart_token),
    email: napis(c.email) ?? napis(klient.email),
    imie: napis(klient.first_name) ?? napis(c.billing_address?.first_name),
    nazwisko: napis(klient.last_name) ?? napis(c.billing_address?.last_name),
    customerId: idZGid(klient.id),
    zgodaMarketingowa: c.buyer_accepts_marketing === true,
    linkPowrotu: adresHttps(c.abandoned_checkout_url),
    pozycje: pozycjeKoszyka(c.line_items, waluta),
    wartoscMinor: minorAlboNull(c.total_price ?? c.subtotal_price, waluta),
    waluta,
    utworzony,
    zmieniony: c.updated_at ? data(c.updated_at, "updated_at", `checkout ${token.slice(0, 8)}`) : utworzony,
    zakonczony: Boolean(c.completed_at),
  };
}

/** carts/create|update: bez e-maila i klienta (sprawdzone w dokumentacji tematów). */
export function koszykZWebhooka(k: any, waluta: string): { token: string; pozycje: PozycjaKoszyka[]; zmieniony: Date } {
  const token = napis(k?.token) ?? napis(k?.id);
  if (!token || token.length > 200) throw new BladMapowaniaShopify("koszyk Shopify bez tokenu");
  const utworzony = data(k.created_at ?? k.updated_at, "created_at", `koszyk ${token.slice(0, 8)}`);
  return {
    token,
    pozycje: pozycjeKoszyka(k.line_items, waluta),
    zmieniony: k.updated_at ? data(k.updated_at, "updated_at", `koszyk ${token.slice(0, 8)}`) : utworzony,
  };
}

// ── produkty ──────────────────────────────────────────────────────────────────────────

export interface WariantShopify {
  externalId: string;
  sku: string | null;
  ean: string | null;
  tytul: string | null;
  cenaMinor: number | null;
  porownawczaMinor: number | null;
  stan: number | null;
  obraz: string | null;
}

export interface ProduktShopify {
  externalId: string;
  tytul: string;
  handle: string | null;
  url: string | null;
  obraz: string | null;
  opis: string | null;
  marka: string | null;
  kategorie: string[];
  aktywny: boolean;
  zmieniony: Date | null;
  warianty: WariantShopify[];
}

function bezHtml(t: unknown): string | null {
  const s = napis(t);
  if (!s) return null;
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 5000) || null;
}

/** products/create|update (kształt REST). `adresSklepu` = https://domena publiczna (do URL produktu). */
export function produktZWebhooka(p: any, waluta: string, adresSklepu: string | null): ProduktShopify {
  const id = idZGid(p?.id);
  const tytul = napis(p?.title);
  if (!id || !tytul) throw new BladMapowaniaShopify("produkt Shopify bez id albo nazwy");
  const handle = napis(p.handle);
  const obrazy: any[] = Array.isArray(p.images) ? p.images : [];
  const obrazPo = new Map<string, string>();
  for (const o of obrazy) {
    const src = adresHttps(o?.src);
    if (!src) continue;
    for (const v of Array.isArray(o?.variant_ids) ? o.variant_ids : []) obrazPo.set(String(v), src);
  }
  const glowny = adresHttps(p.image?.src) ?? adresHttps(obrazy[0]?.src);
  return {
    externalId: id,
    tytul: tytul.slice(0, 500),
    handle,
    url: adresSklepu && handle ? `${adresSklepu.replace(/\/+$/, "")}/products/${encodeURIComponent(handle)}` : null,
    obraz: glowny,
    opis: bezHtml(p.body_html),
    marka: napis(p.vendor)?.slice(0, 255) ?? null,
    kategorie: [napis(p.product_type), ...(typeof p.tags === "string" ? p.tags.split(",") : [])]
      .map((x) => (x ? String(x).trim().slice(0, 120) : ""))
      .filter(Boolean)
      .slice(0, 20),
    // archived / draft = niedostępny w bloku produktowym (wiersz zostaje, active=false)
    aktywny: (napis(p.status) ?? "active").toLowerCase() === "active",
    zmieniony: p.updated_at ? new Date(p.updated_at) : null,
    warianty: (Array.isArray(p.variants) ? p.variants : [])
      .map((v: any): WariantShopify | null => {
        const vid = idZGid(v?.id);
        if (!vid) return null;
        const stan = Number(v?.inventory_quantity);
        return {
          externalId: vid,
          sku: napis(v.sku)?.slice(0, 255) ?? null,
          ean: napis(v.barcode)?.slice(0, 64) ?? null,
          tytul: napis(v.title)?.slice(0, 500) ?? null,
          cenaMinor: minorAlboNull(v.price, waluta),
          porownawczaMinor: minorAlboNull(v.compare_at_price, waluta),
          stan: Number.isFinite(stan) ? stan : null,
          obraz: obrazPo.get(vid) ?? null,
        };
      })
      .filter((x: WariantShopify | null): x is WariantShopify => x !== null)
      .slice(0, 250),
  };
}

// ── Bulk Operations (GraphQL, JSONL) ──────────────────────────────────────────────────

const kwota = (s: any): unknown => s?.shopMoney?.amount;

/** Zamówienie z bulk: węzeł `Order` + jego `LineItem` (dzieci po `__parentId`). */
export function zamowienieZBulk(o: any, pozycjeSurowe: any[]): ZamowienieSklepu {
  const id = napis(o?.legacyResourceId) ?? idZGid(o?.id);
  if (!id) throw new BladMapowaniaShopify("zamówienie z bulk bez id");
  const waluta = napis(o.currencyCode) ?? napis(o.currentTotalPriceSet?.shopMoney?.currencyCode) ?? "PLN";
  const utworzone = data(o.createdAt, "createdAt", `zamówienie ${id}`);
  const klient = o.customer ?? {};
  return {
    externalId: id,
    numer: napis(o.name),
    status: statusZamowienia({ anulowane: Boolean(o.cancelledAt), finansowy: napis(o.displayFinancialStatus), wysylka: napis(o.displayFulfillmentStatus) }),
    email: napis(o.email) ?? napis(klient.defaultEmailAddress?.emailAddress),
    imie: napis(klient.firstName) ?? napis(o.billingAddress?.firstName),
    nazwisko: napis(klient.lastName) ?? napis(o.billingAddress?.lastName),
    sumaMinor: minor(kwota(o.currentTotalPriceSet) ?? kwota(o.totalPriceSet), waluta),
    waluta,
    occurredAt: utworzone,
    zmodyfikowaneAt: o.updatedAt ? data(o.updatedAt, "updatedAt", `zamówienie ${id}`) : utworzone,
    pozycje: pozycjeSurowe.map((p: any, i: number) => {
      const ilosc = Number(p?.quantity ?? 1);
      return {
        sku: napis(p?.sku),
        nazwa: napis(p?.name) ?? napis(p?.title) ?? `pozycja ${i + 1}`,
        ilosc: Number.isFinite(ilosc) ? ilosc : 1,
        cenaMinor: minor(kwota(p?.originalUnitPriceSet), waluta),
        lineId: idZGid(p?.id),
        productId: napis(p?.product?.legacyResourceId) ?? idZGid(p?.product?.id),
        sumaMinor: minorAlboNull(kwota(p?.discountedTotalSet), waluta),
      };
    }),
    surowe: { ...o, lineItems: pozycjeSurowe, _zrodlo: "bulk" },
  };
}

export function klientZBulk(k: any): { klient: KlientSklepu; zgoda: ZgodaShopify } {
  const id = napis(k?.legacyResourceId) ?? idZGid(k?.id);
  if (!id) throw new BladMapowaniaShopify("klient z bulk bez id");
  const utworzony = data(k.createdAt, "createdAt", `klient ${id}`);
  const e = k.defaultEmailAddress ?? {};
  const email = napis(e.emailAddress);
  const kiedy = typeof e.marketingUpdatedAt === "string" ? new Date(e.marketingUpdatedAt) : null;
  return {
    klient: {
      externalId: id,
      email,
      imie: napis(k.firstName),
      nazwisko: napis(k.lastName),
      telefon: napis(k.defaultPhoneNumber?.phoneNumber),
      occurredAt: utworzony,
      zmodyfikowaneAt: k.updatedAt ? data(k.updatedAt, "updatedAt", `klient ${id}`) : utworzony,
      surowe: { id, _zrodlo: "bulk" },
    },
    zgoda: {
      customerId: id,
      email,
      stan: stanZgody(e.marketingState),
      poziom: napis(e.marketingOptInLevel),
      kiedy: kiedy && !Number.isNaN(kiedy.getTime()) ? kiedy : null,
    },
  };
}

export function produktZBulk(p: any, warianty: any[], waluta: string): ProduktShopify {
  const id = napis(p?.legacyResourceId) ?? idZGid(p?.id);
  const tytul = napis(p?.title);
  if (!id || !tytul) throw new BladMapowaniaShopify("produkt z bulk bez id albo nazwy");
  return {
    externalId: id,
    tytul: tytul.slice(0, 500),
    handle: napis(p.handle),
    url: adresHttps(p.onlineStoreUrl),
    obraz: adresHttps(p.featuredMedia?.preview?.image?.url),
    opis: bezHtml(p.description),
    marka: napis(p.vendor)?.slice(0, 255) ?? null,
    kategorie: [napis(p.productType), ...(Array.isArray(p.tags) ? p.tags : [])]
      .map((x) => (x ? String(x).trim().slice(0, 120) : ""))
      .filter(Boolean)
      .slice(0, 20),
    aktywny: (napis(p.status) ?? "ACTIVE").toUpperCase() === "ACTIVE",
    zmieniony: p.updatedAt ? new Date(p.updatedAt) : null,
    warianty: warianty
      .map((v: any): WariantShopify | null => {
        const vid = napis(v?.legacyResourceId) ?? idZGid(v?.id);
        if (!vid) return null;
        const stan = Number(v?.inventoryQuantity);
        return {
          externalId: vid,
          sku: napis(v.sku)?.slice(0, 255) ?? null,
          ean: napis(v.barcode)?.slice(0, 64) ?? null,
          tytul: napis(v.title)?.slice(0, 500) ?? null,
          cenaMinor: minorAlboNull(v.price, waluta),
          porownawczaMinor: minorAlboNull(v.compareAtPrice, waluta),
          stan: Number.isFinite(stan) ? stan : null,
          obraz: adresHttps(v.image?.url),
        };
      })
      .filter((x: WariantShopify | null): x is WariantShopify => x !== null)
      .slice(0, 250),
  };
}
