import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { odczytajTokenMx, wystawTokenMx } from "../src/adapters/token-mx";
import { BladPobierania, pobierzBezpiecznie } from "../src/adapters/pobierz-bezpiecznie";
import { middleware } from "../middleware";
import { POST as postEvents, OPTIONS as optEvents } from "../src/app/client/events/route";
import { POST as postProfiles } from "../src/app/client/profiles/route";
import { POST as postSubs } from "../src/app/client/subscriptions/route";
import { GET as getSkrypt } from "../src/app/js/v1/[plik]/route";
import { wyczyscLimity } from "../src/usecases/api/limity";
import { przetworzZadanieKlienta } from "../src/usecases/integracja/klient-api";
import { wyczyscPamiecKluczy, zapewnijKluczStrony, zapiszUstawieniaStrony, wymienKluczStrony, type UstawieniaStrony } from "../src/usecases/integracja/klucz-strony";
import { ostatnieZdarzeniaStrony, sygnalyStrony, wyczyscSygnaly } from "../src/usecases/integracja/podglad";
import { celZIdentyfikacja } from "../src/usecases/integracja/token-linku";
import { ustawRoleMetrykStrony } from "../src/usecases/integracja/role-metryk";
import { importujFeed, zapiszFeed } from "../src/usecases/katalog/katalog";
import { osProfilu } from "../src/usecases/zdarzenia/odczyt";
import { anonimizujProfil } from "../src/usecases/profil-rodo";
import { ponowZalegleZdarzeniaApi } from "../src/jobs/handlery-zdarzenia";

// Integracja „custom” jak Klaviyo (0044): klucz publiczny strony, Client API, token _mx,
// katalog z feedu, stan koszyka, podgląd „Sprawdź połączenie” i oś profilu.

const PREFIKS = "CUSTOM ";
const znak = randomBytes(3).toString("hex");
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const ZGODA = "Zapisuję się na newsletter sklepu testowego i zgadzam się na wiadomości e-mail z ofertami.";

let ip = 1;
function zadanie(sciezka: string, cialo: unknown, o: { origin?: string; typ?: string; ua?: string; ip?: string; metoda?: string } = {}) {
  return new NextRequest(new URL(sciezka, "https://link.midrev.test"), {
    method: o.metoda ?? "POST",
    headers: {
      "content-type": o.typ ?? "text/plain;charset=UTF-8",
      "user-agent": o.ua ?? UA,
      "x-forwarded-for": o.ip ?? `203.0.113.${ip++ % 250}`,
      ...(o.origin ? { origin: o.origin } : {}),
    },
    body: o.metoda === "OPTIONS" ? undefined : typeof cialo === "string" ? cialo : JSON.stringify(cialo),
  });
}

function zdarzenie(nazwa: string, profil: Record<string, unknown>, properties: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    data: {
      type: "event",
      attributes: {
        properties,
        ...extra,
        metric: { data: { type: "metric", attributes: { name: nazwa } } },
        profile: { data: { type: "profile", attributes: profil } },
      },
    },
  };
}

async function przetworzWszystko(tenantId: string) {
  const { rows } = await getPool().query(
    "select id from raw_events where tenant_id = $1 and channel = 'client' and processed_at is null order by received_at",
    [tenantId],
  );
  const w = [];
  for (const r of rows) w.push(await przetworzZadanieKlienta(tenantId, r.id));
  return w;
}

async function zdarzeniaKlienta(tenantId: string) {
  const { rows } = await getPool().query(
    `select m.name, m.integration_key, e.unique_id, e.properties, e.source, e.profile_id, p.email, p.first_name, p.anonymous_id
       from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
       left join profiles p on p.tenant_id = e.tenant_id and p.id = e.profile_id
      where e.tenant_id = $1 and e.source = 'client' order by e.recorded_at`,
    [tenantId],
  );
  return rows;
}

const BAZOWE: UstawieniaStrony = {
  domeny: [],
  ograniczOriginy: false,
  wymagajZgodyCookies: true,
  identyfikacjaZLinkow: true,
  ga4: true,
  zaladujFormularze: false,
  tekstZgody: null,
  politykaUrl: null,
};

describe("Integracja custom jak Klaviyo (0044)", () => {
  let tenantA = "";
  let tenantB = "";
  let kluczA = "";
  let kluczB = "";

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantA = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"])).rows[0].id;
    tenantB = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "B"])).rows[0].id;
    kluczA = (await zapiszUstawieniaStrony(tenantA, { ...BAZOWE, domeny: ["https://www.sklep-a.test/"], tekstZgody: ZGODA })).id;
    kluczB = (await zapiszUstawieniaStrony(tenantB, { ...BAZOWE, domeny: ["sklep-b.test"], ograniczOriginy: true })).id;
  });

  beforeEach(() => {
    wyczyscLimity();
    wyczyscSygnaly();
    wyczyscPamiecKluczy();
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  describe("klucz publiczny strony", () => {
    it("jeden aktywny klucz na tenanta, 6 znaków, idempotentne zapewnienie, domena znormalizowana", async () => {
      expect(kluczA).toMatch(/^[A-Za-z0-9]{6}$/);
      expect((await zapewnijKluczStrony(tenantA)).id).toBe(kluczA);
      const { rows } = await getPool().query("select link_domains, allowed_origins from site_keys where id = $1", [kluczA]);
      expect(rows[0].link_domains).toEqual(["sklep-a.test"]);
    });

    it("role metryk: przeglądarka ustawia viewed_product/added_to_cart/started_checkout, nie nadpisuje istniejących", async () => {
      expect(await ustawRoleMetrykStrony(tenantA)).toBe(4);
      expect(await ustawRoleMetrykStrony(tenantA)).toBe(0);
      const { rows } = await getPool().query(
        "select r.role, m.name, m.integration_key from metric_mappings r join metrics m on m.tenant_id = r.tenant_id and m.id = r.metric_id where r.tenant_id = $1 order by r.role",
        [tenantA],
      );
      expect(rows.map((r) => `${r.role}=${r.integration_key}:${r.name}`)).toEqual([
        "active_on_site=midrev:Active on Site",
        "added_to_cart=midrev:Added to Cart",
        "started_checkout=midrev:Started Checkout",
        "viewed_product=midrev:Viewed Product",
      ]);
    });
  });

  describe("Client API: bramki", () => {
    it("zły albo brakujący company_id = 400 JSON:API; odpowiedzi nie zdradzają, czy klucz istniał", async () => {
      for (const q of ["", "?company_id=nieMa99", "?company_id=<script>"]) {
        const o = await postEvents(zadanie(`/client/events${q}`, zdarzenie("X", { email: "a@b.pl" })));
        expect(o.status).toBe(400);
        expect((await o.json()).errors[0].detail).toBe("Invalid or missing company_id.");
      }
    });

    it("preflight CORS: * dla klucza bez ograniczeń, echo originu z listy domen, nic dla obcego", async () => {
      const a = await optEvents(zadanie(`/client/events?company_id=${kluczA}`, null, { metoda: "OPTIONS", origin: "https://obcy.test" }));
      expect(a.status).toBe(204);
      expect(a.headers.get("access-control-allow-origin")).toBe("*");
      expect(a.headers.get("access-control-allow-credentials")).toBeNull();
      const b = await optEvents(zadanie(`/client/events?company_id=${kluczB}`, null, { metoda: "OPTIONS", origin: "https://www.sklep-b.test" }));
      expect(b.headers.get("access-control-allow-origin")).toBe("https://www.sklep-b.test");
      const c = await optEvents(zadanie(`/client/events?company_id=${kluczB}`, null, { metoda: "OPTIONS", origin: "https://zlysklep-b.test" }));
      expect(c.headers.get("access-control-allow-origin")).toBeNull();
      const d = await postEvents(zadanie(`/client/events?company_id=${kluczB}`, zdarzenie("Viewed Product", { email: `b-${znak}@ex.test` }), { origin: "https://zlysklep-b.test" }));
      expect(d.status).toBe(403);
    });

    it("text/plain i application/json przyjęte, formularz = 415, za duże ciało = 413, zły JSON = 400", async () => {
      const ok = await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Ping", { anonymous_id: "anon-nic" }), { typ: "application/json" }));
      expect(ok.status).toBe(202);
      const f = await postEvents(zadanie(`/client/events?company_id=${kluczA}`, "a=b", { typ: "application/x-www-form-urlencoded" }));
      expect(f.status).toBe(415);
      const duze = await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("X", { email: "a@b.pl" }, { x: "y".repeat(70_000) })));
      expect(duze.status).toBe(413);
      const zly = await postEvents(zadanie(`/client/events?company_id=${kluczA}`, "{nie json"));
      expect(zly.status).toBe(400);
    });

    it("limit per IP: seria z jednego adresu dostaje 429 z Retry-After, inny adres przechodzi", async () => {
      const statusy: number[] = [];
      for (let i = 0; i < 12; i++) {
        const o = await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Ping", { anonymous_id: "anon-limit" }), { ip: "198.51.100.7" }));
        statusy.push(o.status);
        if (o.status === 429) expect(Number(o.headers.get("retry-after"))).toBeGreaterThan(0);
      }
      expect(statusy).toContain(429);
      const inny = await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Ping", { anonymous_id: "anon-limit" }), { ip: "198.51.100.8" }));
      expect(inny.status).toBe(202);
    });

    it("bot (User-Agent) dostaje 202 i NIC nie trafia do bazy", async () => {
      const email = `bot-${znak}@ex.test`;
      const o = await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Viewed Product", { email }), { ua: "Mozilla/5.0 (compatible; Googlebot/2.1)" }));
      expect(o.status).toBe(202);
      const { rows } = await getPool().query("select 1 from profiles where tenant_id = $1 and email = $2", [tenantA, email]);
      expect(rows).toHaveLength(0);
    });

    it("metryki zastrzeżone (Submitted Form, Received Email, Placed Order, rodo.*) = 400", async () => {
      for (const n of ["Submitted Form", "received email", "Placed Order", "rodo.anonimizacja", "customer.created"]) {
        const o = await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie(n, { email: `z-${znak}@ex.test` })));
        expect(o.status, n).toBe(400);
      }
    });

    it("/client/events/ z ukośnikiem: middleware przepisuje bez 308; /client i /js same nie są publiczne", () => {
      const mw = middleware(new NextRequest(new URL(`/client/events/?company_id=${kluczA}`, "https://link.midrev.test"), { method: "POST", body: "{}" }));
      expect(mw.headers.get("location")).toBeNull();
      expect(new URL(mw.headers.get("x-middleware-rewrite")!).pathname).toBe("/client/events");
      const panel = middleware(new NextRequest(new URL("/client", "https://link.midrev.test")));
      expect(panel.headers.get("location")).toContain("/logowanie");
    });
  });

  describe("Client API: zapis i odczyt", () => {
    it("Viewed Product z e-mailem: 202 bez treści, raw_events client, po workerze metric_events (midrev) + profil + katalog + oś profilu + podgląd", async () => {
      const email = `vp-${znak}@ex.test`;
      const o = await postEvents(
        zadanie(
          `/client/events/?company_id=${kluczA}`.replace("/?", "?"),
          zdarzenie(
            "Viewed Product",
            { email, anonymous_id: "anon-vp", first_name: "Ola" },
            { ProductID: "KREM-50", ProductName: "Krem <b>nawilżający</b>", Price: 89.9, URL: "https://sklep-a.test/krem?utm=x&email=a@b.pl", ImageURL: "javascript:alert(1)", Categories: ["Pielęgnacja"] },
            { unique_id: "vp:anon-vp:krem:1", value: 89.9, time: "2001-01-01T00:00:00Z" },
          ),
          { origin: "https://sklep-a.test" },
        ),
      );
      expect(o.status).toBe(202);
      expect(await o.text()).toBe("");
      const { rows: surowe } = await getPool().query("select payload from raw_events where tenant_id = $1 and channel = 'client'", [tenantA]);
      expect(surowe.length).toBeGreaterThan(0);
      const wyniki = await przetworzWszystko(tenantA);
      expect(wyniki.some((w) => w.status === "zapisane")).toBe(true);
      const z = (await zdarzeniaKlienta(tenantA)).find((r) => r.email === email)!;
      expect(z).toMatchObject({ name: "Viewed Product", integration_key: "midrev", source: "client", first_name: "Ola", anonymous_id: "anon-vp" });
      // czas przeglądarki nie jest czasem zdarzenia (AD-39)
      const { rows: czas } = await getPool().query("select occurred_at from metric_events where tenant_id = $1 and unique_id = 'vp:anon-vp:krem:1'", [tenantA]);
      expect(Date.now() - czas[0].occurred_at.getTime()).toBeLessThan(60_000);
      // katalog: produkt z przeglądarki, bez złego adresu obrazka
      const { rows: prod } = await getPool().query("select source, title, url, image_url, price_minor::text, currency from products where tenant_id = $1 and external_id = 'KREM-50'", [tenantA]);
      expect(prod[0]).toMatchObject({ source: "viewed", image_url: null, price_minor: "8990", currency: "PLN" });
      // oś profilu (strumień) pokazuje zdarzenie
      const os = await osProfilu(tenantA, z.profile_id);
      expect(os.wpisy.map((w) => w.nazwa)).toContain("Viewed Product");
      // „Sprawdź połączenie”: zdarzenie z bazy + sygnał bez query (e-mail z adresu nie trafia do podglądu)
      const ostatnie = await ostatnieZdarzeniaStrony(tenantA);
      expect(ostatnie[0]).toMatchObject({ metryka: "Viewed Product", sciezka: "/krem", profileId: z.profile_id });
      expect(ostatnie[0].osoba).toMatch(/^v\*\*\*@ex\.test$/);
      expect(JSON.stringify(sygnalyStrony(kluczA))).not.toContain("a@b.pl");
    });

    it("deduplikacja unique_id: to samo zdarzenie dwa razy = jeden wiersz strumienia", async () => {
      const email = `dup-${znak}@ex.test`;
      const cialo = zdarzenie("Added to Cart", { email }, { AddedItemProductID: "X1", AddedItemProductName: "Iks", AddedItemQuantity: 1, AddedItemPrice: 10, $value: 10 }, { unique_id: "atc:dup:1" });
      expect((await postEvents(zadanie(`/client/events?company_id=${kluczA}`, cialo))).status).toBe(202);
      expect((await postEvents(zadanie(`/client/events?company_id=${kluczA}`, cialo))).status).toBe(202);
      await przetworzWszystko(tenantA);
      const ile = (await zdarzeniaKlienta(tenantA)).filter((r) => r.email === email).length;
      expect(ile).toBe(1);
    });

    it("anonimowy gość (sam anonymous_id, bez profilu) = 202 i zero śladu w bazie; sygnał w podglądzie", async () => {
      const przed = (await getPool().query("select count(*)::int as n from raw_events where tenant_id = $1", [tenantA])).rows[0].n;
      const o = await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Viewed Product", { anonymous_id: `anon-${znak}-nowy` }, { URL: "https://sklep-a.test/p/1" })));
      expect(o.status).toBe(202);
      const po = (await getPool().query("select count(*)::int as n from raw_events where tenant_id = $1", [tenantA])).rows[0].n;
      expect(po).toBe(przed);
      expect(sygnalyStrony(kluczA)[0]).toMatchObject({ rodzaj: "anonimowe", metryka: "Viewed Product", sciezka: "/p/1" });
    });

    it("przeglądarka nie nadpisuje danych istniejącego profilu ani identyfikatorów; anonymous_id wiąże przeglądarkę", async () => {
      const email = `ist-${znak}@ex.test`;
      const { rows } = await getPool().query(
        "insert into profiles (tenant_id, email, first_name, external_id, properties) values ($1, $2, 'Anna', $3, '{\"plan\":\"vip\"}') returning id",
        [tenantA, email, `ext-${znak}`],
      );
      const id = rows[0].id;
      await postProfiles(zadanie(`/client/profiles?company_id=${kluczA}`, { data: { type: "profile", attributes: { email, first_name: "Haker", anonymous_id: `anon-ist-${znak}`, properties: { ulubione: "kremy", plan: "darmowy" } } } }));
      await postProfiles(zadanie(`/client/profiles?company_id=${kluczA}`, { data: { type: "profile", attributes: { external_id: `ext-${znak}`, email: `inny-${znak}@ex.test` } } }));
      await przetworzWszystko(tenantA);
      const { rows: p } = await getPool().query("select email, first_name, anonymous_id, properties from profiles where id = $1", [id]);
      expect(p[0]).toMatchObject({ email, first_name: "Anna", anonymous_id: `anon-ist-${znak}` });
      expect(p[0].properties.ulubione).toBe("kremy");
      // istniejąca właściwość nie jest nadpisywana przez przeglądarkę
      expect(p[0].properties.plan).toBe("vip");
      // teraz sam anonymous_id (przeglądarka po identify) trafia do tego profilu
      await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Active on Site", { anonymous_id: `anon-ist-${znak}` }, { page: "https://sklep-a.test/" })));
      await przetworzWszystko(tenantA);
      expect((await zdarzeniaKlienta(tenantA)).filter((r) => r.profile_id === id).map((r) => r.name)).toContain("Active on Site");
    });

    it("token _mx z linku: identyfikuje profil, jawny token nie leży w bazie; token innego konta = ignorowany", async () => {
      const { rows } = await getPool().query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantA, `tok-${znak}@ex.test`]);
      const id = rows[0].id;
      const token = wystawTokenMx({ tenantId: tenantA, profileId: id });
      const o = await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Viewed Product", { _kx: token, anonymous_id: `anon-tok-${znak}` }, { ProductID: "T1", ProductName: "T" })));
      expect(o.status).toBe(202);
      const { rows: surowe } = await getPool().query("select payload::text as p from raw_events where tenant_id = $1 and channel = 'client'", [tenantA]);
      expect(surowe.some((r) => r.p.includes(token))).toBe(false);
      await przetworzWszystko(tenantA);
      expect((await zdarzeniaKlienta(tenantA)).filter((r) => r.profile_id === id).map((r) => r.name)).toContain("Viewed Product");
      // token wystawiony dla profilu konta A wysłany kluczem konta B: brak identyfikacji
      const przed = (await getPool().query("select count(*)::int as n from raw_events where tenant_id = $1", [tenantB])).rows[0].n;
      const b = await postEvents(zadanie(`/client/events?company_id=${kluczB}`, zdarzenie("Viewed Product", { _kx: token }), { origin: "https://sklep-b.test" }));
      expect(b.status).toBe(202);
      expect((await getPool().query("select count(*)::int as n from raw_events where tenant_id = $1", [tenantB])).rows[0].n).toBe(przed);
    });

    it("izolacja tenantów: zdarzenie kluczem B z e-mailem osoby z A tworzy profil w B, A bez zmian", async () => {
      const email = `vp-${znak}@ex.test`;
      const przedA = (await zdarzeniaKlienta(tenantA)).length;
      await postEvents(zadanie(`/client/events?company_id=${kluczB}`, zdarzenie("Viewed Product", { email }, { ProductID: "B1", ProductName: "B" }), { origin: "https://sklep-b.test" }));
      await przetworzWszystko(tenantB);
      expect((await zdarzeniaKlienta(tenantA)).length).toBe(przedA);
      expect((await zdarzeniaKlienta(tenantB)).map((r) => r.email)).toContain(email);
    });

    it("Started Checkout zapisuje koszyk; CheckoutURL spoza domen strony NIE trafia do linku powrotu", async () => {
      const email = `kosz-${znak}@ex.test`;
      const items = [{ ProductID: "K1", ProductName: "Krem", Quantity: 2, ItemPrice: 10, ProductURL: "https://sklep-a.test/k1" }];
      await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Started Checkout", { email, anonymous_id: `anon-k-${znak}` }, { $value: 20, ItemNames: ["Krem"], CheckoutURL: "https://phishing.test/cart", Items: items }, { unique_id: "sc:1" })));
      await przetworzWszystko(tenantA);
      const { rows } = await getPool().query("select stage, items, value_minor::text, recovery_url, profile_id from carts where tenant_id = $1 and anonymous_id = $2", [tenantA, `anon-k-${znak}`]);
      expect(rows[0]).toMatchObject({ stage: "checkout", value_minor: "2000", recovery_url: null });
      expect(rows[0].items[0]).toMatchObject({ product_id: "K1", qty: 2 });
      await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Started Checkout", { email, anonymous_id: `anon-k-${znak}` }, { $value: 20, ItemNames: ["Krem", "x"], CheckoutURL: "https://www.sklep-a.test/koszyk?t=1", Items: items }, { unique_id: "sc:2" })));
      await przetworzWszystko(tenantA);
      const { rows: r2 } = await getPool().query("select recovery_url from carts where tenant_id = $1 and anonymous_id = $2", [tenantA, `anon-k-${znak}`]);
      expect(r2[0].recovery_url).toBe("https://www.sklep-a.test/koszyk?t=1");
    });

    it("zaległe żądanie klienta bez joba dostaje nowy job (ponawianie obejmuje kanał client)", async () => {
      await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Własne", { email: `zal-${znak}@ex.test` }, {}, { unique_id: "zal-1" })));
      await getPool().query(
        "update raw_events set received_at = now() - interval '20 minutes' where tenant_id = $1 and channel = 'client' and processed_at is null",
        [tenantA],
      );
      await getPool().query("delete from jobs where tenant_id = $1 and kind = 'przetworz_zdarzenie_klienta'", [tenantA]);
      const w = await ponowZalegleZdarzeniaApi();
      expect(w.ponowione).toBeGreaterThanOrEqual(1);
      await przetworzWszystko(tenantA);
    });
  });

  describe("Client API: subskrypcje (dowód zgody)", () => {
    function sub(email: string, tekst: string | null, listId?: string) {
      return {
        data: {
          type: "subscription",
          attributes: { custom_source: "Stopka", ...(tekst !== null ? { consent_text: tekst } : {}), profile: { data: { type: "profile", attributes: { email } } } },
          ...(listId ? { relationships: { list: { data: { type: "list", id: listId } } } } : {}),
        },
      };
    }

    it("bez treści zgody = 400 consent_required; inna treść = 400 consent_mismatch; klucz bez klauzuli = consent_not_configured", async () => {
      const a = await postSubs(zadanie(`/client/subscriptions?company_id=${kluczA}`, sub(`s1-${znak}@ex.test`, null)));
      expect(a.status).toBe(400);
      expect((await a.json()).errors[0].code).toBe("consent_required");
      const b = await postSubs(zadanie(`/client/subscriptions?company_id=${kluczA}`, sub(`s1-${znak}@ex.test`, "Zgadzam się na wszystko, także na spam.")));
      expect((await b.json()).errors[0].code).toBe("consent_mismatch");
      const c = await postSubs(zadanie(`/client/subscriptions?company_id=${kluczB}`, sub(`s1-${znak}@ex.test`, ZGODA), { origin: "https://sklep-b.test" }));
      expect((await c.json()).errors[0].code).toBe("consent_not_configured");
      const { rows } = await getPool().query("select 1 from consents c join profiles p on p.id = c.profile_id where p.email = $1", [`s1-${znak}@ex.test`]);
      expect(rows).toHaveLength(0);
    });

    it("poprawna zgoda (inne białe znaki i cudzysłowy) = 202, w rejestrze tekst Z BAZY, lista z wyzwalaczem formularza; lista innego konta = 400", async () => {
      const email = `s2-${znak}@ex.test`;
      const lista = (await getPool().query("insert into lists (tenant_id, name) values ($1, 'Newsletter') returning id", [tenantA])).rows[0].id;
      const listaB = (await getPool().query("insert into lists (tenant_id, name) values ($1, 'B') returning id", [tenantB])).rows[0].id;
      const zla = await postSubs(zadanie(`/client/subscriptions?company_id=${kluczA}`, sub(email, ZGODA, listaB)));
      expect(zla.status).toBe(400);
      const o = await postSubs(zadanie(`/client/subscriptions?company_id=${kluczA}`, sub(email, `  ${ZGODA.replace(/ /g, "\n ")} `, lista)));
      expect(o.status).toBe(202);
      const { rows } = await getPool().query(
        `select c.wording, c.source, c.method_detail, c.state from consents c join profiles p on p.tenant_id = c.tenant_id and p.id = c.profile_id
          where c.tenant_id = $1 and p.email = $2`,
        [tenantA, email],
      );
      expect(rows[0]).toMatchObject({ wording: ZGODA, state: "granted", source: "strona:Stopka" });
      expect(rows[0].method_detail).toContain(kluczA);
      const { rows: czl } = await getPool().query("select source from list_members where tenant_id = $1 and list_id = $2", [tenantA, lista]);
      expect(czl[0].source).toBe(`formularz:strona-${kluczA}`);
    });

    it("adres wykluczony: 202 (bez zdradzania), ale bez nowej zgody", async () => {
      const email = `s3-${znak}@ex.test`;
      await getPool().query("insert into tenant_suppressions (tenant_id, email, action, reason) values ($1, $2, 'suppressed', 'unsubscribe')", [tenantA, email]);
      const o = await postSubs(zadanie(`/client/subscriptions?company_id=${kluczA}`, sub(email, ZGODA)));
      expect(o.status).toBe(202);
      const { rows } = await getPool().query("select 1 from consents c join profiles p on p.tenant_id = c.tenant_id and p.id = c.profile_id where c.tenant_id = $1 and p.email = $2", [tenantA, email]);
      expect(rows).toHaveLength(0);
    });
  });

  describe("token _mx w przekierowaniu /r (D5)", () => {
    it("podpis, wygaśnięcie po 90 dniach, zmiana jednego znaku = odrzucenie, w tokenie nie ma e-maila ani id jawnie", () => {
      const t = wystawTokenMx({ tenantId: tenantA, profileId: tenantB }, Date.UTC(2026, 0, 1));
      expect(t).toMatch(/^[A-Za-z0-9_-]{87}$/);
      expect(t).not.toContain(tenantB.replace(/-/g, ""));
      expect(odczytajTokenMx(t, Date.UTC(2026, 2, 1))).toMatchObject({ tenantId: tenantA, profileId: tenantB });
      expect(odczytajTokenMx(t, Date.UTC(2026, 3, 2))).toBeNull();
      expect(odczytajTokenMx(t, Date.UTC(2025, 11, 31))).toBeNull();
      const zmieniony = t.slice(0, 40) + (t[40] === "A" ? "B" : "A") + t.slice(41);
      expect(odczytajTokenMx(zmieniony, Date.UTC(2026, 0, 2))).toBeNull();
      expect(odczytajTokenMx(t, Date.UTC(2026, 0, 2), Buffer.alloc(32, 7))).toBeNull();
    });

    it("tylko domeny tenanta, tylko przy zgodzie na śledzenie kliknięć, nie przy wyłączonym rozpoznawaniu", async () => {
      const { rows } = await getPool().query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantA, `r-${znak}@ex.test`]);
      const id = rows[0].id;
      const zTokenem = await celZIdentyfikacja(tenantA, id, "https://www.sklep-a.test/produkt?x=1#opis");
      const u = new URL(zTokenem);
      expect(u.searchParams.get("x")).toBe("1");
      expect(u.hash).toBe("#opis");
      expect(odczytajTokenMx(u.searchParams.get("_mx"))).toMatchObject({ tenantId: tenantA, profileId: id });
      expect(zTokenem).not.toContain("r-" + znak);
      expect(await celZIdentyfikacja(tenantA, id, "https://zlysklep-a.test/")).toBe("https://zlysklep-a.test/");
      // http: bez tokenu (poświadczenie nie leci otwartym tekstem)
      expect(await celZIdentyfikacja(tenantA, id, "http://sklep-a.test/")).toBe("http://sklep-a.test/");
      expect(await celZIdentyfikacja(tenantA, id, "https://sklep-a.test.evil.test/")).toBe("https://sklep-a.test.evil.test/");
      expect(await celZIdentyfikacja(tenantA, null, "https://sklep-a.test/")).toBe("https://sklep-a.test/");
      // profil cofnął zgodę na śledzenie kliknięć
      await getPool().query(
        "insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email_click_tracking', 'withdrawn', 'test', now())",
        [tenantA, id],
      );
      expect(await celZIdentyfikacja(tenantA, id, "https://sklep-a.test/")).toBe("https://sklep-a.test/");
      // profil konta A w konfiguracji konta B: domena B, ale profil nie z B → token i tak tylko z tenantem B (brak profilu = bez tokenu)
      expect(await celZIdentyfikacja(tenantB, id, "https://sklep-b.test/")).toBe("https://sklep-b.test/");
    });
  });

  describe("skrypt /js/v1/{klucz}.js", () => {
    it("zwraca midrev.js z kluczem i ustawieniami; nieznany klucz = pusty skrypt 200; pobranie widać w podglądzie", async () => {
      const o = await getSkrypt(
        new NextRequest(new URL(`/js/v1/${kluczA}.js`, "https://link.midrev.test"), { headers: { referer: "https://sklep-a.test/produkt?email=a@b.pl" } }),
        { params: Promise.resolve({ plik: `${kluczA}.js` }) },
      );
      expect(o.status).toBe(200);
      expect(o.headers.get("content-type")).toContain("javascript");
      const js = await o.text();
      expect(js).toContain(`"id":"${kluczA}"`);
      expect(js).toContain('"ga4":true');
      expect(js).not.toContain(tenantA);
      expect(gzipSync(js).length).toBeLessThan(15_000);
      expect(sygnalyStrony(kluczA)[0]).toMatchObject({ rodzaj: "skrypt", origin: "https://sklep-a.test" });
      const zly = await getSkrypt(new NextRequest(new URL("/js/v1/nieMa00.js", "https://link.midrev.test")), { params: Promise.resolve({ plik: "nieMa00.js" }) });
      expect(zly.status).toBe(200);
      expect(await zly.text()).toMatch(/^\/\* midrev\.js/);
    });

    it("wymiana klucza: stary przestaje działać, nowy dostaje te same ustawienia", async () => {
      const nowy = await wymienKluczStrony(tenantB);
      expect(nowy.id).not.toBe(kluczB);
      expect(nowy.domeny).toEqual(["sklep-b.test"]);
      const stary = await postEvents(zadanie(`/client/events?company_id=${kluczB}`, zdarzenie("X", { email: "a@b.pl" }), { origin: "https://sklep-b.test" }));
      expect(stary.status).toBe(400);
      kluczB = nowy.id;
    });
  });

  describe("katalog: feed Google Merchant", () => {
    let serwer: Server;
    let adres = "";
    let tresc = "";
    beforeAll(async () => {
      serwer = createServer((req, res) => {
        if (req.url === "/gz") {
          res.writeHead(200, { "Content-Type": "application/xml", "Content-Encoding": "gzip" }).end(gzipSync(tresc));
          return;
        }
        if (req.url === "/duzy") {
          res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" }).end(gzipSync("x".repeat(3_000_000)));
          return;
        }
        if (req.url === "/przekierowanie") {
          res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" }).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/xml" }).end(tresc);
      });
      await new Promise<void>((ok) => serwer.listen(0, "127.0.0.1", () => ok()));
      adres = `http://127.0.0.1:${(serwer.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((ok) => serwer.close(() => ok())));

    const dopusc = (a: string) => a === "127.0.0.1";

    it("SSRF: localhost, adres prywatny z DNS, metadane chmury przez przekierowanie i niestandardowy port = odmowa", async () => {
      await expect(pobierzBezpiecznie(adres + "/feed", { maksBajtow: 1e6 })).rejects.toThrow(BladPobierania);
      await expect(pobierzBezpiecznie("https://wewn.test/feed.xml", { maksBajtow: 1e6, lookup: async () => [{ address: "10.0.0.5", family: 4 }] })).rejects.toMatchObject({ kod: "adres_prywatny" });
      await expect(pobierzBezpiecznie("https://mieszany.test/", { maksBajtow: 1e6, lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }] })).rejects.toMatchObject({ kod: "adres_prywatny" });
      await expect(pobierzBezpiecznie("http://feed.test:8080/x", { maksBajtow: 1e6, lookup: async () => [{ address: "93.184.216.34", family: 4 }] })).rejects.toMatchObject({ kod: "port" });
      await expect(pobierzBezpiecznie("file:///etc/passwd", { maksBajtow: 1e6 })).rejects.toMatchObject({ kod: "adres" });
      await expect(pobierzBezpiecznie(adres + "/przekierowanie", { maksBajtow: 1e6, dopuscAdres: dopusc })).rejects.toMatchObject({ kod: "adres_prywatny" });
      await expect(pobierzBezpiecznie(adres + "/duzy", { maksBajtow: 1_000_000, dopuscAdres: dopusc })).rejects.toMatchObject({ kod: "rozmiar" });
    });

    it("import feedu RSS (gzip): produkty z wariantami, ponowny import bez pozycji = active=false, Viewed Product nie nadpisuje feedu", async () => {
      tresc = `<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel>
        <item><g:id>K-50</g:id><g:item_group_id>KREM</g:item_group_id><g:title><![CDATA[Krem <script>alert(1)</script> 50 ml]]></g:title>
          <g:link>https://sklep-a.test/krem</g:link><g:image_link>https://sklep-a.test/krem.jpg</g:image_link>
          <g:price>89.90 PLN</g:price><g:sale_price>79.90 PLN</g:sale_price><g:availability>in stock</g:availability>
          <g:product_type>Pielęgnacja &gt; Kremy</g:product_type></item>
        <item><g:id>K-100</g:id><g:item_group_id>KREM</g:item_group_id><g:title>Krem 100 ml</g:title><g:price>129,00 PLN</g:price><g:availability>out_of_stock</g:availability></item>
        <item><g:id>SER</g:id><g:title>Serum</g:title><g:link>javascript:alert(1)</g:link><g:price>59 PLN</g:price></item>
      </channel></rss>`;
      await zapiszFeed(tenantA, adres + "/gz");
      const w = await importujFeed(tenantA, { dopuscAdres: dopusc });
      expect(w).toMatchObject({ status: "ok", produkty: 2, warianty: 3 });
      const { rows } = await getPool().query(
        "select external_id, title, url, price_minor::text, compare_at_minor::text, in_stock, categories, active from products where tenant_id = $1 and source = 'feed' order by external_id",
        [tenantA],
      );
      expect(rows[0]).toMatchObject({ external_id: "KREM", price_minor: "7990", compare_at_minor: "8990", in_stock: true, categories: ["Pielęgnacja", "Kremy"] });
      expect(rows[0].title).not.toContain("<script>");
      expect(rows[1]).toMatchObject({ external_id: "SER", url: null });
      const { rows: st } = await getPool().query("select last_status, last_products from product_feeds where tenant_id = $1", [tenantA]);
      expect(st[0]).toMatchObject({ last_status: "ok", last_products: 2 });

      // Viewed Product dla produktu z feedu nie zmienia go
      await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Viewed Product", { email: `vp-${znak}@ex.test` }, { ProductID: "KREM", ProductName: "PODMIANA", Price: 1 }, { unique_id: "vp-feed" })));
      await przetworzWszystko(tenantA);
      expect((await getPool().query("select title from products where tenant_id = $1 and external_id = 'KREM' and store_id is null", [tenantA])).rows[0].title).not.toBe("PODMIANA");

      tresc = tresc.replace(/<item><g:id>SER[\s\S]*?<\/item>/, "");
      await getPool().query("update product_feeds set etag = null, last_modified = null where tenant_id = $1", [tenantA]);
      const w2 = await importujFeed(tenantA, { dopuscAdres: dopusc });
      expect(w2).toMatchObject({ status: "ok", produkty: 1, wylaczone: 1 });
      expect((await getPool().query("select active from products where tenant_id = $1 and external_id = 'SER'", [tenantA])).rows[0].active).toBe(false);
    });

    it("feed z DOCTYPE/ENTITY = błąd zapisany w product_feeds, katalog bez zmian", async () => {
      tresc = `<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY a "aaaa">]><rss><channel><item><g:id>Z</g:id><g:title>&a;</g:title></item></channel></rss>`;
      await getPool().query("update product_feeds set url = $2 where tenant_id = $1", [tenantA, adres + "/feed"]);
      const w = await importujFeed(tenantA, { dopuscAdres: dopusc });
      expect(w?.status).toBe("blad");
      expect(w?.blad).toContain("DOCTYPE");
      expect((await getPool().query("select 1 from products where tenant_id = $1 and external_id = 'Z'", [tenantA])).rows).toHaveLength(0);
    });
  });

  describe("RODO", () => {
    it("anonimizacja zaślepia surowe żądania z przeglądarki i usuwa koszyk osoby", async () => {
      const email = `kosz-${znak}@ex.test`;
      const { rows } = await getPool().query("select id from profiles where tenant_id = $1 and email = $2", [tenantA, email]);
      await postEvents(zadanie(`/client/events?company_id=${kluczA}`, zdarzenie("Viewed Product", { email }, {}, { unique_id: "przed-rodo" })));
      await anonimizujProfil(tenantA, rows[0].id, { aktor: "test", powod: "żądanie osoby (art. 17)" });
      const { rows: surowe } = await getPool().query("select payload::text as p from raw_events where tenant_id = $1 and channel = 'client'", [tenantA]);
      expect(surowe.some((r) => r.p.includes(email))).toBe(false);
      expect((await getPool().query("select 1 from carts where tenant_id = $1 and profile_id = $2", [tenantA, rows[0].id])).rows).toHaveLength(0);
    });
  });
});
