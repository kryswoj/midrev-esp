// Webhooki zakladane przy podlaczeniu sklepu celuja w adres testowego odbiornika, nie
// w serwer dev :3005 (ten pisze do bazy deweloperskiej). Sam import nie czeka na dostawe,
// wiec odbiornik nie musi tu nasluchiwac - patrz tests/odbiornik-webhookow.ts.
import { ADRES_ODBIORNIKA } from "./odbiornik-webhookow";
process.env.APP_URL = ADRES_ODBIORNIKA;

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { adresDostawy } from "../src/adapters/store/webhooki";
import { AdapterWoo, mapujZamowienieWoo } from "../src/adapters/store/woo/adapter";
import { wykonajImport, zaplanujImport } from "../src/usecases/importuj-historie";
import { podlaczSklepWoo } from "../src/usecases/podlacz-sklep";
import { usunWebhookiPodAdresem, wczytajKlucze, woo, wszystkieWoo } from "./pomoc-woo";

// Audyt #13: import ucinal po 20 stronach x 100 i raportowal sukces, plan liczyl tym samym
// sufitem (rozbieznosc nigdy nie zapalala sie), 5xx sklepu wygladal jak koniec danych,
// klienci nie wchodzili, parametr `od` byl martwy. Tu: sandbox ma ~50 zamowien, wiec
// paginacja idzie po 2 na strone - ponad 20 stron - i MUSI dojsc do konca.

const klucze = wczytajKlucze();
const PREFIKS = "IMPORT PELNY ";

describe("Adapter Woo: odpowiedz inna niz 2xx jest bledem z nazwa", () => {
  let serwer: Server;
  let port = 0;

  beforeAll(async () => {
    serwer = createServer((zadanie, odpowiedz) => {
      if (zadanie.url?.includes("/orders")) {
        odpowiedz.writeHead(500, { "content-type": "application/json" });
        odpowiedz.end(JSON.stringify({ code: "woocommerce_rest_awaria_testowa", message: "boom" }));
      } else {
        odpowiedz.writeHead(502);
        odpowiedz.end("<html>bad gateway</html>");
      }
    });
    await new Promise<void>((r) => serwer.listen(0, "127.0.0.1", r));
    port = (serwer.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => serwer.close(() => r()));
  });

  it("rzuca z kodem Woo i numerem HTTP zamiast oddawac pusta strone", async () => {
    const adapter = new AdapterWoo("t", { baseUrl: `http://127.0.0.1:${port}`, consumerKey: "ck", consumerSecret: "cs" });
    await expect(adapter.pobierzZamowienia({ strona: 3, naStrone: 100 })).rejects.toThrow(
      /GET orders\?.*page=3.*woocommerce_rest_awaria_testowa \(HTTP 500\)/,
    );
    await expect(adapter.pobierzKlientow(1, 100)).rejects.toThrow(/GET customers.*HTTP 502/);
    await expect(adapter.policzZamowienia()).rejects.toThrow(/HTTP 500/);
  });

  it("zamowienie bez daty ze zrodla jest bledem z nazwa, nie Invalid Date", () => {
    expect(() => mapujZamowienieWoo({ id: 7, total: "10.00" })).toThrow(/Zamówienie 7 bez date_created_gmt/);
  });
});

describe.skipIf(!klucze)("Import historii na zywym Woo", () => {
  let tenantId = "";
  let storeId = "";
  let adres = "";
  // niezalezna wyrocznia: to, co sklep mowi o sobie przez goly REST, nie przez adapter
  let zamowieniaWoo: any[] = [];
  let klienciWoo: any[] = [];
  let odczekiwane: number;

  beforeAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = (await getPool().query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"])).rows[0].id;
    const wynik = await podlaczSklepWoo(tenantId, { baseUrl: klucze!.url, consumerKey: klucze!.ck, consumerSecret: klucze!.cs });
    if (!wynik.ok) throw new Error(wynik.blad);
    storeId = wynik.storeId;
    adres = adresDostawy(process.env.APP_URL!, storeId);
    zamowieniaWoo = await wszystkieWoo(klucze!, "orders", "status=any");
    klienciWoo = await wszystkieWoo(klucze!, "customers");
    odczekiwane = new Set([
      ...zamowieniaWoo.map((z) => z.billing?.email).filter(Boolean),
      ...klienciWoo.map((k) => k.email).filter(Boolean),
    ].map((e: string) => e.trim().toLowerCase())).size;
  }, 120_000);

  afterAll(async () => {
    if (adres) await usunWebhookiPodAdresem(klucze!, adres);
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  it("plan liczy zamowienia i klientow z naglowka sklepu, a nowe profile z prawdziwych e-maili", async () => {
    expect(zamowieniaWoo.length).toBeGreaterThan(40); // po 2 na strone = ponad 20 stron
    const plan = await zaplanujImport(tenantId, storeId, { naStrone: 2 });
    expect(plan.zamowienia).toBe(zamowieniaWoo.length);
    expect(plan.klienci).toBe(klienciWoo.length);
    expect(plan.noweProfile).toBe(odczekiwane);
    expect(plan.probki.length).toBeGreaterThan(0);
    expect(plan.zakresOd).not.toBeNull();
    console.log(`[import-pelny] plan na sandboxie: ${plan.zamowienia} zamowien, ${plan.klienci} klientow, ${plan.noweProfile} nowych profili`);
  }, 120_000);

  it(
    "import idzie do konca paginacji, klienci wchodza jako profile bez zgody, liczniki z odczytu zwrotnego",
    async () => {
      const pool = getPool();
      const wynik = await wykonajImport(tenantId, storeId, { naStrone: 2 });
      expect(wynik.rozbieznosc).toBeNull();
      expect(wynik.objeteZamowienia).toBe(zamowieniaWoo.length);
      expect(wynik.objeciKlienci).toBe(klienciWoo.length);
      expect(wynik.utworzoneZamowienia).toBe(zamowieniaWoo.length);
      expect(wynik.utworzoneProfile).toBe(odczekiwane);
      expect(wynik.pominieteDuplikaty).toBe(0);
      expect(wynik.zaktualizowaneZamowienia).toBe(0);
      expect(wynik.pominieteRodo).toBe(0);

      // liczby w bazie, nie w pamieci
      const { rows: [z] } = await pool.query("select count(*)::int as ile from orders where tenant_id = $1 and store_id = $2", [tenantId, storeId]);
      expect(z.ile).toBe(zamowieniaWoo.length);
      const { rows: [p] } = await pool.query("select count(*)::int as ile from profiles where tenant_id = $1", [tenantId]);
      expect(p.ile).toBe(odczekiwane);
      const { rows: [c] } = await pool.query("select count(*)::int as ile from consents where tenant_id = $1", [tenantId]);
      expect(c.ile, "import nie ma prawa nadac zgody marketingowej (FR27)").toBe(0);

      // profil z konta: imie i nazwisko z konta klienta, e-mail znormalizowany
      const klient = klienciWoo.find((k) => k.email === "anna.kowalska@example.test");
      if (klient) {
        const { rows: [anna] } = await pool.query(
          "select first_name, last_name from profiles where tenant_id = $1 and lower(btrim(email)) = $2",
          [tenantId, "anna.kowalska@example.test"],
        );
        expect(anna.first_name).toBe(klient.first_name);
        expect(anna.last_name).toBe(klient.last_name);
      }

      // surowe zdarzenia obu bytow z kluczami wg AD-24 i zdarzenia customer.created z data ze zrodla
      const { rows: [surowe] } = await pool.query(
        `select count(*) filter (where split_part(idempotency_key, ':', 3) = 'customer')::int as klienci,
                count(*) filter (where split_part(idempotency_key, ':', 3) = 'order')::int as zamowienia
           from raw_events where tenant_id = $1 and store_id = $2`,
        [tenantId, storeId],
      );
      expect(surowe.klienci).toBe(klienciWoo.length);
      expect(surowe.zamowienia).toBe(zamowieniaWoo.length);
      // kanal importu: ocena ciszy sklepu nie moze wziac importu za zywe webhooki
      const { rows: [kanaly] } = await pool.query(
        "select count(*) filter (where channel = 'import')::int as import, count(*) filter (where channel = 'webhook')::int as webhook from raw_events where tenant_id = $1",
        [tenantId],
      );
      expect(kanaly.import).toBe(klienciWoo.length + zamowieniaWoo.length);
      expect(kanaly.webhook).toBe(0);
      const { rows: [kanalZdarzen] } = await pool.query(
        "select count(*)::int as ile from events where tenant_id = $1 and event_type = 'order.created' and payload ->> 'kanal' = 'import'",
        [tenantId],
      );
      expect(kanalZdarzen.ile).toBe(zamowieniaWoo.length);
      const { rows: zdarzenia } = await pool.query(
        `select e.occurred_at, p.email from events e join profiles p on p.tenant_id = e.tenant_id and p.id = e.profile_id
          where e.tenant_id = $1 and e.event_type = 'customer.created'`,
        [tenantId],
      );
      expect(zdarzenia).toHaveLength(klienciWoo.length);
      for (const zd of zdarzenia) {
        const k = klienciWoo.find((k) => k.email.toLowerCase() === zd.email);
        expect(new Date(zd.occurred_at).toISOString()).toBe(new Date(k.date_created_gmt + "Z").toISOString());
      }

      // daty zamowien ze zrodla, nie z importu
      const najstarsze = zamowieniaWoo.map((z) => new Date(z.date_created_gmt + "Z").getTime()).sort()[0];
      expect(wynik.najstarszaData!.getTime()).toBe(najstarsze);

      const { rows: [run] } = await pool.query("select status, planned, counters from import_runs where id = $1", [wynik.runId]);
      expect(run.status).toBe("done");
      expect(run.planned.klienci).toBe(klienciWoo.length);
      expect(run.counters.utworzoneZamowienia).toBe(zamowieniaWoo.length);
    },
    300_000,
  );

  it("drugi import niczego nie dubluje i nie zglasza rozbieznosci; ta sama wersja to duplikat, nie aktualizacja", async () => {
    const wynik = await wykonajImport(tenantId, storeId);
    expect(wynik.utworzoneZamowienia).toBe(0);
    expect(wynik.utworzoneProfile).toBe(0);
    expect(wynik.zaktualizowaneZamowienia).toBe(0);
    expect(wynik.pominieteDuplikaty).toBe(zamowieniaWoo.length);
    expect(wynik.objeteZamowienia).toBe(zamowieniaWoo.length);
    expect(wynik.rozbieznosc).toBeNull();
  }, 300_000);

  it("zamowienie zmienione w sklepie po imporcie dostaje przy ponownym imporcie nowy status (osłona wersji)", async () => {
    const pool = getPool();
    const cel = zamowieniaWoo.find((z) => z.status === "processing") ?? zamowieniaWoo[0];
    await new Promise((r) => setTimeout(r, 1500)); // date_modified_gmt z dokladnoscia do sekundy
    await woo(klucze!, `orders/${cel.id}`, { method: "PUT", body: JSON.stringify({ status: "completed" }) });
    const wynik = await wykonajImport(tenantId, storeId);
    expect(wynik.zaktualizowaneZamowienia).toBe(1);
    expect(wynik.pominieteDuplikaty).toBe(zamowieniaWoo.length - 1);
    const { rows: [z] } = await pool.query("select status from orders where tenant_id = $1 and store_id = $2 and external_id = $3", [tenantId, storeId, String(cel.id)]);
    expect(z.status).toBe("completed");
    await woo(klucze!, `orders/${cel.id}`, { method: "PUT", body: JSON.stringify({ status: cel.status }) }).catch(() => {});
  }, 300_000);

  it("drugi import tego samego sklepu w trakcie pierwszego jest odrzucany", async () => {
    const pool = getPool();
    const { rows: [run] } = await pool.query(
      "insert into import_runs (tenant_id, store_id, status, started_at) values ($1, $2, 'running', now()) returning id",
      [tenantId, storeId],
    );
    await expect(wykonajImport(tenantId, storeId)).rejects.toThrow(/już trwa/);
    await pool.query("delete from import_runs where id = $1", [run.id]);
  }, 120_000);

  it("zakres `od` ogranicza import do zamowien od tej daty i zgadza sie z liczba wg sklepu", async () => {
    const pool = getPool();
    const tenantB = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "B"])).rows[0].id;
    const podl = await podlaczSklepWoo(tenantB, { baseUrl: klucze!.url, consumerKey: klucze!.ck, consumerSecret: klucze!.cs });
    if (!podl.ok) throw new Error(podl.blad);
    const od = new Date(Date.now() - 100 * 24 * 3600 * 1000);
    const { naglowki } = await woo(klucze!, `orders?per_page=1&status=any&after=${encodeURIComponent(od.toISOString())}`);
    const wgSklepu = Number(naglowki.get("x-wp-total"));
    expect(wgSklepu).toBeGreaterThan(0);
    expect(wgSklepu).toBeLessThan(zamowieniaWoo.length);

    const wynik = await wykonajImport(tenantB, podl.storeId, { od });
    expect(wynik.rozbieznosc).toBeNull();
    expect(wynik.objeteZamowienia).toBe(wgSklepu);
    const { rows: [k] } = await pool.query(
      "select count(*)::int as ile, min(occurred_at) as min from orders where tenant_id = $1",
      [tenantB],
    );
    expect(k.ile).toBe(wgSklepu);
    expect(new Date(k.min).getTime()).toBeGreaterThanOrEqual(od.getTime() - 1000);
    await usunWebhookiPodAdresem(klucze!, adresDostawy(process.env.APP_URL!, podl.storeId));
  }, 300_000);
});
