import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { czyBackfill, czyMozeWyzwolic, METRYKI_WBUDOWANE, type WejscieZdarzenia } from "../src/domain/zdarzenia/kontrakt";
import { MAKS_METRYK_NA_TENANTA, naMinor } from "../src/domain/zdarzenia/limity";
import { telefonE164 } from "../src/domain/zdarzenia/telefon";
import { upsertZamowienie } from "../src/usecases/przetworz-zdarzenie";
import { przyjmijZgloszenie } from "../src/usecases/popupy/zglos-popup";
import { utworzPopup, ustawAktywnosc } from "../src/usecases/popupy/zarzadzaj";
import { anonimizujProfil, eksportujProfil } from "../src/usecases/profil-rodo";
import { LimitMetryk, metrykaPoId, metrykaPoKluczu } from "../src/usecases/zdarzenia/metryki";
import { osProfilu, wlasciwosciZdarzenia, zdarzeniaDoSkanu, zdarzeniePoId } from "../src/usecases/zdarzenia/odczyt";
import { utrzymajPartycjeMetryk, wyczyscCachePartycji } from "../src/usecases/zdarzenia/partycje";
import { BladZdarzenia, zapiszZdarzenie } from "../src/usecases/zdarzenia/zapisz-zdarzenie";
import type { ZamowienieSklepu } from "../src/domain/store/contract";

// E1 (plan metryki-i-profil, 7.3): strumien metric_events jako specyfikacja wykonywalna.
// Prawdziwa baza testowa (AD-20), kazdy scenariusz cross-tenant obowiazkowy (AD-2).

const PREFIKS = "ZDA ";
const znak = randomBytes(3).toString("hex");

async function wTransakcji<T>(praca: (k: PoolClient) => Promise<T>): Promise<T> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const w = await praca(klient);
    await klient.query("commit");
    return w;
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}

function zapisz(w: WejscieZdarzenia) {
  return wTransakcji((k) => zapiszZdarzenie(k, w));
}

async function nowyProfil(tenantId: string, email: string): Promise<string> {
  const { rows } = await getPool().query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantId, email]);
  return rows[0].id;
}

async function ileZdarzen(tenantId: string, metricId?: string): Promise<number> {
  const { rows } = await getPool().query(
    "select count(*)::int as n from metric_events where tenant_id = $1 and ($2::uuid is null or metric_id = $2)",
    [tenantId, metricId ?? null],
  );
  return rows[0].n;
}

const QUIZ = { integracja: "api" as const, nazwa: "Quiz Ukończony" };

describe("Strumień zdarzeń metryk (E1)", () => {
  let tenantA = "";
  let tenantB = "";
  let profilA = "";
  let profilB = "";

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantA = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"])).rows[0].id;
    tenantB = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "B"])).rows[0].id;
    profilA = await nowyProfil(tenantA, `a-${znak}@example.test`);
    profilB = await nowyProfil(tenantB, `b-${znak}@example.test`);
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  describe("schemat (0030)", () => {
    it("strumień jest partycjonowany miesięcznie i NIE ma partycji domyślnej (AD-45)", async () => {
      const { rows } = await getPool().query(
        `select p.partstrat, p.partdefid::int as domyslna
           from pg_partitioned_table p where p.partrelid = 'metric_events'::regclass`,
      );
      expect(rows[0].partstrat).toBe("r");
      expect(rows[0].domyslna).toBe(0);
      const { rows: part } = await getPool().query(
        `select count(*)::int as n from pg_inherits where inhparent = 'metric_events'::regclass`,
      );
      // zapas od poprzedniego miesiąca do +12
      expect(part[0].n).toBeGreaterThanOrEqual(14);
    });

    it("zdarzenie z miesiąca bez partycji zakłada ją samo i zapisuje się (1995)", async () => {
      wyczyscCachePartycji();
      const kiedy = new Date(Date.UTC(1995, 2, 14, 10, 0, 0));
      const w = await zapisz({ tenantId: tenantA, metryka: QUIZ, profileId: profilA, occurredAt: kiedy, source: "import", uniqueId: `hist-${znak}` });
      expect(w.duplikat).toBe(false);
      expect(w.backfill).toBe(true);
      const { rows } = await getPool().query("select to_regclass('metric_events_1995_03') is not null as jest");
      expect(rows[0].jest).toBe(true);
      const odczyt = await zdarzeniePoId(getPool(), tenantA, w.id, kiedy);
      expect(odczyt?.occurredAt.toISOString()).toBe(kiedy.toISOString());
    });

    it("utrzymanie partycji (job workera) jest idempotentne i nie zwraca błędu", async () => {
      const w1 = await utrzymajPartycjeMetryk();
      const w2 = await utrzymajPartycjeMetryk();
      expect(w1.blad).toBeNull();
      expect(w2).toEqual({ zalozone: 0, blad: null });
    });

    it("złożone klucze obce: zdarzenie tenanta A nie może wskazać metryki ani profilu tenanta B", async () => {
      const mB = await metrykaPoKluczu(getPool(), tenantB, { integracja: "api", nazwa: `Obca ${znak}` }, { utworz: true });
      await expect(
        getPool().query(
          `insert into metric_events (tenant_id, metric_id, profile_id, occurred_at, ingested_at, unique_id, source)
           values ($1, $2, $3, date_trunc('second', now()), now(), 'x', 'api')`,
          [tenantA, mB!.id, profilA],
        ),
      ).rejects.toThrow(/foreign key/);
      const mA = await metrykaPoKluczu(getPool(), tenantA, { integracja: "api", nazwa: `Moja ${znak}` }, { utworz: true });
      await expect(
        getPool().query(
          `insert into metric_events (tenant_id, metric_id, profile_id, occurred_at, ingested_at, unique_id, source)
           values ($1, $2, $3, date_trunc('second', now()), now(), 'x', 'api')`,
          [tenantA, mA!.id, profilB],
        ),
      ).rejects.toThrow(/foreign key/);
      // odczyt po id w cudzym tenancie = brak (AD-40)
      expect(await metrykaPoId(getPool(), tenantA, mB!.id)).toBeNull();
    });

    it("czas zdarzenia w bazie ma pełne sekundy (CHECK)", async () => {
      const mA = await metrykaPoKluczu(getPool(), tenantA, QUIZ, { utworz: true });
      await expect(
        getPool().query(
          `insert into metric_events (tenant_id, metric_id, occurred_at, ingested_at, unique_id, source)
           values ($1, $2, '2026-09-30 10:00:00.5+00', now(), 'x', 'api')`,
          [tenantA, mA!.id],
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe("zapiszZdarzenie (1.2)", () => {
    it("metryka powstaje w locie, zapis wraca z czasem ze źródła uciętym do sekundy", async () => {
      const kiedy = new Date("2026-09-30T08:15:42.789Z");
      const w = await zapisz({
        tenantId: tenantA,
        metryka: { integracja: "api", nazwa: `Lead ${znak}` },
        profileId: profilA,
        occurredAt: kiedy,
        ingestedAt: new Date("2026-09-30T08:16:00Z"),
        properties: { zrodlo: "n8n" },
        source: "api",
        uniqueId: "u1",
      });
      expect(w.occurredAt.toISOString()).toBe("2026-09-30T08:15:42.000Z");
      const z = await zdarzeniePoId(getPool(), tenantA, w.id, w.occurredAt);
      expect(z).toMatchObject({ profileId: profilA, uniqueId: "u1", source: "api", backfill: false, properties: { zrodlo: "n8n" } });
      const m = await metrykaPoId(getPool(), tenantA, w.metricId);
      expect(m).toMatchObject({ integracja: "api", mozeWyzwalac: true, ukryta: false, wbudowana: false });
      expect(m!.ostatnieZdarzenie?.toISOString()).toBe("2026-09-30T08:15:42.000Z");
    });

    it("AD-38: ten sam unique_id z INNYM czasem (retry n8n) = jedno zdarzenie, cichy sukces", async () => {
      const nazwa = { integracja: "api" as const, nazwa: `Retry ${znak}` };
      const a = await zapisz({ tenantId: tenantA, metryka: nazwa, profileId: profilA, occurredAt: new Date("2026-09-30T10:00:00Z"), source: "api", uniqueId: "nonce-1" });
      const b = await zapisz({ tenantId: tenantA, metryka: nazwa, profileId: profilA, occurredAt: new Date("2026-09-30T10:00:07Z"), source: "api", uniqueId: "nonce-1" });
      expect(b.duplikat).toBe(true);
      expect(b.id).toBe(a.id);
      expect(b.occurredAt.toISOString()).toBe(a.occurredAt.toISOString());
      expect(await ileZdarzen(tenantA, a.metricId)).toBe(1);
      // inny profil z tym samym unique_id to INNE zdarzenie (klucz per profil, jak Klaviyo)
      const profil2 = await nowyProfil(tenantA, `a2-${znak}@example.test`);
      const c = await zapisz({ tenantId: tenantA, metryka: nazwa, profileId: profil2, occurredAt: new Date("2026-09-30T10:00:07Z"), source: "api", uniqueId: "nonce-1" });
      expect(c.duplikat).toBe(false);
      expect(await ileZdarzen(tenantA, a.metricId)).toBe(2);
    });

    it("AD-38 bez unique_id: ta sama sekunda = 1, inna sekunda = 2", async () => {
      const nazwa = { integracja: "api" as const, nazwa: `Bez id ${znak}` };
      const a = await zapisz({ tenantId: tenantA, metryka: nazwa, profileId: profilA, occurredAt: new Date("2026-09-30T11:00:00.100Z"), source: "api" });
      const b = await zapisz({ tenantId: tenantA, metryka: nazwa, profileId: profilA, occurredAt: new Date("2026-09-30T11:00:00.900Z"), source: "api" });
      const c = await zapisz({ tenantId: tenantA, metryka: nazwa, profileId: profilA, occurredAt: new Date("2026-09-30T11:00:01Z"), source: "api" });
      expect(b.duplikat).toBe(true);
      expect(c.duplikat).toBe(false);
      expect(await ileZdarzen(tenantA, a.metricId)).toBe(2);
    });

    it("20 równoległych zapisów z tym samym kluczem = dokładnie 1 zdarzenie", async () => {
      const nazwa = { integracja: "api" as const, nazwa: `Rownolegle ${znak}` };
      const wyniki = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          zapisz({ tenantId: tenantA, metryka: nazwa, profileId: profilA, occurredAt: new Date(Date.UTC(2026, 8, 30, 12, 0, i)), source: "api", uniqueId: "rownolegly" }),
        ),
      );
      expect(wyniki.filter((w) => !w.duplikat)).toHaveLength(1);
      expect(new Set(wyniki.map((w) => w.id)).size).toBe(1);
      expect(await ileZdarzen(tenantA, wyniki[0].metricId)).toBe(1);
    });

    it("limity: 401 właściwości, napis > 100 KB, nazwa 128 znaków, czas przed 1990 i > rok w przód", async () => {
      const baza = { tenantId: tenantA, profileId: profilA, occurredAt: new Date(), source: "api" as const, metryka: QUIZ };
      const duzo = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`k${i}`, i]));
      await expect(zapisz({ ...baza, properties: duzo })).rejects.toBeInstanceOf(BladZdarzenia);
      await expect(zapisz({ ...baza, properties: { a: { b: "x".repeat(100 * 1024 + 1) } } })).rejects.toThrow(/100 KB/);
      await expect(zapisz({ ...baza, metryka: { integracja: "api", nazwa: "x".repeat(128) } })).rejects.toThrow(/127/);
      await expect(zapisz({ ...baza, occurredAt: new Date("1989-12-31T23:59:59Z") })).rejects.toThrow(/1990/);
      const zaRok = new Date();
      zaRok.setUTCFullYear(zaRok.getUTCFullYear() + 1);
      zaRok.setUTCDate(zaRok.getUTCDate() + 2);
      await expect(zapisz({ ...baza, occurredAt: zaRok })).rejects.toThrow(/rok w przód/);
      // 400 właściwości przechodzi
      const ok = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, i]));
      await expect(zapisz({ ...baza, properties: ok, uniqueId: `limit-ok-${znak}` })).resolves.toMatchObject({ duplikat: false });
    });

    it("limit 200 metryk na tenanta: 201. metryka odrzucona, istniejące dalej przyjmują zdarzenia", async () => {
      const pool = getPool();
      const t = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "limit"])).rows[0].id;
      await pool.query(
        `insert into metrics (tenant_id, name, integration_key, integration_category)
         select $1, 'M' || i, 'api', 'API' from generate_series(1, $2::int) i`,
        [t, MAKS_METRYK_NA_TENANTA],
      );
      await expect(zapisz({ tenantId: t, metryka: { integracja: "api", nazwa: "Nowa" }, profileId: null, occurredAt: new Date(), source: "api" })).rejects.toBeInstanceOf(LimitMetryk);
      await expect(zapisz({ tenantId: t, metryka: { integracja: "api", nazwa: "M7" }, profileId: null, occurredAt: new Date(), source: "api" })).resolves.toMatchObject({ duplikat: false });
    });

    it("$value → value_minor wg wykładnika waluty, bez błędu zmiennoprzecinkowego", async () => {
      expect(naMinor(199.99, "PLN")).toBe(19999n);
      expect(naMinor("0.1", "PLN")).toBe(10n);
      expect(naMinor(0.1 + 0.2, "PLN")).toBe(30n);
      expect(naMinor(1500, "JPY")).toBe(1500n);
      expect(naMinor("1.2345", "KWD")).toBe(1235n);
      expect(naMinor("abc", "PLN")).toBeNull();
      const w = await zapisz({ tenantId: tenantA, metryka: { integracja: "api", nazwa: `Zakup ${znak}` }, profileId: profilA, occurredAt: new Date(), source: "api", properties: { $value: 199.99 } });
      const z = await zdarzeniePoId(getPool(), tenantA, w.id, w.occurredAt);
      expect(z).toMatchObject({ valueMinor: "19999", valueCurrency: "PLN" });
      // oryginał zostaje w properties
      expect(z!.properties.$value).toBe(199.99);
    });
  });

  describe("reguła backfill / 4 h (AD-39)", () => {
    const teraz = new Date("2026-09-30T12:00:00Z");
    it("czyBackfill: flaga, import, przyszłość > 5 min, dotarcie > 4 h po zdarzeniu", () => {
      const baza = { flaga: false, source: "api" as const, ingestedAt: teraz };
      expect(czyBackfill({ ...baza, occurredAt: new Date("2026-09-30T11:59:00Z") })).toBe(false);
      expect(czyBackfill({ ...baza, flaga: true, occurredAt: teraz })).toBe(true);
      expect(czyBackfill({ ...baza, source: "import", occurredAt: teraz })).toBe(true);
      expect(czyBackfill({ ...baza, occurredAt: new Date("2026-09-30T12:04:59Z") })).toBe(false);
      expect(czyBackfill({ ...baza, occurredAt: new Date("2026-09-30T12:05:01Z") })).toBe(true);
      expect(czyBackfill({ ...baza, occurredAt: new Date("2026-09-30T08:00:00Z") })).toBe(false);
      expect(czyBackfill({ ...baza, occurredAt: new Date("2026-09-30T07:59:59Z") })).toBe(true);
    });

    it("zapis i skan wejść: backfill, stare > 4 h, import i gość bez profilu NIE trafiają do skanu", async () => {
      const m = { integracja: "api" as const, nazwa: `Skan ${znak}` };
      const tak = await zapisz({ tenantId: tenantA, metryka: m, profileId: profilA, occurredAt: new Date(Date.now() - 60_000), source: "api", uniqueId: "s-tak" });
      await zapisz({ tenantId: tenantA, metryka: m, profileId: profilA, occurredAt: new Date(Date.now() - 60_000), source: "api", uniqueId: "s-flaga", backfill: true });
      await zapisz({ tenantId: tenantA, metryka: m, profileId: profilA, occurredAt: new Date(Date.now() - 5 * 3600_000), source: "api", uniqueId: "s-stare" });
      await zapisz({ tenantId: tenantA, metryka: m, profileId: profilA, occurredAt: new Date(Date.now() - 60_000), source: "import", uniqueId: "s-import" });
      await zapisz({ tenantId: tenantA, metryka: m, profileId: null, occurredAt: new Date(Date.now() - 60_000), source: "api", uniqueId: "s-gosc" });
      const wynik = await zdarzeniaDoSkanu(getPool(), {
        tenantId: tenantA,
        metricId: tak.metricId,
        recordedPo: new Date(Date.now() - 3600_000),
        occurredOd: new Date(Date.now() - 6 * 3600_000),
      });
      expect(wynik.map((z) => z.uniqueId)).toEqual(["s-tak"]);
      expect(czyMozeWyzwolic(wynik[0])).toBe(true);
      // cudzy tenant nie widzi nic z tej metryki
      const cudze = await zdarzeniaDoSkanu(getPool(), { tenantId: tenantB, metricId: tak.metricId, recordedPo: new Date(0), occurredOd: new Date(0) });
      expect(cudze).toEqual([]);
    });
  });

  describe("metryki wbudowane z popupu i Woo (1.3, MVP)", () => {
    it("popup: „Submitted Form” w strumieniu + lustro popup.submitted w events z TYM SAMYM id", async () => {
      const popup = await utworzPopup(tenantA, { name: `ZDA popup ${znak}`, headline: "H", bodyText: "B", buttonText: "OK", discountCode: null, delaySeconds: 0 });
      await ustawAktywnosc(tenantA, popup, true);
      const wynik = await przyjmijZgloszenie(popup, { zgoda: true, wersjaKlauzuli: 1, email: `popup-${znak}@example.test` });
      const { rows } = await getPool().query(
        `select e.id, e.occurred_at, e.properties, e.source, e.backfill, e.unique_id, m.name, m.integration_key, m.builtin, m.can_trigger,
                ev.event_type, ev.occurred_at as ev_occurred, ev.payload
           from metric_events e
           join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
           join events ev on ev.tenant_id = e.tenant_id and ev.id = e.id
          where e.tenant_id = $1 and e.profile_id = $2`,
        [tenantA, wynik!.profileId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "Submitted Form",
        integration_key: "midrev",
        builtin: true,
        can_trigger: true,
        source: "client",
        backfill: false,
        event_type: "popup.submitted",
        properties: { form_id: popup, form_name: `ZDA popup ${znak}` },
        payload: { popup_id: popup, popup_name: `ZDA popup ${znak}` },
      });
      expect(rows[0].unique_id).toBe(`form:${popup}:${rows[0].id}`);
      expect(new Date(rows[0].ev_occurred).getTime()).toBe(new Date(rows[0].occurred_at).getTime());
    });

    it("Woo: „Placed Order” raz + „Ordered Product” na pozycję; aktualizacja zamówienia nie dubluje; import = backfill", async () => {
      const pool = getPool();
      const storeId = (
        await pool.query(
          `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
           values ($1, 'woocommerce', $2, decode('00', 'hex'), 'connected') returning id`,
          [tenantA, `https://zda-${znak}.example`],
        )
      ).rows[0].id;
      const zamowienie = (extId: string, zmod: string): ZamowienieSklepu => ({
        externalId: extId,
        numer: `N${extId}`,
        status: "processing",
        email: `kupujacy-${znak}@example.test`,
        imie: "Kasia",
        nazwisko: null,
        sumaMinor: 34900,
        waluta: "PLN",
        occurredAt: new Date("2026-09-29T09:30:15Z"),
        zmodyfikowaneAt: new Date(zmod),
        pozycje: [
          { sku: "LONG-1", nazwa: "Pakiet Longevity", ilosc: 1, cenaMinor: 29900, lineId: "11", productId: "501", sumaMinor: 29900 },
          { sku: "KONS", nazwa: "Konsultacja", ilosc: 1, cenaMinor: 5000, lineId: "12", productId: "502", sumaMinor: 5000 },
        ],
        surowe: {},
      });
      const w = await wTransakcji((k) => upsertZamowienie(k, tenantA, storeId, zamowienie("9001", "2026-09-29T09:30:15Z"), { kanal: "webhook" }));
      expect(w.nowe).toBe(true);
      const { rows } = await pool.query(
        `select m.name, e.unique_id, e.value_minor::int as v, e.value_currency, e.source, e.backfill, e.properties, e.occurred_at
           from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
          where e.tenant_id = $1 and e.profile_id = $2 order by m.name, e.unique_id`,
        [tenantA, w.profileId],
      );
      expect(rows.map((r) => [r.name, r.unique_id, r.v])).toEqual([
        ["Ordered Product", `${w.orderId}:11`, 29900],
        ["Ordered Product", `${w.orderId}:12`, 5000],
        ["Placed Order", w.orderId, 34900],
      ]);
      for (const r of rows) {
        // data ze źródła, nie z zapisu (AD-10)
        expect(new Date(r.occurred_at).toISOString()).toBe("2026-09-29T09:30:15.000Z");
        expect(r.source).toBe("webhook");
      }
      expect(rows[0].properties).toMatchObject({ ProductID: "501", ProductName: "Pakiet Longevity", Quantity: 1, OrderId: "9001" });
      expect(rows[2].properties).toMatchObject({ OrderId: "9001", $value: 349, ProductNames: ["Pakiet Longevity", "Konsultacja"] });
      // lustro order.created z tym samym id co Placed Order
      const { rows: lustro } = await pool.query(
        `select ev.payload from events ev join metric_events e on e.tenant_id = ev.tenant_id and e.id = ev.id
          where ev.tenant_id = $1 and ev.event_type = 'order.created' and ev.profile_id = $2`,
        [tenantA, w.profileId],
      );
      expect(lustro).toEqual([{ payload: { orderId: w.orderId, totalMinor: 34900, kanal: "webhook" } }]);

      // nowsza wersja tego samego zamówienia: status się zmienia, zdarzeń nie przybywa
      await wTransakcji((k) => upsertZamowienie(k, tenantA, storeId, zamowienie("9001", "2026-09-29T11:00:00Z"), { kanal: "webhook" }));
      const { rows: po } = await pool.query("select count(*)::int as n from metric_events where tenant_id = $1 and profile_id = $2", [tenantA, w.profileId]);
      expect(po[0].n).toBe(3);

      // import historii: te same metryki, ale backfill (nie wyzwalają flow)
      const imp = await wTransakcji((k) => upsertZamowienie(k, tenantA, storeId, zamowienie("9002", "2026-09-29T09:30:15Z"), { kanal: "import" }));
      const { rows: importowane } = await pool.query(
        "select bool_and(backfill) as b, min(source) as s, count(*)::int as n from metric_events where tenant_id = $1 and unique_id like $2",
        [tenantA, `${imp.orderId}%`],
      );
      expect(importowane[0]).toEqual({ b: true, s: "import", n: 3 });
    });
  });

  describe("backfill 0031 (1.4)", () => {
    it("funkcja kopiuje stare events: te same id, daty ze źródła, backfill, mapowanie metryk; drugie wywołanie nic nie dodaje", async () => {
      const pool = getPool();
      const t = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "backfill"])).rows[0].id;
      const p = await nowyProfil(t, `bf-${znak}@example.test`);
      // wiersze zapisane „starym kodem”: prosto do events, z mikrosekundami i datą zapisu z przeszłości
      const { rows: stare } = await pool.query(
        `insert into events (tenant_id, profile_id, event_type, payload, occurred_at, recorded_at) values
           ($1, $2, 'popup.submitted', '{"popup_id":"p1","popup_name":"Powitanie"}', '2026-01-10 10:00:00.123456+00', '2026-01-10 10:00:01+00'),
           ($1, $2, 'order.created', '{"orderId":"nie-uuid","totalMinor":12345,"kanal":"import"}', '2025-06-01 08:00:00+00', '2026-01-02 00:00:00+00'),
           ($1, $2, 'customer.created', '{"storeId":null,"externalId":"7"}', '2025-05-01 08:00:00+00', '2026-01-02 00:00:00+00'),
           ($1, null, 'rodo.eksport', '{"aktor":"op"}', '2026-02-01 08:00:00+00', '2026-02-01 08:00:00+00'),
           ($1, $2, 'cos.innego', '[1,2]', '2026-03-01 08:00:00+00', '2026-03-01 08:00:00+00')
         returning id`,
        [t, p],
      );
      const n1 = (await pool.query("select metryki_dosynchronizuj_events('2025-12-31'::timestamptz) as n")).rows[0].n;
      expect(n1).toBeGreaterThanOrEqual(stare.length);
      const n2 = (await pool.query("select metryki_dosynchronizuj_events('2025-12-31'::timestamptz) as n")).rows[0].n;
      expect(n2).toBe(0);
      const { rows } = await pool.query(
        `select ev.event_type, m.name, m.integration_key, m.hidden, m.can_trigger, e.occurred_at, e.recorded_at, e.ingested_at,
                ev.occurred_at as src_occ, ev.recorded_at as src_rec, e.backfill, e.source, e.value_minor::int as v, e.properties, e.unique_id,
                e.profile_id is not distinct from ev.profile_id as ten_sam_profil
           from events ev
           join metric_events e on e.tenant_id = ev.tenant_id and e.id = ev.id
           join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
          where ev.tenant_id = $1 order by ev.occurred_at`,
        [t],
      );
      expect(rows).toHaveLength(5);
      for (const r of rows) {
        expect(r.backfill).toBe(true);
        expect(r.ten_sam_profil).toBe(true);
        // daty ze źródła: occurred ucięte do sekundy, recorded/ingested = recorded_at starego wiersza
        expect(new Date(r.occurred_at).getTime()).toBe(Math.floor(new Date(r.src_occ).getTime() / 1000) * 1000);
        expect(new Date(r.recorded_at).getTime()).toBe(new Date(r.src_rec).getTime());
        expect(new Date(r.ingested_at).getTime()).toBe(new Date(r.src_rec).getTime());
      }
      const po = Object.fromEntries(rows.map((r) => [r.event_type, r]));
      expect(po["popup.submitted"]).toMatchObject({ name: "Submitted Form", integration_key: "midrev", source: "client", properties: { form_id: "p1", form_name: "Powitanie" } });
      expect(po["order.created"]).toMatchObject({ name: "Placed Order", integration_key: "woocommerce", source: "import", v: 12345, unique_id: "nie-uuid" });
      expect(po["customer.created"]).toMatchObject({ hidden: true, can_trigger: false, source: "webhook" });
      expect(po["rodo.eksport"]).toMatchObject({ hidden: true, source: "system" });
      expect(po["cos.innego"]).toMatchObject({ name: "cos.innego", properties: { payload: [1, 2] } });
    });

    it("blok DO z migracji: przechodzi na zgodnych danych, a rozjazd (brak lustra) wycofuje całość", async () => {
      const sql = readFileSync(join(import.meta.dirname, "..", "migrations", "0031_backfill_strumienia.sql"), "utf-8");
      const blok = sql.slice(sql.lastIndexOf("do $$"));
      const klient = await getPool().connect();
      try {
        // na świeżym strumieniu (jak w dniu migracji) asercje przechodzą
        await klient.query("begin");
        await klient.query("delete from event_keys");
        await klient.query("delete from metric_events");
        await klient.query(blok);
        await klient.query("rollback");

        // sabotaż: wiersz strumienia z id starego zdarzenia, ale innym profilem, już jest -
        // kopia go pominie (on conflict), a odczyt zwrotny ma to złapać
        await klient.query("begin");
        await klient.query("delete from event_keys");
        await klient.query("delete from metric_events");
        const { rows } = await klient.query("select id, tenant_id, occurred_at from events where profile_id is not null limit 1");
        const m = await klient.query("select id from metrics where tenant_id = $1 limit 1", [rows[0].tenant_id]);
        await klient.query(
          `insert into metric_events (id, tenant_id, metric_id, profile_id, occurred_at, ingested_at, unique_id, source)
           values ($1, $2, $3, null, date_trunc('second', $4::timestamptz), now(), 'sabotaz', 'system')`,
          [rows[0].id, rows[0].tenant_id, m.rows[0].id, rows[0].occurred_at],
        );
        await expect(klient.query(blok)).rejects.toThrow(/0031: rozjazd backfillu/);
        await klient.query("rollback");
      } finally {
        await klient.query("rollback").catch(() => {});
        klient.release();
      }
    });
  });

  describe("oś profilu (6.4) i RODO (1.5)", () => {
    it("oś: filtr metryk, kursor po 50, properties tylko dla właściciela zdarzenia", async () => {
      const p = await nowyProfil(tenantA, `os-${znak}@example.test`);
      const m1 = { integracja: "api" as const, nazwa: `Os1 ${znak}` };
      const m2 = { integracja: "api" as const, nazwa: `Os2 ${znak}` };
      let id1 = "";
      for (let i = 0; i < 55; i++) {
        const w = await zapisz({ tenantId: tenantA, metryka: i % 5 === 0 ? m2 : m1, profileId: p, occurredAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)), source: "api", uniqueId: `os-${i}`, properties: { i } });
        if (i === 0) id1 = w.metricId;
      }
      const s1 = await osProfilu(tenantA, p);
      expect(s1.wpisy).toHaveLength(50);
      expect(s1.nastepna).not.toBeNull();
      const s2 = await osProfilu(tenantA, p, { kursor: s1.nastepna });
      expect(s2.wpisy).toHaveLength(5);
      expect(s2.nastepna).toBeNull();
      const wszystkie = [...s1.wpisy, ...s2.wpisy];
      expect(new Set(wszystkie.map((w) => w.id)).size).toBe(55);
      const tylkoM2 = await osProfilu(tenantA, p, { metryki: [id1] });
      expect(tylkoM2.wpisy).toHaveLength(11);
      const pierwszy = s1.wpisy[0];
      const props = await wlasciwosciZdarzenia(tenantA, p, pierwszy.id, pierwszy.occurredAt.toISOString());
      expect(props).toEqual({ i: 54 });
      // cudzy profil / tenant nie otworzy tych właściwości (AD-40)
      expect(await wlasciwosciZdarzenia(tenantA, profilA, pierwszy.id, pierwszy.occurredAt.toISOString())).toBeNull();
      expect(await wlasciwosciZdarzenia(tenantB, p, pierwszy.id, pierwszy.occurredAt.toISOString())).toBeNull();
      expect((await osProfilu(tenantB, p)).wpisy).toEqual([]);
    });

    it("RODO: eksport zawiera zdarzenia strumienia; anonimizacja czyści properties, unique_id i event_keys, kwota zostaje", async () => {
      const email = `rodo-str-${znak}@example.test`;
      const p = await nowyProfil(tenantA, email);
      await zapisz({ tenantId: tenantA, metryka: { integracja: "api", nazwa: `Kupil ${znak}` }, profileId: p, occurredAt: new Date(), source: "api", uniqueId: email, properties: { email, $value: 10 } });
      const eksport = await eksportujProfil(tenantA, p);
      expect(eksport!.zdarzeniaMetryk).toHaveLength(1);
      expect(eksport!.zdarzeniaMetryk[0]).toMatchObject({ metryka: `Kupil ${znak}`, properties: { email } });
      const wynik = await anonimizujProfil(tenantA, p, { aktor: "test", powod: null });
      expect(wynik).toMatchObject({ zdarzeniaMetryk: 1, kluczeZdarzen: 1, danePozostaly: false });
      const { rows } = await getPool().query(
        `select e.properties, e.unique_id, e.value_minor::int as v, m.name from metric_events e
           join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
          where e.tenant_id = $1 and e.profile_id = $2 order by m.name`,
        [tenantA, p],
      );
      const kupil = rows.find((r) => r.name === `Kupil ${znak}`)!;
      expect(kupil.properties).toEqual({});
      expect(kupil.unique_id).toMatch(/^rodo:/);
      expect(kupil.v).toBe(1000);
      // ślad RODO jest w strumieniu (i w lustrze events)
      expect(rows.map((r) => r.name)).toContain("rodo.anonimizacja");
      const { rows: klucze } = await getPool().query("select count(*)::int as n from event_keys where tenant_id = $1 and profile_id = $2", [tenantA, p]);
      expect(klucze[0].n).toBe(0);
      const { rows: tekst } = await getPool().query("select count(*)::int as n from metric_events e where e.tenant_id = $1 and e::text ilike $2", [tenantA, `%${email}%`]);
      expect(tekst[0].n).toBe(0);
    });
  });

  it("telefon: normalizacja TS = funkcja SQL z 0033", async () => {
    const proby = [" +48 600-100-200 ", "600100200", "0048600100200", "48600100200", "(+44) 20 7946 0958", "12", "", "+0 123", "600 100 20", "+48600100200"];
    const { rows } = await getPool().query("select x, midrev_telefon_e164(x) as n from unnest($1::text[]) x", [proby]);
    for (const r of rows) expect(telefonE164(r.x)).toBe(r.n);
  });

  it("metryki wbudowane: flagi z kontraktu niezależnie od wołającego", async () => {
    const m = await metrykaPoKluczu(getPool(), tenantA, { integracja: "midrev", nazwa: "rodo.eksport" }, { utworz: true });
    expect(m).toMatchObject({ wbudowana: true, ukryta: true, mozeWyzwalac: false });
    expect(METRYKI_WBUDOWANE.zamowionyProdukt.nazwa).toBe("Ordered Product");
  });
});

describe("AD-38 dla gościa bez profilu (review Codeksa R1)", () => {
  it("zdarzenie zewnętrzne bez profilu: retry z tym samym unique_id i innym czasem = jedno zdarzenie", async () => {
    const pool = getPool();
    const t = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "gosc"])).rows[0].id;
    const m = { integracja: "woocommerce" as const, nazwa: "Placed Order" };
    const a = await zapisz({ tenantId: t, metryka: m, profileId: null, occurredAt: new Date("2026-09-01T10:00:00Z"), source: "webhook", uniqueId: "zam-1" });
    const b = await zapisz({ tenantId: t, metryka: m, profileId: null, occurredAt: new Date("2026-09-01T10:05:00Z"), source: "webhook", uniqueId: "zam-1" });
    expect(b).toMatchObject({ duplikat: true, id: a.id });
    expect(await ileZdarzen(t)).toBe(1);
    await pool.query("delete from tenants where id = $1", [t]);
    await closePool();
  });
});
