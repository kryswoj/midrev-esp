import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { ROZMIAR_STRONY, odkodujKursor, stronaProfili, uciekajLike, warunekWyszukiwania, zakodujKursor } from "../src/usecases/lista-profili";

// Fala 1 UX, pkt 5: lista profili z wyszukiwarka (prefiks), kursorem i filtrem zgody.

describe("Lista profili: wyszukiwarka, kursor, filtr zgody", () => {
  let tenantA: string;
  let tenantB: string;
  const pool = () => getPool();

  beforeAll(async () => {
    await pool().query("delete from tenants where name in ('PROFLISTA A', 'PROFLISTA B')");
    tenantA = (await pool().query("insert into tenants (name) values ('PROFLISTA A') returning id")).rows[0].id;
    tenantB = (await pool().query("insert into tenants (name) values ('PROFLISTA B') returning id")).rows[0].id;
    // 120 osob w A, kazda z innym created_at (rozne sekundy) + dwie z tym samym czasem (remis po id)
    await pool().query(
      `insert into profiles (tenant_id, email, first_name, last_name, created_at)
       select $1, 'osoba' || g || '@lista.test', 'Imie' || g, 'Nazwisko' || g, timestamptz '2026-01-01' + g * interval '1 second'
         from generate_series(1, 120) g`,
      [tenantA],
    );
    await pool().query(
      `insert into profiles (tenant_id, email, first_name, last_name, phone, created_at) values
         ($1, 'anna.kowalska@sklep.test', 'Anna', 'Kowalska', '600 100 200', timestamptz '2026-02-01 10:00:00.123456'),
         ($1, 'jan_nowak@sklep.test', 'Jan', 'Nowak', '+48 601-100-200', timestamptz '2026-02-01 10:00:00.123456'),
         ($1, 'procent%@sklep.test', 'Zofia', 'Anna', null, timestamptz '2026-02-02')`,
      [tenantA],
    );
    // cudzy tenant z identycznym adresem: nie moze wyjsc w wynikach A
    await pool().query("insert into profiles (tenant_id, email, first_name) values ($1, 'anna.kowalska@sklep.test', 'Anna')", [tenantB]);
    const anna = (await pool().query("select id from profiles where tenant_id = $1 and email = 'anna.kowalska@sklep.test'", [tenantA])).rows[0].id;
    const jan = (await pool().query("select id from profiles where tenant_id = $1 and email = 'jan_nowak@sklep.test'", [tenantA])).rows[0].id;
    // zgody: Anna udzielila (ostatni wpis granted), Jan udzielil i wycofal
    await pool().query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values
         ($1, $2, 'email', 'granted', 'test', now() - interval '2 days'),
         ($1, $3, 'email', 'granted', 'test', now() - interval '2 days'),
         ($1, $3, 'email', 'withdrawn', 'test', now() - interval '1 day')`,
      [tenantA, anna, jan],
    );
    const sklep = (await pool().query("insert into stores (tenant_id, platform, base_url, credentials_encrypted) values ($1, 'woocommerce', 'https://s.test', '\\x00') returning id", [tenantA])).rows[0].id;
    {
      await pool().query(
        `insert into orders (tenant_id, store_id, profile_id, external_id, status, total_minor, currency, occurred_at)
         values ($1, $2, $3, 'o1', 'completed', 12345, 'PLN', '2026-03-01'), ($1, $2, $3, 'o2', 'pending', 999, 'PLN', '2026-03-02')`,
        [tenantA, sklep, anna],
      );
    }
  });

  afterAll(async () => {
    await pool().query("delete from tenants where name in ('PROFLISTA A', 'PROFLISTA B')");
    await closePool();
  });

  it("licznik to wszyscy pasujący, strona ma 50 wierszy, najnowsi u góry", async () => {
    const s = await stronaProfili(tenantA);
    expect(s.razem).toBe(123);
    expect(s.wiersze).toHaveLength(ROZMIAR_STRONY);
    expect(s.wiersze[0].email).toBe("procent%@sklep.test");
    expect(s.wstecz).toBeNull();
    expect(s.dalej).not.toBeNull();
  });

  it("kursor przechodzi całą listę bez duplikatów i dziur (także przy remisie created_at) i wraca wstecz", async () => {
    const widziane: string[] = [];
    let po: string | undefined;
    const strony: { dalej: string | null; wstecz: string | null; ids: string[] }[] = [];
    for (let i = 0; i < 10; i++) {
      const s = await stronaProfili(tenantA, { po });
      strony.push({ dalej: s.dalej, wstecz: s.wstecz, ids: s.wiersze.map((w) => w.id) });
      widziane.push(...s.wiersze.map((w) => w.id));
      if (!s.dalej) break;
      po = s.dalej;
    }
    expect(strony.map((x) => x.ids.length)).toEqual([50, 50, 23]);
    expect(new Set(widziane).size).toBe(123);
    // wstecz z ostatniej strony daje dokladnie strone 2, z niej strone 1
    const s2 = await stronaProfili(tenantA, { przed: strony[2].wstecz! });
    expect(s2.wiersze.map((w) => w.id)).toEqual(strony[1].ids);
    const s1 = await stronaProfili(tenantA, { przed: s2.wstecz! });
    expect(s1.wiersze.map((w) => w.id)).toEqual(strony[0].ids);
    expect(s1.wstecz).toBeNull();
  });

  it("wyszukiwanie po prefiksie e-maila, imienia, nazwiska, imienia i nazwiska, telefonu", async () => {
    const emaile = async (q: string) => (await stronaProfili(tenantA, { q })).wiersze.map((w) => w.email).sort();
    expect(await emaile("ANNA.kow")).toEqual(["anna.kowalska@sklep.test"]);
    expect(await emaile("anna")).toEqual(["anna.kowalska@sklep.test", "procent%@sklep.test"]); // imie albo nazwisko "Anna"
    expect(await emaile("kowalska anna")).toEqual(["anna.kowalska@sklep.test"]);
    expect(await emaile("Jan Nowak")).toEqual(["jan_nowak@sklep.test"]);
    expect(await emaile("601100")).toEqual(["jan_nowak@sklep.test"]);
    expect(await emaile("+48 600 100")).toEqual(["anna.kowalska@sklep.test"]);
    expect(await emaile("osoba12")).toHaveLength(2); // osoba12, osoba120
    expect((await stronaProfili(tenantA, { q: "osoba1" })).razem).toBe(32); // 1, 10-19, 100-120
  });

  it("znaki % _ \\ są dosłowne (bez dopasowania wszystkiego), a cudzy tenant nie wychodzi", async () => {
    expect((await stronaProfili(tenantA, { q: "%" })).razem).toBe(0);
    expect((await stronaProfili(tenantA, { q: "procent%" })).wiersze.map((w) => w.email)).toEqual(["procent%@sklep.test"]);
    expect((await stronaProfili(tenantA, { q: "jan_" })).wiersze.map((w) => w.email)).toEqual(["jan_nowak@sklep.test"]);
    expect((await stronaProfili(tenantA, { q: "jan%" })).razem).toBe(0);
    expect((await stronaProfili(tenantA, { q: "'; drop table profiles; --" })).razem).toBe(0);
    expect(uciekajLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    const b = await stronaProfili(tenantB, { q: "anna" });
    expect(b.razem).toBe(1);
    expect((await stronaProfili(tenantA, { q: "anna.kowalska@sklep.test" })).razem).toBe(1);
  });

  it("filtr zgody liczy ostatni wpis rejestru; zamówienia tylko dla wierszy strony", async () => {
    const zg = await stronaProfili(tenantA, { zgoda: "granted" });
    expect(zg.wiersze.map((w) => w.email)).toEqual(["anna.kowalska@sklep.test"]);
    expect(zg.razem).toBe(1);
    expect((await stronaProfili(tenantA, { zgoda: "withdrawn" })).wiersze.map((w) => w.email)).toEqual(["jan_nowak@sklep.test"]);
    expect((await stronaProfili(tenantA, { zgoda: "brak" })).razem).toBe(121);
    expect((await stronaProfili(tenantA, { zgoda: "cokolwiek" })).razem).toBe(123); // nieznany filtr = brak filtra
    const anna = (await stronaProfili(tenantA, { q: "anna.k" })).wiersze[0];
    expect(anna.zamowien).toBe(2);
    expect(anna.wydal_minor).toBe("12345"); // tylko oplacone (completed/processing)
  });

  it("spreparowany kursor = pierwsza strona, nigdy błąd SQL", async () => {
    for (const zly of ["", "x", Buffer.from("2026-01-01|nie-uuid").toString("base64url"), Buffer.from("drop|01a00000-0000-7000-8000-000000000001").toString("base64url"), "%%%"]) {
      expect(odkodujKursor(zly)).toBeNull();
      const s = await stronaProfili(tenantA, { po: zly });
      expect(s.wiersze[0].email).toBe("procent%@sklep.test");
    }
    const k = { czas: "2026-02-01 10:00:00.123456+00", id: "01a00000-0000-7000-8000-000000000001" };
    expect(odkodujKursor(zakodujKursor(k))).toEqual(k);
  });

  it("warunek wyszukiwania używa wyłącznie parametrów (tekst zapytania nie trafia do SQL)", () => {
    const w = warunekWyszukiwania("x' or 1=1 --", 2)!;
    expect(w.sql).not.toMatch(/x'|1=1/);
    expect(w.parametry).toEqual(["x'%", "or%"]); // dwa pierwsze slowa jako parametry, reszta odcieta
    expect(warunekWyszukiwania("   ", 2)).toBeNull();
  });
});
