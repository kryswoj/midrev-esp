import type {
  BytSklepu,
  KlientSklepu,
  MozliwosciPlatformy,
  PortSklepu,
  ProduktSklepu,
  RolaStatusu,
  StronaWynikow,
  WynikWeryfikacji,
  ZamowienieSklepu,
} from "../../../domain/store/contract";
import type { DefinicjaPlatformy } from "../rejestr";
import { BladDostepuShopify, KlientShopify } from "./graphql";
import { klientZWebhooka, klientZBulk, produktZWebhooka, zamowienieZBulk, zamowienieZWebhooka, type ProduktShopify } from "./mapowanie";
import { brakujaceZakresy, domenaSklepu } from "./oauth";

/**
 * Shopify w porcie „Sklep” (KONTRAKT-PORT-SKLEP.md). Różnice wobec Woo, świadome:
 *
 *   - poświadczenia: aplikacja custom distribution per sklep (`clientId`, `clientSecret`,
 *     `accessToken`, `zakresy`) z OAuth, nie z formularza `podlaczSklep`,
 *   - `webhooki` puste: subskrypcje zakłada instalacja przez GraphQL `webhookSubscriptionCreate`
 *     (`usecases/shopify/instalacja.ts`), RODO deklaruje `shopify.app.toml`, a dostawa idzie na
 *     JEDEN adres `/api/webhooks/shopify` (sklep po `X-Shopify-Shop-Domain`, podpis sekretem jego
 *     aplikacji, idempotencja po `X-Shopify-Webhook-Id`). Faza 2 ma tematy spoza bytów portu
 *     (checkouty, zgody, zwroty, RODO, odinstalowanie), więc idzie po TEMACIE
 *     (`usecases/shopify/przetwarzanie.ts`), a zamówienia i klientów zapisuje wspólnym upsertem,
 *   - import historii: Bulk Operations (`usecases/shopify/import.ts`), nie stronicowanie;
 *     `pobierz*` niżej istnieją dla fabryki (zgodność danych, ewentualny generyczny import).
 */

/** Statusy (słownik systemu z `statusZamowienia`) emitujące metrykę statusu przy zmianie roli. */
const ROLE_STATUSOW: Record<string, RolaStatusu> = {
  completed: "fulfilled_order",
  cancelled: "cancelled_order",
  // refunded: NIE tutaj. Refunded Order liczy webhook `refunds/create` (każdy zwrot z kwotą,
  // także częściowy, unique_id = id zwrotu); rola statusu dałaby drugie zdarzenie dla pełnego zwrotu.
};

export function produktSklepuZShopify(p: ProduktShopify, waluta: string): ProduktSklepu {
  const ceny = p.warianty.map((w) => w.cenaMinor).filter((c): c is number => c !== null);
  const najnizsza = ceny.length ? Math.min(...ceny) : 0;
  const tani = p.warianty.find((w) => w.cenaMinor === najnizsza) ?? null;
  const stan = p.warianty.reduce<number | null>((s, w) => (w.stan === null ? s : (s ?? 0) + w.stan), null);
  return {
    externalId: p.externalId,
    nazwa: p.tytul,
    sku: p.warianty[0]?.sku ?? null,
    cenaMinor: najnizsza,
    waluta,
    kategorie: p.kategorie,
    url: p.url,
    obrazUrl: p.obraz,
    opisKrotki: p.opis,
    cenaPrzedMinor: tani?.porownawczaMinor ?? null,
    marka: p.marka,
    wMagazynie: stan === null ? null : stan > 0,
    stan,
    aktywny: p.aktywny,
    zmodyfikowaneAt: p.zmieniony,
    warianty: p.warianty.map((w) => ({
      externalId: w.externalId,
      sku: w.sku,
      tytul: w.tytul,
      url: p.url ? `${p.url}?variant=${encodeURIComponent(w.externalId)}` : null,
      obrazUrl: w.obraz ?? p.obraz,
      cenaMinor: w.cenaMinor,
      cenaPrzedMinor: w.porownawczaMinor,
      wMagazynie: w.stan === null ? null : w.stan > 0,
      stan: w.stan,
      aktywny: true,
    })),
  };
}

const ZAMOWIENIA = `query ($n: Int!, $po: String, $q: String) {
  orders(first: $n, after: $po, query: $q, sortKey: CREATED_AT) {
    nodes {
      id legacyResourceId name email createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus currencyCode
      currentTotalPriceSet { shopMoney { amount currencyCode } } totalPriceSet { shopMoney { amount currencyCode } }
      customer { legacyResourceId firstName lastName defaultEmailAddress { emailAddress } } billingAddress { firstName lastName }
      lineItems(first: 100) { nodes { id sku name title quantity originalUnitPriceSet { shopMoney { amount } } discountedTotalSet { shopMoney { amount } } product { legacyResourceId } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
const KLIENCI = `query ($n: Int!, $po: String) {
  customers(first: $n, after: $po) {
    nodes { id legacyResourceId firstName lastName createdAt updatedAt defaultEmailAddress { emailAddress marketingState marketingOptInLevel marketingUpdatedAt } defaultPhoneNumber { phoneNumber } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Adapter GraphQL dla fabryki portu. Stronicowanie numerowane przez kursory pamiętane w obiekcie. */
export class AdapterShopify implements PortSklepu {
  readonly platforma = "shopify" as const;
  readonly #klient: KlientShopify;
  readonly #zakresy: string[];
  readonly #kursory = new Map<string, (string | null)[]>();

  constructor(
    readonly tenantId: string,
    o: { domena: string; token: string; zakresy: string[]; fetchImpl?: typeof fetch; czekaj?: (ms: number) => Promise<void> },
  ) {
    this.#klient = new KlientShopify({ domena: o.domena, token: o.token, fetchImpl: o.fetchImpl, czekaj: o.czekaj });
    this.#zakresy = o.zakresy;
  }

  toJSON() {
    return { platforma: "shopify", tenantId: this.tenantId };
  }

  async weryfikujPoswiadczenia(): Promise<WynikWeryfikacji> {
    const braki = brakujaceZakresy(this.#zakresy);
    if (braki.length) return { ok: false, brakujaceUprawnienia: braki, powod: "brak-uprawnien" };
    try {
      await this.#klient.zapytanie("query { shop { name } }", {}, 1);
      return { ok: true, brakujaceUprawnienia: [] };
    } catch (b) {
      if (b instanceof BladDostepuShopify) return { ok: false, brakujaceUprawnienia: [], powod: "bledne-poswiadczenia", szczegoly: b.message };
      return { ok: false, brakujaceUprawnienia: [], powod: "brak-odpowiedzi", szczegoly: b instanceof Error ? b.message : "błąd" };
    }
  }

  mozliwosci(): MozliwosciPlatformy {
    return { zamowienia: true, klienci: true, produkty: true, porzuconyKoszyk: true, webhooki: true, katalog: true, checkoutSerwerowy: true, linkKoszyka: true, zgody: true };
  }

  async #strona<T>(klucz: string, strona: number, pobierz: (po: string | null) => Promise<{ pozycje: T[]; dalej: string | null }>): Promise<T[]> {
    const kursory = this.#kursory.get(klucz) ?? [null];
    this.#kursory.set(klucz, kursory);
    // kursor strony N znamy tylko po przejściu stron 1..N-1 (GraphQL nie ma offsetu)
    for (let s = kursory.length; s < strona; s++) {
      const w = await pobierz(kursory[s - 1] ?? null);
      kursory[s] = w.dalej;
      if (!w.dalej) return [];
    }
    if (strona > 1 && kursory[strona - 1] === null) return [];
    const w = await pobierz(kursory[strona - 1] ?? null);
    kursory[strona] = w.dalej;
    return w.pozycje;
  }

  async pobierzZamowienia(o: { strona: number; naStrone: number; od?: Date; lekko?: boolean }): Promise<StronaWynikow<ZamowienieSklepu>> {
    const q = o.od ? `created_at:>='${o.od.toISOString()}'` : null;
    const lacznie = await this.policzZamowienia(o.od);
    const n = Math.min(250, Math.max(1, o.naStrone));
    const pozycje = await this.#strona(`o:${q}:${n}`, o.strona, async (po) => {
      const d = await this.#klient.zapytanie<{ orders: { nodes: any[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(ZAMOWIENIA, { n, po, q }, 200);
      return {
        pozycje: d.orders.nodes.map((x) => zamowienieZBulk(x, x.lineItems?.nodes ?? [])),
        dalej: d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null,
      };
    });
    return { pozycje, lacznie, stron: Math.ceil(lacznie / n) };
  }

  async pobierzKlientow(strona: number, naStrone: number): Promise<StronaWynikow<KlientSklepu>> {
    const lacznie = await this.policzKlientow();
    const n = Math.min(250, Math.max(1, naStrone));
    const pozycje = await this.#strona(`k:${n}`, strona, async (po) => {
      const d = await this.#klient.zapytanie<{ customers: { nodes: any[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(KLIENCI, { n, po }, 50);
      return { pozycje: d.customers.nodes.map((x) => klientZBulk(x).klient), dalej: d.customers.pageInfo.hasNextPage ? d.customers.pageInfo.endCursor : null };
    });
    return { pozycje, lacznie, stron: Math.ceil(lacznie / n) };
  }

  async pobierzProdukty(): Promise<StronaWynikow<ProduktSklepu>> {
    // katalog Shopify idzie przez Bulk Operations (import) i webhooki products/*
    return { pozycje: [], lacznie: 0, stron: 0 };
  }

  async policzZamowienia(od?: Date): Promise<number> {
    const d = await this.#klient.zapytanie<{ ordersCount: { count: number } | null }>(
      `query ($q: String) { ordersCount(query: $q, limit: null) { count } }`,
      { q: od ? `created_at:>='${od.toISOString()}'` : null },
      2,
    );
    if (typeof d.ordersCount?.count !== "number") throw new Error("Shopify nie podał liczby zamówień");
    return d.ordersCount.count;
  }

  async policzKlientow(): Promise<number> {
    const d = await this.#klient.zapytanie<{ customersCount: { count: number } | null }>(`query { customersCount(limit: null) { count } }`, {}, 2);
    return d.customersCount?.count ?? 0;
  }

  kluczIdempotencji(byt: BytSklepu, externalId: string, wersja: string): string {
    return `shopify:${this.tenantId}:${byt}:${externalId}:${wersja}`;
  }
}

/** Opcje testowe (atrapa fetch) wstrzykiwane przez `usecases/shopify/sklep.ts`. */
const g = globalThis as unknown as { __midrevShopifyTest?: { fetchImpl?: typeof fetch; czekaj?: (ms: number) => Promise<void> } };

export const DEFINICJA_SHOPIFY: DefinicjaPlatformy = {
  platforma: "shopify",
  zrodloSurowych: "shopify",

  utworzAdapter(tenantId, baseUrl, p) {
    const domena = domenaSklepu(baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
    const token = typeof p.accessToken === "string" ? p.accessToken : "";
    if (!domena || !token) throw new Error("Sklep Shopify bez domeny myshopify albo bez tokenu (aplikacja niezainstalowana)");
    return new AdapterShopify(tenantId, {
      domena,
      token,
      zakresy: Array.isArray(p.zakresy) ? p.zakresy.map(String) : [],
      fetchImpl: g.__midrevShopifyTest?.fetchImpl,
      czekaj: g.__midrevShopifyTest?.czekaj,
    });
  },

  // webhooki podpisuje SEKRET APLIKACJI (client secret aplikacji custom distribution tego sklepu)
  sekretWebhooka(p) {
    return typeof p.clientSecret === "string" && p.clientSecret ? p.clientSecret : null;
  },

  mapujZamowienie: zamowienieZWebhooka,
  mapujKlienta: klientZWebhooka,
  mapujProdukt: (p) => produktSklepuZShopify(produktZWebhooka(p, "PLN", null), "PLN"),
  rolaStatusu: (status) => ROLE_STATUSOW[status] ?? null,

  // klucz webhooka Shopify ma wersję = X-Shopify-Webhook-Id (idempotencja dostawy); import nie
  // pisze surowych zdarzeń, a zamówienie i tak deduplikuje upsert po (sklep, external_id)
  wersjaBytu(byt) {
    return byt.zmodyfikowaneAt.toISOString();
  },
};
