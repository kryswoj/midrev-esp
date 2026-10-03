import { bledyUzytkownika, type KlientShopify } from "./graphql";

/**
 * Tematy webhooków Shopify (plan A.4) i ich rejestracja przez GraphQL
 * `webhookSubscriptionCreate`. Nazwy tematów z listy w dokumentacji webhooków
 * (shopify.dev/docs/api/webhooks), w dwóch zapisach: nagłówek `X-Shopify-Topic`
 * (`orders/create`) i enum GraphQL `WebhookSubscriptionTopic` (`ORDERS_CREATE`).
 *
 * Uwaga do planu: `customers_marketing_consent/update` to zgoda SMS; zgodę E-MAIL niesie
 * `customers_email_marketing_consent/update` (payload: customer_id, email_address,
 * email_marketing_consent{state, opt_in_level, consent_updated_at}). Subskrybujemy e-mail.
 *
 * Tematy RODO (`customers/data_request`, `customers/redact`, `shop/redact`) NIE dają się
 * zarejestrować przez API: deklaruje je `shopify.app.toml` (`compliance_topics`). Ten sam
 * adres dostawy, ta sama weryfikacja HMAC.
 */

export const TEMATY_SHOPIFY = [
  "orders/create",
  "orders/updated",
  "orders/paid",
  "orders/fulfilled",
  "orders/cancelled",
  "refunds/create",
  "checkouts/create",
  "checkouts/update",
  "carts/create",
  "carts/update",
  "customers/create",
  "customers/update",
  "customers_email_marketing_consent/update",
  "products/create",
  "products/update",
  "products/delete",
  "app/uninstalled",
] as const;

export const TEMATY_RODO = ["customers/data_request", "customers/redact", "shop/redact"] as const;

export type TematShopify = (typeof TEMATY_SHOPIFY)[number] | (typeof TEMATY_RODO)[number];

export function tematShopify(t: string | null): TematShopify | null {
  if (!t) return null;
  return (TEMATY_SHOPIFY as readonly string[]).includes(t) || (TEMATY_RODO as readonly string[]).includes(t) ? (t as TematShopify) : null;
}

/** `orders/create` → `ORDERS_CREATE`. */
export function enumTematu(t: string): string {
  return t.replace(/[/]/g, "_").toUpperCase();
}

export type BytShopify = "order" | "refund" | "checkout" | "cart" | "customer" | "consent" | "product" | "shop" | "gdpr";

/**
 * Byt i jego id zewnętrzne z tematu i payloadu: 3. i 4. człon klucza idempotencji
 * `shopify:{tenant}:{byt}:{id}:{webhookId}`. Kształt jak w Woo, żeby predykat RODO (4. człon
 * = id zamówienia, `customer` = id konta do nagrobka) działał bez zmian.
 */
export function bytWebhooka(temat: TematShopify, p: any): { byt: BytShopify; id: string } | null {
  const id = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.length > 0 && v.length <= 255) ? String(v) : null);
  let w: { byt: BytShopify; id: string | null };
  if (temat.startsWith("orders/")) w = { byt: "order", id: id(p?.id) };
  else if (temat === "refunds/create") w = { byt: "refund", id: id(p?.id) };
  else if (temat.startsWith("checkouts/")) w = { byt: "checkout", id: id(p?.token) };
  else if (temat.startsWith("carts/")) w = { byt: "cart", id: id(p?.token ?? p?.id) };
  else if (temat.startsWith("customers/") && !temat.endsWith("redact") && temat !== "customers/data_request") w = { byt: "customer", id: id(p?.id) };
  else if (temat === "customers_email_marketing_consent/update") w = { byt: "consent", id: id(p?.customer_id) };
  else if (temat.startsWith("products/")) w = { byt: "product", id: id(p?.id) };
  else if (temat === "app/uninstalled") w = { byt: "shop", id: id(p?.id) ?? "app" };
  else w = { byt: "gdpr", id: id(p?.customer?.id) ?? id(p?.shop_id) ?? "shop" };
  return w.id ? { byt: w.byt, id: w.id } : null;
}

/** Adres dostawy: jeden endpoint, sklep rozpoznany po nagłówku domeny, podpis sekretem jego aplikacji. */
export function adresDostawyShopify(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/shopify`;
}

export interface WynikRejestracji {
  temat: string;
  stan: "aktywny" | "blad";
  id: string | null;
  blad: string | null;
}

const LISTA = `query ($po: String) {
  webhookSubscriptions(first: 100, after: $po) {
    nodes { id topic uri }
    pageInfo { hasNextPage endCursor }
  }
}`;

const UTWORZ = `mutation ($topic: WebhookSubscriptionTopic!, $uri: String!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
    webhookSubscription { id topic uri }
    userErrors { field message }
  }
}`;

/**
 * Idempotentna rejestracja: najpierw lista istniejących subskrypcji (odczyt), zakładamy tylko
 * brakujące pod naszym adresem. Stan „aktywny” WYŁĄCZNIE z odczytu zwrotnego po zapisie
 * (jak w Woo: kod odpowiedzi mutacji to nie dowód).
 */
export async function zarejestrujWebhookiShopify(klient: KlientShopify, adres: string): Promise<WynikRejestracji[]> {
  const istniejace = await listujSubskrypcje(klient);
  const nasze = new Map(istniejace.filter((s) => s.uri === adres).map((s) => [s.topic, s.id]));
  const bledy = new Map<string, string>();
  for (const t of TEMATY_SHOPIFY) {
    const e = enumTematu(t);
    if (nasze.has(e)) continue;
    try {
      const d = await klient.zapytanie<{ webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: unknown[] } }>(UTWORZ, { topic: e, uri: adres }, 10);
      const b = bledyUzytkownika(d.webhookSubscriptionCreate.userErrors);
      if (b) bledy.set(e, b);
    } catch (b) {
      bledy.set(e, b instanceof Error ? b.message.slice(0, 200) : "błąd");
    }
  }
  const poZapisie = new Map((await listujSubskrypcje(klient)).filter((s) => s.uri === adres).map((s) => [s.topic, s.id]));
  return TEMATY_SHOPIFY.map((t) => {
    const e = enumTematu(t);
    const id = poZapisie.get(e) ?? null;
    return { temat: t, stan: id ? "aktywny" : "blad", id, blad: id ? null : (bledy.get(e) ?? "brak subskrypcji po zapisie") };
  });
}

async function listujSubskrypcje(klient: KlientShopify): Promise<{ id: string; topic: string; uri: string }[]> {
  const wynik: { id: string; topic: string; uri: string }[] = [];
  let po: string | null = null;
  for (let i = 0; i < 20; i++) {
    const d: { webhookSubscriptions: { nodes: { id: string; topic: string; uri: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
      await klient.zapytanie(LISTA, { po }, 10);
    wynik.push(...d.webhookSubscriptions.nodes);
    if (!d.webhookSubscriptions.pageInfo.hasNextPage) break;
    po = d.webhookSubscriptions.pageInfo.endCursor;
  }
  return wynik;
}

// ── Web Pixel i metapola instalacji ────────────────────────────────────────────────────

const PIKSEL_UTWORZ = `mutation ($settings: JSON!) {
  webPixelCreate(webPixel: { settings: $settings }) { webPixel { id settings } userErrors { code field message } }
}`;
const PIKSEL_ZMIEN = `mutation ($id: ID!, $settings: JSON!) {
  webPixelUpdate(id: $id, webPixel: { settings: $settings }) { webPixel { id settings } userErrors { code field message } }
}`;
const PIKSEL_ODCZYT = `query { webPixel { id settings } }`;

/**
 * Włączenie piksela aplikacji w sklepie (`webPixelCreate`, zakres `write_pixels`). Ustawienia
 * = klucz publiczny strony i adres API; nic tajnego (piksel działa w przeglądarce). Drugi raz:
 * `webPixelUpdate` (jeden piksel na aplikację). Zwraca id z odczytu zwrotnego.
 */
export async function wlaczPiksel(klient: KlientShopify, ustawienia: { siteKey: string; apiUrl: string }): Promise<{ id: string | null; blad: string | null }> {
  const settings = JSON.stringify({ siteKey: ustawienia.siteKey, apiUrl: ustawienia.apiUrl });
  let istniejacy: string | null = null;
  try {
    const d = await klient.zapytanie<{ webPixel: { id: string } | null }>(PIKSEL_ODCZYT, {}, 5);
    istniejacy = d.webPixel?.id ?? null;
  } catch {
    // brak piksela = błąd NOT_FOUND w części wersji API; traktujemy jak brak
  }
  try {
    const d: any = istniejacy
      ? await klient.zapytanie(PIKSEL_ZMIEN, { id: istniejacy, settings }, 10)
      : await klient.zapytanie(PIKSEL_UTWORZ, { settings }, 10);
    const w = istniejacy ? d.webPixelUpdate : d.webPixelCreate;
    const b = bledyUzytkownika(w?.userErrors);
    if (b) return { id: null, blad: b };
  } catch (b) {
    return { id: null, blad: b instanceof Error ? b.message.slice(0, 200) : "błąd" };
  }
  const po = await klient.zapytanie<{ webPixel: { id: string; settings: string } | null }>(PIKSEL_ODCZYT, {}, 5);
  return po.webPixel?.id ? { id: po.webPixel.id, blad: null } : { id: null, blad: "piksel nie istnieje po zapisie" };
}

const INSTALACJA = `query { currentAppInstallation { id } }`;
const METAPOLA = `mutation ($pola: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $pola) { metafields { key value } userErrors { field message } }
}`;

/**
 * Metapola instalacji aplikacji (app-data metafields, bez dodatkowego zakresu). Czyta je app
 * embed w Liquid: `app.metafields.midrev.site_key` i `.script_url`, więc klient niczego nie wkleja.
 */
export async function ustawMetapolaInstalacji(klient: KlientShopify, pola: { siteKey: string; scriptUrl: string }): Promise<string | null> {
  try {
    const i = await klient.zapytanie<{ currentAppInstallation: { id: string } }>(INSTALACJA, {}, 2);
    const ownerId = i.currentAppInstallation.id;
    const d: any = await klient.zapytanie(
      METAPOLA,
      {
        pola: [
          { ownerId, namespace: "midrev", key: "site_key", type: "single_line_text_field", value: pola.siteKey },
          { ownerId, namespace: "midrev", key: "script_url", type: "url", value: pola.scriptUrl },
        ],
      },
      10,
    );
    return bledyUzytkownika(d.metafieldsSet?.userErrors);
  } catch (b) {
    return b instanceof Error ? b.message.slice(0, 200) : "błąd";
  }
}
