import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { zaszyfruj } from "../src/adapters/crypto";
import { zapiszStanWebhookow } from "../src/adapters/store/stan-webhookow";
import { TEMATY_WEBHOOKOW } from "../src/adapters/store/webhooki";
import { stanOnboardingu, type KrokWdrozenia } from "../src/usecases/onboarding";

/**
 * Wykonywalna specyfikacja listy kroków wdrożenia z ekranu startowego.
 *
 * Sens tych testów: krok ma być WYLICZANY ZE STANU BAZY. Test na atrapie potwierdzałby
 * wyłącznie to, że umiem napisać atrapę — a cała wartość tej listy polega na tym, że
 * „zrobione" znaczy „dane to potwierdzają", a nie „ktoś kliknął checkbox". Dlatego baza
 * jest prawdziwa (AD-20), a konto budowane jest krok po kroku i po każdym dołożeniu
 * sprawdzamy, że odhaczył się DOKŁADNIE ten krok, o który chodziło.
 *
 * Izolacja tenantów (AD-2) jest tu obowiązkowa: sklep i zamówienia obcego tenanta nie mają
 * prawa odhaczyć niczego na naszym koncie.
 */

function krok(kroki: KrokWdrozenia[], klucz: string): KrokWdrozenia {
  const znaleziony = kroki.find((k) => k.klucz === klucz);
  if (!znaleziony) throw new Error(`Brak kroku ${klucz}`);
  return znaleziony;
}

async function zrobione(tenantId: string): Promise<string[]> {
  const stan = await stanOnboardingu(tenantId);
  return stan.kroki.filter((k) => k.zrobiony).map((k) => k.klucz);
}

describe("Onboarding: lista kroków wdrożenia", () => {
  let tenantA: string;
  let tenantB: string;
  let sklepA: string;
  let sklepB: string;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'ONB %'");
    const a = await pool.query("insert into tenants (name) values ('ONB tenant A') returning id");
    const b = await pool.query("insert into tenants (name) values ('ONB tenant B') returning id");
    tenantA = a.rows[0].id;
    tenantB = b.rows[0].id;
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'ONB %'");
    await closePool();
  });

  it("puste konto nie ma odhaczonego ani jednego kroku", async () => {
    const stan = await stanOnboardingu(tenantA);
    expect(stan.wszystkie).toBe(6);
    expect(stan.zrobione).toBe(0);
    expect(stan.gotowe).toBe(false);
    expect(stan.kroki.every((k) => k.href.startsWith("/"))).toBe(true);
    expect(stan.kroki.every((k) => k.poCo.length > 0 && k.akcja.length > 0)).toBe(true);
  });

  it("sama zweryfikowana domena nie odhacza kroku — bez serwera nie ma czym wysłać", async () => {
    const pool = getPool();
    await pool.query(
      `insert into sending_domains (tenant_id, domain, status, verified_at)
       values ($1, 'onb.example', 'verified', now())`,
      [tenantA],
    );
    const domena = krok((await stanOnboardingu(tenantA)).kroki, "domena");
    expect(domena.wBudowie).toBe(false);
    expect(domena.zrobiony).toBe(false);
    expect(domena.href).toBe("/ustawienia/wysylka");
    expect(domena.szczegol).toContain("serwer wysyłkowy nie jest ustawiony");
  });

  it("podłączony sklep odhacza krok sklepu, ale nie webhooków", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
       values ($1, 'woocommerce', 'http://onb-a.example', $2, 'connected') returning id`,
      [tenantA, zaszyfruj(JSON.stringify({ ck: "x", cs: "y" }))],
    );
    sklepA = rows[0].id;

    expect(await zrobione(tenantA)).toEqual(["sklep"]);
    // sklep bez zapisanego stanu webhooków = webhooki nieustawione, nie „nie wiemy"
    expect(krok((await stanOnboardingu(tenantA)).kroki, "webhooki").zrobiony).toBe(false);
  });

  it("sklep w stanie pending nie odhacza kroku sklepu", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
       values ($1, 'woocommerce', 'http://onb-b.example', $2, 'pending') returning id`,
      [tenantB, zaszyfruj(JSON.stringify({ ck: "x", cs: "y" }))],
    );
    sklepB = rows[0].id;
    expect(await zrobione(tenantB)).toEqual([]);
  });

  it("zamówienia obcego tenanta nie odhaczają historii na naszym koncie", async () => {
    const pool = getPool();
    await pool.query(
      `insert into orders (tenant_id, store_id, external_id, status, total_minor, currency, occurred_at)
       values ($1, $2, 'onb-obce-1', 'completed', 10000, 'PLN', now())`,
      [tenantB, sklepB],
    );
    expect(await zrobione(tenantA)).toEqual(["sklep"]);
  });

  it("własne zamówienie odhacza krok historii", async () => {
    const pool = getPool();
    await pool.query(
      `insert into orders (tenant_id, store_id, external_id, status, total_minor, currency, occurred_at)
       values ($1, $2, 'onb-1', 'completed', 25000, 'PLN', now())`,
      [tenantA, sklepA],
    );
    expect(await zrobione(tenantA)).toEqual(["sklep", "historia"]);
  });

  it("webhooki odhaczają się dopiero po potwierdzeniu KAŻDEGO tematu odczytem zwrotnym", async () => {
    // Woo oddaje 201 i potrafi zostawić webhooka wstrzymanego, więc sam zapis stanu
    // bez `potwierdzonyAt` nie może wystarczyć (por. `wszystkieAktywne`).
    await zapiszStanWebhookow(tenantA, sklepA, {
      adresDostawy: "http://app.example/api/webhooks/woo/x",
      sprawdzonyAt: new Date().toISOString(),
      blad: null,
      wpisy: TEMATY_WEBHOOKOW.map((temat, i) => ({
        temat,
        webhookId: i + 1,
        stan: i === 0 ? "wstrzymany" : "aktywny",
        statusZrodla: i === 0 ? "paused" : "active",
        potwierdzonyAt: new Date().toISOString(),
        blad: null,
      })),
    });
    expect(krok((await stanOnboardingu(tenantA)).kroki, "webhooki").zrobiony).toBe(false);

    await zapiszStanWebhookow(tenantA, sklepA, {
      adresDostawy: "http://app.example/api/webhooks/woo/x",
      sprawdzonyAt: new Date().toISOString(),
      blad: null,
      wpisy: TEMATY_WEBHOOKOW.map((temat, i) => ({
        temat,
        webhookId: i + 1,
        stan: "aktywny",
        statusZrodla: "active",
        potwierdzonyAt: new Date().toISOString(),
        blad: null,
      })),
    });
    expect(await zrobione(tenantA)).toEqual(["sklep", "historia", "webhooki"]);
  });

  it("odbiorcy liczą się bramką wysyłki, a nie liczbą profili", async () => {
    const pool = getPool();
    const { rows: p } = await pool.query(
      "insert into profiles (tenant_id, email) values ($1, 'onb-lead@example.test') returning id",
      [tenantA],
    );
    // profil bez zgody: bramka go nie przepuszcza, więc krok zostaje niezrobiony
    expect(krok((await stanOnboardingu(tenantA)).kroki, "odbiorcy").zrobiony).toBe(false);

    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
       values ($1, $2, 'email', 'granted', 'test', now())`,
      [tenantA, p[0].id],
    );
    expect(krok((await stanOnboardingu(tenantA)).kroki, "odbiorcy").zrobiony).toBe(true);

    // wykluczenie tenanta zdejmuje go z bramki mimo ważnej zgody
    await pool.query(
      `insert into tenant_suppressions (tenant_id, email, action, reason)
       values ($1, 'onb-lead@example.test', 'suppressed', 'test')`,
      [tenantA],
    );
    expect(krok((await stanOnboardingu(tenantA)).kroki, "odbiorcy").zrobiony).toBe(false);

    // zdjęcie wykluczenia to nowy wpis, nie DELETE (AD-16) — bramka czyta ostatni
    await pool.query(
      `insert into tenant_suppressions (tenant_id, email, action, reason)
       values ($1, 'onb-lead@example.test', 'released', 'test')`,
      [tenantA],
    );
    expect(krok((await stanOnboardingu(tenantA)).kroki, "odbiorcy").zrobiony).toBe(true);
  });

  it("kampania w szkicu nie liczy się jako wysłana, wysłana liczy się", async () => {
    const pool = getPool();
    await pool.query("insert into campaigns (tenant_id, name) values ($1, 'ONB szkic')", [tenantA]);
    expect(krok((await stanOnboardingu(tenantA)).kroki, "kampania").zrobiony).toBe(false);

    await pool.query(
      "insert into campaigns (tenant_id, name, status) values ($1, 'ONB wyslana', 'sent')",
      [tenantA],
    );
    const stan = await stanOnboardingu(tenantA);
    expect(krok(stan.kroki, "kampania").zrobiony).toBe(true);
    // pięć z sześciu: domena jest zweryfikowana, ale serwera wysyłkowego wciąż nie ma
    expect(stan.zrobione).toBe(5);
    expect(stan.gotowe).toBe(false);
  });

  it("krok domeny wymaga tego samego co silnik: sprawdzonego serwera i domeny verified", async () => {
    const pool = getPool();
    const { rows: d } = await pool.query(
      "select id from sending_domains where tenant_id = $1 and domain = 'onb.example'",
      [tenantA],
    );
    // serwer zapisany, ale bez udanego testu połączenia: krok niezrobiony
    await pool.query(
      `insert into tenant_smtp_configs (tenant_id, sending_domain_id, host, port, security, from_name, from_email)
       values ($1, $2, 'smtp.onb.example', 587, 'starttls', 'ONB', 'sklep@onb.example')`,
      [tenantA, d[0].id],
    );
    let domena = krok((await stanOnboardingu(tenantA)).kroki, "domena");
    expect(domena.zrobiony).toBe(false);
    expect(domena.szczegol).toContain("testu połączenia");

    // serwer sprawdzony, domena spada do partial (np. ktoś usunął DMARC): nadal niezrobiony
    await pool.query("update tenant_smtp_configs set connection_verified_at = now() where tenant_id = $1", [tenantA]);
    await pool.query("update sending_domains set status = 'partial' where tenant_id = $1", [tenantA]);
    domena = krok((await stanOnboardingu(tenantA)).kroki, "domena");
    expect(domena.zrobiony).toBe(false);
    expect(domena.szczegol).toContain("częściowo");

    await pool.query("update sending_domains set status = 'verified' where tenant_id = $1", [tenantA]);
    const stan = await stanOnboardingu(tenantA);
    expect(krok(stan.kroki, "domena").zrobiony).toBe(true);
    expect(stan.zrobione).toBe(6);
    expect(stan.gotowe).toBe(true);

    // serwer i domena obcego tenanta nie odhaczają niczego na koncie B
    expect(krok((await stanOnboardingu(tenantB)).kroki, "domena").zrobiony).toBe(false);
  });
});
