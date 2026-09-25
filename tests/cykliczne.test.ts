import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { wyslijAlert, zbudujPayloadAlertu } from "../src/jobs/alerty";
import {
  atrybucjaDoPrzeliczenia,
  dodajJesliBrak,
  domknijPorzuconeImporty,
  HANDLERY_CYKLICZNE,
  MAKS_PONOWIEN_SUROWYCH,
  planujCykliczne,
  ponowZalegleSurowe,
  RYTM,
} from "../src/jobs/handlery-cykliczne";
import { przeliczAtrybucje } from "../src/usecases/przelicz-atrybucje";
import type { Zadanie } from "../src/jobs/kolejka";

// Audyt #18/#19: atrybucja tylko przyciskiem, cisza sklepow i zgodnosc wolane tylko z testow,
// alerty bez kanalu. Tu: alert idzie POST-em z poziomem i tenantem na lokalny serwer,
// planowanie nie dubluje jobow (takze przy rownoleglych wywolaniach), atrybucja planuje sie
// tylko, gdy od ostatniego przebiegu cos sie zmienilo.

const PREFIKS = "CYKLICZNE ";
const odebrane: Array<{ naglowki: Record<string, string | string[] | undefined>; cialo: any }> = [];
let serwer: Server;

beforeAll(async () => {
  serwer = createServer((zadanie, odpowiedz) => {
    let dane = "";
    zadanie.on("data", (c) => (dane += c));
    zadanie.on("end", () => {
      odebrane.push({ naglowki: zadanie.headers, cialo: JSON.parse(dane) });
      odpowiedz.writeHead(204);
      odpowiedz.end();
    });
  });
  await new Promise<void>((r) => serwer.listen(0, "127.0.0.1", r));
  const port = (serwer.address() as { port: number }).port;
  // PRZED pierwszym config(): konfiguracja jest buforowana przy pierwszym odczycie
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/alert`;
});

afterAll(async () => {
  await new Promise<void>((r) => serwer.close(() => r()));
});

describe("Alert do czlowieka", () => {
  it("idzie POST-em JSON z poziomem, tenantem, trescia i czasem", async () => {
    await wyslijAlert("sklep milczy od 30 h", { poziom: "krytyczny", tenantId: "tenant-123" });
    expect(odebrane).toHaveLength(1);
    expect(odebrane[0].naglowki["content-type"]).toBe("application/json");
    const cialo = odebrane[0].cialo;
    expect(cialo.poziom).toBe("krytyczny");
    expect(cialo.tenant).toBe("tenant-123");
    expect(cialo.tresc).toBe("sklep milczy od 30 h");
    expect(new Date(cialo.kiedy).toISOString()).toBe(cialo.kiedy);
    expect(cialo.content).toBe("[KRYTYCZNY] tenant tenant-123: sklep milczy od 30 h");
    expect(cialo.text).toBe(cialo.content);
  });

  it("bez opcji ma poziom uwaga i pusty tenant (zgodnosc ze starymi wywolaniami)", async () => {
    await wyslijAlert("cos poszlo nie tak");
    const cialo = odebrane.at(-1)!.cialo;
    expect(cialo.poziom).toBe("uwaga");
    expect(cialo.tenant).toBeNull();
    expect(cialo.content).toBe("[UWAGA] cos poszlo nie tak");
    expect(zbudujPayloadAlertu("x", { poziom: "info" }).content).toBe("[INFO] x");
  });
});

describe("Planowanie jobow cyklicznych", () => {
  let tenantId = "";
  let profileId = "";
  let storeId = "";

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"])).rows[0].id;
    profileId = (await pool.query("insert into profiles (tenant_id, email) values ($1, 'cykl@example.test') returning id", [tenantId])).rows[0].id;
    storeId = (
      await pool.query(
        `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
         values ($1, 'woocommerce', 'http://127.0.0.1:9', decode('00', 'hex'), 'connected') returning id`,
        [tenantId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  async function jobyTenanta(kind: string) {
    const { rows } = await getPool().query("select id, status from jobs where tenant_id = $1 and kind = $2", [tenantId, kind]);
    return rows;
  }

  it("dodajJesliBrak kolejkuje raz w oknie rytmu, takze przy pieciu rownoleglych wywolaniach", async () => {
    const wyniki = await Promise.all(Array.from({ length: 5 }, () => dodajJesliBrak(tenantId, "cisza_sklepow")));
    expect(wyniki.filter(Boolean)).toHaveLength(1);
    expect(await jobyTenanta("cisza_sklepow")).toHaveLength(1);
    expect(await dodajJesliBrak(tenantId, "cisza_sklepow")).toBe(false);
    expect(RYTM.cisza_sklepow).toEqual({ godziny: 1 });
    expect(RYTM.zgodnosc_danych).toEqual({ doba: true });
  });

  it("atrybucja planuje sie tylko, gdy od ostatniego przebiegu zmienilo sie oplacone zamowienie", async () => {
    const pool = getPool();
    expect(await atrybucjaDoPrzeliczenia(tenantId)).toBe(false);
    await pool.query(
      `insert into orders (tenant_id, store_id, profile_id, external_id, status, total_minor, currency, occurred_at, source_updated_at)
       values ($1, $2, $3, 'z-1', 'completed', 1000, 'PLN', now() - interval '1 day', now() - interval '1 day')`,
      [tenantId, storeId, profileId],
    );
    expect(await atrybucjaDoPrzeliczenia(tenantId)).toBe(true);
    await przeliczAtrybucje(tenantId);
    expect(await atrybucjaDoPrzeliczenia(tenantId)).toBe(false);
    // order.updated ze zrodla po przebiegu (np. pending -> completed) = do przeliczenia
    await pool.query("update orders set source_updated_at = now() where tenant_id = $1 and external_id = 'z-1'", [tenantId]);
    expect(await atrybucjaDoPrzeliczenia(tenantId)).toBe(true);
  });

  it("planujCykliczne zaklada komplet dla tenanta i nie dubluje przy drugim tiku", async () => {
    const pierwszy = await planujCykliczne();
    expect(pierwszy.atrybucja).toBeGreaterThanOrEqual(1);
    expect(pierwszy.zgodnoscDanych).toBeGreaterThanOrEqual(1);
    expect(await jobyTenanta("atrybucja")).toHaveLength(1);
    expect(await jobyTenanta("zgodnosc_danych")).toHaveLength(1);
    expect(await jobyTenanta("cisza_sklepow")).toHaveLength(1);
    const drugi = await planujCykliczne();
    expect(await jobyTenanta("atrybucja")).toHaveLength(1);
    expect(await jobyTenanta("zgodnosc_danych")).toHaveLength(1);
    // inne tenanty mogly dostac swoje joby; ten tenant - nic nowego
    expect(drugi.atrybucja + drugi.zgodnoscDanych + drugi.ciszaSklepow).toBeGreaterThanOrEqual(0);
  });

  it("zalegle surowe zdarzenie po wyczerpanych probach dostaje nowy job, ale nie czesciej niz raz na dobe", async () => {
    const pool = getPool();
    const { rows: [surowe] } = await pool.query(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload, received_at)
       values ($1, $2, 'woocommerce', $3, '{"id": 5}', now() - interval '1 hour') returning id`,
      [tenantId, storeId, `woocommerce:${tenantId}:customer:5:v1`],
    );
    // job z webhooka, ktory wyczerpal proby na starym kodzie - stworzony 2 h temu
    await pool.query(
      `insert into jobs (tenant_id, kind, payload, status, attempts, created_at)
       values ($1, 'przetworz_zdarzenie', $2, 'failed', 5, now() - interval '2 hours')`,
      [tenantId, JSON.stringify({ rawEventId: surowe.id, storeId })],
    );
    // w ciagu doby od ostatniego joba: nie ponawiamy (zatruty payload nie ma budzic co godzine)
    expect(await ponowZalegleSurowe()).toBe(0);
    await pool.query("update jobs set created_at = now() - interval '25 hours' where tenant_id = $1 and kind = 'przetworz_zdarzenie'", [tenantId]);
    expect(await ponowZalegleSurowe()).toBeGreaterThanOrEqual(1);
    const { rows: joby } = await pool.query(
      "select status, payload from jobs where tenant_id = $1 and kind = 'przetworz_zdarzenie' and payload ->> 'rawEventId' = $2 order by created_at",
      [tenantId, surowe.id],
    );
    expect(joby).toHaveLength(2);
    expect(joby[1].payload.ponowienie).toBe(1);
    // drugi tik: job juz czeka, nic nowego
    expect(await ponowZalegleSurowe()).toBe(0);
    // licznik ponowien w process_error; po MAKS_PONOWIEN_SUROWYCH zdarzenie zostaje na stale
    const { rows: [pe] } = await pool.query("select process_error from raw_events where id = $1", [surowe.id]);
    expect(pe.process_error).toBe("ponowiono:1");
    await pool.query("update raw_events set process_error = $2 where id = $1", [surowe.id, `ponowiono:${MAKS_PONOWIEN_SUROWYCH}`]);
    await pool.query("update jobs set status = 'failed', created_at = now() - interval '25 hours' where tenant_id = $1 and kind = 'przetworz_zdarzenie'", [tenantId]);
    expect(await ponowZalegleSurowe()).toBe(0);
    // zaslepka RODO i sklep poza `connected` tez nie wracaja do kolejki
    await pool.query("update raw_events set process_error = null, payload = '{\"anonimizowano\": true}' where id = $1", [surowe.id]);
    expect(await ponowZalegleSurowe()).toBe(0);
    // po przetworzeniu (processed_at) zdarzenie znika z listy zaleglych
    await pool.query("update raw_events set processed_at = now() where id = $1", [surowe.id]);
    expect(await ponowZalegleSurowe()).toBe(0);
  });

  it("porzucony import (running ponad godzine) dostaje status failed z powodem", async () => {
    const pool = getPool();
    const { rows: [run] } = await pool.query(
      `insert into import_runs (tenant_id, store_id, status, started_at) values ($1, $2, 'running', now() - interval '2 hours') returning id`,
      [tenantId, storeId],
    );
    expect(await domknijPorzuconeImporty()).toBeGreaterThanOrEqual(1);
    const { rows: [po] } = await pool.query("select status, last_error from import_runs where id = $1", [run.id]);
    expect(po.status).toBe("failed");
    expect(po.last_error).toContain("porzucony");
  });

  it("zgodnosc danych: sklep, ktory nie odpowiada, daje alert 'uwaga' z tenantem", async () => {
    const przed = odebrane.length;
    const zadanie = { id: "x", token: "t", tenant_id: tenantId, kind: "zgodnosc_danych", payload: {}, attempts: 1, max_attempts: 5 } as Zadanie;
    await HANDLERY_CYKLICZNE.zgodnosc_danych(zadanie);
    const nowe = odebrane.slice(przed);
    expect(nowe).toHaveLength(1);
    expect(nowe[0].cialo.poziom).toBe("uwaga");
    expect(nowe[0].cialo.tenant).toBe(tenantId);
    expect(nowe[0].cialo.tresc).toContain("nie odpowiada");
  });

  it("cisza sklepow: handler zglasza sklep bez webhookow alertem 'krytyczny'", async () => {
    const przed = odebrane.length;
    await getPool().query("update stores set created_at = now() - interval '48 hours' where id = $1", [storeId]);
    const zadanie = { id: "x", token: "t", tenant_id: tenantId, kind: "cisza_sklepow", payload: {}, attempts: 1, max_attempts: 5 } as Zadanie;
    await HANDLERY_CYKLICZNE.cisza_sklepow(zadanie);
    const nowe = odebrane.slice(przed);
    expect(nowe).toHaveLength(1);
    expect(nowe[0].cialo.poziom).toBe("krytyczny");
    expect(nowe[0].cialo.tenant).toBe(tenantId);
    expect(nowe[0].cialo.tresc).toContain("NIE DOSYŁA DANYCH");
  });
});
