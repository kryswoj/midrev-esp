import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zaszyfruj } from "../src/adapters/crypto";
import { closePool, getPool } from "../src/adapters/db/pool";
import { definicjaPlatformy, definicjaPoZrodle } from "../src/adapters/store/rejestr";
import { metrykaZamowienia } from "../src/domain/zdarzenia/kontrakt";
import { metrykaRoli, ustawRoleSklepu } from "../src/usecases/integracja/role-metryk";
import { zapiszZgodeSklepu } from "../src/usecases/integracja/zgody-sklepu";
import { zapiszProduktySklepu } from "../src/usecases/katalog/katalog-sklepu";
import { zapiszKoszykSklepu } from "../src/usecases/katalog/koszyki";
import { przetworzZdarzenie } from "../src/usecases/przetworz-zdarzenie";
import { przyjmijWebhookSklepu } from "../src/usecases/sklep/przyjmij-webhook";

// Port „Sklep” (plan integracji E.1): kontrakt, na którym stoją Woo, a za chwilę Shopify.
// Bez żywego sklepu: payloady w kształcie REST v3 Woo, podpisane jak robi to sklep.

const PREFIKS = "PORT SKLEP ";
const SEKRET = "sekret-webhooka-portu";

function zamowienieWoo(id: number, opcje: { status?: string; zmiana?: string; token?: string; email?: string } = {}) {
  return {
    id,
    number: String(id),
    status: opcje.status ?? "processing",
    currency: "PLN",
    total: "123.45",
    date_created_gmt: "2026-10-01T10:00:00",
    date_modified_gmt: opcje.zmiana ?? "2026-10-01T10:00:00",
    billing: { email: opcje.email ?? "port-kupujacy@example.test", first_name: "Ola", last_name: "Port" },
    line_items: [
      { id: 501, name: "Kubek", product_id: 77, variation_id: 0, quantity: 2, price: 30, total: "60.00", sku: "KUB" },
      { id: 502, name: "Koszulka M", product_id: 78, variation_id: 781, quantity: 1, price: 63.45, total: "63.45", sku: "KOS-M" },
    ],
    meta_data: opcje.token ? [{ id: 1, key: "_mrv_cart_token", value: opcje.token }] : [],
  };
}

function naglowki(temat: string, cialo: string, sekret = SEKRET): Headers {
  return new Headers({
    "x-wc-webhook-topic": temat,
    "x-wc-webhook-signature": createHmac("sha256", sekret).update(cialo, "utf8").digest("base64"),
  });
}

describe("Port „Sklep”: rejestr platform", () => {
  it("Woo jest zarejestrowane, custom nie ma adaptera API, nieznana platforma = null", () => {
    expect(definicjaPlatformy("woocommerce")?.platforma).toBe("woocommerce");
    expect(definicjaPoZrodle("woocommerce")?.webhooki?.tematy).toContain("order.created");
    expect(definicjaPlatformy("custom")).toBeNull();
    expect(definicjaPlatformy("magento")).toBeNull();
  });

  it("role statusów Woo: completed/cancelled/refunded, reszta bez metryki", () => {
    const d = definicjaPlatformy("woocommerce")!;
    expect(d.rolaStatusu("completed")).toBe("fulfilled_order");
    expect(d.rolaStatusu("cancelled")).toBe("cancelled_order");
    expect(d.rolaStatusu("refunded")).toBe("refunded_order");
    expect(d.rolaStatusu("processing")).toBeNull();
  });

  it("metryka zamówień Woo = dotychczasowa metryka wbudowana (ten sam klucz naturalny)", () => {
    expect(metrykaZamowienia("woocommerce", "placed_order")).toMatchObject({ integracja: "woocommerce", nazwa: "Placed Order", mozeWyzwalac: true });
    expect(metrykaZamowienia("shopify", "fulfilled_order")).toMatchObject({ integracja: "shopify", nazwa: "Fulfilled Order" });
  });
});

describe("Port „Sklep”: ingest, metryki, role, koszyki, zgody, katalog", () => {
  let tenantId = "";
  let storeId = "";

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"])).rows[0].id;
    storeId = (
      await pool.query(
        `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
         values ($1, 'woocommerce', 'https://sklep-port.example', $2, 'connected') returning id`,
        [tenantId, zaszyfruj(JSON.stringify({ ck: "ck_x", cs: "cs_x", webhookSecret: SEKRET }))],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  async function dostarcz(temat: string, payload: unknown, sekret = SEKRET) {
    const cialo = JSON.stringify(payload);
    const w = await przyjmijWebhookSklepu("woocommerce", storeId, naglowki(temat, cialo, sekret), cialo);
    if (w.status === 200 && w.tresc !== "temat pominięty" && w.tresc !== "ping") {
      const { rows } = await getPool().query(
        "select id from raw_events where tenant_id = $1 and store_id = $2 and processed_at is null order by received_at",
        [tenantId, storeId],
      );
      for (const r of rows) await przetworzZdarzenie(tenantId, r.id);
    }
    return w;
  }

  async function metryki(nazwa: string) {
    const { rows } = await getPool().query(
      `select e.unique_id, e.source, e.properties from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
        where e.tenant_id = $1 and m.integration_key = 'woocommerce' and m.name = $2 order by e.recorded_at`,
      [tenantId, nazwa],
    );
    return rows;
  }

  it("zły podpis = 401, sklep innej platformy = 404, temat spoza subskrypcji = 200 bez zapisu", async () => {
    const cialo = JSON.stringify(zamowienieWoo(1));
    expect((await przyjmijWebhookSklepu("woocommerce", storeId, naglowki("order.created", cialo, "zly"), cialo)).status).toBe(401);
    expect((await przyjmijWebhookSklepu("shopify", storeId, naglowki("order.created", cialo), cialo)).status).toBe(404);
    expect((await przyjmijWebhookSklepu("woocommerce", storeId, naglowki("coupon.created", cialo), cialo)).tresc).toBe("temat pominięty");
    const { rows } = await getPool().query("select count(*)::int as n from raw_events where tenant_id = $1", [tenantId]);
    expect(rows[0].n).toBe(0);
  });

  it("role zamówień wskazują metryki platformy po podłączeniu (nadpisują rolę z API)", async () => {
    await ustawRoleSklepu(getPool(), tenantId, "woocommerce");
    expect(await metrykaRoli(getPool(), tenantId, "placed_order")).toMatchObject({ integracja: "woocommerce", nazwa: "Placed Order" });
    expect(await metrykaRoli(getPool(), tenantId, "refunded_order")).toMatchObject({ nazwa: "Refunded Order" });
    expect(await metrykaRoli(getPool(), tenantId, "started_checkout")).toBeNull();
  });

  it("zamówienie z webhooka: Placed Order + Ordered Product z wariantem, zamyka koszyk po tokenie", async () => {
    const pool = getPool();
    const klient = await pool.connect();
    try {
      await klient.query("begin");
      await zapiszKoszykSklepu(klient, {
        tenantId,
        storeId,
        profileId: null,
        email: null,
        hostSklepu: "sklep-port.example",
        koszyk: {
          token: "TOKENKOSZYKA000000000001",
          etap: "checkout",
          pozycje: [{ product_id: "77", variant_id: null, title: "Kubek", qty: 2, price_minor: "3000", image_url: null, url: null }],
          wartoscMinor: 6000,
          waluta: "PLN",
          linkPowrotu: "https://evil.example/phish",
          zmodyfikowaneAt: new Date("2026-10-01T09:50:00Z"),
        },
      });
      await klient.query("commit");
    } finally {
      klient.release();
    }
    const { rows: przed } = await pool.query("select stage, recovery_url from carts where tenant_id = $1", [tenantId]);
    // link poza domeną sklepu nie trafia do koszyka (phishing w mailu „wróć do koszyka”)
    expect(przed[0]).toMatchObject({ stage: "checkout", recovery_url: null });

    expect((await dostarcz("order.created", zamowienieWoo(1001, { token: "TOKENKOSZYKA000000000001" }))).status).toBe(200);
    expect(await metryki("Placed Order")).toHaveLength(1);
    const produkty = await metryki("Ordered Product");
    expect(produkty).toHaveLength(2);
    expect(produkty.find((p) => p.properties.ProductID === "78").properties.VariantID).toBe("781");
    const { rows: po } = await pool.query("select stage, order_external_id from carts where tenant_id = $1", [tenantId]);
    expect(po[0]).toEqual({ stage: "ordered", order_external_id: "1001" });
  });

  it("koszyk tej osoby w INNYM sklepie tenanta nie zamyka się zakupem; odłączony sklep nie przyjmuje webhooków", async () => {
    const pool = getPool();
    const drugi = (
      await pool.query(
        `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
         values ($1, 'woocommerce', 'https://drugi-port.example', $2, 'connected') returning id`,
        [tenantId, zaszyfruj(JSON.stringify({ ck: "ck_y", cs: "cs_y", webhookSecret: SEKRET }))],
      )
    ).rows[0].id;
    const profil = (await pool.query("select id from profiles where tenant_id = $1 and email = 'port-kupujacy@example.test'", [tenantId])).rows[0].id;
    await pool.query(
      `insert into carts (tenant_id, store_id, platform_token, profile_id, stage, items, source_updated_at)
       values ($1, $2, 'INNYSKLEP0000000000000001', $3, 'cart', '[]', '2026-10-01T09:00:00Z')`,
      [tenantId, drugi, profil],
    );
    await dostarcz("order.created", zamowienieWoo(1002));
    const { rows } = await pool.query("select stage from carts where tenant_id = $1 and store_id = $2", [tenantId, drugi]);
    expect(rows[0].stage).toBe("cart");
    await pool.query("update stores set status = 'disconnected' where id = $1", [drugi]);
    const cialo = JSON.stringify(zamowienieWoo(1003));
    expect((await przyjmijWebhookSklepu("woocommerce", drugi, naglowki("order.created", cialo), cialo)).status).toBe(404);
  });

  it("zmiana statusu: Fulfilled raz (powtórka = duplikat), potem Refunded; starszy payload nic nie emituje", async () => {
    await dostarcz("order.updated", zamowienieWoo(1001, { status: "completed", zmiana: "2026-10-02T08:00:00" }));
    await dostarcz("order.updated", zamowienieWoo(1001, { status: "completed", zmiana: "2026-10-02T09:00:00" }));
    // spóźniona dostawa starszej wersji (processing) nie cofa statusu i nie emituje nic
    await dostarcz("order.updated", zamowienieWoo(1001, { status: "processing", zmiana: "2026-10-01T11:00:00" }));
    const ful = await metryki("Fulfilled Order");
    expect(ful).toHaveLength(1);
    expect(ful[0].source).toBe("webhook");
    await dostarcz("order.updated", zamowienieWoo(1001, { status: "refunded", zmiana: "2026-10-03T08:00:00" }));
    expect(await metryki("Refunded Order")).toHaveLength(1);
    expect((await metryki("Placed Order")).filter((m) => m.properties.OrderId === "1001")).toHaveLength(1);
    const { rows } = await getPool().query("select status from orders where tenant_id = $1 and external_id = '1001'", [tenantId]);
    expect(rows[0].status).toBe("refunded");
  });

  it("zgoda ze sklepu: nowszy wypis u nas wygrywa, nowsza zgoda przechodzi, powtórka = duplikat", async () => {
    const pool = getPool();
    const profil = (await pool.query("select id from profiles where tenant_id = $1 and email = 'port-kupujacy@example.test'", [tenantId])).rows[0].id;
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email', 'withdrawn', 'wypis', '2026-10-02T12:00:00Z')`,
      [tenantId, profil],
    );
    const klient = await pool.connect();
    try {
      await klient.query("begin");
      const starsza = await zapiszZgodeSklepu(klient, tenantId, profil, { email: "port-kupujacy@example.test", stan: "granted", kiedy: new Date("2026-10-02T11:00:00Z"), zrodlo: "checkout_woocommerce" });
      expect(starsza).toBe("pominieta_nowszy_wypis");
      const nowsza = await zapiszZgodeSklepu(klient, tenantId, profil, { email: "port-kupujacy@example.test", stan: "granted", kiedy: new Date("2026-10-02T13:00:00Z"), zrodlo: "checkout_woocommerce", tresc: "Zgoda testowa na newsletter sklepu" });
      expect(nowsza).toBe("zapisana");
      const powtorka = await zapiszZgodeSklepu(klient, tenantId, profil, { email: "port-kupujacy@example.test", stan: "granted", kiedy: new Date("2026-10-02T13:00:00Z"), zrodlo: "checkout_woocommerce" });
      expect(powtorka).toBe("duplikat");
      await klient.query("commit");
    } finally {
      klient.release();
    }
  });

  it("katalog: produkt z wariantami, starsza wersja nie nadpisuje, usunięty wariant = nieaktywny", async () => {
    const pool = getPool();
    const klient = await pool.connect();
    const produkt = (zmiana: string, cena: number, warianty: string[]) => ({
      externalId: "78",
      nazwa: "Koszulka <b>bawełna</b>",
      sku: "KOS",
      cenaMinor: cena,
      waluta: "PLN",
      kategorie: ["Odzież"],
      url: "javascript:alert(1)",
      obrazUrl: "https://sklep-port.example/k.jpg",
      aktywny: true,
      zmodyfikowaneAt: new Date(zmiana),
      warianty: warianty.map((w) => ({ externalId: w, sku: `KOS-${w}`, tytul: w, url: null, obrazUrl: null, cenaMinor: cena, cenaPrzedMinor: null, wMagazynie: true, stan: 3, aktywny: true })),
    });
    try {
      await klient.query("begin");
      await zapiszProduktySklepu(klient, tenantId, storeId, [produkt("2026-10-02T10:00:00Z", 6345, ["781", "782"])], "api");
      await zapiszProduktySklepu(klient, tenantId, storeId, [produkt("2026-10-01T10:00:00Z", 1, ["781"])], "webhook");
      await zapiszProduktySklepu(klient, tenantId, storeId, [produkt("2026-10-03T10:00:00Z", 7000, ["781"])], "webhook");
      await klient.query("commit");
    } finally {
      klient.release();
    }
    const { rows } = await pool.query("select id, price_minor, url, image_url, source from products where tenant_id = $1 and store_id = $2", [tenantId, storeId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ price_minor: "7000", url: null, image_url: "https://sklep-port.example/k.jpg", source: "webhook" });
    // payload bez wersji (review r1) nie cofa produktu z wersją
    const k2 = await pool.connect();
    try {
      await k2.query("begin");
      await zapiszProduktySklepu(k2, tenantId, storeId, [{ ...produkt("2026-10-03T10:00:00Z", 5, ["781"]), zmodyfikowaneAt: null, warianty: undefined }], "webhook");
      await k2.query("commit");
    } finally {
      k2.release();
    }
    const { rows: po } = await pool.query("select price_minor, source_updated_at from products where tenant_id = $1 and store_id = $2", [tenantId, storeId]);
    expect(po[0].price_minor).toBe("7000");
    expect(po[0].source_updated_at).not.toBeNull();
    const { rows: w } = await pool.query("select external_id, active from product_variants where tenant_id = $1 order by external_id", [tenantId]);
    expect(w).toEqual([{ external_id: "781", active: true }, { external_id: "782", active: false }]);
  });
});
