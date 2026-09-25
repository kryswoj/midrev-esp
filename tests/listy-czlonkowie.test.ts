import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { czlonkowieListy, dodajDoListyPoEmailu, dodajZSegmentu, eksportujListe, statystykiListy, usunZListy } from "../src/usecases/listy/czlonkowie";

// Czlonkowie list (audyt #2): dodanie po adresie, z segmentu, usuniecie, wyszukiwanie
// po stronie serwera, statystyki zgod liczone tym samym oknem co bramka wysylki,
// eksport CSV z ochrona przed formula. Prawdziwa baza, izolacja tenantow obowiazkowa.

describe("Członkowie list", () => {
  let tenantA: string;
  let tenantB: string;
  let listaA: string;
  let listaB: string;
  let segmentA: string;
  const profile: Record<string, string> = {};

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'LST %'");
    tenantA = (await pool.query("insert into tenants (name) values ('LST A') returning id")).rows[0].id;
    tenantB = (await pool.query("insert into tenants (name) values ('LST B') returning id")).rows[0].id;
    listaA = (await pool.query("insert into lists (tenant_id, name) values ($1, 'LST lista A') returning id", [tenantA])).rows[0].id;
    listaB = (await pool.query("insert into lists (tenant_id, name) values ($1, 'LST lista B') returning id", [tenantB])).rows[0].id;
    for (const [email, imie, nazwisko] of [
      ["lst-zgoda@example.test", "Anna", "Zgodna"],
      ["lst-bez@example.test", "Jan", "Bezzgody"],
      ["lst-wypis@example.test", "Ewa", "Wypisana"],
      ["=lst-formula@example.test", "Formu", "Injekcja"],
    ]) {
      const { rows } = await pool.query("insert into profiles (tenant_id, email, first_name, last_name) values ($1, $2, $3, $4) returning id", [tenantA, email, imie, nazwisko]);
      profile[email] = rows[0].id;
    }
    await pool.query("insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email', 'granted', 'test', '2024-01-01')", [tenantA, profile["lst-zgoda@example.test"]]);
    await pool.query("insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email', 'granted', 'test', '2024-01-01')", [tenantA, profile["lst-wypis@example.test"]]);
    await pool.query("insert into tenant_suppressions (tenant_id, email, action, reason) values ($1, 'lst-wypis@example.test', 'suppressed', 'test')", [tenantA]);
    segmentA = (await pool.query("insert into segments (tenant_id, name, rules) values ($1, 'LST ze zgodą', $2) returning id", [tenantA, JSON.stringify([{ typ: "ma_zgode", kanal: "email" }])])).rows[0].id;
    // profil tenanta B o tym samym adresie co u A
    await pool.query("insert into profiles (tenant_id, email) values ($1, 'lst-zgoda@example.test')", [tenantB]);
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like 'LST %'");
    await closePool();
  });

  it("dodaje po adresie (znormalizowanym) tylko istniejący profil; drugi raz nie dubluje", async () => {
    const w1 = await dodajDoListyPoEmailu(tenantA, listaA, " LST-Zgoda@Example.test ", "reczny:test");
    expect(w1).toMatchObject({ ok: true, dodano: true, profileId: profile["lst-zgoda@example.test"] });
    const w2 = await dodajDoListyPoEmailu(tenantA, listaA, "lst-zgoda@example.test", "reczny:test");
    expect(w2).toMatchObject({ ok: true, dodano: false });
    const brak = await dodajDoListyPoEmailu(tenantA, listaA, "nikt@example.test", "reczny:test");
    expect(brak.ok).toBe(false);
    expect(await dodajDoListyPoEmailu(tenantA, listaA, "nie-adres", "reczny:test")).toMatchObject({ ok: false });
  });

  it("izolacja: profil tenanta B nie wchodzi na listę A, a lista A nie istnieje dla B", async () => {
    const w = await dodajDoListyPoEmailu(tenantB, listaA, "lst-zgoda@example.test", "reczny:test");
    expect(w.ok).toBe(false);
    expect(await statystykiListy(tenantB, listaA)).toEqual({ czlonkow: 0, zeZgoda: 0, bezZgody: 0, wykluczonych: 0, bezAdresu: 0 });
    expect((await czlonkowieListy(tenantB, listaA)).razem).toBe(0);
  });

  it("z segmentu: migawka, bez duplikatów, ze statystykami zgodnymi z bramką", async () => {
    await dodajDoListyPoEmailu(tenantA, listaA, "lst-bez@example.test", "reczny:test");
    await dodajDoListyPoEmailu(tenantA, listaA, "=lst-formula@example.test", "reczny:test");
    const w = await dodajZSegmentu(tenantA, listaA, segmentA);
    // segment "ma zgode": zgoda i wypis (zgoda granted, ale wykluczona); zgoda juz byla na liscie
    expect(w).toMatchObject({ ok: true, kandydatow: 2, dodano: 1, nazwaSegmentu: "LST ze zgodą" });
    const s = await statystykiListy(tenantA, listaA);
    expect(s).toEqual({ czlonkow: 4, zeZgoda: 1, bezZgody: 2, wykluczonych: 1, bezAdresu: 0 });
    expect(await dodajZSegmentu(tenantB, listaB, segmentA)).toMatchObject({ ok: false });
  });

  it("wyszukiwanie po stronie serwera po e-mailu i nazwisku, z metaznakami traktowanymi dosłownie", async () => {
    expect((await czlonkowieListy(tenantA, listaA, { q: "LST-ZGODA" })).wiersze.map((c) => c.email)).toEqual(["lst-zgoda@example.test"]);
    expect((await czlonkowieListy(tenantA, listaA, { q: "anna zgodna" })).wiersze.map((c) => c.email)).toEqual(["lst-zgoda@example.test"]);
    expect((await czlonkowieListy(tenantA, listaA, { q: "Bezzgody" })).razem).toBe(1);
    expect((await czlonkowieListy(tenantA, listaA, { q: "%" })).razem).toBe(0);
    expect((await czlonkowieListy(tenantA, listaA, { q: "_" })).razem).toBe(0);
    const wszyscy = await czlonkowieListy(tenantA, listaA, { limit: 2 });
    expect(wszyscy.wiersze.length).toBe(2);
    expect(wszyscy.razem).toBe(4);
    const wypis = (await czlonkowieListy(tenantA, listaA, { q: "wypis" })).wiersze[0];
    expect(wypis.zgoda).toBe("granted");
    expect(wypis.wykluczony).toBe(true);
  });

  it("eksport CSV: nagłówki Klaviyo, stan zgody, formuła unieszkodliwiona", async () => {
    let csv = "";
    for await (const linia of eksportujListe(tenantA, listaA)) csv += linia;
    const linie = csv.trim().split("\r\n");
    expect(linie[0]).toBe("Email,First Name,Last Name,Phone Number,Email Marketing Consent,Email Marketing Consent Timestamp,Suppressed,Added At,Source");
    expect(linie.length).toBe(5);
    expect(csv).toContain("'=lst-formula@example.test,Formu,Injekcja,,NEVER_SUBSCRIBED,,,");
    expect(csv).toMatch(/lst-zgoda@example.test,Anna,Zgodna,,SUBSCRIBED,2024-01-01T00:00:00.000Z,,/);
    expect(csv).toMatch(/lst-wypis@example.test,Ewa,Wypisana,,SUBSCRIBED,[^,]+,yes,/);
    expect(csv).toContain(",segment:LST ze zgodą");
  });

  it("usunięcie z listy zostawia profil i zgodę; z cudzego tenanta nic nie usuwa", async () => {
    expect(await usunZListy(tenantB, listaA, profile["lst-zgoda@example.test"])).toBe(false);
    expect(await usunZListy(tenantA, listaA, profile["lst-zgoda@example.test"])).toBe(true);
    expect(await usunZListy(tenantA, listaA, profile["lst-zgoda@example.test"])).toBe(false);
    const pool = getPool();
    const { rows } = await pool.query("select count(*)::int as n from consents where tenant_id = $1 and profile_id = $2", [tenantA, profile["lst-zgoda@example.test"]]);
    expect(rows[0].n).toBe(1);
    expect((await statystykiListy(tenantA, listaA)).czlonkow).toBe(3);
  });
});
