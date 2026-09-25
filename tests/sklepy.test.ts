// Adres, pod ktory sandboxowy WooCommerce ma dosylac webhooki. Ustawiany PRZED
// pierwszym uzyciem config(): kontener Woo nie widzi "localhost" aplikacji, tylko
// bramke dockera. Port 3005 jest dopuszczony filtrem w mu-pluginie sandboxa
// (WordPress przepuszcza "safe" zadania tylko na 80/443/8080).
process.env.APP_URL = process.env.APP_URL ?? "http://172.22.0.1:3005";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { odszyfruj, zaszyfruj } from "../src/adapters/crypto";
import { odczytajStanWebhookow } from "../src/adapters/store/stan-webhookow";
import { adresDostawy, TEMATY_WEBHOOKOW, wszystkieAktywne } from "../src/adapters/store/webhooki";
import { odswiezWebhokiSklepu, podlaczSklepWoo } from "../src/usecases/podlacz-sklep";
import { ocenSklepy, sprawdzCiszeSklepow } from "../src/usecases/cisza-sklepow";

// Test integracyjny na ZYWYM sandboxie WooCommerce (sandbox/woo, port 8091), nie na
// atrapie. Atrapa Woo potwierdzalaby wylacznie to, ze umiem napisac atrape: caly sens
// B3 tkwi w zachowaniu prawdziwego sklepu (ignorowany `status` przy POST, webhook
// wstrzymany mimo 201, dostawa z wp-crona).

const PLIK_KLUCZY = join(import.meta.dirname, "..", "sandbox", "woo", ".woo-credentials");
const klucze = wczytajKlucze();
const APP_URL = process.env.APP_URL!;

function wczytajKlucze(): { url: string; ck: string; cs: string } | null {
  if (!existsSync(PLIK_KLUCZY)) return null;
  const pary = new Map<string, string>();
  for (const linia of readFileSync(PLIK_KLUCZY, "utf-8").split("\n")) {
    const i = linia.indexOf("=");
    if (i > 0) pary.set(linia.slice(0, i).trim(), linia.slice(i + 1).trim());
  }
  const url = pary.get("WOO_URL");
  const ck = pary.get("WOO_CONSUMER_KEY");
  const cs = pary.get("WOO_CONSUMER_SECRET");
  return url && ck && cs ? { url, ck, cs } : null;
}

async function woo(sciezka: string, init: RequestInit = {}): Promise<any> {
  const auth = Buffer.from(`${klucze!.ck}:${klucze!.cs}`).toString("base64");
  const odpowiedz = await fetch(new URL(`/wp-json/wc/v3/${sciezka}`, klucze!.url), {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!odpowiedz.ok) throw new Error(`Woo ${sciezka}: HTTP ${odpowiedz.status} ${await odpowiedz.text()}`);
  return odpowiedz.json();
}

/** Webhooki WIDZIANE PRZEZ SKLEP pod naszym adresem - jedyne wiarygodne zrodlo prawdy. */
async function webhookiSklepu(adres: string): Promise<any[]> {
  const wszystkie = (await woo("webhooks?per_page=100&status=all")) as any[];
  return wszystkie.filter((w) => w.delivery_url === adres);
}

async function utworzTenanta(nazwa: string): Promise<string> {
  const { rows } = await getPool().query("insert into tenants (name) values ($1) returning id", [nazwa]);
  return rows[0].id as string;
}

async function sekretWebhooka(tenantId: string, storeId: string): Promise<string> {
  const { rows } = await getPool().query(
    "select credentials_encrypted from stores where tenant_id = $1 and id = $2",
    [tenantId, storeId],
  );
  return JSON.parse(odszyfruj(rows[0].credentials_encrypted)).webhookSecret;
}

const PREFIKS = "SKLEPY ";
const sprzatanie: string[] = [];

describe.skipIf(!klucze)("Sklepy: webhooki po stronie Woo (B3)", () => {
  let tenantId = "";
  let storeId = "";
  let adres = "";

  beforeAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = await utworzTenanta(PREFIKS + "Woo");
  });

  afterAll(async () => {
    // webhooki w sandboxowym sklepie przezylyby usuniecie tenanta i zostalyby martwymi
    // wpisami celujacymi w nieistniejacy sklep - Woo wylaczyloby je po serii bledow
    for (const id of sprzatanie) {
      for (const w of await webhookiSklepu(adresDostawy(APP_URL, id)).catch(() => [])) {
        await woo(`webhooks/${w.id}?force=true`, { method: "DELETE" }).catch(() => {});
      }
    }
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  it("podlaczenie sklepu zaklada webhooki w Woo i potwierdza je odczytem zwrotnym", async () => {
    const wynik = await podlaczSklepWoo(tenantId, {
      baseUrl: klucze!.url,
      consumerKey: klucze!.ck,
      consumerSecret: klucze!.cs,
    });
    expect(wynik.ok).toBe(true);
    if (!wynik.ok) return;
    storeId = wynik.storeId;
    sprzatanie.push(storeId);
    adres = adresDostawy(APP_URL, storeId);

    expect(wynik.webhooki.blad).toBeNull();
    expect(wynik.ostrzezenie).toBeUndefined();
    expect(wynik.webhooki.wpisy.map((w) => w.temat).sort()).toEqual([...TEMATY_WEBHOOKOW].sort());
    for (const wpis of wynik.webhooki.wpisy) {
      expect(wpis.stan).toBe("aktywny");
      // potwierdzenie pochodzi z GET-a po utworzeniu, nie z kodu odpowiedzi POST-a
      expect(wpis.potwierdzonyAt).not.toBeNull();
      expect(wpis.webhookId).toBeGreaterThan(0);
    }

    // ODCZYT ZE SKLEPU, nie z naszego wyniku
    const wSklepie = await webhookiSklepu(adres);
    expect(wSklepie).toHaveLength(TEMATY_WEBHOOKOW.length);
    expect(wSklepie.map((w) => w.topic).sort()).toEqual([...TEMATY_WEBHOOKOW].sort());
    expect(wSklepie.every((w) => w.status === "active")).toBe(true);

    // stan trafil do bazy, wiec ekran ma co pokazac po odswiezeniu strony
    const stan = await odczytajStanWebhookow(tenantId, storeId);
    expect(wszystkieAktywne(stan)).toBe(true);
    expect(stan!.adresDostawy).toBe(adres);
  });

  it("ponowne podlaczenie tego samego sklepu nie tworzy duplikatow i zachowuje sekret", async () => {
    const sekretPrzed = await sekretWebhooka(tenantId, storeId);
    const idPrzed = (await webhookiSklepu(adres)).map((w) => w.id).sort();

    const drugi = await podlaczSklepWoo(tenantId, {
      baseUrl: klucze!.url,
      consumerKey: klucze!.ck,
      consumerSecret: klucze!.cs,
    });
    expect(drugi.ok).toBe(true);
    if (!drugi.ok) return;
    expect(drugi.storeId).toBe(storeId);

    const idPo = (await webhookiSklepu(adres)).map((w) => w.id).sort();
    expect(idPo).toEqual(idPrzed);
    // nowy sekret przy istniejacych webhookach = sklep podpisuje po staremu,
    // a endpoint odrzuca kazda dostawe jako zly podpis (cisza zamiast bledu)
    expect(await sekretWebhooka(tenantId, storeId)).toBe(sekretPrzed);
  });

  it("nadmiarowy webhook pod tym samym adresem znika przy odswiezeniu", async () => {
    await woo("webhooks", {
      method: "POST",
      body: JSON.stringify({
        name: "duplikat z wczesniejszego przebiegu",
        topic: "order.created",
        delivery_url: adres,
        secret: "nieistotny",
      }),
    });
    expect(await webhookiSklepu(adres)).toHaveLength(TEMATY_WEBHOOKOW.length + 1);

    const wynik = await odswiezWebhokiSklepu(tenantId, storeId);
    expect(wynik.ok).toBe(true);
    if (!wynik.ok) return;
    expect(wynik.stan.usunieteDuplikaty).toBe(1);
    expect(await webhookiSklepu(adres)).toHaveLength(TEMATY_WEBHOOKOW.length);
  });

  it("webhook wstrzymany w sklepie wraca do aktywnego, a stan potwierdza sklep", async () => {
    const cel = (await webhookiSklepu(adres)).find((w) => w.topic === "order.created");
    await woo(`webhooks/${cel.id}`, { method: "PUT", body: JSON.stringify({ status: "paused" }) });
    // sanity: sklep faktycznie oddaje "paused" - inaczej test nic by nie sprawdzal
    expect((await woo(`webhooks/${cel.id}`)).status).toBe("paused");

    const wynik = await odswiezWebhokiSklepu(tenantId, storeId);
    expect(wynik.ok).toBe(true);
    if (!wynik.ok) return;
    expect(wszystkieAktywne(wynik.stan)).toBe(true);
    expect((await woo(`webhooks/${cel.id}`)).status).toBe("active");
  });

  it(
    "zamowienie zlozone w sklepie dociera webhookiem do raw_events",
    async () => {
      // Woo wymaga w pozycji zamowienia realnego produktu (product_id albo sku),
      // wiec bierzemy pierwszy z katalogu sandboxa zamiast wymyslac pozycje
      const [produkt] = (await woo("products?per_page=1")) as any[];
      const zamowienie = await woo("orders", {
        method: "POST",
        body: JSON.stringify({
          status: "processing",
          billing: { first_name: "Webhook", last_name: "Testowy", email: "webhook-b3@example.com" },
          line_items: [{ product_id: produkt.id, quantity: 1 }],
        }),
      });

      // Woo dostarcza webhooki z wp-crona, wiec sklep bez ruchu nie wysle NIC,
      // dopoki ktos nie uderzy w wp-cron.php. W sandboxie robi to kontener woo-cron
      // co 30 s; tutaj dokladamy wlasne tykniecia, zeby test nie czekal na cudzy zegar.
      let trafienie: any;
      for (let proba = 0; proba < 40 && !trafienie; proba++) {
        await fetch(`${klucze!.url}/wp-cron.php?doing_wp_cron`).catch(() => {});
        const { rows } = await getPool().query(
          `select id, payload, received_at from raw_events
            where tenant_id = $1 and store_id = $2 and payload->>'id' = $3`,
          [tenantId, storeId, String(zamowienie.id)],
        );
        trafienie = rows[0];
        if (!trafienie) await new Promise((r) => setTimeout(r, 4000));
      }

      await woo(`orders/${zamowienie.id}?force=true`, { method: "DELETE" }).catch(() => {});
      expect(
        trafienie,
        "sklep nie dostarczyl webhooka - sprawdz, czy aplikacja slucha na " + APP_URL,
      ).toBeTruthy();
      expect(trafienie.payload.billing.email).toBe("webhook-b3@example.com");
    },
    180_000,
  );

  it("sklep, ktory przyslal zdarzenie, nie jest uznany za milczacy", async () => {
    const [ocena] = await ocenSklepy(tenantId);
    expect(ocena.storeId).toBe(storeId);
    expect(ocena.webhookiAktywne).toBe(true);
    expect(ocena.milczy).toBe(false);
    expect(ocena.zdarzen24h).toBeGreaterThan(0);
  });
});

describe("Cisza sklepu: awaria bez sygnalu dostaje sygnal", () => {
  const PREFIKS_CISZA = "SKLEPY CISZA ";
  let tenantId = "";
  let storeId = "";

  beforeAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS_CISZA + "%"]);
    const { rows } = await getPool().query("insert into tenants (name) values ($1) returning id", [
      PREFIKS_CISZA + "Tenant",
    ]);
    tenantId = rows[0].id;
    // sklep podlaczony dwie doby temu, bez webhookow i bez jednego zdarzenia -
    // dokladnie ten stan, ktory w panelu wyglada jak sklep bez sprzedazy
    const sklep = await getPool().query(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted, capabilities, status, created_at)
       values ($1, 'woocommerce', 'https://milczacy.example', $2, '{}'::jsonb, 'connected', now() - interval '48 hours')
       returning id`,
      [tenantId, zaszyfruj(JSON.stringify({ ck: "ck_x", cs: "cs_x" }))],
    );
    storeId = sklep.rows[0].id;
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS_CISZA + "%"]);
    await closePool();
  });

  it("zglasza sklep bez webhookow i bez zdarzen, ale nie powtarza alertu w okienku", async () => {
    const pierwszy = await sprawdzCiszeSklepow(tenantId);
    expect(pierwszy.zgloszone.map((o) => o.storeId)).toEqual([storeId]);
    expect(pierwszy.zgloszone[0].powod).toContain("webhooki");

    // drugi przebieg tego samego joba nie ma prawa zasypac kanalu tym samym alertem
    const drugi = await sprawdzCiszeSklepow(tenantId);
    expect(drugi.zgloszone).toHaveLength(0);
    expect(drugi.ocenione[0].milczy).toBe(true);

    // ...ale wyciszenie jest OKIENKIEM, nie kneblem na zawsze
    const trzeci = await sprawdzCiszeSklepow(tenantId, { odstepAlertuGodzin: 0 });
    expect(trzeci.zgloszone.map((o) => o.storeId)).toEqual([storeId]);
  });

  it("swieze zdarzenie ze sklepu przerywa cisze dopiero razem z aktywnymi webhookami", async () => {
    await getPool().query(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
       values ($1, $2, 'woocommerce', $3, '{"id": 1}'::jsonb)`,
      [tenantId, storeId, `test:${storeId}:order:1:v1`],
    );
    const [ocena] = await ocenSklepy(tenantId);
    expect(ocena.ostatnieZdarzenieAt).not.toBeNull();
    expect(ocena.zdarzen24h).toBe(1);
    // zdarzenie przyszlo, ale webhookow dalej nie ma (np. skasowane w sklepie) -
    // to NIE jest sklep zdrowy i panel nie ma prawa pokazac go jako dosylajacego
    expect(ocena.webhookiAktywne).toBe(false);
    expect(ocena.milczy).toBe(true);
  });
});
