import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { hashKluczaApi, kluczZNaglowka, wygenerujKluczApi, WZOR_KLUCZA } from "../src/adapters/klucze-api";
import { middleware } from "../middleware";
import { POST, GET } from "../src/app/api/events/route";
import { ponowZalegleZdarzeniaApi } from "../src/jobs/handlery-zdarzenia";
import { anonimizujProfil, eksportujProfil } from "../src/usecases/profil-rodo";
import { kluczeTenanta, uniewaznijKlucz, utworzKlucz, uwierzytelnij } from "../src/usecases/api/klucze";
import { LIMIT_ZDARZEN, sprawdzLimit, sprawdzSufitDobowy, wyczyscLimity, zaliczDoSufitu } from "../src/usecases/api/limity";
import { przetworzZdarzenieApi, RODZAJ_JOBA } from "../src/usecases/api/przyjmij-zdarzenie";
import { czasZTekstu } from "../src/usecases/api/zdarzenie-api";
import { sciezkaPoPrzepisaniu } from "../src/trasy-publiczne";

// E2 (plan 2.x, 7.3): API zdarzeń zgodne z Klaviyo jako specyfikacja wykonywalna.
// Kontrakt: żądania z workflowów n8n Sports-med (tests/fixtures/n8n-klaviyo, zanonimizowane)
// muszą przejść BEZ ZMIAN: ta sama ścieżka z ukośnikiem, te same nagłówki, to samo ciało.

const PREFIKS = "APIZ ";
const znak = randomBytes(3).toString("hex");
const FIXTURES = join(import.meta.dirname, "fixtures", "n8n-klaviyo");
const NAGLOWKI_N8N: Record<string, string> = JSON.parse(readFileSync(join(FIXTURES, "naglowki.json"), "utf-8"));

function fixture(plik: string): string {
  return readFileSync(join(FIXTURES, plik), "utf-8").trim();
}

function zadanie(cialo: string, naglowki: Record<string, string>, sciezka = "/api/events/"): NextRequest {
  return new NextRequest(new URL(sciezka, "https://api.midrev.test"), { method: "POST", headers: naglowki, body: cialo });
}

/** Tak jak w produkcji: najpierw middleware (ukośnik), potem handler trasy. */
async function wyslij(cialo: string, klucz: string | null, dodatkowe: Record<string, string> = {}, sciezka = "/api/events/") {
  const naglowki: Record<string, string> = { ...NAGLOWKI_N8N, ...dodatkowe };
  if (klucz) naglowki.Authorization = `Klaviyo-API-Key ${klucz}`;
  const wstepne = zadanie(cialo, naglowki, sciezka);
  const mw = middleware(wstepne);
  expect(mw.headers.get("location"), "middleware nie może przekierować POST-a API").toBeNull();
  expect(mw.headers.get("x-middleware-rewrite"), "rewrite robi next.config, nie middleware").toBeNull();
  const cel = sciezkaPoPrzepisaniu(new URL(sciezka, "https://api.midrev.test").pathname);
  expect(cel).toBe("/api/events");
  const odp = await POST(zadanie(cialo, naglowki, cel));
  const tekst = await odp.text();
  return { status: odp.status, cialo: tekst ? JSON.parse(tekst) : null, naglowki: odp.headers };
}

async function przetworzWszystko(tenantId: string) {
  const { rows } = await getPool().query(
    "select id from raw_events where tenant_id = $1 and channel = 'api' and processed_at is null order by received_at",
    [tenantId],
  );
  const wyniki = [];
  for (const r of rows) wyniki.push(await przetworzZdarzenieApi(tenantId, r.id));
  return wyniki;
}

async function zdarzeniaTenanta(tenantId: string) {
  const { rows } = await getPool().query(
    `select m.name, m.integration_key, e.unique_id, e.properties, e.source, e.backfill, e.occurred_at, e.ingested_at,
            e.value_minor::text as value_minor, p.email, p.id as profile_id
       from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
       left join profiles p on p.tenant_id = e.tenant_id and p.id = e.profile_id
      where e.tenant_id = $1 and m.integration_key = 'api' order by e.recorded_at`,
    [tenantId],
  );
  return rows;
}

function cialoZdarzenia(o: { nazwa?: string; email?: string; uniqueId?: string; time?: string; profil?: Record<string, unknown>; properties?: Record<string, unknown>; extra?: Record<string, unknown> }) {
  return JSON.stringify({
    data: {
      type: "event",
      attributes: {
        properties: o.properties ?? { zrodlo: "test" },
        ...(o.time ? { time: o.time } : {}),
        ...(o.uniqueId ? { unique_id: o.uniqueId } : {}),
        ...(o.extra ?? {}),
        metric: { data: { type: "metric", attributes: { name: o.nazwa ?? "Test API" } } },
        profile: { data: { type: "profile", attributes: o.profil ?? { email: o.email ?? `x-${znak}@example.test` } } },
      },
    },
  });
}

describe("API zdarzeń zgodne z Klaviyo (E2)", () => {
  let tenantA = "";
  let tenantB = "";
  let kluczA = "";
  let kluczB = "";
  let kluczBezZakresu = "";

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantA = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"])).rows[0].id;
    tenantB = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "B"])).rows[0].id;
    kluczA = (await utworzKlucz(tenantA, { nazwa: "n8n quiz", zakresy: ["events:write", "profiles:read", "profiles:write"], aktorId: null })).jawny;
    kluczB = (await utworzKlucz(tenantB, { nazwa: "n8n B", zakresy: ["events:write"], aktorId: null })).jawny;
    kluczBezZakresu = (await utworzKlucz(tenantA, { nazwa: "tylko odczyt", zakresy: ["profiles:read"], aktorId: null })).jawny;
  });

  beforeEach(() => wyczyscLimity());

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  describe("klucze API (2.1)", () => {
    it("klucz ma format mrv_pk_ + 43 znaki base62, w bazie leży tylko HMAC, UI widzi prefiks", async () => {
      expect(kluczA).toMatch(WZOR_KLUCZA);
      const { rows } = await getPool().query("select t::text as wiersz, secret_hash from api_keys t where tenant_id = $1", [tenantA]);
      for (const r of rows) expect(r.wiersz).not.toContain(kluczA.slice(12));
      expect(rows.some((r) => Buffer.compare(r.secret_hash, hashKluczaApi(kluczA)) === 0)).toBe(true);
      const lista = await kluczeTenanta(tenantA);
      expect(lista.find((k) => k.nazwa === "n8n quiz")!.prefiks).toBe(kluczA.slice(0, 12));
      expect(JSON.stringify(lista)).not.toContain(kluczA.slice(12));
      // dwa klucze nigdy nie są takie same
      expect(wygenerujKluczApi().jawny).not.toBe(wygenerujKluczApi().jawny);
    });

    it("nagłówek: Klaviyo-API-Key i Bearer; zły schemat, klucz Klaviyo pk_ i śmieci = brak klucza", () => {
      expect(kluczZNaglowka(`Klaviyo-API-Key ${kluczA}`)).toBe(kluczA);
      expect(kluczZNaglowka(`Bearer ${kluczA}`)).toBe(kluczA);
      expect(kluczZNaglowka(`Basic ${kluczA}`)).toBeNull();
      expect(kluczZNaglowka("Klaviyo-API-Key pk_VhL6pH_7e533e989a7bd49445f2a07de1c65d65d7")).toBeNull();
      expect(kluczZNaglowka(null)).toBeNull();
    });

    it("unieważniony klucz = 401, a last_used_at odświeża się najwyżej raz na minutę", async () => {
      const k = await utworzKlucz(tenantA, { nazwa: "do unieważnienia", zakresy: ["events:write"], aktorId: null });
      const a = await uwierzytelnij(`Klaviyo-API-Key ${k.jawny}`);
      expect(a).toMatchObject({ ok: true, tenantId: tenantA });
      const { rows: r1 } = await getPool().query("select last_used_at from api_keys where id = $1", [k.id]);
      await uwierzytelnij(`Klaviyo-API-Key ${k.jawny}`);
      const { rows: r2 } = await getPool().query("select last_used_at from api_keys where id = $1", [k.id]);
      expect(r2[0].last_used_at.getTime()).toBe(r1[0].last_used_at.getTime());
      // cudzy tenant nie unieważni klucza A
      expect(await uniewaznijKlucz(tenantB, k.id, null)).toBe(false);
      expect(await uniewaznijKlucz(tenantA, k.id, null)).toBe(true);
      expect(await uwierzytelnij(`Klaviyo-API-Key ${k.jawny}`)).toEqual({ ok: false, powod: "uniewazniony" });
      const odp = await wyslij(cialoZdarzenia({}), k.jawny);
      expect(odp.status).toBe(401);
      expect(odp.cialo.errors[0]).toMatchObject({ status: 401, code: "authentication_failed" });
    });
  });

  describe("warstwa zgodności (2.2)", () => {
    it("401 bez klucza, 403 bez zakresu events:write, 400 bez revision, 415 zły typ treści — w formacie JSON:API", async () => {
      const bez = await wyslij(cialoZdarzenia({}), null);
      expect(bez.status).toBe(401);
      expect(bez.cialo.errors[0]).toMatchObject({ status: 401, code: "not_authenticated" });
      expect(typeof bez.cialo.errors[0].id).toBe("string");

      const zakres = await wyslij(cialoZdarzenia({}), kluczBezZakresu);
      expect(zakres.status).toBe(403);
      expect(zakres.cialo.errors[0].code).toBe("permission_denied");

      const naglowki = { ...NAGLOWKI_N8N, Authorization: `Klaviyo-API-Key ${kluczA}` };
      delete (naglowki as Record<string, string>).revision;
      const bezRewizji = await POST(zadanie(cialoZdarzenia({}), naglowki, "/api/events"));
      expect(bezRewizji.status).toBe(400);
      expect((await bezRewizji.json()).errors[0]).toMatchObject({ code: "invalid", source: { header: "revision" } });

      const typ = await wyslij(cialoZdarzenia({}), kluczA, { "Content-Type": "text/plain" });
      expect(typ.status).toBe(415);

      const vnd = await wyslij(cialoZdarzenia({ uniqueId: `vnd-${znak}` }), kluczA, { "Content-Type": "application/vnd.api+json" });
      expect(vnd.status).toBe(202);

      const get = await GET();
      expect(get.status).toBe(405);
    });

    it("400 z source.pointer (n8n czyta errors[0].code i source.pointer); zły JSON; brak identyfikatora profilu", async () => {
      const zlyJson = await wyslij("{nie json", kluczA);
      expect(zlyJson.status).toBe(400);
      expect(zlyJson.cialo.errors[0].code).toBe("invalid");

      const bezNazwy = await wyslij(cialoZdarzenia({ nazwa: "" }), kluczA);
      expect(bezNazwy.status).toBe(400);
      expect(bezNazwy.cialo.errors[0].source.pointer).toBe("/data/attributes/metric/data/attributes/name");

      const bezProfilu = await wyslij(cialoZdarzenia({ profil: { first_name: "Ala" } }), kluczA);
      expect(bezProfilu.status).toBe(400);
      expect(bezProfilu.cialo.errors[0].source.pointer).toBe("/data/attributes/profile/data/attributes");

      const zlyEmail = await wyslij(cialoZdarzenia({ email: "nie-mail" }), kluczA);
      expect(zlyEmail.cialo.errors[0].source.pointer).toBe("/data/attributes/profile/data/attributes/email");

      const zlyCzas = await wyslij(cialoZdarzenia({ time: "1989-01-01T00:00:00Z" }), kluczA);
      expect(zlyCzas.status).toBe(400);
      expect(zlyCzas.cialo.errors[0].source.pointer).toBe("/data/attributes/time");

      const bezProperties = JSON.parse(cialoZdarzenia({}));
      delete bezProperties.data.attributes.properties;
      const odp = await wyslij(JSON.stringify(bezProperties), kluczA);
      expect(odp.status).toBe(400);
      expect(odp.cialo.errors[0].source.pointer).toBe("/data/attributes/properties");

      const duzo = await wyslij(cialoZdarzenia({ properties: Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`k${i}`, i])) }), kluczA);
      expect(duzo.status).toBe(400);

      // żadne z odrzuconych nie trafiło do kolejki
      const { rows } = await getPool().query("select count(*)::int as n from raw_events where tenant_id = $1 and payload::text like '%nie-mail%'", [tenantA]);
      expect(rows[0].n).toBe(0);
    });

    it("413 dla ciała > 5 MB", async () => {
      const wielkie = cialoZdarzenia({ properties: { a: "x".repeat(5 * 1024 * 1024) } });
      const odp = await wyslij(wielkie, kluczA);
      expect(odp.status).toBe(413);
    });

    it("429 z Retry-After po wyczerpaniu kubełka (350/s), inny klucz nie jest dotknięty", async () => {
      const a = await uwierzytelnij(`Klaviyo-API-Key ${kluczA}`);
      if (!a.ok) throw new Error("klucz A");
      // kubełek opróżniony „z przyszłości”: zegar kubełka nie cofa się, więc do chwili żądania
      // nie przybędzie ani jeden token (test nie zależy od szybkości maszyny)
      const za = Date.now() + 5_000;
      for (let i = 0; i < LIMIT_ZDARZEN.naSekunde; i++) expect(sprawdzLimit("events", a.kluczId, LIMIT_ZDARZEN, za).ok).toBe(true);
      expect(sprawdzLimit("events", a.kluczId, LIMIT_ZDARZEN, za).ok).toBe(false);
      const odp = await wyslij(cialoZdarzenia({}), kluczA);
      expect(odp.status).toBe(429);
      expect(odp.cialo.errors[0].code).toBe("throttled");
      expect(Number(odp.naglowki.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect((await wyslij(cialoZdarzenia({ uniqueId: `b-${znak}` }), kluczB)).status).toBe(202);
    });

    it("token bucket: minutowy sufit 3500 i odnawianie w czasie", () => {
      const t0 = 1_000_000;
      let przyjete = 0;
      for (let s = 0; s < 20; s++) {
        for (let i = 0; i < 400; i++) if (sprawdzLimit("events", "k-min", LIMIT_ZDARZEN, t0 + s * 1000).ok) przyjete++;
      }
      // w 20 s: kubełek minutowy (3500 + odnowienie ~20/60*3500) ogranicza, nie sekundowy
      expect(przyjete).toBeLessThanOrEqual(3500 + Math.ceil((19 / 60) * 3500) + 1);
      expect(przyjete).toBeGreaterThan(3500);
      const w = sprawdzLimit("events", "k-min", LIMIT_ZDARZEN, t0 + 19_000);
      expect(w.ok).toBe(false);
    });

    it("dzienny sufit tenanta: po przekroczeniu 429 do północy UTC", async () => {
      // dzień bez żadnych żądań w bazie: licznik startuje od 0
      const teraz = Date.UTC(2030, 0, 1, 22, 0, 0);
      expect((await sprawdzSufitDobowy(tenantB, 1, teraz)).ok).toBe(true);
      zaliczDoSufitu(tenantB, teraz);
      const w = await sprawdzSufitDobowy(tenantB, 1, teraz);
      expect(w).toEqual({ ok: false, poSekundach: 7200 });
    });
  });

  describe("POST /api/events (2.3) i kontrakt n8n", () => {
    it.each([
      ["quiz-v6-zdarzenie-ukonczony.json", "Quiz Ukończony", "anna.testowa@example.test"],
      ["quiz-v6-zdarzenie-zapisana.json", "Quiz Karta Zapisana", "anna.testowa@example.test"],
      ["quiz-lead-v3-zdarzenie.json", "Subscribed Via Quiz", "bartek.probny@example.test"],
      ["quiz-lead-v3-zdarzenie-bez-run.json", "Subscribed Via Quiz", "celina.krotka@example.test"],
    ])("%s: 202 bez treści, zdarzenie w strumieniu z właściwościami 1:1, retry = jedno zdarzenie", async (plik, metryka, email) => {
      const cialo = fixture(plik);
      const pierwsze = await wyslij(cialo, kluczA);
      expect(pierwsze.status).toBe(202);
      expect(pierwsze.cialo).toBeNull();
      // n8n ponawia to samo żądanie (neverError + retry frontu): 202, ale bez drugiego zdarzenia
      const drugie = await wyslij(cialo, kluczA);
      expect(drugie.status).toBe(202);
      await przetworzWszystko(tenantA);
      const oczekiwane = JSON.parse(cialo).data.attributes;
      const { rows } = await getPool().query(
        `select e.properties, e.unique_id, e.source, e.backfill, p.email
           from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
           join profiles p on p.tenant_id = e.tenant_id and p.id = e.profile_id
          where e.tenant_id = $1 and m.integration_key = 'api' and m.name = $2 and e.unique_id = $3`,
        [tenantA, metryka, oczekiwane.unique_id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ properties: oczekiwane.properties, source: "api", backfill: false });
      expect(rows[0].email.toLowerCase()).toBe(email);
    });

    it("surowe żądanie i job powstają razem PRZED 202 (brak utraty przy padniętym workerze)", async () => {
      const u = `przed-202-${znak}`;
      const odp = await wyslij(cialoZdarzenia({ uniqueId: u }), kluczA);
      expect(odp.status).toBe(202);
      const { rows } = await getPool().query(
        `select r.id, r.channel, r.source, r.store_id, r.payload -> 'meta' ->> 'revision' as revision,
                (select count(*)::int from jobs j where j.tenant_id = r.tenant_id and j.kind = $2 and j.payload ->> 'rawEventId' = r.id::text) as joby
           from raw_events r where r.tenant_id = $1 and r.payload::text like $3`,
        [tenantA, RODZAJ_JOBA, `%${u}%`],
      );
      expect(rows).toEqual([expect.objectContaining({ channel: "api", source: "api", store_id: null, revision: "2025-01-15", joby: 1 })]);
      // klucz nie trafia do surowego zapisu
      const { rows: kl } = await getPool().query("select count(*)::int as n from raw_events where payload::text like $1", [`%${kluczA.slice(12)}%`]);
      expect(kl[0].n).toBe(0);
      // worker idempotentny: drugie przetworzenie tego samego wiersza nic nie robi
      expect((await przetworzZdarzenieApi(tenantA, rows[0].id)).status).toBe("zapisane");
      expect((await przetworzZdarzenieApi(tenantA, rows[0].id)).status).toBe("pominiete");
    });

    it("AD-38 przez API: ten sam unique_id z INNYM time = jedno żądanie w kolejce i jedno zdarzenie (czas pierwszego)", async () => {
      const u = `retry-${znak}`;
      expect((await wyslij(cialoZdarzenia({ uniqueId: u, time: "2026-09-30T08:00:00Z", nazwa: "Retry API" }), kluczA)).status).toBe(202);
      expect((await wyslij(cialoZdarzenia({ uniqueId: u, time: "2026-09-30T08:00:09Z", nazwa: "Retry API" }), kluczA)).status).toBe(202);
      // wczesne sito: klucz idempotencji surowego żądania nie zawiera czasu (wiążący dedup
      // w event_keys sprawdza tests/zdarzenia-strumien.test.ts)
      const { rows: surowe } = await getPool().query("select count(*)::int as n from raw_events where tenant_id = $1 and payload::text like $2", [tenantA, `%${u}%`]);
      expect(surowe[0].n).toBe(1);
      const w = await przetworzWszystko(tenantA);
      expect(w.map((x) => x.status)).toEqual(["zapisane"]);
      const { rows } = await getPool().query(
        "select occurred_at from metric_events where tenant_id = $1 and unique_id = $2",
        [tenantA, u],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].occurred_at.toISOString()).toBe("2026-09-30T08:00:00.000Z");
    });

    it("czas: bez `time` = chwila przyjęcia; ISO bez strefy = UTC; backfill przy > 4 h i przy fladze", async () => {
      expect(czasZTekstu("2026-09-30T10:00:00")!.toISOString()).toBe("2026-09-30T10:00:00.000Z");
      expect(czasZTekstu("2026-09-30T12:00:00+02:00")!.toISOString()).toBe("2026-09-30T10:00:00.000Z");
      expect(czasZTekstu("wczoraj")).toBeNull();
      const stare = new Date(Date.now() - 5 * 3600_000).toISOString();
      await wyslij(cialoZdarzenia({ uniqueId: `bf-stare-${znak}`, time: stare }), kluczA);
      await wyslij(cialoZdarzenia({ uniqueId: `bf-flaga-${znak}`, extra: { backfill: true } }), kluczA);
      await wyslij(cialoZdarzenia({ uniqueId: `bf-swieze-${znak}` }), kluczA);
      await przetworzWszystko(tenantA);
      const { rows } = await getPool().query(
        "select unique_id, backfill, ingested_at, occurred_at from metric_events where tenant_id = $1 and unique_id like 'bf-%' order by unique_id",
        [tenantA],
      );
      const po = Object.fromEntries(rows.map((r) => [r.unique_id.replace(`-${znak}`, ""), r]));
      expect(po["bf-stare"].backfill).toBe(true);
      expect(po["bf-flaga"].backfill).toBe(true);
      expect(po["bf-swieze"].backfill).toBe(false);
      // bez time: czas zdarzenia = przyjęcie żądania (ucięte do sekundy), nie przetworzenie
      expect(Math.abs(po["bf-swieze"].ingested_at.getTime() - po["bf-swieze"].occurred_at.getTime())).toBeLessThan(1000);
    });

    it("value i $value → value_minor w walucie tenanta albo value_currency", async () => {
      await wyslij(cialoZdarzenia({ uniqueId: `v1-${znak}`, nazwa: "Zakup API", extra: { value: 199.99 } }), kluczA);
      await wyslij(cialoZdarzenia({ uniqueId: `v2-${znak}`, nazwa: "Zakup API", properties: { $value: "49.5" }, extra: { value_currency: "eur" } }), kluczA);
      await przetworzWszystko(tenantA);
      const { rows } = await getPool().query(
        "select unique_id, value_minor::int as v, value_currency, properties ->> '$value' as pv from metric_events where tenant_id = $1 and unique_id in ($2, $3) order by unique_id",
        [tenantA, `v1-${znak}`, `v2-${znak}`],
      );
      expect(rows).toEqual([
        { unique_id: `v1-${znak}`, v: 19999, value_currency: "PLN", pv: "199.99" },
        { unique_id: `v2-${znak}`, v: 4950, value_currency: "EUR", pv: "49.5" },
      ]);
    });
  });

  describe("identyfikacja profilu (2.4) i izolacja tenantów (AD-40)", () => {
    it("klucz tenanta A pisze wyłącznie do A: id profilu z B nie trafia w B", async () => {
      const pool = getPool();
      const profilB = (await pool.query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantB, `b-${znak}@example.test`])).rows[0].id;
      const odp = await wyslij(cialoZdarzenia({ uniqueId: `iso-${znak}`, profil: { email: `b-${znak}@example.test` }, nazwa: "Izolacja" }), kluczA);
      expect(odp.status).toBe(202);
      const cudzeId = JSON.parse(cialoZdarzenia({ uniqueId: `iso2-${znak}`, nazwa: "Izolacja" }));
      cudzeId.data.attributes.profile.data.id = profilB;
      delete cudzeId.data.attributes.profile.data.attributes;
      expect((await wyslij(JSON.stringify(cudzeId), kluczA)).status).toBe(202);
      const wyniki = await przetworzWszystko(tenantA);
      expect(wyniki.filter((w) => w.status === "odrzucone").map((w) => w.powod)).toEqual(["nie_znaleziono"]);
      const { rows: wB } = await pool.query("select count(*)::int as n from metric_events where tenant_id = $1 and profile_id = $2", [tenantB, profilB]);
      expect(wB[0].n).toBe(0);
      const { rows: profileA } = await pool.query("select id from profiles where tenant_id = $1 and email = $2", [tenantA, `b-${znak}@example.test`]);
      expect(profileA).toHaveLength(1);
      expect(profileA[0].id).not.toBe(profilB);
      // zdarzenie z samym cudzym id: w A takiego profilu nie ma (AD-40) = odrzucone, bez pustego profilu
      const { rows: iso2 } = await pool.query("select profile_id from metric_events where tenant_id = $1 and unique_id = $2", [tenantA, `iso2-${znak}`]);
      expect(iso2).toHaveLength(0);
    });

    it("kolejność: email przed external_id; konflikt = zdarzenie do profilu z e-maila, cudzy external_id nienaruszony", async () => {
      const pool = getPool();
      const pEmail = (await pool.query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantA, `kon-${znak}@example.test`])).rows[0].id;
      const pExt = (await pool.query("insert into profiles (tenant_id, external_id) values ($1, $2) returning id", [tenantA, `ext-${znak}`])).rows[0].id;
      await wyslij(cialoZdarzenia({ uniqueId: `kon-${znak}`, profil: { email: `kon-${znak}@example.test`, external_id: `ext-${znak}`, first_name: "Kasia", properties: { plan: "longevity" } } }), kluczA);
      await przetworzWszystko(tenantA);
      const { rows } = await pool.query("select profile_id from metric_events where tenant_id = $1 and unique_id = $2", [tenantA, `kon-${znak}`]);
      expect(rows[0].profile_id).toBe(pEmail);
      const { rows: p } = await pool.query("select id, external_id, first_name, properties from profiles where tenant_id = $1 and id in ($2, $3) order by (id = $2) desc", [tenantA, pEmail, pExt]);
      expect(p[0]).toMatchObject({ id: pEmail, external_id: null, first_name: "Kasia", properties: { plan: "longevity" } });
      expect(p[1]).toMatchObject({ id: pExt, external_id: `ext-${znak}` });
      const { rows: raw } = await pool.query("select payload -> 'meta' -> 'konflikty' as k from raw_events where tenant_id = $1 and payload::text like $2", [tenantA, `%kon-${znak}-sub%`]);
      expect(raw.length).toBeLessThanOrEqual(1);
    });

    it("telefon E.164 dopasowuje istniejący profil zapisany w innym formacie; properties scalane, '' zapisuje pusty napis", async () => {
      const pool = getPool();
      const p = (await pool.query("insert into profiles (tenant_id, email, phone, properties) values ($1, null, '600 700 800', '{\"a\":\"1\",\"b\":\"2\"}') returning id", [tenantA])).rows[0].id;
      await wyslij(cialoZdarzenia({ uniqueId: `tel-${znak}`, profil: { phone_number: "+48600700800", properties: { a: "", c: "3" } } }), kluczA);
      await przetworzWszystko(tenantA);
      const { rows } = await pool.query("select profile_id from metric_events where tenant_id = $1 and unique_id = $2", [tenantA, `tel-${znak}`]);
      expect(rows[0].profile_id).toBe(p);
      const { rows: pr } = await pool.query("select properties from profiles where id = $1", [p]);
      expect(pr[0].properties).toEqual({ a: "", b: "2", c: "3" });
    });

    it("nowy profil z anonymous_id; nagrobek RODO: zdarzenie odrzucone, ciało zaślepione, profil nie wraca", async () => {
      const pool = getPool();
      await wyslij(cialoZdarzenia({ uniqueId: `anon-${znak}`, profil: { anonymous_id: `anon-${znak}` } }), kluczA);
      const email = `rodo-api-${znak}@example.test`;
      await wyslij(cialoZdarzenia({ uniqueId: `przed-${znak}`, email }), kluczA);
      await przetworzWszystko(tenantA);
      const { rows: anon } = await pool.query("select id, email from profiles where tenant_id = $1 and anonymous_id = $2", [tenantA, `anon-${znak}`]);
      expect(anon).toHaveLength(1);
      const { rows: osoba } = await pool.query("select id from profiles where tenant_id = $1 and email = $2", [tenantA, email]);
      const wynik = await anonimizujProfil(tenantA, osoba[0].id, { aktor: "test", powod: null });
      expect(wynik).toMatchObject({ danePozostaly: false });
      expect(wynik!.suroweApi).toBeGreaterThanOrEqual(1);
      await wyslij(cialoZdarzenia({ uniqueId: `po-${znak}`, email }), kluczA);
      const w = await przetworzWszystko(tenantA);
      expect(w).toEqual([{ status: "odrzucone", powod: "rodo" }]);
      const { rows } = await pool.query("select count(*)::int as n from profiles where tenant_id = $1 and lower(email) = $2", [tenantA, email]);
      expect(rows[0].n).toBe(0);
      const { rows: surowe } = await pool.query("select count(*)::int as n from raw_events where tenant_id = $1 and payload::text ilike $2", [tenantA, `%${email}%`]);
      expect(surowe[0].n).toBe(0);
    });
  });

  it("zaległe żądanie API bez żywego joba dostaje nowy job; po 3 ponowieniach = porzucone (alert)", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `insert into raw_events (tenant_id, source, idempotency_key, payload, received_at, channel)
       values ($1, 'api', $2, '{"body":{}}', now() - interval '1 hour', 'api') returning id`,
      [tenantB, `api:zalegle:${znak}`],
    );
    const w1 = await ponowZalegleZdarzeniaApi();
    expect(w1.ponowione).toBeGreaterThanOrEqual(1);
    const { rows: joby } = await pool.query("select count(*)::int as n from jobs where tenant_id = $1 and kind = $2 and payload ->> 'rawEventId' = $3", [tenantB, RODZAJ_JOBA, rows[0].id]);
    expect(joby[0].n).toBe(1);
    // job żyje (pending) = drugi przebieg go nie dubluje
    await ponowZalegleZdarzeniaApi();
    const { rows: joby2 } = await pool.query("select count(*)::int as n from jobs where tenant_id = $1 and kind = $2 and payload ->> 'rawEventId' = $3", [tenantB, RODZAJ_JOBA, rows[0].id]);
    expect(joby2[0].n).toBe(1);
    await pool.query("update jobs set status = 'failed' where tenant_id = $1 and kind = $2", [tenantB, RODZAJ_JOBA]);
    await pool.query("update raw_events set process_error = 'ponowiono:3' where id = $1", [rows[0].id]);
    const w3 = await ponowZalegleZdarzeniaApi();
    expect(w3.porzucone).toBeGreaterThanOrEqual(1);
    const { rows: stan } = await pool.query("select process_error from raw_events where id = $1", [rows[0].id]);
    expect(stan[0].process_error).toMatch(/^porzucone:/);
    // wiersz z pustym ciałem przy przetworzeniu = odrzucony deterministycznie (nie krąży)
    await pool.query("update raw_events set process_error = null where id = $1", [rows[0].id]);
    expect((await przetworzZdarzenieApi(tenantB, rows[0].id)).status).toBe("odrzucone");
  });

  it("zdarzenia widać w strumieniu tenanta A (sanity dla osi profilu)", async () => {
    const z = await zdarzeniaTenanta(tenantA);
    expect(z.length).toBeGreaterThan(5);
    expect(z.every((r) => r.integration_key === "api")).toBe(true);
  });
});

describe("RODO a API bez e-maila (review Codeksa R1)", () => {
  const PRE = "APIR ";
  let t = "";
  let klucz = "";
  beforeAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PRE + "%"]);
    t = (await getPool().query("insert into tenants (name) values ($1) returning id", [PRE + "A"])).rows[0].id;
    klucz = (await utworzKlucz(t, { nazwa: "k", zakresy: ["events:write"], aktorId: null })).jawny;
  });
  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PRE + "%"]);
    await closePool();
  });

  it("osoba tylko z external_id i telefonem: pending żądanie zaślepione, nowe zdarzenie odrzucone nagrobkiem, eksport ma nowe kolumny", async () => {
    const pool = getPool();
    const ext = `crm-${znak}`;
    const profil = { external_id: ext, phone_number: "+48 600 111 222", locale: "pl-PL", location: { city: "Kraków" } };
    await wyslij(cialoZdarzenia({ uniqueId: `r1-${znak}`, profil }), klucz);
    await przetworzWszystko(t);
    const { rows } = await pool.query("select id from profiles where tenant_id = $1 and external_id = $2", [t, ext]);
    const p = rows[0].id;
    const eksport = await eksportujProfil(t, p);
    expect(eksport!.profil).toMatchObject({ external_id: ext, locale: "pl-PL", location: { city: "Kraków" } });
    // drugie żądanie czeka w kolejce (worker jeszcze go nie wziął), tylko z external_id
    await wyslij(cialoZdarzenia({ uniqueId: `r2-${znak}`, profil: { external_id: ext } }), klucz);
    const wynik = await anonimizujProfil(t, p, { aktor: "test", powod: null });
    expect(wynik).toMatchObject({ danePozostaly: false });
    expect(wynik!.suroweApi).toBe(2);
    const { rows: surowe } = await pool.query("select count(*)::int as n from raw_events where tenant_id = $1 and payload::text like $2", [t, `%${ext}%`]);
    expect(surowe[0].n).toBe(0);
    // zaślepione żądanie nie odtwarza osoby, a nowe z tym samym external_id / telefonem jest odrzucane
    await wyslij(cialoZdarzenia({ uniqueId: `r3-${znak}`, profil: { external_id: ext } }), klucz);
    await wyslij(cialoZdarzenia({ uniqueId: `r4-${znak}`, profil: { phone_number: "600111222" } }), klucz);
    const w = await przetworzWszystko(t);
    expect(w).toEqual([{ status: "odrzucone", powod: "rodo" }, { status: "odrzucone", powod: "rodo" }]);
    const { rows: odtworzone } = await pool.query("select count(*)::int as n from profiles where tenant_id = $1 and (external_id = $2 or phone is not null)", [t, ext]);
    expect(odtworzone[0].n).toBe(0);
  });
});

describe("poprawki po review Codeksa R2a/R2b", () => {
  const PRE = "APIQ ";
  let t = "";
  let klucz = "";
  beforeAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PRE + "%"]);
    t = (await getPool().query("insert into tenants (name) values ($1) returning id", [PRE + "A"])).rows[0].id;
    klucz = (await utworzKlucz(t, { nazwa: "k", zakresy: ["events:write"], aktorId: null })).jawny;
  });
  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PRE + "%"]);
    await closePool();
  });

  it("brak Content-Type = 415; odrzucone żądania nie zjadają dziennego sufitu", async () => {
    wyczyscLimity();
    const naglowki = { revision: "2025-01-15", Authorization: `Klaviyo-API-Key ${klucz}` };
    const odp = await POST(zadanie(cialoZdarzenia({}), naglowki, "/api/events"));
    expect(odp.status).toBe(415);
    for (let i = 0; i < 3; i++) expect((await wyslij(cialoZdarzenia({ nazwa: "" }), klucz)).status).toBe(400);
    const dzis = Date.now();
    // sufit 1: odrzucone 400 nie zostały zaliczone, więc pierwsze poprawne przechodzi
    expect((await sprawdzSufitDobowy(t, 1, dzis)).ok).toBe(true);
  });

  it("równoległe zdarzenia o tę samą NOWĄ osobę z samym telefonem = jeden profil", async () => {
    for (let i = 0; i < 5; i++) {
      await wyslij(cialoZdarzenia({ uniqueId: `rown-${i}-${znak}`, profil: { phone_number: "+48 699 000 111" } }), klucz);
    }
    const { rows } = await getPool().query("select id from raw_events where tenant_id = $1 and processed_at is null", [t]);
    const wyniki = await Promise.all(rows.map((r) => przetworzZdarzenieApi(t, r.id)));
    expect(wyniki.every((w) => w.status === "zapisane")).toBe(true);
    const { rows: p } = await getPool().query("select count(*)::int as n from profiles where tenant_id = $1 and midrev_telefon_e164(phone) = '+48699000111'", [t]);
    expect(p[0].n).toBe(1);
  });

  it("oś profilu: filtr dat liczy dzień w strefie tenanta (Europe/Warsaw)", async () => {
    const { osProfilu } = await import("../src/usecases/zdarzenia/odczyt");
    const { rows } = await getPool().query("select id from profiles where tenant_id = $1 limit 1", [t]);
    const p = rows[0].id;
    const { zapiszZdarzenie } = await import("../src/usecases/zdarzenia/zapisz-zdarzenie");
    const k = await getPool().connect();
    try {
      await k.query("begin");
      // 30.09 23:30 w Warszawie = 30.09 21:30 UTC; 1.10 00:30 w Warszawie = 30.09 22:30 UTC
      await zapiszZdarzenie(k, { tenantId: t, metryka: { integracja: "api", nazwa: "Strefa" }, profileId: p, occurredAt: new Date("2026-09-30T21:30:00Z"), source: "api", uniqueId: "s1" });
      await zapiszZdarzenie(k, { tenantId: t, metryka: { integracja: "api", nazwa: "Strefa" }, profileId: p, occurredAt: new Date("2026-09-30T22:30:00Z"), source: "api", uniqueId: "s2" });
      await k.query("commit");
    } finally {
      k.release();
    }
    const dzien30 = await osProfilu(t, p, { odDnia: "2026-09-30", doDnia: "2026-09-30" });
    const strefa = (w: { nazwa: string }) => w.nazwa === "Strefa";
    expect(dzien30.wpisy.filter(strefa).map((w) => w.occurredAt.toISOString())).toEqual(["2026-09-30T21:30:00.000Z"]);
    const dzien1 = await osProfilu(t, p, { odDnia: "2026-10-01", doDnia: "2026-10-01" });
    expect(dzien1.wpisy.filter(strefa).map((w) => w.occurredAt.toISOString())).toEqual(["2026-09-30T22:30:00.000Z"]);
  });
});
