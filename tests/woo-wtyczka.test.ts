import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { closePool, getPool } from "../src/adapters/db/pool";
import { odszyfrujPoswiadczenia } from "../src/adapters/store/fabryka";
import {
  BladParowania,
  klauzulaCheckoutu,
  normalizujKod,
  podpisWtyczki,
  przetworzZdarzenieWtyczki,
  przyjmijKluczeWcAuth,
  rozlaczWtyczke,
  sparujWtyczke,
  startWcAuth,
  utworzKodParowania,
  uwierzytelnijWtyczke,
  zapiszKlauzuleCheckoutu,
} from "../src/usecases/integracja/woo-wtyczka";
import { POST as postZdarzenia } from "../src/app/api/integracje/woocommerce/[storeId]/zdarzenia/route";

// Wtyczka „MidRev ESP for WooCommerce” po stronie ESP: parowanie kodem, podpisane zdarzenia
// serwer-serwer, koszyk z linkiem powrotu, zgoda z kasy z wersją klauzuli, /wc-auth.
// Sklep udaje mały serwer HTTP w kształcie REST v3 Woo (zakresy, nagłówki paginacji, webhooki),
// więc test nie zależy od sandboxa Woo ani od firewalla.

const PREFIKS = "WOO WTYCZKA ";
const CK = "ck_" + "a".repeat(40);
const CS = "cs_" + "b".repeat(40);

let sklep: Server;
let adresSklepu = "";
const webhookiSklepu: any[] = [];
let odrzucajKlucze = false;

function uruchomSklep(): Promise<void> {
  sklep = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const auth = req.headers.authorization ?? "";
    const ok = auth === "Basic " + Buffer.from(`${CK}:${CS}`).toString("base64") && !odrzucajKlucze;
    if (!ok) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ code: "woocommerce_rest_authentication_error" }));
      return;
    }
    const lista = (dane: unknown[]) => {
      res.writeHead(200, { "content-type": "application/json", "x-wp-total": String(dane.length), "x-wp-totalpages": "1" }).end(JSON.stringify(dane));
    };
    if (/^\/wp-json\/wc\/v3\/(orders|customers|products)$/.test(u.pathname)) return lista([]);
    if (u.pathname === "/wp-json/wc/v3/webhooks" && req.method === "GET") return lista(webhookiSklepu);
    if (u.pathname === "/wp-json/wc/v3/webhooks" && req.method === "POST") {
      const kawalki: Buffer[] = [];
      for await (const k of req) kawalki.push(k as Buffer);
      const d = JSON.parse(Buffer.concat(kawalki).toString());
      const w = { id: webhookiSklepu.length + 1, name: d.name, status: "active", topic: d.topic, delivery_url: d.delivery_url, date_modified_gmt: null };
      webhookiSklepu.push(w);
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(w));
      return;
    }
    const m = /^\/wp-json\/wc\/v3\/webhooks\/(\d+)$/.exec(u.pathname);
    if (m) {
      const i = webhookiSklepu.findIndex((w) => w.id === Number(m[1]));
      if (i < 0) return void res.writeHead(404).end("{}");
      if (req.method === "DELETE") {
        const [usuniety] = webhookiSklepu.splice(i, 1);
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(usuniety));
      }
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(webhookiSklepu[i]));
    }
    res.writeHead(404).end("{}");
  });
  return new Promise((r) => sklep.listen(0, "127.0.0.1", () => r()));
}

describe("Wtyczka WooCommerce po stronie ESP", () => {
  let tenantId = "";
  let storeId = "";
  let sekret = "";

  beforeAll(async () => {
    await uruchomSklep();
    adresSklepu = `http://127.0.0.1:${(sklep.address() as AddressInfo).port}`;
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"])).rows[0].id;
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await new Promise((r) => sklep.close(r));
    await closePool();
  });

  it("kod parowania: ≥ 125 bitów, w bazie tylko hash, normalizacja wpisu", async () => {
    const k = await utworzKodParowania(tenantId, { adresSklepu });
    expect(k.kod).toMatch(/^MRV(-[A-Z2-9]{5}){5}$/);
    expect(normalizujKod(k.kod.toLowerCase().replace(/-/g, " "))).toBe(k.kod.replace(/-/g, ""));
    expect(k.link).toContain(`${adresSklepu}/wp-admin/admin.php?page=midrev-esp&mrv_kod=`);
    const { rows } = await getPool().query("select token_hash::text as h from store_connect_tokens where tenant_id = $1", [tenantId]);
    expect(rows[0].h).not.toContain(k.kod.replace(/-/g, ""));
  });

  it("parowanie: zły kod, kod dla innego sklepu i odrzucone klucze nie łączą (kod zostaje do ponowienia)", async () => {
    await expect(sparujWtyczke({ kod: "MRV-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA", home_url: adresSklepu, consumer_key: CK, consumer_secret: CS })).rejects.toThrow(BladParowania);
    const inny = await utworzKodParowania(tenantId, { adresSklepu: "https://inny-sklep.example" });
    await expect(sparujWtyczke({ kod: inny.kod, home_url: adresSklepu, consumer_key: CK, consumer_secret: CS })).rejects.toThrow(/inny-sklep\.example/);
    const k = await utworzKodParowania(tenantId, { adresSklepu });
    odrzucajKlucze = true;
    await expect(sparujWtyczke({ kod: k.kod, home_url: adresSklepu, consumer_key: CK, consumer_secret: CS })).rejects.toThrow(/odrzucił/);
    odrzucajKlucze = false;
    // klucz strony z wyłączonym wymogiem zgody na cookies (np. wcześniej „Własna strona”):
    // parowanie Woo musi go włączyć, bo __mx_id = zgoda dla wtyczki (RODO wariant B)
    const { zapewnijKluczStrony } = await import("../src/usecases/integracja/klucz-strony");
    await zapewnijKluczStrony(tenantId);
    await getPool().query("update site_keys set require_cookie_consent = false where tenant_id = $1", [tenantId]);
    // ten sam kod działa po naprawie (porażka zwolniła kod)
    const w = await sparujWtyczke({ kod: k.kod, home_url: adresSklepu + "/", consumer_key: CK, consumer_secret: CS, plugin_version: "1.0.0" });
    storeId = w.store_id;
    sekret = w.plugin_secret;
    expect(w.site_key).toMatch(/^[A-Za-z0-9]{6,10}$/);
    expect(w.script_url).toContain(`/js/v1/${w.site_key}.js`);
    expect(w.konfiguracja.checkbox).toBe(true);
    expect(w.konfiguracja.zgoda?.wersja).toBe(1);
    // ponowienie TYM SAMYM kodem i TYM SAMYM kluczem dla TEGO sklepu (zgubiona odpowiedź) =
    // ten sam sekret (idempotentnie); inny klucz z tym kodem = odmowa (nikt nie obróci sekretu)
    const ponowne = await sparujWtyczke({ kod: k.kod, home_url: adresSklepu, consumer_key: CK, consumer_secret: CS });
    expect(ponowne.store_id).toBe(storeId);
    expect(ponowne.plugin_secret).toBe(sekret);
    await expect(sparujWtyczke({ kod: k.kod, home_url: adresSklepu, consumer_key: "ck_" + "c".repeat(40), consumer_secret: CS })).rejects.toThrow(/nieważny/);
    await expect(sparujWtyczke({ kod: k.kod, home_url: "https://obcy-sklep.example", consumer_key: CK, consumer_secret: CS })).rejects.toThrow(/nieważny|innego sklepu|obcy/);
    // sklep zapisany z metodą, wersją wtyczki, sekretem w szyfrogramie; webhooki założone
    const { rows } = await getPool().query("select platform, base_url, connection_method, plugin_version, credentials_encrypted from stores where id = $1", [storeId]);
    expect(rows[0]).toMatchObject({ platform: "woocommerce", base_url: adresSklepu, connection_method: "wtyczka", plugin_version: "1.0.0" });
    expect(odszyfrujPoswiadczenia(rows[0].credentials_encrypted).pluginSecret).toBe(sekret);
    expect(webhookiSklepu.map((x) => x.topic).sort()).toEqual(["customer.created", "customer.updated", "order.created", "order.updated"]);
    const { rows: role } = await getPool().query("select role from metric_mappings where tenant_id = $1 order by role", [tenantId]);
    expect(role.map((r) => r.role)).toEqual(expect.arrayContaining(["added_to_cart", "placed_order", "started_checkout", "viewed_product"]));
    const { rows: sk } = await getPool().query("select platform, link_domains, ga4_datalayer, require_cookie_consent from site_keys where tenant_id = $1", [tenantId]);
    expect(sk[0]).toMatchObject({ platform: "woocommerce", link_domains: ["127.0.0.1"], ga4_datalayer: false, require_cookie_consent: true });
  });

  function podpisane(cialo: unknown, ts = Math.floor(Date.now() / 1000), klucz = sekret) {
    const json = JSON.stringify(cialo);
    return { json, naglowki: new Headers({ "x-mrv-timestamp": String(ts), "x-mrv-signature": podpisWtyczki(klucz, String(ts), json), "content-type": "application/json" }) };
  }

  async function wyslij(zdarzenia: unknown[]) {
    const { json, naglowki } = podpisane({ zdarzenia, wtyczka: { wersja: "1.0.0" } });
    const odp = await postZdarzenia(new NextRequest(`http://localhost/api/integracje/woocommerce/${storeId}/zdarzenia`, { method: "POST", headers: naglowki, body: json }), {
      params: Promise.resolve({ storeId }),
    });
    const { rows } = await getPool().query("select id from raw_events where tenant_id = $1 and channel = 'plugin' and processed_at is null order by received_at", [tenantId]);
    for (const r of rows) await przetworzZdarzenieWtyczki(tenantId, r.id);
    return odp;
  }

  const koszyk = (token: string, link: string) => ({
    token,
    pozycje: [
      { product_id: 77, variation_id: 0, name: "Kubek <b>XL</b>", qty: 2, price: "30.00", image: "javascript:alert(1)", url: `${adresSklepu}/kubek` },
      { product_id: 78, variation_id: 781, name: "Koszulka", qty: 1, price: "63.45", image: `${adresSklepu}/k.jpg`, url: `${adresSklepu}/koszulka` },
    ],
    wartosc: "123.45",
    waluta: "PLN",
    link,
  });

  it("krok 1 bez kluczy: kod pokazuje konto, kod dla innego sklepu (także podkatalog) odpada", async () => {
    const { sprawdzKodParowania } = await import("../src/usecases/integracja/woo-wtyczka");
    const k = await utworzKodParowania(tenantId, { adresSklepu: `${adresSklepu}/sklep-a` });
    expect(await sprawdzKodParowania({ kod: k.kod, home_url: `${adresSklepu}/sklep-a/` })).toMatchObject({ konto: "WOO WTYCZKA A" });
    await expect(sprawdzKodParowania({ kod: k.kod, home_url: `${adresSklepu}/sklep-b` })).rejects.toThrow(/innego sklepu/);
  });

  it("podpis: zły sekret, stary znacznik czasu i odłączony sklep = brak dostępu", async () => {
    const { json, naglowki } = podpisane({ a: 1 });
    expect(await uwierzytelnijWtyczke(storeId, naglowki, json)).not.toBeNull();
    const zly = podpisane({ a: 1 }, undefined, "zly");
    expect(await uwierzytelnijWtyczke(storeId, zly.naglowki, zly.json)).toBeNull();
    const stary = podpisane({ a: 1 }, Math.floor(Date.now() / 1000) - 3600);
    expect(await uwierzytelnijWtyczke(storeId, stary.naglowki, stary.json)).toBeNull();
    // podmienione ciało przy tym samym podpisie
    expect(await uwierzytelnijWtyczke(storeId, naglowki, json.replace("1", "2"))).toBeNull();
  });

  it("Added to Cart i Started Checkout: metryki midrev, koszyk z linkiem na domenie sklepu, ponowienie = bez duplikatu", async () => {
    const link = `${adresSklepu}/?mrv_cart=TOKEN0000000000000000000000000001.1999999999.${"a".repeat(32)}`;
    const atc = { id: "11111111-1111-4111-8111-111111111111", typ: "added_to_cart", czas: new Date().toISOString(), email: "Kupujaca@Example.test", koszyk: koszyk("TOKEN0000000000000000000000000001", link), dodany: koszyk("x", link).pozycje[1] };
    expect((await wyslij([atc])).status).toBe(202);
    // ponowienie tej samej paczki (zgubiona odpowiedź) = nic nowego
    const ponowna = await wyslij([atc]);
    expect(await ponowna.json()).toMatchObject({ nowe: 0, duplikaty: 1 });
    const sc = { id: "22222222-2222-4222-8222-222222222222", typ: "started_checkout", czas: new Date().toISOString(), email: "kupujaca@example.test", imie: "Ola", koszyk: koszyk("TOKEN0000000000000000000000000001", link) };
    await wyslij([sc, { ...sc, id: "33333333-3333-4333-8333-333333333333" }]);
    const { rows } = await getPool().query(
      `select m.name, e.properties, e.source, e.unique_id from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
        where e.tenant_id = $1 and m.integration_key = 'midrev' and m.name in ('Added to Cart', 'Started Checkout') order by e.recorded_at`,
      [tenantId],
    );
    // Started Checkout raz na token i zawartość, mimo dwóch zdarzeń z wtyczki
    expect(rows.map((r) => r.name)).toEqual(["Added to Cart", "Started Checkout"]);
    expect(rows[0].properties).toMatchObject({ AddedItemProductID: "78", AddedItemVariantID: "781", $value: 123.45, CheckoutURL: link });
    expect(rows[1].properties.Items[0]).toMatchObject({ ProductID: "77", ProductName: "Kubek <b>XL</b>", Quantity: 2, ItemPrice: 30, ImageURL: null });
    const { rows: c } = await getPool().query("select stage, recovery_url, email, value_minor, profile_id is not null as z_profilem from carts where tenant_id = $1 and store_id = $2", [tenantId, storeId]);
    expect(c[0]).toMatchObject({ stage: "checkout", recovery_url: link, email: "kupujaca@example.test", value_minor: "12345", z_profilem: true });
  });

  it("link powrotu spoza domeny sklepu nie trafia do koszyka; gość bez identyfikatora = koszyk bez profilu, bez metryki", async () => {
    const zly = { id: "44444444-4444-4444-8444-444444444444", typ: "added_to_cart", czas: new Date().toISOString(), anonymous_id: "anonimowyNieznany01", koszyk: koszyk("TOKEN0000000000000000000000000002", "https://phishing.example/?mrv_cart=x") };
    await wyslij([zly]);
    const { rows } = await getPool().query("select recovery_url, profile_id from carts where tenant_id = $1 and platform_token = 'TOKEN0000000000000000000000000002'", [tenantId]);
    expect(rows[0]).toEqual({ recovery_url: null, profile_id: null });
  });

  it("zgoda z kasy: tekst z bazy w wersji z wtyczki; nieznana wersja = odrzucona; nowa klauzula = nowa wersja", async () => {
    const v2 = await zapiszKlauzuleCheckoutu(tenantId, storeId, { tresc: "Zapisuję się na newsletter sklepu testowego i chcę dostawać oferty.", polityka: "https://sklep.example/polityka" });
    expect(v2.wersja).toBe(2);
    expect((await klauzulaCheckoutu(tenantId, storeId))?.wersja).toBe(2);
    await wyslij([
      { id: "55555555-5555-4555-8555-555555555555", typ: "consent", czas: new Date().toISOString(), email: "kupujaca@example.test", zgoda: { wersja: 2, zamowienie: "1234" } },
      { id: "66666666-6666-4666-8666-666666666666", typ: "consent", czas: new Date().toISOString(), email: "kupujaca@example.test", zgoda: { wersja: 99, zamowienie: "1235" } },
    ]);
    const { rows } = await getPool().query(
      `select c.source, c.wording, c.method_detail, v.version from consents c join store_consent_versions v on v.id = c.store_consent_version_id
        where c.tenant_id = $1 and c.state = 'granted'`,
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "checkout_woocommerce", wording: v2.tresc, version: 2 });
    expect(rows[0].method_detail).toContain("zamówienie 1234");
    const { rows: odrz } = await getPool().query("select process_error from raw_events where tenant_id = $1 and payload ->> 'id' = '66666666-6666-4666-8666-666666666666'", [tenantId]);
    expect(odrz[0].process_error).toBe("niepoprawne:nieznana_wersja_klauzuli");
  });

  it("odłączenie: usuwa nasze webhooki w sklepie, sklep nie przyjmuje zdarzeń", async () => {
    const { json, naglowki } = podpisane({});
    const auth = await uwierzytelnijWtyczke(storeId, naglowki, json);
    const w = await rozlaczWtyczke(auth!);
    expect(w.usunieteWebhooki).toBe(4);
    expect(webhookiSklepu).toHaveLength(0);
    expect(await uwierzytelnijWtyczke(storeId, naglowki, json)).toBeNull();
  });

  it("/wc-auth: stan jednorazowy, klucze bez zapisu odrzucone (stan zostaje), poprawne łączą sklep", async () => {
    const { url } = await startWcAuth(tenantId, adresSklepu, null);
    const u = new URL(url);
    expect(u.pathname).toBe("/wc-auth/v1/authorize");
    expect(u.searchParams.get("scope")).toBe("read_write");
    const stan = u.searchParams.get("user_id")!;
    expect(await przyjmijKluczeWcAuth({ user_id: stan, consumer_key: CK, consumer_secret: CS, key_permissions: "read" })).toMatchObject({ ok: false });
    const ok = await przyjmijKluczeWcAuth({ user_id: stan, consumer_key: CK, consumer_secret: CS, key_permissions: "read_write" });
    expect(ok).toMatchObject({ ok: true, storeId });
    expect(await przyjmijKluczeWcAuth({ user_id: stan, consumer_key: CK, consumer_secret: CS })).toMatchObject({ ok: false, blad: "nieważny stan" });
    const { rows } = await getPool().query("select connection_method, status from stores where id = $1", [storeId]);
    expect(rows[0]).toEqual({ connection_method: "wc_auth", status: "connected" });
  });
});
