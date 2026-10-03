import { bledyUzytkownika, BladShopify, type KlientShopify } from "./graphql";

/**
 * Import historii przez GraphQL Bulk Operations (plan A.3): jedno zadanie po stronie Shopify
 * zamiast stronicowania, bez limitu kosztu zapytania. Wynik to plik JSONL: każdy węzeł w osobnej
 * linii, dzieci zagnieżdżonych połączeń (pozycje zamówienia, warianty) jako osobne linie
 * z `__parentId` (dokumentacja „Perform bulk operations with the GraphQL Admin API”).
 *
 * Trzy zapytania, po kolei (w starszych wersjach API jedna operacja bulk na sklep naraz):
 *   produkty (z wariantami) → klienci (zgoda filtrowana w kodzie) → zamówienia z N miesięcy.
 * Daty zawsze ze źródła (createdAt/updatedAt), import pisze `backfill` (kanał import).
 */

export type EtapBulk = "produkty" | "klienci" | "zamowienia";

/** Zapytanie bulk dla etapu. `od` tylko dla zamówień (filtr `created_at:>=`). */
export function zapytanieBulk(etap: EtapBulk, od?: Date): string {
  if (etap === "produkty") {
    return `{ products { edges { node {
      id legacyResourceId title handle status vendor productType tags description onlineStoreUrl updatedAt
      featuredMedia { preview { image { url } } }
      variants { edges { node { id legacyResourceId sku barcode title price compareAtPrice inventoryQuantity image { url } } } }
    } } } }`;
  }
  if (etap === "klienci") {
    return `{ customers { edges { node {
      id legacyResourceId firstName lastName createdAt updatedAt
      defaultEmailAddress { emailAddress marketingState marketingOptInLevel marketingUpdatedAt }
      defaultPhoneNumber { phoneNumber }
    } } } }`;
  }
  const filtr = od ? `(query: "created_at:>='${od.toISOString()}'")` : "";
  return `{ orders${filtr} { edges { node {
    id legacyResourceId name email createdAt updatedAt processedAt cancelledAt test
    displayFinancialStatus displayFulfillmentStatus currencyCode
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    totalPriceSet { shopMoney { amount currencyCode } }
    customer { legacyResourceId firstName lastName defaultEmailAddress { emailAddress } }
    billingAddress { firstName lastName }
    lineItems { edges { node {
      id sku name title quantity
      originalUnitPriceSet { shopMoney { amount } }
      discountedTotalSet { shopMoney { amount } }
      product { legacyResourceId }
    } } }
  } } } }`;
}

const START = `mutation ($q: String!) {
  bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } }
}`;

const STAN = `query ($id: ID!) {
  node(id: $id) { ... on BulkOperation { id status errorCode objectCount url partialDataUrl createdAt completedAt } }
}`;

export interface StanBulk {
  id: string;
  status: "CREATED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" | "CANCELING" | "EXPIRED" | string;
  kodBledu: string | null;
  obiekty: number;
  url: string | null;
}

export async function uruchomBulk(klient: KlientShopify, zapytanie: string): Promise<string> {
  const d = await klient.zapytanie<{ bulkOperationRunQuery: { bulkOperation: { id: string } | null; userErrors: unknown[] } }>(START, { q: zapytanie }, 10);
  const b = bledyUzytkownika(d.bulkOperationRunQuery.userErrors);
  if (b || !d.bulkOperationRunQuery.bulkOperation) throw new BladShopify(`bulk nie wystartował: ${b ?? "brak operacji"}`, "bulk_start");
  return d.bulkOperationRunQuery.bulkOperation.id;
}

export async function stanBulk(klient: KlientShopify, id: string): Promise<StanBulk> {
  const d = await klient.zapytanie<{ node: { id: string; status: string; errorCode: string | null; objectCount: string | number; url: string | null } | null }>(STAN, { id }, 2);
  if (!d.node) throw new BladShopify("operacja bulk nie istnieje", "bulk_brak");
  return { id: d.node.id, status: d.node.status, kodBledu: d.node.errorCode, obiekty: Number(d.node.objectCount ?? 0), url: d.node.url };
}

/**
 * Pobranie pliku wyniku. Adres podpisany przez Shopify (Google Cloud Storage), ważny 7 dni.
 * Akceptujemy wyłącznie https i hosty storage Shopify/Google (adres pochodzi z odpowiedzi API,
 * ale i tak nie pobieramy z dowolnego miejsca, SSRF). Sufit rozmiaru chroni pamięć workera.
 */
export const HOSTY_WYNIKU_BULK = [/^storage\.googleapis\.com$/, /^[a-z0-9-]+\.storage\.googleapis\.com$/, /\.shopifycloud\.com$/, /\.shopify\.com$/];
export const MAKS_BAJTOW_BULK = 512 * 1024 * 1024;

export async function pobierzWynikBulk(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BladShopify("nieczytelny adres wyniku bulk", "bulk_url");
  }
  if (u.protocol !== "https:" || !HOSTY_WYNIKU_BULK.some((h) => h.test(u.hostname))) {
    throw new BladShopify(`adres wyniku bulk spoza dozwolonych hostów (${u.hostname})`, "bulk_url");
  }
  const odp = await fetchImpl(u.toString(), { redirect: "error", signal: AbortSignal.timeout(300_000) });
  if (!odp.ok) throw new BladShopify(`pobranie wyniku bulk: HTTP ${odp.status}`, "bulk_pobranie");
  const dlugosc = Number(odp.headers.get("content-length") ?? 0);
  if (dlugosc > MAKS_BAJTOW_BULK) throw new BladShopify("wynik bulk większy niż limit importu", "bulk_rozmiar");
  const tekst = await odp.text();
  if (tekst.length > MAKS_BAJTOW_BULK) throw new BladShopify("wynik bulk większy niż limit importu", "bulk_rozmiar");
  return tekst;
}

/**
 * JSONL → węzły główne z dziećmi. Dziecko ma `__parentId` = `id` rodzica i występuje PO nim
 * (gwarancja Shopify). Linia nieczytelna = błąd (nie pomijamy po cichu części historii).
 */
export function zlozJsonl(tekst: string): { wezel: any; dzieci: any[] }[] {
  const wynik: { wezel: any; dzieci: any[] }[] = [];
  const po = new Map<string, { wezel: any; dzieci: any[] }>();
  let nr = 0;
  for (const linia of tekst.split("\n")) {
    nr++;
    if (!linia.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(linia);
    } catch {
      throw new BladShopify(`wynik bulk: nieczytelna linia ${nr}`, "bulk_jsonl");
    }
    if (o && typeof o.__parentId === "string") {
      const rodzic = po.get(o.__parentId);
      if (rodzic) rodzic.dzieci.push(o);
      continue;
    }
    const w = { wezel: o, dzieci: [] as any[] };
    wynik.push(w);
    if (o && typeof o.id === "string") po.set(o.id, w);
  }
  return wynik;
}
