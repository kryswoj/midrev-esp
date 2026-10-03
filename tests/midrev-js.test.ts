import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BUDZET_MIDREV_JS_GZ_B, zbudujMidrevJs, type KonfiguracjaMidrevJs } from "../src/app/js/runtime-midrev";
import { parsujCene, parsujFeed, produktyZPozycji, BladFeedu, MAKS_POZYCJI_FEEDU } from "../src/domain/katalog/feed";

// midrev.js uruchamiany W TEJ POSTACI, w jakiej trafia do przeglądarek (node:vm + atrapa
// window/document): bramka zgody, shim Klaviyo, token _mx, GA4 dataLayer, deduplikacja,
// odporność. Bez bazy.

interface Wyslane {
  url: string;
  cialo: { data: { type: string; attributes: Record<string, any> } };
}

function przegladarka(o: { url?: string; konfig?: Partial<KonfiguracjaMidrevJs>; przed?: (w: any) => void; fetchRzuca?: boolean } = {}) {
  const wyslane: Wyslane[] = [];
  const ciasteczka = new Map<string, string>();
  const nasluchy: Record<string, ((e: any) => void)[]> = {};
  const timery: (() => void)[] = [];
  let adres = new URL(o.url ?? "https://sklep.test/produkt?x=1");
  const location = {
    get href() { return adres.toString(); },
    get search() { return adres.search; },
    get pathname() { return adres.pathname; },
    get origin() { return adres.origin; },
    get hostname() { return adres.hostname; },
    get protocol() { return adres.protocol; },
  };
  const document: any = {
    readyState: "complete",
    get cookie() { return [...ciasteczka].map(([k, v]) => `${k}=${v}`).join("; "); },
    set cookie(v: string) {
      const [para] = v.split(";");
      const i = para.indexOf("=");
      const k = para.slice(0, i).trim();
      if (/max-age=0/i.test(v)) ciasteczka.delete(k);
      else ciasteczka.set(k, para.slice(i + 1));
    },
    addEventListener(t: string, f: (e: any) => void) { (nasluchy["d:" + t] ??= []).push(f); },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    createElement: () => ({ setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    body: null,
  };
  const pamiec = new Map<string, string>();
  const w: any = {
    location,
    document,
    history: { state: null, replaceState(_s: unknown, _t: string, u: string) { adres = new URL(u, adres); } },
    console: { log() {} },
    crypto: webcrypto,
    localStorage: { getItem: (k: string) => pamiec.get(k) ?? null, setItem: (k: string, v: string) => void pamiec.set(k, v) },
    navigator: {},
    setTimeout: (f: () => void) => { timery.push(f); return 1; },
    setInterval: () => 1,
    clearInterval() {},
    addEventListener(t: string, f: (e: any) => void) { (nasluchy["w:" + t] ??= []).push(f); },
    fetch: async (url: string, init: { body: string; headers: Record<string, string> }) => {
      if (o.fetchRzuca) throw new Error("sieć");
      expect(init.headers["Content-Type"]).toMatch(/^text\/plain/);
      expect(url).not.toMatch(/@/);
      wyslane.push({ url, cialo: JSON.parse(init.body) });
      return { status: 202 };
    },
  };
  o.przed?.(w);
  const js = zbudujMidrevJs({ id: "AbC123", api: "https://link.midrev.test", zgoda: true, ga4: true, shim: true, formy: null, ...o.konfig });
  runInNewContext(js, { window: w, document, URL, URLSearchParams, Uint8Array, Promise, JSON });
  const czekaj = () => new Promise((r) => setTimeout(r, 5));
  return {
    w,
    wyslane,
    ciasteczka,
    adres: () => adres.toString(),
    czekaj,
    wyzwol: (t: string) => [...(nasluchy["w:" + t] ?? []), ...(nasluchy["d:" + t] ?? [])].forEach((f) => f({})),
    zdarzenieDokumentu: (t: string, detail: unknown) => (nasluchy["d:" + t] ?? []).forEach((f) => f({ detail })),
    timery,
  };
}

const zdarzenia = (b: { wyslane: Wyslane[] }) => b.wyslane.filter((x) => x.url.includes("/client/events")).map((x) => x.cialo.data.attributes.metric.data.attributes.name);

describe("midrev.js w przeglądarce", () => {
  it("rozmiar < 15 KB po gzip, czysty JavaScript (vm się kompiluje)", () => {
    const js = zbudujMidrevJs({ id: "AbC123", api: "https://x", zgoda: true, ga4: true, shim: true, formy: "https://x/s/1" });
    expect(gzipSync(js).length).toBeLessThan(BUDZET_MIDREV_JS_GZ_B);
  });

  it("konfiguracja w skrypcie jest bezpieczna (</script> z danych nie zamyka tagu)", () => {
    const js = zbudujMidrevJs({ id: "AbC123", api: "https://x</script><script>alert(1)//", zgoda: true, ga4: false, shim: true, formy: null });
    expect(js).not.toContain("</script>");
  });

  it("BEZ ZGODY: zero żądań i zero ciasteczek mimo identify, track i view_item w dataLayer; _mx i tak znika z adresu", async () => {
    const token = "A".repeat(87);
    const b = przegladarka({
      url: `https://sklep.test/p?_mx=${token}&utm_source=mail`,
      przed: (w) => {
        w.dataLayer = [{ event: "view_item", ecommerce: { items: [{ item_id: "1", item_name: "Krem", price: 10 }] } }];
        w._learnq = [["identify", { $email: "jan@ex.test" }]];
      },
    });
    b.w.midrev.track("Własne", { a: 1 });
    await b.czekaj();
    expect(b.wyslane).toHaveLength(0);
    expect(b.ciasteczka.size).toBe(0);
    expect(b.adres()).toBe("https://sklep.test/p?utm_source=mail");
    expect(await b.w.midrev.isIdentified()).toBe(false);
  });

  it("zgoda przez Google Consent Mode v2 (gtag consent update): kolejka sprzed zgody wysłana, token z linku użyty", async () => {
    const token = "B".repeat(87);
    const b = przegladarka({
      url: `https://sklep.test/p?_mx=${token}`,
      przed: (w) => {
        w.dataLayer = [];
        w.dataLayer.push(["consent", "default", { analytics_storage: "denied" }]);
        w.dataLayer.push({ event: "view_item", ecommerce: { currency: "PLN", items: [{ item_id: "1", item_name: "Krem", price: 10 }] } });
      },
    });
    await b.czekaj();
    expect(b.wyslane).toHaveLength(0);
    // gtag('consent','update',...) wkłada do dataLayer obiekt arguments
    (function (..._a: unknown[]) { b.w.dataLayer.push(arguments); })("consent", "update", { analytics_storage: "granted" });
    await b.czekaj();
    const profile = b.wyslane.filter((x) => x.url.includes("/client/profiles"));
    expect(profile[0].cialo.data.attributes._kx).toBe(token);
    expect(zdarzenia(b)).toContain("Viewed Product");
    expect(b.ciasteczka.get("__mx_id")).toBeTruthy();
    // wycofanie zgody: ciasteczko usunięte, kolejne zdarzenia nie wychodzą
    (function (..._a: unknown[]) { b.w.dataLayer.push(arguments); })("consent", "update", { analytics_storage: "denied" });
    const ile = b.wyslane.length;
    b.w.midrev.track("Po wycofaniu", {});
    await b.czekaj();
    expect(b.wyslane.length).toBe(ile);
    expect(b.ciasteczka.has("__mx_id")).toBe(false);
  });

  it("Cookiebot: zdarzenie CookiebotOnAccept włącza śledzenie; tryb bez wymogu zgody działa od razu", async () => {
    const b = przegladarka();
    b.w.Cookiebot = { hasResponse: true, consent: { statistics: true } };
    b.wyzwol("CookiebotOnAccept");
    b.w.midrev.identify({ email: "ola@ex.test" });
    await b.czekaj();
    expect(b.wyslane.some((x) => x.url.includes("/client/profiles"))).toBe(true);
    const bez = przegladarka({ konfig: { zgoda: false } });
    bez.w.midrev.track("Coś", {});
    await bez.czekaj();
    expect(zdarzenia(bez)).toEqual(["Coś"]);
  });

  it("shim Klaviyo: _learnq i klaviyo z kolejki sprzed załadowania, klaviyo.identify zwraca Promise, adres z company_id", async () => {
    const b = przegladarka({
      konfig: { zgoda: false },
      przed: (w) => {
        w._learnq = [["identify", { $email: "jan@ex.test", $first_name: "Jan", plan: "pro" }], ["track", "Kliknął baner", { id: 7 }]];
        w.klaviyo = [["track", "Z kolejki klaviyo", {}]];
      },
    });
    const wynik = b.w.klaviyo.identify({ email: "jan@ex.test" });
    expect(typeof wynik.then).toBe("function");
    await b.czekaj();
    const id = b.wyslane.find((x) => x.url.includes("/client/profiles"))!;
    expect(id.url).toBe("https://link.midrev.test/client/profiles?company_id=AbC123");
    expect(id.cialo.data.attributes).toMatchObject({ email: "jan@ex.test", first_name: "Jan", properties: { plan: "pro" } });
    expect(zdarzenia(b)).toEqual(expect.arrayContaining(["Kliknął baner", "Z kolejki klaviyo", "Active on Site"]));
    b.w._learnq.push(["track", "Po załadowaniu", {}]);
    await b.czekaj();
    expect(zdarzenia(b)).toContain("Po załadowaniu");
  });

  it("prawdziwe klaviyo.js na stronie NIE jest nadpisywane (tylko window.midrev)", () => {
    const prawdziwe = { identify() {}, track() {}, push() {} };
    const b = przegladarka({ przed: (w) => { w.klaviyo = prawdziwe; } });
    expect(b.w.klaviyo).toBe(prawdziwe);
    expect(b.w.midrev.v).toBe("1.0.0");
  });

  it("Active on Site tylko dla rozpoznanych, najwyżej raz na 30 min", async () => {
    const b = przegladarka({ konfig: { zgoda: false } });
    await b.czekaj();
    expect(zdarzenia(b)).not.toContain("Active on Site");
    b.w.midrev.identify({ email: "a@ex.test" });
    b.w.midrev.identify({ email: "a@ex.test" });
    await b.czekaj();
    expect(zdarzenia(b).filter((n) => n === "Active on Site")).toHaveLength(1);
  });

  it("GA4: view_item → Viewed Product (pola Klaviyo), add_to_cart → Added to Cart, begin_checkout → Started Checkout z Items; purchase tylko identify", async () => {
    const b = przegladarka({ konfig: { zgoda: false } });
    const item = { item_id: "K-50", item_name: "Krem", price: 89.9, quantity: 2, item_brand: "Somi", item_category: "Pielęgnacja", item_category2: "Kremy", item_variant: "50 ml" };
    const [n1, p1, w1] = b.w.midrev._mapujGa4("view_item", { currency: "PLN", items: [item] }, "https://sklep.test/krem", "https://sklep.test/k.jpg");
    expect(n1).toBe("Viewed Product");
    expect(w1).toBe("PLN");
    expect(p1).toMatchObject({ ProductID: "K-50", ProductName: "Krem", Price: 89.9, $value: 89.9, URL: "https://sklep.test/krem", ImageURL: "https://sklep.test/k.jpg", Brand: "Somi", Categories: ["Pielęgnacja", "Kremy"] });
    const [n2, p2] = b.w.midrev._mapujGa4("add_to_cart", { value: 179.8, items: [item] }, "https://sklep.test/krem", null);
    expect(n2).toBe("Added to Cart");
    expect(p2).toMatchObject({ $value: 179.8, AddedItemProductID: "K-50", AddedItemQuantity: 2, AddedItemPrice: 89.9, ItemNames: ["Krem"] });
    const [n3, p3] = b.w.midrev._mapujGa4("begin_checkout", { items: [item, { item_id: "S", item_name: "Serum", price: 10 }] }, "https://sklep.test/kasa", null);
    expect(n3).toBe("Started Checkout");
    expect(p3).toMatchObject({ $value: 189.8, CheckoutURL: "https://sklep.test/kasa", ItemNames: ["Krem", "Serum"] });
    expect(p3.Items[0]).toMatchObject({ ProductID: "K-50", Quantity: 2, RowTotal: 179.8, ProductCategories: ["Pielęgnacja", "Kremy"] });
    expect(b.w.midrev._mapujGa4("purchase", { items: [item] }, "x", null)).toBeNull();
    expect(b.w.midrev._mapujGa4("view_item", null, "x", null)).toBeNull();
    expect(b.w.midrev._mapujGa4("view_item", { items: [] }, "x", null)).toBeNull();

    b.w.dataLayer.push({ event: "purchase", ecommerce: { transaction_id: "1", items: [item] }, user_data: { email: "kupil@ex.test" } });
    await b.czekaj();
    expect(zdarzenia(b)).not.toContain("Placed Order");
    expect(b.wyslane.find((x) => x.url.includes("/client/profiles"))!.cialo.data.attributes.email).toBe("kupil@ex.test");
  });

  it("deduplikacja: GA4 view_item i ręczne track('Viewed Product') tego samego produktu = jedno żądanie z unique_id", async () => {
    const b = przegladarka({ konfig: { zgoda: false } });
    b.w.midrev.identify({ email: "d@ex.test" });
    b.w.dataLayer.push({ event: "view_item", ecommerce: { items: [{ item_id: "K-50", item_name: "Krem", price: 1 }] } });
    b.w.midrev.track("Viewed Product", { ProductID: "K-50", ProductName: "Krem" });
    b.w._learnq.push(["track", "Viewed Product", { ProductID: "K-50", ProductName: "Krem" }]);
    await b.czekaj();
    const vp = b.wyslane.filter((x) => x.url.includes("/client/events") && x.cialo.data.attributes.metric.data.attributes.name === "Viewed Product");
    expect(vp).toHaveLength(1);
    expect(vp[0].cialo.data.attributes.unique_id).toMatch(/^vp:/);
  });

  it("GA4 wyłączone w panelu: dataLayer ecommerce ignorowany (ale Consent Mode dalej czytany)", async () => {
    const b = przegladarka({ konfig: { ga4: false, zgoda: false } });
    b.w.dataLayer.push({ event: "view_item", ecommerce: { items: [{ item_id: "1", item_name: "K" }] } });
    await b.czekaj();
    expect(zdarzenia(b)).toHaveLength(0);
  });

  it("formularz zgłasza zapis zdarzeniem midrev:identify; subscribe wysyła treść zgody w ciele, nie w adresie", async () => {
    const b = przegladarka({ konfig: { zgoda: false } });
    b.zdarzenieDokumentu("midrev:identify", { email: "form@ex.test" });
    await b.w.midrev.subscribe({ email: "form@ex.test", consentText: "Zgoda X", listId: "l1", source: "stopka" });
    await b.czekaj();
    const s = b.wyslane.find((x) => x.url.includes("/client/subscriptions"))!;
    expect(s.cialo.data.attributes).toMatchObject({ consent_text: "Zgoda X", custom_source: "stopka" });
    expect(s.url).not.toContain("form");
    expect(b.wyslane.filter((x) => x.url.includes("/client/profiles")).length).toBeGreaterThan(0);
  });

  it("odporność: fetch rzuca, śmieci w komendach, podwójny tag: strona nie dostaje wyjątku", async () => {
    const b = przegladarka({ konfig: { zgoda: false }, fetchRzuca: true });
    expect(() => {
      b.w.midrev.push(null, 7, "x", ["nieznana"], ["track"], ["identify", "zly"], () => { throw new Error("x"); });
      b.w._learnq.push(["track", { obiekt: true }]);
      b.w.dataLayer.push({ event: "add_to_cart", ecommerce: { items: "nie tablica" } });
    }).not.toThrow();
    await expect(b.w.midrev.track("X", {})).resolves.toBe(false);
    // drugi raz ten sam skrypt na stronie: nic się nie dubluje
    const js = zbudujMidrevJs({ id: "AbC123", api: "https://x", zgoda: false, ga4: true, shim: true, formy: null });
    expect(() => runInNewContext(js, { window: b.w, document: b.w.document, URL })).not.toThrow();
  });
});

describe("parser feedu Google Merchant", () => {
  it("RSS 2.0 z g:, CDATA, encje, HTML w opisie usunięty, javascript: link odrzucony", () => {
    const w = parsujFeed(`<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel><title>Sklep</title>
      <item><g:id>1</g:id><title><![CDATA[Krem & <b>serum</b>]]></title><description>&lt;p&gt;Opis&lt;/p&gt; <![CDATA[<img src=x onerror=alert(1)>]]></description>
      <link>javascript:alert(1)</link><g:image_link>https://cdn.test/a.jpg</g:image_link><g:price>1 299,00 zł</g:price>
      <g:shipping><g:country>PL</g:country><g:price>9.99 PLN</g:price></g:shipping><g:availability>out of stock</g:availability></item></channel></rss>`);
    expect(w.format).toBe("rss");
    expect(w.pozycje[0]).toMatchObject({ id: "1", tytul: "Krem & serum", link: null, obraz: "https://cdn.test/a.jpg", dostepnosc: "out_of_stock" });
    expect(w.pozycje[0].cena).toEqual({ minor: 129900n, waluta: "PLN" });
    expect(w.pozycje[0].opis).not.toMatch(/<|onerror/);
  });

  it("Atom (<entry>, <link href>)", () => {
    const w = parsujFeed(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:g="http://base.google.com/ns/1.0"><entry><g:id>A1</g:id><title>Atom</title><link href="https://s.test/a1"/><g:price>10 EUR</g:price></entry></feed>`);
    expect(w).toMatchObject({ format: "atom", pozycje: [{ id: "A1", link: "https://s.test/a1", cena: { minor: 1000n, waluta: "EUR" } }] });
  });

  it("CSV (cudzysłowy, przecinek w polu, nowa linia) i TSV z nagłówkami „image link”", () => {
    const csv = parsujFeed(`id,title,price,link,item_group_id\n"1","Krem, ""duży""\nnowa",19.99 PLN,https://s.test/1,G\n2,Serum,5 PLN,https://s.test/2,G\n`);
    expect(csv.format).toBe("csv");
    expect(csv.pozycje[0].tytul).toBe('Krem, "duży" nowa');
    const p = produktyZPozycji(csv.pozycje);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ externalId: "G", cenaMinor: 500n });
    expect(p[0].warianty).toHaveLength(2);
    const tsv = parsujFeed(`id\ttitle\timage link\tprice\nX\tIks\thttps://s.test/x.jpg\t3.50 PLN\n`);
    expect(tsv).toMatchObject({ format: "tsv", pozycje: [{ id: "X", obraz: "https://s.test/x.jpg", cena: { minor: 350n } }] });
  });

  it("złośliwe i złe wejście: DOCTYPE/ENTITY, JSON, CSV bez id/title, pusty plik = BladFeedu; duplikaty id pominięte", () => {
    expect(() => parsujFeed(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><rss><channel><item><g:id>1</g:id><title>&e;</title></item></channel></rss>`)).toThrow(BladFeedu);
    expect(() => parsujFeed(`{"items":[]}`)).toThrow(BladFeedu);
    expect(() => parsujFeed(`sku,name\n1,a`)).toThrow(BladFeedu);
    expect(() => parsujFeed("   ")).toThrow(BladFeedu);
    const d = parsujFeed(`<rss><channel><item><g:id>1</g:id><title>A</title></item><item><g:id>1</g:id><title>B</title></item><item><title>bez id</title></item></channel></rss>`);
    expect(d.pozycje).toHaveLength(1);
    expect(d.pominiete).toBe(2);
  });

  it("limit liczby pozycji i długości pól", () => {
    const wiersze = ["id,title"];
    for (let i = 0; i < MAKS_POZYCJI_FEEDU + 5; i++) wiersze.push(`${i},T${i}`);
    const w = parsujFeed(wiersze.join("\n"));
    expect(w.pozycje).toHaveLength(MAKS_POZYCJI_FEEDU);
    expect(w.obciety).toBe(true);
    const dlugi = parsujFeed(`id,title\n1,${"x".repeat(2000)}`);
    expect(dlugi.pozycje[0].tytul.length).toBe(500);
  });

  it("ceny: formaty PL i EN, waluta domyślna, śmieci = null", () => {
    expect(parsujCene("12.99 PLN")).toEqual({ minor: 1299n, waluta: "PLN" });
    expect(parsujCene("PLN 1,234.50")).toEqual({ minor: 123450n, waluta: "PLN" });
    expect(parsujCene("1.234,50 EUR")).toEqual({ minor: 123450n, waluta: "EUR" });
    expect(parsujCene("15", "CZK")).toEqual({ minor: 1500n, waluta: "CZK" });
    expect(parsujCene("darmo")).toBeNull();
    expect(parsujCene("-5 PLN")).toBeNull();
  });
});
