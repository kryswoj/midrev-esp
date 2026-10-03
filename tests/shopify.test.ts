import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { zlozJsonl } from "../src/adapters/store/shopify/bulk";
import { KlientShopify } from "../src/adapters/store/shopify/graphql";
import { parsujJsonShopify } from "../src/adapters/store/shopify/json";
import { checkoutZWebhooka, statusZamowienia, zamowienieZWebhooka } from "../src/adapters/store/shopify/mapowanie";
import { adresAutoryzacji, brakujaceZakresy, domenaSklepu, domenaZWpisu, swiezyZnacznik, zweryfikujHmacWebhooka, zweryfikujHmacZapytania } from "../src/adapters/store/shopify/oauth";
import { bytWebhooka } from "../src/adapters/store/shopify/webhooki";
import { GET as getAuth } from "../src/app/api/shopify/auth/route";
import { GET as getCallback } from "../src/app/api/shopify/callback/route";
import { POST as postWebhook } from "../src/app/api/webhooks/shopify/route";
import { GET as getSkrypt } from "../src/app/js/v1/[plik]/route";
import { profilSpelnia } from "../src/usecases/automatyzacje/bramka-filtrow";
import { wyczyscLimity } from "../src/usecases/api/limity";
import { wyczyscPamiecKluczy } from "../src/usecases/integracja/klucz-strony";
import { przetworzZdarzenie } from "../src/usecases/przetworz-zdarzenie";
import { krokImportuShopify, rozpocznijImportShopify, zaplanujImportShopify } from "../src/usecases/shopify/import";
import { CIASTECZKO_STANU } from "../src/usecases/shopify/instalacja";
import { BladSklepuShopify, sklepShopify, ustawOpcjeTestoweShopify, zapiszAplikacjeShopify } from "../src/usecases/shopify/sklep";
import { stanShopify } from "../src/usecases/shopify/stan";
import { sprawdzZgodnosc } from "../src/usecases/sprawdz-zgodnosc";
import type { Filtr } from "../src/domain/filtry";
// piksel: ten sam plik, który bundluje Shopify CLI
import { mapujZdarzenie, tozsamosc, tokenKoszyka, zgodaPozwala } from "../integrations/shopify/midrev-esp-app/extensions/midrev-pixel/src/mapowanie.js";

// Integracja Shopify (0047) na ATRAPIE Shopify: payloady webhooków i odpowiedzi GraphQL
// w kształcie z dokumentacji (tests/fixtures/shopify/README.md). Żadnego wywołania do
// prawdziwego sklepu: atrapa fetch rzuca przy każdym hoście spoza *.myshopify.com i storage bulk.

const PREFIKS = "SHOPIFY ";
const znak = randomBytes(3).toString("hex");
const DOMENA_A = `sklep-a-${znak}.myshopify.com`;
const DOMENA_B = `sklep-b-${znak}.myshopify.com`;
const CLIENT_A = `clienta${znak}0123456789abcdef`;
const CLIENT_B = `clientb${znak}0123456789abcdef`;
const SEKRET_A = `shpss_a${znak}0123456789abcdef0123`;
const SEKRET_B = `shpss_b${znak}0123456789abcdef0123`;
const TOKEN_A = `shpat_tokenA${znak}SECRETVALUE`;
const FX = (n: string) => readFileSync(new URL(`./fixtures/shopify/${n}`, import.meta.url), "utf8");
const json = (n: string) => JSON.parse(FX(n));

// ── atrapa Shopify ────────────────────────────────────────────────────────────────────
interface StanAtrapy {
  wywolania: { host: string; sciezka: string; query?: string; naglowki: Record<string, string> }[];
  subskrypcje: { id: string; topic: string; uri: string }[];
  piksel: { id: string; settings: string } | null;
  metapola: unknown[];
  bulk: { etapy: string[]; stany: Record<string, string[]>; pliki: Record<string, string> };
  dlawij: number;
}
const atrapa: StanAtrapy = { wywolania: [], subskrypcje: [], piksel: null, metapola: [], bulk: { etapy: [], stany: {}, pliki: {} }, dlawij: 0 };

function odp(dane: unknown, koszt = 10, dostepne = 990) {
  return new Response(JSON.stringify({ data: dane, extensions: { cost: { requestedQueryCost: koszt, actualQueryCost: koszt, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: dostepne, restoreRate: 50 } } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const fetchAtrapa: typeof fetch = async (wejscie, init) => {
  const u = new URL(String(wejscie));
  const naglowki = Object.fromEntries(new Headers(init?.headers).entries());
  if (u.hostname === "storage.googleapis.com") {
    const plik = atrapa.bulk.pliki[u.pathname];
    return new Response(plik ?? "", { status: plik ? 200 : 404 });
  }
  if (!u.hostname.endsWith(".myshopify.com")) throw new Error(`atrapa: zakazany host ${u.hostname}`);
  if (u.pathname === "/admin/oauth/access_token") {
    atrapa.wywolania.push({ host: u.hostname, sciezka: u.pathname, naglowki });
    const b = JSON.parse(String(init?.body));
    if (b.client_secret !== SEKRET_A || b.code !== "kod-autoryzacji-ok") return new Response("{}", { status: 400 });
    return new Response(JSON.stringify({ access_token: TOKEN_A, scope: "read_orders,read_all_orders,read_products,read_customers,read_checkouts,write_pixels,read_customer_events" }), { status: 200 });
  }
  const { query, variables } = JSON.parse(String(init?.body));
  atrapa.wywolania.push({ host: u.hostname, sciezka: u.pathname, query, naglowki });
  if (naglowki["x-shopify-access-token"] !== TOKEN_A) return new Response("{}", { status: 401 });
  if (atrapa.dlawij > 0) {
    atrapa.dlawij--;
    return new Response(JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 200, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 } } } }), { status: 200 });
  }
  if (query.includes("webhookSubscriptionCreate")) {
    const s = { id: `gid://shopify/WebhookSubscription/${atrapa.subskrypcje.length + 1}`, topic: variables.topic, uri: variables.uri };
    atrapa.subskrypcje.push(s);
    return odp({ webhookSubscriptionCreate: { webhookSubscription: s, userErrors: [] } });
  }
  if (query.includes("webhookSubscriptions(")) return odp({ webhookSubscriptions: { nodes: atrapa.subskrypcje, pageInfo: { hasNextPage: false, endCursor: null } } });
  if (query.includes("webPixelCreate")) {
    atrapa.piksel = { id: "gid://shopify/WebPixel/1", settings: variables.settings };
    return odp({ webPixelCreate: { webPixel: atrapa.piksel, userErrors: [] } });
  }
  if (query.includes("webPixelUpdate")) {
    atrapa.piksel = { id: variables.id, settings: variables.settings };
    return odp({ webPixelUpdate: { webPixel: atrapa.piksel, userErrors: [] } });
  }
  if (query.includes("webPixel {")) return odp({ webPixel: atrapa.piksel });
  if (query.includes("currentAppInstallation")) return odp({ currentAppInstallation: { id: "gid://shopify/AppInstallation/77" } });
  if (query.includes("metafieldsSet")) {
    atrapa.metapola.push(...variables.pola);
    return odp({ metafieldsSet: { metafields: variables.pola, userErrors: [] } });
  }
  if (query.includes("shop {")) return odp({ shop: { name: "Sklep A", currencyCode: "PLN", primaryDomain: { url: "https://sklep-a.example" } } });
  if (query.includes("ordersCount")) return odp({ ordersCount: { count: 2 }, ...(query.includes("customersCount") ? { customersCount: { count: 2 }, productsCount: { count: 2 } } : {}) });
  if (query.includes("bulkOperationRunQuery")) {
    const etap = variables.q.includes("products") ? "produkty" : variables.q.includes("customers") ? "klienci" : "zamowienia";
    atrapa.bulk.etapy.push(etap);
    if (etap === "zamowienia") expect(variables.q).toMatch(/created_at:>=/);
    return odp({ bulkOperationRunQuery: { bulkOperation: { id: `gid://shopify/BulkOperation/${etap}`, status: "CREATED" }, userErrors: [] } });
  }
  if (query.includes("on BulkOperation")) {
    const etap = String(variables.id).split("/").pop()!;
    const kolejka = atrapa.bulk.stany[etap] ?? [];
    const status = kolejka.length > 1 ? kolejka.shift()! : (kolejka[0] ?? "COMPLETED");
    return odp({ node: { id: variables.id, status, errorCode: null, objectCount: "4", url: status === "COMPLETED" ? `https://storage.googleapis.com/bulk/${etap}.jsonl` : null } });
  }
  throw new Error(`atrapa: nieobsłużone zapytanie ${query.slice(0, 80)}`);
};

// ── podpisy ───────────────────────────────────────────────────────────────────────────
function podpiszZapytanie(p: Record<string, string>, sekret: string): URLSearchParams {
  const tekst = Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("&");
  return new URLSearchParams({ ...p, hmac: createHmac("sha256", sekret).update(tekst).digest("hex") });
}
const teraz = () => String(Math.floor(Date.now() / 1000));

let nrWebhooka = 0;
function webhook(temat: string, cialo: unknown, o: { domena?: string; sekret?: string; webhookId?: string; zlyPodpis?: boolean } = {}) {
  const tekst = typeof cialo === "string" ? cialo : JSON.stringify(cialo);
  const hmac = createHmac("sha256", o.sekret ?? SEKRET_A).update(tekst).digest("base64");
  return new NextRequest(new URL("/api/webhooks/shopify", "https://app.midrev.test"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": temat,
      "x-shopify-shop-domain": o.domena ?? DOMENA_A,
      "x-shopify-hmac-sha256": o.zlyPodpis ? "AAAA" + hmac.slice(4) : hmac,
      "x-shopify-webhook-id": o.webhookId ?? `b54557e4-bdd9-4b37-8a5f-${String(++nrWebhooka).padStart(12, "0")}`,
      "x-shopify-triggered-at": new Date().toISOString(),
      "x-shopify-api-version": "2026-07",
    },
    body: tekst,
  });
}

async function przetworzSurowe(tenantId: string) {
  const { rows } = await getPool().query("select id from raw_events where tenant_id = $1 and source = 'shopify' and processed_at is null order by received_at, id", [tenantId]);
  for (const r of rows) await przetworzZdarzenie(tenantId, r.id);
  return rows.length;
}

async function zdarzenia(tenantId: string) {
  const { rows } = await getPool().query(
    `select m.integration_key || '/' || m.name as metryka, e.unique_id, e.properties, e.backfill, e.source, e.occurred_at, e.profile_id, e.value_minor::text as value_minor
       from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
      where e.tenant_id = $1 order by e.recorded_at`,
    [tenantId],
  );
  return rows;
}

const NIE_KUPIL_OD_STARTU: Filtr = { grupy: [{ warunki: [{ typ: "metryka_profilu", metryka: { nazwa: "Placed Order" }, operator: "rowna", wartosc: 0, okno: { od: "startu_flow" } }] }] };

describe("Shopify: czyste funkcje (OAuth, HMAC, mapowanie, piksel)", () => {
  it("domena sklepu: tylko *.myshopify.com, bez podszywania", () => {
    expect(domenaSklepu("Sklep-A.myshopify.com")).toBe("sklep-a.myshopify.com");
    expect(domenaSklepu("sklep.myshopify.com.evil.test")).toBeNull();
    expect(domenaSklepu("evil.test/?x=sklep.myshopify.com")).toBeNull();
    expect(domenaSklepu("-zly.myshopify.com")).toBeNull();
    expect(domenaZWpisu("https://moj-sklep.myshopify.com/admin")).toBe("moj-sklep.myshopify.com");
    expect(domenaZWpisu("moj-sklep")).toBe("moj-sklep.myshopify.com");
    expect(domenaZWpisu("sklep.pl")).toBeNull();
  });

  it("HMAC zapytania: poprawny przechodzi, zmieniony parametr i cudzy sekret nie", () => {
    const p = podpiszZapytanie({ shop: DOMENA_A, timestamp: teraz(), host: "YWRtaW4" }, SEKRET_A);
    expect(zweryfikujHmacZapytania(p, SEKRET_A)).toBe(true);
    expect(zweryfikujHmacZapytania(p, SEKRET_B)).toBe(false);
    const zmieniony = new URLSearchParams(p);
    zmieniony.set("shop", DOMENA_B);
    expect(zweryfikujHmacZapytania(zmieniony, SEKRET_A)).toBe(false);
    const bez = new URLSearchParams(p);
    bez.delete("hmac");
    expect(zweryfikujHmacZapytania(bez, SEKRET_A)).toBe(false);
    expect(swiezyZnacznik(teraz())).toBe(true);
    expect(swiezyZnacznik(String(Math.floor(Date.now() / 1000) - 7200))).toBe(false);
  });

  it("HMAC webhooka z SUROWEGO ciała (inny zapis spacji = inny podpis)", () => {
    const tekst = '{"id": 1}';
    const h = createHmac("sha256", SEKRET_A).update(tekst).digest("base64");
    expect(zweryfikujHmacWebhooka(tekst, h, SEKRET_A)).toBe(true);
    expect(zweryfikujHmacWebhooka('{"id":1}', h, SEKRET_A)).toBe(false);
    expect(zweryfikujHmacWebhooka(tekst, null, SEKRET_A)).toBe(false);
  });

  it("adres autoryzacji: token offline (bez per-user), zakresy, stan", () => {
    const u = new URL(adresAutoryzacji({ domena: DOMENA_A, clientId: CLIENT_A, redirectUri: "https://app.test/api/shopify/callback", stan: "s1" }));
    expect(u.hostname).toBe(DOMENA_A);
    expect(u.searchParams.get("scope")).toContain("read_checkouts");
    expect(u.searchParams.get("state")).toBe("s1");
    expect(u.searchParams.has("grant_options[]")).toBe(false);
    expect(brakujaceZakresy(["read_orders", "write_products", "read_customers", "read_checkouts", "write_pixels", "read_customer_events"])).toEqual([]);
    expect(brakujaceZakresy(["read_orders"])).toContain("write_pixels");
  });

  it("id 64-bitowe z webhooka zostają tekstem (bez zaokrąglenia)", () => {
    const d = parsujJsonShopify('{"id": 820982911946154500, "orders_to_redact": [820982911946154500], "q": 2}') as any;
    expect(d.id).toBe("820982911946154500");
    expect(d.orders_to_redact).toEqual(["820982911946154500"]);
    expect(d.q).toBe(2);
    // liczby w napisach, z ucieczkami, ułamki i bezpieczne liczby bez zmian
    const e = parsujJsonShopify('{"n": "id: 820982911946154500, \\"x\\": 1", "a": -9007199254740993, "f": 1.5, "s": 9007199254740991, "z": [12345678901234567890]}') as any;
    expect(e).toEqual({ n: 'id: 820982911946154500, "x": 1', a: "-9007199254740993", f: 1.5, s: 9007199254740991, z: ["12345678901234567890"] });
  });

  it("mapowanie zamówienia: data ze źródła, kwoty w groszach, status w słowniku systemu", () => {
    const z = zamowienieZWebhooka(parsujJsonShopify(FX("zamowienie.json")));
    expect(z.externalId).toBe("820982911946154500");
    expect(z.occurredAt.toISOString()).toBe("2026-10-03T08:20:00.000Z");
    expect(z.sumaMinor).toBe(25800);
    expect(z.status).toBe("processing");
    expect(z.pozycje[0]).toMatchObject({ cenaMinor: 9900, ilosc: 2, productId: "632910392", sumaMinor: 19800 });
    expect(() => zamowienieZWebhooka({ id: 1, line_items: [] })).toThrow(/created_at/);
    expect(statusZamowienia({ anulowane: false, finansowy: "paid", wysylka: "fulfilled" })).toBe("completed");
    expect(statusZamowienia({ anulowane: true, finansowy: "paid", wysylka: null })).toBe("cancelled");
    expect(statusZamowienia({ anulowane: false, finansowy: "REFUNDED", wysylka: null })).toBe("refunded");
    expect(statusZamowienia({ anulowane: false, finansowy: "pending", wysylka: null })).toBe("pending");
  });

  it("checkout: link powrotu tylko https, e-mail, pozycje", () => {
    const c = checkoutZWebhooka(json("checkout-z-emailem.json"));
    expect(c.linkPowrotu).toMatch(/^https:\/\/sklep-a\.example\/.*recover/);
    expect(c.email).toBe("Jan.Kowalski@Example.test");
    expect(c.pozycje).toHaveLength(2);
    expect(checkoutZWebhooka({ ...json("checkout-z-emailem.json"), abandoned_checkout_url: "javascript:alert(1)" }).linkPowrotu).toBeNull();
    expect(bytWebhooka("checkouts/update", json("checkout-z-emailem.json"))).toEqual({ byt: "checkout", id: "ck-7f3a9b2c1d" });
    expect(bytWebhooka("customers/redact", json("rodo-customers-redact.json"))?.byt).toBe("gdpr");
  });

  it("JSONL bulk: dzieci po __parentId przy rodzicu", () => {
    const w = zlozJsonl(FX("bulk-zamowienia.jsonl"));
    expect(w).toHaveLength(2);
    expect(w[0].dzieci).toHaveLength(1);
    expect(() => zlozJsonl('{"id":1}\n{zle')).toThrow(/linia 2/);
  });

  it("dławik po koszcie: THROTTLED czeka wg throttleStatus i ponawia", async () => {
    ustawOpcjeTestoweShopify(null);
    const czekania: number[] = [];
    atrapa.dlawij = 1;
    const k = new KlientShopify({ domena: DOMENA_A, token: TOKEN_A, fetchImpl: fetchAtrapa, czekaj: async (ms) => void czekania.push(ms), teraz: () => 0 });
    const d = await k.zapytanie<{ shop: { name: string } }>("query { shop { name currencyCode primaryDomain { url } } }", {}, 200);
    expect(d.shop.name).toBe("Sklep A");
    // 100 dostępnych, koszt 200, odpływ 50/s → co najmniej 2 s
    expect(czekania[0]).toBeGreaterThanOrEqual(2000);
    expect(JSON.stringify(k)).not.toContain(TOKEN_A);
  });

  it("piksel: bramka zgody, mapowanie, nigdy Placed Order ani Started Checkout z przeglądarki", () => {
    const zgoda = { analyticsProcessingAllowed: true, marketingAllowed: true };
    expect(zgodaPozwala({ analyticsProcessingAllowed: true, marketingAllowed: false })).toBe(false);
    expect(zgodaPozwala(null)).toBe(false);
    const wariant = { id: "gid://shopify/ProductVariant/808950810", title: "100 ml", sku: "WOSK-100", price: { amount: 99, currencyCode: "PLN" }, image: { src: "https://cdn.shopify.example/w.jpg" }, product: { id: "gid://shopify/Product/632910392", title: "Wosk", vendor: "A", type: "Pielęgnacja", url: "/products/wosk" } };
    const ev = { id: "e1", name: "product_viewed", clientId: "cid-1", data: { productVariant: wariant } };
    expect(mapujZdarzenie(ev, { prywatnosc: { analyticsProcessingAllowed: false, marketingAllowed: false } })).toEqual([]);
    const ciastko = encodeURIComponent(JSON.stringify({ a: "anon-z-midrev-js", t: 0 }));
    const [vp] = mapujZdarzenie(ev, { prywatnosc: zgoda, ciastko, origin: "https://sklep-a.example", teraz: 0 });
    expect(vp.sciezka).toBe("/client/events");
    const at = vp.cialo.data.attributes;
    expect(at.metric.data.attributes.name).toBe("Viewed Product");
    expect(at.properties).toMatchObject({ ProductID: "632910392", URL: "https://sklep-a.example/products/wosk", Price: 99 });
    expect(at.profile.data.attributes.anonymous_id).toBe("anon-z-midrev-js");
    const atc = mapujZdarzenie({ id: "e2", name: "product_added_to_cart", clientId: "cid-1", data: { cartLine: { merchandise: wariant, quantity: 2, cost: { totalAmount: { amount: 198 } } } } }, { prywatnosc: zgoda, tokenKoszyka: "tok" });
    expect(atc[0].cialo.data.attributes.properties).toMatchObject({ AddedItemProductID: "632910392", AddedItemQuantity: 2, CartToken: "tok", $value: 198 });
    const koniec = mapujZdarzenie({ id: "e3", name: "checkout_completed", clientId: "cid-1", data: { checkout: { email: "jan@example.test", order: { id: "1" } } } }, { prywatnosc: zgoda });
    expect(koniec).toEqual([{ sciezka: "/client/profiles", cialo: { data: { type: "profile", attributes: { anonymous_id: "shopify:cid-1", email: "jan@example.test" } } } }]);
    expect(mapujZdarzenie({ id: "e4", name: "checkout_started", clientId: "c", data: { checkout: {} } }, { prywatnosc: zgoda })).toEqual([]);
    for (const n of ["checkout_started", "checkout_contact_info_submitted", "checkout_completed", "page_viewed"]) {
      const w = mapujZdarzenie({ id: "x", name: n, clientId: "c", data: { checkout: { email: "a@b.test" } } }, { prywatnosc: zgoda });
      expect(w.every((z: any) => z.sciezka === "/client/profiles")).toBe(true);
    }
    expect(tokenKoszyka("gid://shopify/Cart/Z2NwLWV1?key=abc")).toBe("Z2NwLWV1");
    expect(tozsamosc({ ciastko: "%%zle", osoba: '{"e":"x@y.test","k":"tok"}', clientId: "c", email: null })).toEqual({ anonymous_id: "shopify:c", email: "x@y.test", _kx: "tok" });
  });
});

describe("Shopify: instalacja, webhooki, RODO, import (baza testowa + atrapa)", () => {
  let tenantA = "";
  let tenantB = "";
  let storeA = "";

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantA = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"])).rows[0].id;
    tenantB = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "B"])).rows[0].id;
    ustawOpcjeTestoweShopify({ fetchImpl: fetchAtrapa, czekaj: async () => {} });
  });

  beforeEach(() => {
    wyczyscLimity();
    wyczyscPamiecKluczy();
  });

  afterAll(async () => {
    ustawOpcjeTestoweShopify(null);
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  it("zapis aplikacji: szyfrogram bez sekretu jawnym tekstem; ten sam sklep w innym tenancie = odmowa", async () => {
    const s = await zapiszAplikacjeShopify(tenantA, { adres: `https://${DOMENA_A}/admin`, clientId: CLIENT_A, clientSecret: SEKRET_A });
    storeA = s.id;
    expect(s.status).toBe("pending");
    const { rows } = await getPool().query("select credentials_encrypted, shop_domain from stores where id = $1", [storeA]);
    expect(rows[0].shop_domain).toBe(DOMENA_A);
    expect(Buffer.from(rows[0].credentials_encrypted).toString("latin1")).not.toContain(SEKRET_A);
    await expect(zapiszAplikacjeShopify(tenantB, { adres: DOMENA_A, clientId: CLIENT_B, clientSecret: SEKRET_B })).rejects.toBeInstanceOf(BladSklepuShopify);
    await zapiszAplikacjeShopify(tenantB, { adres: DOMENA_B, clientId: CLIENT_B, clientSecret: SEKRET_B });
    expect(JSON.stringify(s)).not.toContain(SEKRET_A);
  });

  it("OAuth: zły podpis 401, start ustawia ciasteczko i hasz stanu; callback bez ciasteczka i z cudzym stanem 403", async () => {
    const zly = await getAuth(new NextRequest(new URL(`/api/shopify/auth?${podpiszZapytanie({ shop: DOMENA_A, timestamp: teraz() }, SEKRET_B)}`, "https://app.midrev.test")));
    expect(zly.status).toBe(401);
    // podpis sekretem sklepu B z domeną sklepu A (cross-tenant) też nie przechodzi
    const start = await getAuth(new NextRequest(new URL(`/api/shopify/auth?${podpiszZapytanie({ shop: DOMENA_A, timestamp: teraz() }, SEKRET_A)}`, "https://app.midrev.test")));
    expect(start.status).toBe(302);
    const cel = new URL(start.headers.get("location")!);
    expect(cel.hostname).toBe(DOMENA_A);
    expect(cel.pathname).toBe("/admin/oauth/authorize");
    expect(cel.searchParams.get("client_id")).toBe(CLIENT_A);
    const stan = cel.searchParams.get("state")!;
    expect(start.cookies.get(CIASTECZKO_STANU)?.value).toBe(stan);
    const { rows } = await getPool().query("select state_hash from shopify_oauth_states where store_id = $1", [storeA]);
    expect(rows.map((r) => r.state_hash)).not.toContain(stan);
    expect(rows[0].state_hash).toMatch(/^[0-9a-f]{64}$/);

    const parametry = (s: string) => podpiszZapytanie({ shop: DOMENA_A, code: "kod-autoryzacji-ok", state: s, timestamp: teraz() }, SEKRET_A);
    const bezCiastka = await getCallback(new NextRequest(new URL(`/api/shopify/callback?${parametry(stan)}`, "https://app.midrev.test")));
    expect(bezCiastka.status).toBe(403);
    const cudzy = await getCallback(new NextRequest(new URL(`/api/shopify/callback?${parametry("inny-stan")}`, "https://app.midrev.test"), { headers: { cookie: `${CIASTECZKO_STANU}=inny-stan` } }));
    expect(cudzy.status).toBe(403);
    expect(atrapa.wywolania.filter((w) => w.sciezka === "/admin/oauth/access_token")).toHaveLength(0);

    const ok = await getCallback(new NextRequest(new URL(`/api/shopify/callback?${parametry(stan)}`, "https://app.midrev.test"), { headers: { cookie: `${CIASTECZKO_STANU}=${stan}` } }));
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toContain(`/t/${tenantA}/sklepy/shopify`);
    // stan jednorazowy
    const powtorka = await getCallback(new NextRequest(new URL(`/api/shopify/callback?${parametry(stan)}`, "https://app.midrev.test"), { headers: { cookie: `${CIASTECZKO_STANU}=${stan}` } }));
    expect(powtorka.status).toBe(403);
  });

  it("po instalacji: token zaszyfrowany, webhooki z odczytem zwrotnym, piksel, metapola, role, klucz strony z wymaganą zgodą", async () => {
    const s = await sklepShopify(tenantA, storeA);
    expect(s?.status).toBe("connected");
    expect(s?.poswiadczenia.accessToken?.ujawnij()).toBe(TOKEN_A);
    const { rows } = await getPool().query("select credentials_encrypted::text as t, capabilities from stores where id = $1", [storeA]);
    expect(rows[0].t).not.toContain(TOKEN_A);
    expect(rows[0].capabilities.shopify.webhooki.every((w: any) => w.stan === "aktywny")).toBe(true);
    expect(rows[0].capabilities.webhooki).toBe(true);
    expect(atrapa.subskrypcje.map((x) => x.topic)).toEqual(expect.arrayContaining(["ORDERS_CREATE", "CHECKOUTS_UPDATE", "CUSTOMERS_EMAIL_MARKETING_CONSENT_UPDATE", "APP_UNINSTALLED", "REFUNDS_CREATE"]));
    expect(atrapa.subskrypcje.every((x) => x.uri.endsWith("/api/webhooks/shopify"))).toBe(true);
    expect(JSON.parse(atrapa.piksel!.settings)).toMatchObject({ siteKey: expect.stringMatching(/^[A-Za-z0-9]{6}$/) });
    expect(atrapa.metapola.map((m: any) => m.key)).toEqual(["site_key", "script_url"]);
    const role = await getPool().query(
      "select r.role, m.integration_key || '/' || m.name as m from metric_mappings r join metrics m on m.tenant_id = r.tenant_id and m.id = r.metric_id where r.tenant_id = $1 order by r.role",
      [tenantA],
    );
    expect(role.rows).toEqual(expect.arrayContaining([{ role: "placed_order", m: "shopify/Placed Order" }, { role: "started_checkout", m: "shopify/Started Checkout" }, { role: "viewed_product", m: "midrev/Viewed Product" }]));
    const klucz = await getPool().query("select platform, require_cookie_consent, link_domains from site_keys where tenant_id = $1 and revoked_at is null", [tenantA]);
    expect(klucz.rows[0]).toMatchObject({ platform: "shopify", require_cookie_consent: true });
    expect(klucz.rows[0].link_domains).toEqual(expect.arrayContaining([DOMENA_A, "sklep-a.example"]));
    // midrev.js na Shopify: zgoda wymagana i TYLKO z mostu (Customer Privacy), bez wykrywania CMP/GCM
    const idKlucza = JSON.parse(atrapa.piksel!.settings).siteKey;
    const js = await (await getSkrypt(new NextRequest(new URL(`/js/v1/${idKlucza}.js`, "https://link.midrev.test")), { params: Promise.resolve({ plik: `${idKlucza}.js` }) })).text();
    expect(js).toContain('"zgoda":true');
    expect(js).toContain('"recz":true');
    // runtime: na Shopify zwykłe consent(true) ze strony nie nadaje zgody; nadaje tylko platformConsent z mostu
    const vm = await import("node:vm");
    const wyslane: string[] = [];
    const okno: any = {
      location: { search: "", hostname: "sklep.test", href: "https://sklep.test/", protocol: "https:", pathname: "/" },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      fetch: (u: string) => { wyslane.push(u); return Promise.resolve({ status: 202 }); },
      addEventListener: () => {}, setInterval: () => 0, clearInterval: () => {}, crypto: { getRandomValues: (a: Uint8Array) => a }, console,
    };
    const dok: any = { cookie: "", readyState: "complete", addEventListener: () => {}, getElementsByTagName: () => [], createElement: () => ({}), head: { appendChild: () => {} }, documentElement: {}, body: null, querySelector: () => null };
    okno.window = okno;
    vm.runInNewContext(js, { window: okno, document: dok, Promise, JSON, Date, Math, encodeURIComponent, decodeURIComponent, Object, String, Number, Array, Uint8Array, Blob: class {} });
    okno.midrev.consent(true);
    okno.midrev.push(["consent", true]);
    await okno.midrev.identify({ email: "a@b.test" });
    expect(wyslane).toHaveLength(0);
    okno.midrev.push(["platformConsent", true]);
    await new Promise((r) => setTimeout(r, 0));
    expect(wyslane.some((u) => u.includes("/client/profiles"))).toBe(true);
    // ponowne „Sprawdź” nie zakłada drugich subskrypcji
    const ile = atrapa.subskrypcje.length;
    const { poInstalacji } = await import("../src/usecases/shopify/instalacja");
    await poInstalacji(tenantA, storeA);
    expect(atrapa.subskrypcje.length).toBe(ile);
    // token nigdy w żadnym wywołaniu poza nagłówkiem
    expect(atrapa.wywolania.every((w) => !(w.query ?? "").includes(TOKEN_A))).toBe(true);
  });

  it("webhook: zły podpis 401, sekret innego sklepu 401, temat spoza listy 200 bez zapisu, ponowienie po webhook id = duplikat", async () => {
    const cialo = FX("zamowienie.json");
    expect((await postWebhook(webhook("orders/create", cialo, { zlyPodpis: true }))).status).toBe(401);
    expect((await postWebhook(webhook("orders/create", cialo, { sekret: SEKRET_B }))).status).toBe(401);
    // podpis sekretem B, nagłówek domeny B: przechodzi, ale trafia do tenanta B, nie A
    expect((await postWebhook(webhook("themes/update", "{}"))).status).toBe(200);
    const id = "11111111-2222-3333-4444-555555555555";
    expect(await (await postWebhook(webhook("orders/create", cialo, { webhookId: id }))).text()).toBe("przyjęte");
    expect(await (await postWebhook(webhook("orders/create", cialo, { webhookId: id }))).text()).toBe("duplikat");
    const { rows } = await getPool().query("select idempotency_key, tenant_id from raw_events where source = 'shopify' and store_id = $1", [storeA]);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotency_key).toBe(`shopify:${tenantA}:order:820982911946154500:${id}`);
    const b = await getPool().query("select count(*)::int as n from raw_events where tenant_id = $1", [tenantB]);
    expect(b.rows[0].n).toBe(0);
    // zostawiamy zamówienie na później (test zakupu); czyścimy tylko ten wpis
    await getPool().query("delete from raw_events where tenant_id = $1 and source = 'shopify'", [tenantA]);
  });

  it("porzucony checkout → Started Checkout (shopify) + koszyk z abandoned_checkout_url; zakup zamyka koszyk i kończy „nie kupił od startu”", async () => {
    // czasy checkoutu „przed chwilą” (data ze źródła); stałe daty z fixture byłyby backfillem
    const kiedyCheckout = new Date(Math.floor(Date.now() / 1000) * 1000 - 120_000);
    const utworzony = new Date(kiedyCheckout.getTime() - 60_000).toISOString();
    expect((await postWebhook(webhook("checkouts/create", FX("checkout-bez-emaila.json").replaceAll("2026-10-03T10:00:00+02:00", utworzony)))).status).toBe(200);
    await przetworzSurowe(tenantA);
    let ev = await zdarzenia(tenantA);
    expect(ev.filter((e) => e.metryka === "shopify/Started Checkout")).toHaveLength(0);

    const checkout = FX("checkout-z-emailem.json").replace("2026-10-03T10:05:00+02:00", kiedyCheckout.toISOString()).replace("2026-10-03T10:00:00+02:00", utworzony);
    expect((await postWebhook(webhook("checkouts/update", checkout))).status).toBe(200);
    // powtórka checkoutu (drugi webhook update) nie robi drugiego zdarzenia
    expect((await postWebhook(webhook("checkouts/update", checkout))).status).toBe(200);
    await przetworzSurowe(tenantA);
    ev = await zdarzenia(tenantA);
    const sc = ev.filter((e) => e.metryka === "shopify/Started Checkout");
    expect(sc).toHaveLength(1);
    expect(sc[0]).toMatchObject({ unique_id: "sc:ck-7f3a9b2c1d", backfill: false, source: "webhook", value_minor: "25800" });
    // data ze źródła (updated_at checkoutu), nie now() zapisu
    expect(new Date(sc[0].occurred_at).toISOString()).toBe(kiedyCheckout.toISOString());
    expect(sc[0].properties.CheckoutURL).toMatch(/recover\?key=abc123$/);
    expect(sc[0].properties.Items[0]).toMatchObject({ ProductID: "632910392", Quantity: 2, ItemPrice: 99 });
    const { rows: koszyk } = await getPool().query("select stage, recovery_url, email, profile_id, items from carts where tenant_id = $1 and store_id = $2", [tenantA, storeA]);
    expect(koszyk[0]).toMatchObject({ stage: "checkout", email: "jan.kowalski@example.test" });
    expect(koszyk[0].recovery_url).toMatch(/recover/);
    const profileId = koszyk[0].profile_id;
    // checkout bez zaznaczonej zgody: brak zgody marketingowej (mail porzuconego NIE wyjdzie)
    const zg = await getPool().query("select count(*)::int as n from consents where tenant_id = $1 and profile_id = $2", [tenantA, profileId]);
    expect(zg.rows[0].n).toBe(0);

    const start = new Date(Date.now() - 60_000).toISOString();
    const kontekst = { flowId: "00000000-0000-7000-8000-000000000001", start, zdarzenieWyzwalajaceId: null, uczestnikId: null };
    expect(await profilSpelnia(getPool(), tenantA, profileId, NIE_KUPIL_OD_STARTU, kontekst)).toBe(true);

    // zakup: zamówienie z tym samym checkout_token (czas zamówienia „teraz”, żeby liczyło się od startu)
    const zam = json("zamowienie.json");
    const tekst = FX("zamowienie.json").replace(/2026-10-03T10:20:00\+02:00/g, new Date().toISOString()).replace("2026-10-03T10:20:05+02:00", new Date().toISOString());
    expect(zam.checkout_token).toBe("ck-7f3a9b2c1d");
    expect((await postWebhook(webhook("orders/create", tekst))).status).toBe(200);
    await przetworzSurowe(tenantA);
    ev = await zdarzenia(tenantA);
    const po = ev.filter((e) => e.metryka === "shopify/Placed Order");
    expect(po).toHaveLength(1);
    expect(po[0]).toMatchObject({ source: "webhook", backfill: false, value_minor: "25800", profile_id: profileId });
    expect(ev.filter((e) => e.metryka === "shopify/Ordered Product")).toHaveLength(2);
    const { rows: k2 } = await getPool().query("select stage, order_external_id from carts where tenant_id = $1 and store_id = $2", [tenantA, storeA]);
    expect(k2[0]).toMatchObject({ stage: "ordered", order_external_id: "820982911946154500" });
    expect(await profilSpelnia(getPool(), tenantA, profileId, NIE_KUPIL_OD_STARTU, kontekst)).toBe(false);
    const { rows: o } = await getPool().query("select status, total_minor::int as suma, occurred_at from orders where tenant_id = $1 and store_id = $2", [tenantA, storeA]);
    expect(o[0]).toMatchObject({ status: "processing", suma: 25800 });
  });

  it("wysyłka, zwrot, anulowanie: Fulfilled/Refunded Order raz, z datą ze źródła; starszy update nie cofa statusu", async () => {
    expect((await postWebhook(webhook("orders/fulfilled", FX("zamowienie-wyslane.json")))).status).toBe(200);
    expect((await postWebhook(webhook("orders/updated", FX("zamowienie-wyslane.json")))).status).toBe(200);
    expect((await postWebhook(webhook("refunds/create", FX("zwrot.json")))).status).toBe(200);
    await przetworzSurowe(tenantA);
    const ev = await zdarzenia(tenantA);
    const ful = ev.filter((e) => e.metryka === "shopify/Fulfilled Order");
    expect(ful).toHaveLength(1);
    // metryka statusu z portu „Sklep”: raz na zamówienie i rolę, czas = updated_at zamówienia ze źródła
    expect(ful[0].unique_id).toMatch(/^fulfilled_order:/);
    expect(new Date(ful[0].occurred_at).toISOString()).toBe("2026-10-04T07:00:00.000Z");
    const ref = ev.filter((e) => e.metryka === "shopify/Refunded Order");
    expect(ref).toHaveLength(1);
    expect(ref[0]).toMatchObject({ unique_id: "ref:929361462", value_minor: "6000" });
    const { rows } = await getPool().query("select status from orders where tenant_id = $1 and store_id = $2", [tenantA, storeA]);
    expect(rows[0].status).toBe("completed");
  });

  it("zgoda e-mail ze Shopify: subscribed → zgoda ze źródłem; nasz późniejszy wypis wygrywa z tym samym zapisem", async () => {
    expect((await postWebhook(webhook("customers_email_marketing_consent/update", FX("zgoda-zapis.json")))).status).toBe(200);
    await przetworzSurowe(tenantA);
    const { rows: p } = await getPool().query("select id from profiles where tenant_id = $1 and lower(email) = 'jan.kowalski@example.test'", [tenantA]);
    const zgody = async () => (await getPool().query("select state, source, method_detail from consents where tenant_id = $1 and profile_id = $2 order by occurred_at, recorded_at", [tenantA, p[0].id])).rows;
    expect(await zgody()).toEqual([{ state: "granted", source: "shopify", method_detail: expect.stringContaining("single_opt_in") }]);
    // wypis u nas (nowszy niż data zgody w Shopify), potem ten sam webhook jeszcze raz
    await getPool().query("insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email', 'withdrawn', 'unsubscribe_link', '2026-10-03T09:30:00Z')", [tenantA, p[0].id]);
    expect((await postWebhook(webhook("customers_email_marketing_consent/update", FX("zgoda-zapis.json")))).status).toBe(200);
    await przetworzSurowe(tenantA);
    expect((await zgody()).map((z) => z.state)).toEqual(["granted", "withdrawn"]);
  });

  it("katalog: produkt z webhooka (warianty, cena od, przekreślona), usunięcie = active=false", async () => {
    expect((await postWebhook(webhook("products/update", FX("produkt.json")))).status).toBe(200);
    await przetworzSurowe(tenantA);
    const { rows } = await getPool().query("select title, url, price_minor::int as cena, compare_at_minor::int as przed, active, description_short from products where tenant_id = $1 and store_id = $2", [tenantA, storeA]);
    expect(rows[0]).toMatchObject({ title: "Wosk do włosów", url: "https://sklep-a.example/products/wosk-do-wlosow", cena: 9900, przed: 12900, active: true, description_short: "Mocny wosk" });
    expect((await postWebhook(webhook("products/delete", { id: 632910392 }))).status).toBe(200);
    await przetworzSurowe(tenantA);
    const po = await getPool().query("select active from products where tenant_id = $1 and store_id = $2 and external_id = '632910392'", [tenantA, storeA]);
    expect(po.rows[0].active).toBe(false);
  });

  it("koszyk z carts/update: stan bez e-maila, bez zdarzenia", async () => {
    const przed = (await zdarzenia(tenantA)).length;
    expect((await postWebhook(webhook("carts/update", FX("koszyk.json")))).status).toBe(200);
    await przetworzSurowe(tenantA);
    const { rows } = await getPool().query("select stage, email, profile_id from carts where tenant_id = $1 and platform_token = 'cart:Z2NwLWV1cm9wZS13ZXN0'", [tenantA]);
    expect(rows[0]).toMatchObject({ stage: "cart", email: null, profile_id: null });
    expect((await zdarzenia(tenantA)).length).toBe(przed);
  });

  it("import historii (Bulk Operations): plan, etapy z odpytywaniem, daty ze źródła, backfill, klienci tylko ze zgodą", async () => {
    atrapa.bulk.pliki = { "/bulk/produkty.jsonl": FX("bulk-produkty.jsonl"), "/bulk/klienci.jsonl": FX("bulk-klienci.jsonl"), "/bulk/zamowienia.jsonl": FX("bulk-zamowienia.jsonl") };
    atrapa.bulk.stany = { produkty: ["RUNNING", "COMPLETED"], klienci: ["COMPLETED"], zamowienia: ["RUNNING", "RUNNING", "COMPLETED"] };
    const plan = await zaplanujImportShopify(tenantA, storeA, 24);
    expect(plan).toMatchObject({ zamowienia: 2, klienci: 2, produkty: 2, tylko60Dni: false, wejdaDoAutomatyzacji: 0 });
    // zakres importu tak, żeby objął zamówienia z 2025 z atrapy
    const runId = await rozpocznijImportShopify(tenantA, storeA, { ...plan, od: "2025-01-01T00:00:00.000Z" });
    expect(await rozpocznijImportShopify(tenantA, storeA, plan)).toBe(runId);
    let kroki = 0;
    while ((await krokImportuShopify(tenantA, runId)) === "dalej") if (++kroki > 20) throw new Error("import się zapętlił");
    expect(atrapa.bulk.etapy).toEqual(["produkty", "klienci", "zamowienia"]);
    const { rows: run } = await getPool().query("select status, counters, progress from import_runs where id = $1", [runId]);
    expect(run[0].status).toBe("done");
    expect(run[0].counters).toMatchObject({ noweZamowienia: 2, zgody: 1, produkty: 2 });
    const { rows: o } = await getPool().query("select external_id, status, occurred_at from orders where tenant_id = $1 and store_id = $2 and external_id in ('5001', '5002') order by external_id", [tenantA, storeA]);
    expect(o.map((x) => [x.external_id, x.status, new Date(x.occurred_at).toISOString()])).toEqual([
      ["5001", "completed", "2025-03-14T08:30:00.000Z"],
      ["5002", "cancelled", "2025-11-02T19:00:00.000Z"],
    ]);
    const ev = (await zdarzenia(tenantA)).filter((e) => e.metryka === "shopify/Placed Order" && e.source === "import");
    expect(ev).toHaveLength(2);
    expect(ev.every((e) => e.backfill === true)).toBe(true);
    // klient bez zgody (Ewa) nie dostał profilu z importu klientów; Anna ma zgodę z datą ze Shopify
    const { rows: pr } = await getPool().query("select lower(email) as e from profiles where tenant_id = $1 and lower(email) in ('anna@example.test', 'ewa@example.test')", [tenantA]);
    expect(pr.map((x) => x.e)).toEqual(["anna@example.test"]);
    const { rows: zg } = await getPool().query(
      "select c.occurred_at from consents c join profiles p on p.tenant_id = c.tenant_id and p.id = c.profile_id where c.tenant_id = $1 and lower(p.email) = 'anna@example.test' and c.state = 'granted'",
      [tenantA],
    );
    expect(new Date(zg[0].occurred_at).toISOString()).toBe("2025-03-14T08:29:30.000Z");
    // produkt zarchiwizowany w Shopify = nieaktywny
    const { rows: prod } = await getPool().query("select external_id, active from products where tenant_id = $1 and store_id = $2 order by external_id", [tenantA, storeA]);
    expect(prod).toEqual([{ external_id: "632910392", active: true }, { external_id: "632910393", active: false }]);
    // anulowane z historii: metryka statusu jako backfill (nie wyzwala flow)
    const can = (await zdarzenia(tenantA)).filter((e) => e.metryka === "shopify/Cancelled Order" && e.source === "import");
    expect(can.map((e) => e.backfill)).toEqual([true]);
    // zgodność danych przez fabrykę portu „Sklep” (AdapterShopify, ordersCount)
    const zg2 = await sprawdzZgodnosc(tenantA, storeA, 400);
    expect(zg2.wSklepie).toBe(2);
  });

  it("stan „Sprawdź połączenie”: punkty kontroli i deep link app embed", async () => {
    const s = await stanShopify(tenantA, storeA);
    expect(s?.linkMotywu).toBe(`https://${DOMENA_A}/admin/themes/current/editor?context=apps&activateAppId=${CLIENT_A}/midrev-embed`);
    expect(s?.punkty.find((p) => p.klucz === "zamowienia")?.ok).toBe(true);
    expect(s?.punkty.find((p) => p.klucz === "checkout")?.ok).toBe(true);
    expect(await stanShopify(tenantB, storeA)).toBeNull();
  });

  it("RODO: data_request = zadanie dla operatora; customers/redact anonimizuje osobę i jej surowe dane; dowód bez adresu", async () => {
    expect((await postWebhook(webhook("customers/data_request", FX("rodo-data-request.json")))).status).toBe(200);
    expect((await postWebhook(webhook("customers/redact", FX("rodo-customers-redact.json")))).status).toBe(200);
    await przetworzSurowe(tenantA);
    const { rows: req } = await getPool().query("select topic, status, email_hash, result::text as r from shopify_gdpr_requests where tenant_id = $1 order by received_at", [tenantA]);
    expect(req.map((r) => [r.topic, r.status])).toEqual([["customers/data_request", "needs_operator"], ["customers/redact", "done"]]);
    expect(req.every((r) => !r.r.includes("@") && r.email_hash !== "jan.kowalski@example.test")).toBe(true);
    const { rows: p } = await getPool().query("select count(*)::int as n from profiles where tenant_id = $1 and lower(email) = 'jan.kowalski@example.test'", [tenantA]);
    expect(p[0].n).toBe(0);
    const { rows: surowe } = await getPool().query("select count(*)::int as n from raw_events where tenant_id = $1 and source = 'shopify' and payload::text ilike '%jan.kowalski%'", [tenantA]);
    expect(surowe[0].n).toBe(0);
    const { rows: zam } = await getPool().query("select raw::text as r, total_minor::int as suma from orders where tenant_id = $1 and external_id = '820982911946154500'", [tenantA]);
    expect(zam[0].r).not.toContain("jan.kowalski");
    expect(zam[0].suma).toBe(25800);
    // kolejny webhook tej osoby (checkout) nie odtwarza profilu (nagrobek)
    expect((await postWebhook(webhook("checkouts/update", FX("checkout-z-emailem.json").replace("ck-7f3a9b2c1d", "ck-nowy-123")))).status).toBe(200);
    await przetworzSurowe(tenantA);
    const { rows: p2 } = await getPool().query("select count(*)::int as n from profiles where tenant_id = $1 and lower(email) = 'jan.kowalski@example.test'", [tenantA]);
    expect(p2[0].n).toBe(0);
  });

  it("app/uninstalled: token usunięty, status błędu; shop/redact zaślepia sklep (tylko ten sklep)", async () => {
    expect((await postWebhook(webhook("app/uninstalled", { id: 954889, domain: DOMENA_A }))).status).toBe(200);
    await przetworzSurowe(tenantA);
    const s = await sklepShopify(tenantA, storeA);
    expect(s?.status).toBe("error");
    expect(s?.poswiadczenia.accessToken).toBeNull();
    expect(s?.poswiadczenia.clientSecret.ujawnij()).toBe(SEKRET_A);
    // webhook RODO po odinstalowaniu dalej weryfikowalny sekretem aplikacji
    expect((await postWebhook(webhook("shop/redact", FX("rodo-shop-redact.json")))).status).toBe(200);
    await przetworzSurowe(tenantA);
    const { rows } = await getPool().query("select count(*)::int as n from raw_events where tenant_id = $1 and source = 'shopify' and not (payload ? 'anonimizowano')", [tenantA]);
    expect(rows[0].n).toBe(0);
    const { rows: k } = await getPool().query("select count(*)::int as n from carts where tenant_id = $1 and store_id = $2", [tenantA, storeA]);
    expect(k[0].n).toBe(0);
    const { rows: g } = await getPool().query("select status from shopify_gdpr_requests where tenant_id = $1 and topic = 'shop/redact'", [tenantA]);
    // profile sklepu zostają do decyzji operatora: żądanie otwarte
    expect(g[0].status).toBe("needs_operator");
    // atrapa nie dostała żadnego żądania do hosta spoza Shopify
    expect(atrapa.wywolania.every((w) => w.host.endsWith(".myshopify.com"))).toBe(true);
  });
});
