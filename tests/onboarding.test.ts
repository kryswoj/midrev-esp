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

  it("puste konto nie ma odhaczonego ani jednego kroku; kolejność = prosty przepływ (0040)", async () => {
    const stan = await stanOnboardingu(tenantA);
    expect(stan.kroki.map((k) => k.klucz)).toEqual(["firma", "domena", "domena_gotowa", "sklep", "odbiorcy", "test"]);
    expect(stan.wszystkie).toBe(6);
    expect(stan.zrobione).toBe(0);
    expect(stan.gotowe).toBe(false);
    expect(stan.kroki.every((k) => k.href.startsWith("/"))).toBe(true);
    // krok zablokowany zależnością (np. weryfikacja bez domeny) nie ma przycisku, tylko opis
    expect(stan.kroki.every((k) => k.poCo.length > 0 && k.szczegol.length > 0)).toBe(true);
    expect(stan.kroki.filter((k) => !k.akcja).map((k) => k.klucz)).toEqual(["domena_gotowa", "test"]);
    // bez żargonu w tytułach i opisach kroków
    for (const k of stan.kroki) expect(`${k.tytul} ${k.poCo} ${k.szczegol}`).not.toMatch(/SES|SMTP|IMAP|MAIL FROM|DKIM|SPF|DMARC/);
  });

  it("dane firmy: odhaczone dopiero z nazwą i adresem (adres jest bramką wysyłki)", async () => {
    const pool = getPool();
    await pool.query("update tenants set sender_company_name = 'ONB sp. z o.o.' where id = $1", [tenantA]);
    expect(krok((await stanOnboardingu(tenantA)).kroki, "firma").zrobiony).toBe(false);
    await pool.query("update tenants set sender_postal_address = 'ul. Onb 1, 00-001 Warszawa' where id = $1", [tenantA]);
    expect(await zrobione(tenantA)).toEqual(["firma"]);
  });

  it("domena klienta bez serwera nie odhacza niczego; platformowa odhacza „podłącz”, a „gotowa” dopiero po weryfikacji SES", async () => {
    const pool = getPool();
    await pool.query(
      `insert into sending_domains (tenant_id, domain, status, verified_at)
       values ($1, 'onb.example', 'verified', now())`,
      [tenantA],
    );
    expect(await zrobione(tenantA)).toEqual(["firma"]);
    const { rows } = await pool.query(
      `insert into sending_domains (tenant_id, domain, managed_by, zone_apex, status)
       values ($1, 'news.onb-platforma.example', 'platforma', 'onb-platforma.example', 'partial') returning id`,
      [tenantA],
    );
    expect(await zrobione(tenantA)).toEqual(["firma", "domena"]);
    expect(krok((await stanOnboardingu(tenantA)).kroki, "domena_gotowa").szczegol).toContain("część rekordów");
    // status verified bez potwierdzenia SES to jeszcze nie „gotowa" (ta sama bramka co wysyłka)
    await pool.query("update sending_domains set status = 'verified' where id = $1", [rows[0].id]);
    expect(krok((await stanOnboardingu(tenantA)).kroki, "domena_gotowa").zrobiony).toBe(false);
    await pool.query("update sending_domains set ses_verified_for_sending = true where id = $1", [rows[0].id]);
    expect(await zrobione(tenantA)).toEqual(["firma", "domena", "domena_gotowa"]);
    // domena innego tenanta nie odhacza niczego na koncie B
    expect(await zrobione(tenantB)).toEqual([]);
  });

  it("sklep odhacza się dopiero, gdy odpowiada I powiadomienia (webhooki) są potwierdzone odczytem", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
       values ($1, 'woocommerce', 'http://onb-a.example', $2, 'connected') returning id`,
      [tenantA, zaszyfruj(JSON.stringify({ ck: "x", cs: "y" }))],
    );
    sklepA = rows[0].id;
    // sklep bez zapisanego stanu webhooków = webhooki nieustawione, nie „nie wiemy"
    expect(krok((await stanOnboardingu(tenantA)).kroki, "sklep").zrobiony).toBe(false);

    // Woo oddaje 201 i potrafi zostawić webhooka wstrzymanego (por. `wszystkieAktywne`)
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
    expect(krok((await stanOnboardingu(tenantA)).kroki, "sklep").zrobiony).toBe(false);
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
    expect(krok((await stanOnboardingu(tenantA)).kroki, "sklep").zrobiony).toBe(true);
  });

  it("sklep obcego tenanta w stanie pending nie odhacza niczego", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
       values ($1, 'woocommerce', 'http://onb-b.example', $2, 'pending') returning id`,
      [tenantB, zaszyfruj(JSON.stringify({ ck: "x", cs: "y" }))],
    );
    sklepB = rows[0].id;
    expect(sklepB).toBeTruthy();
    expect(await zrobione(tenantB)).toEqual([]);
  });

  it("odbiorcy liczą się bramką wysyłki, a nie liczbą profili", async () => {
    const pool = getPool();
    const { rows: p } = await pool.query(
      "insert into profiles (tenant_id, email) values ($1, 'onb-lead@example.test') returning id",
      [tenantA],
    );
    // profil bez zgody: bramka go nie przepuszcza, więc krok zostaje niezrobiony
    expect(krok((await stanOnboardingu(tenantA)).kroki, "odbiorcy").zrobiony).toBe(false);
    expect(krok((await stanOnboardingu(tenantA)).kroki, "odbiorcy").href).toBe("/popupy");

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

  it("pierwszy mail testowy: z ustawień (data w tenants) albo test kampanii, który naprawdę wyszedł", async () => {
    const pool = getPool();
    expect(krok((await stanOnboardingu(tenantA)).kroki, "test").zrobiony).toBe(false);
    // kampania w szkicu nie jest testem
    await pool.query("insert into campaigns (tenant_id, name) values ($1, 'ONB szkic')", [tenantA]);
    expect(krok((await stanOnboardingu(tenantA)).kroki, "test").zrobiony).toBe(false);
    await pool.query("update tenants set first_test_email_at = now() where id = $1", [tenantA]);
    const stan = await stanOnboardingu(tenantA);
    expect(krok(stan.kroki, "test").zrobiony).toBe(true);
    expect(stan.zrobione).toBe(6);
    expect(stan.gotowe).toBe(true);
    // nic z konta A nie odhacza się na koncie B
    expect(await zrobione(tenantB)).toEqual([]);
  });

  it("konto z własnym serwerem: „gotowa” wymaga sprawdzonego serwera i domeny verified (FR45)", async () => {
    const pool = getPool();
    const { rows: d } = await pool.query(
      "insert into sending_domains (tenant_id, domain, status) values ($1, 'onb-b.example', 'verified') returning id",
      [tenantB],
    );
    await pool.query(
      `insert into tenant_smtp_configs (tenant_id, sending_domain_id, host, port, security, from_name, from_email)
       values ($1, $2, 'smtp.onb.example', 587, 'starttls', 'ONB', 'sklep@onb-b.example')`,
      [tenantB, d[0].id],
    );
    let gotowa = krok((await stanOnboardingu(tenantB)).kroki, "domena_gotowa");
    expect(krok((await stanOnboardingu(tenantB)).kroki, "domena").zrobiony).toBe(true);
    expect(gotowa.zrobiony).toBe(false);
    expect(gotowa.szczegol).toContain("testu połączenia");
    await pool.query("update tenant_smtp_configs set connection_verified_at = now() where tenant_id = $1", [tenantB]);
    gotowa = krok((await stanOnboardingu(tenantB)).kroki, "domena_gotowa");
    expect(gotowa.zrobiony).toBe(true);
  });
});
