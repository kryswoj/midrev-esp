import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import {
  BladKontekstuFiltra,
  OPERATORY,
  OPERATORY_LICZNIKA,
  ocenFiltr,
  opiszFiltr,
  schematFiltra,
  schematFiltraProfilu,
  schematFiltraZdarzenia,
  zapytanieFiltrowane,
  type Filtr,
  type KontekstFlow,
  type KontekstFlowSql,
  type PrzebiegProfilu,
  type Warunek,
  type ZdarzenieProfilu,
} from "../src/domain/filtry";
import { zapiszZdarzenie } from "../src/usecases/zdarzenia/zapisz-zdarzenie";

// Test parytetu AD-42 dla warunkow E4b po HISTORII profilu: `metryka_profilu` (ile razy osoba
// zrobila X w oknie czasu, z filtrem wlasciwosci zdarzenia) i `byl_w_flow`. Ewaluator TS
// liczy na liscie zdarzen i przebiegow w pamieci, kompilator SQL na prawdziwych tabelach
// metric_events + metrics i flow_participants (skorelowane podzapytania). Generator
// deterministyczny; okna czasu celowo trafiaja w granice (zdarzenie dokladnie na starcie,
// zdarzenie wyzwalajace wykluczone, dwie integracje o tej samej nazwie metryki).

function losowanie(ziarno: number) {
  let s = ziarno >>> 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { r, wybierz: <T,>(t: readonly T[]): T => t[Math.floor(r() * t.length)] };
}

const TERAZ = new Date("2026-09-30T12:00:00Z");
const DZIEN = 86_400_000;
const METRYKI = [
  { integracja: "woocommerce", nazwa: "Placed Order" },
  { integracja: "shopify", nazwa: "Placed Order" },
  { integracja: "api", nazwa: "Started Checkout" },
] as const;
const TEKSTY = ["longevity", "Longevity", "a", ""];

describe("Filtry E4b: parytet TS vs SQL dla warunków po historii profilu", () => {
  let tenantId: string;
  let obcyId: string;
  const profile: { id: string; properties: Record<string, unknown> }[] = [];
  const zdarzenia = new Map<string, ZdarzenieProfilu[]>();
  const przebiegi = new Map<string, PrzebiegProfilu[]>();
  const flowy: string[] = [];
  const wszystkieZdarzenia: string[] = [];

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'FHIST %'");
    tenantId = (await pool.query("insert into tenants (name) values ('FHIST tenant') returning id")).rows[0].id;
    obcyId = (await pool.query("insert into tenants (name) values ('FHIST obcy') returning id")).rows[0].id;
    const l = losowanie(20261003);
    const klient = await pool.connect();
    try {
      await klient.query("begin");
      for (let i = 0; i < 14; i++) {
        const properties: Record<string, unknown> = l.r() < 0.6 ? { plan: l.wybierz(TEKSTY) } : {};
        const { rows } = await klient.query("insert into profiles (tenant_id, email, properties) values ($1, $2, $3) returning id", [tenantId, `fhist-${i}@example.test`, JSON.stringify(properties)]);
        profile.push({ id: rows[0].id, properties });
        zdarzenia.set(rows[0].id, []);
        przebiegi.set(rows[0].id, []);
      }
      // obcy tenant: te same metryki, zdarzenia „pasujace” do kazdego warunku; nie moga przeciec
      const obcy = (await klient.query("insert into profiles (tenant_id, email) values ($1, 'fhist-obcy@example.test') returning id", [obcyId])).rows[0].id;
      for (const m of METRYKI) {
        for (let k = 0; k < 3; k++) {
          await zapiszZdarzenie(klient, { tenantId: obcyId, metryka: m as never, profileId: obcy, occurredAt: new Date(TERAZ.getTime() - k * DZIEN), uniqueId: randomUUID(), properties: { ProductName: "longevity" }, source: "api" });
        }
      }
      for (const p of profile) {
        const ile = Math.floor(l.r() * 6);
        for (let k = 0; k < ile; k++) {
          const m = l.wybierz(METRYKI);
          // pelne sekundy (strumien ucina do sekundy), od 60 dni wstecz do 1 dnia naprzod
          const kiedy = new Date(Math.floor((TERAZ.getTime() - 60 * DZIEN + Math.floor(l.r() * 61 * DZIEN)) / 1000) * 1000);
          const properties: Record<string, unknown> = {};
          if (l.r() < 0.7) properties.ProductName = l.wybierz(TEKSTY);
          if (l.r() < 0.5) properties.Quantity = l.wybierz([1, 2, 3]);
          const w = await zapiszZdarzenie(klient, { tenantId, metryka: m as never, profileId: p.id, occurredAt: kiedy, uniqueId: randomUUID(), properties, source: "api" });
          zdarzenia.get(p.id)!.push({ id: w.id, integracja: m.integracja, nazwa: m.nazwa, occurredAtMs: w.occurredAt.getTime(), properties });
          wszystkieZdarzenia.push(w.id);
        }
      }
      for (let f = 0; f < 2; f++) {
        const { rows } = await klient.query(
          `insert into flows (tenant_id, name, draft) values ($1, $2, '{}'::jsonb) returning id`,
          [tenantId, `FHIST flow ${f}`],
        );
        flowy.push(rows[0].id);
        await klient.query("insert into flow_versions (tenant_id, flow_id, version, definition) values ($1, $2, 1, '{}'::jsonb)", [tenantId, rows[0].id]);
        for (const p of profile) {
          if (l.r() < 0.5) continue;
          const wszedl = new Date(TERAZ.getTime() - Math.floor(l.r() * 60) * DZIEN);
          const { rows: u } = await klient.query(
            `insert into flow_participants (tenant_id, flow_id, profile_id, version, node_id, status, entered_at, node_since)
             values ($1, $2, $3, 1, 'wyzwalacz', 'zakonczony', $4, $4) returning id`,
            [tenantId, rows[0].id, p.id, wszedl],
          );
          przebiegi.get(p.id)!.push({ id: u[0].id, flowId: rows[0].id, enteredAtMs: wszedl.getTime() });
        }
      }
      await klient.query("commit");
    } catch (b) {
      await klient.query("rollback");
      throw b;
    } finally {
      klient.release();
    }
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like 'FHIST %'");
    await closePool();
  });

  function losowyWarunekZdarzenia(l: ReturnType<typeof losowanie>): Warunek {
    return l.r() < 0.5
      ? { typ: "wlasciwosc_zdarzenia", pole: "ProductName", typPola: "string", operator: l.wybierz(["rowna", "zawiera", "ustawione", "nieustawione"] as const), wartosc: undefined as never }
      : { typ: "wlasciwosc_zdarzenia", pole: "Quantity", typPola: "number", operator: l.wybierz(["wieksza", "rowna", "nieustawione"] as const), wartosc: undefined as never };
  }

  function uzupelnij(w: Warunek, l: ReturnType<typeof losowanie>): Warunek {
    if (w.typ !== "wlasciwosc_zdarzenia") return w;
    if (w.operator === "ustawione" || w.operator === "nieustawione") return { ...w, wartosc: undefined };
    return { ...w, wartosc: w.typPola === "number" ? l.wybierz([1, 2]) : l.wybierz(TEKSTY) };
  }

  function losowyWarunek(l: ReturnType<typeof losowanie>, flowWKontekscie: boolean): Warunek {
    const los = l.r();
    if (los < 0.6) {
      const m = l.wybierz([...METRYKI, { integracja: undefined, nazwa: "Placed Order" }, { integracja: undefined, nazwa: "Nie istnieje" }]);
      const operator = l.wybierz(OPERATORY_LICZNIKA);
      const a = Math.floor(l.r() * 3), b = a + Math.floor(l.r() * 3);
      const okna = [{ od: "zawsze" as const }, { od: "ostatnich_dni" as const, dni: l.wybierz([1, 7, 30]) }, ...(flowWKontekscie ? [{ od: "startu_flow" as const }] : [])];
      const gdzie = l.r() < 0.4 ? Array.from({ length: 1 + Math.floor(l.r() * 2) }, () => uzupelnij(losowyWarunekZdarzenia(l), l)) : undefined;
      return {
        typ: "metryka_profilu",
        metryka: m.integracja ? { integracja: m.integracja, nazwa: m.nazwa } : { nazwa: m.nazwa },
        operator,
        wartosc: operator === "miedzy" ? [a, b] : a,
        okno: l.wybierz(okna),
        ...(gdzie ? { gdzie: gdzie as never } : {}),
      };
    }
    if (los < 0.85) {
      return {
        typ: "byl_w_flow",
        flow: l.wybierz([...(flowWKontekscie ? ["biezacy" as const] : []), flowy[0], flowy[1], randomUUID()]),
        jest: l.r() < 0.5,
        okno: l.wybierz([{ od: "zawsze" as const }, { od: "ostatnich_dni" as const, dni: l.wybierz([7, 30]) }]),
      };
    }
    return { typ: "wlasciwosc_profilu", pole: { rodzaj: "wlasna", nazwa: "plan" }, typPola: "string", operator: l.wybierz(["rowna", "nieustawione"] as const), wartosc: undefined as never };
  }

  function popraw(w: Warunek, l: ReturnType<typeof losowanie>): Warunek {
    if (w.typ === "wlasciwosc_profilu") return w.operator === "nieustawione" ? { ...w, wartosc: undefined } : { ...w, wartosc: l.wybierz(TEKSTY) };
    return w;
  }

  function kontekst(l: ReturnType<typeof losowanie>): { ts: KontekstFlow; sql: KontekstFlowSql } {
    const flowId = l.wybierz(flowy);
    // start czasem DOKLADNIE na czasie istniejacego zdarzenia (granica >=), czasem losowo
    const wyzw = l.wybierz(wszystkieZdarzenia);
    const zd = [...zdarzenia.values()].flat().find((e) => e.id === wyzw)!;
    const startMs = l.r() < 0.5 ? zd.occurredAtMs : TERAZ.getTime() - Math.floor(l.r() * 40) * DZIEN;
    const wszyscyUczestnicy = [...przebiegi.values()].flat().filter((p) => p.flowId === flowId);
    const uczestnik = l.r() < 0.7 && wszyscyUczestnicy.length ? l.wybierz(wszyscyUczestnicy).id : null;
    const zdarzenieWyzwalajaceId = l.r() < 0.8 ? wyzw : null;
    return {
      ts: { flowId, startMs, zdarzenieWyzwalajaceId, uczestnikId: uczestnik },
      sql: { flowId, start: new Date(startMs).toISOString(), zdarzenieWyzwalajaceId, uczestnikId: uczestnik },
    };
  }

  let ostatniaLiczba = 0;
  async function porownaj(f: Filtr, k: { ts: KontekstFlow; sql: KontekstFlowSql } | null): Promise<string | null> {
    const q = zapytanieFiltrowane({
      kolumny: "p.id",
      zrodloSql: "profiles p",
      alias: "p",
      tenantId,
      filtr: f,
      zrodlo: { profil: { properties: "p.properties", kolumny: { email: "p.email", first_name: "p.first_name", last_name: "p.last_name", phone_number: "p.phone" }, id: "p.id", tenantId: "p.tenant_id" } },
      teraz: TERAZ,
      kontekst: k?.sql ?? null,
      koniec: "order by p.id",
    });
    const { rows } = await getPool().query(q.sql, q.parametry);
    const sql = rows.map((r) => r.id as string);
    ostatniaLiczba = sql.length;
    const ts = profile
      .filter((p) => ocenFiltr(f, { profil: { properties: p.properties }, historia: { zdarzenia: zdarzenia.get(p.id)!, przebiegi: przebiegi.get(p.id)! }, flow: k?.ts ?? null, teraz: TERAZ }))
      .map((p) => p.id)
      .sort();
    if (JSON.stringify(sql) !== JSON.stringify(ts)) return `${JSON.stringify(f)} ${JSON.stringify(k?.ts)}\n SQL: ${sql.length} TS: ${ts.length}`;
    return null;
  }

  it("500 warunków po historii (metryka w oknie, z „gdzie”, był w automatyzacji): ten sam zbiór profili", async () => {
    const l = losowanie(4242);
    const rozjazdy: string[] = [];
    const pokryte = new Set<string>();
    let trafienia = 0;
    for (let i = 0; i < 500; i++) {
      const wFlow = l.r() < 0.7;
      const w = popraw(losowyWarunek(l, wFlow), l);
      const f = schematFiltraProfilu.parse({ grupy: [{ warunki: [w] }] });
      const k = wFlow ? kontekst(l) : null;
      if (w.typ === "metryka_profilu") pokryte.add(`${w.okno.od}:${w.operator}`);
      const r = await porownaj(f, k);
      if (r) rozjazdy.push(r);
      // zbior niepusty i niepelny: test nie przechodzi „na pustym”
      if (ostatniaLiczba > 0 && ostatniaLiczba < profile.length) trafienia++;
    }
    expect(rozjazdy.slice(0, 5)).toEqual([]);
    for (const okno of ["zawsze", "ostatnich_dni", "startu_flow"]) for (const op of OPERATORY_LICZNIKA) expect(pokryte.has(`${okno}:${op}`), `${okno}:${op}`).toBe(true);
    expect(trafienia).toBeGreaterThan(100);
  }, 60_000);

  it("150 filtrów złożonych (AND grup, OR warunków) mieszających historię i właściwości profilu", async () => {
    const l = losowanie(77);
    const rozjazdy: string[] = [];
    for (let i = 0; i < 150; i++) {
      const grupy: Filtr["grupy"] = [];
      for (let g = 0; g < 1 + Math.floor(l.r() * 3); g++) {
        grupy.push({ warunki: Array.from({ length: 1 + Math.floor(l.r() * 3) }, () => popraw(losowyWarunek(l, true), l)) });
      }
      const r = await porownaj(schematFiltra.parse({ grupy }), kontekst(l));
      if (r) rozjazdy.push(r);
    }
    expect(rozjazdy.slice(0, 5)).toEqual([]);
  }, 60_000);

  it("„Placed Order = 0 od startu flow”: zdarzenie wyzwalające się nie liczy, zakup sekundę po starcie już tak", async () => {
    const p = profile[0];
    const f: Filtr = { grupy: [{ warunki: [{ typ: "metryka_profilu", metryka: { nazwa: "Placed Order" }, operator: "rowna", wartosc: 0, okno: { od: "startu_flow" } }] }] };
    const klient = await getPool().connect();
    try {
      await klient.query("begin");
      const start = new Date("2026-09-20T10:00:00Z");
      const wyzw = await zapiszZdarzenie(klient, { tenantId, metryka: { integracja: "woocommerce", nazwa: "Placed Order" }, profileId: p.id, occurredAt: start, uniqueId: randomUUID(), properties: {}, source: "api" });
      const k = { flowId: flowy[0], start: start.toISOString(), zdarzenieWyzwalajaceId: wyzw.id, uczestnikId: null };
      const sprawdz = async () => {
        const q = zapytanieFiltrowane({ kolumny: "p.id", zrodloSql: "profiles p", alias: "p", tenantId, filtr: f, zrodlo: { profil: { properties: "p.properties", kolumny: { email: "p.email", first_name: "p.first_name", last_name: "p.last_name", phone_number: "p.phone" }, id: "p.id", tenantId: "p.tenant_id" } }, teraz: TERAZ, kontekst: k, koniec: `and p.id = '${p.id}'` });
        return (await klient.query(q.sql, q.parametry)).rowCount === 1;
      };
      // bez innych zakupow po starcie: przechodzi (inne zakupy tej osoby moga byc PRZED startem)
      const poStarcie = zdarzenia.get(p.id)!.filter((e) => e.nazwa === "Placed Order" && e.occurredAtMs >= start.getTime());
      expect(await sprawdz()).toBe(poStarcie.length === 0);
      await zapiszZdarzenie(klient, { tenantId, metryka: { integracja: "shopify", nazwa: "Placed Order" }, profileId: p.id, occurredAt: new Date(start.getTime() + 1000), uniqueId: randomUUID(), properties: {}, source: "api" });
      expect(await sprawdz()).toBe(false);
    } finally {
      await klient.query("rollback");
      klient.release();
    }
  });

  it("każde podzapytanie historii stoi na tenancie wiersza profilu; obcy tenant nie przecieka", async () => {
    const f: Filtr = { grupy: [{ warunki: [{ typ: "metryka_profilu", metryka: { nazwa: "Placed Order" }, operator: "wieksza_rowna", wartosc: 1, okno: { od: "zawsze" } }] }] };
    const q = zapytanieFiltrowane({ kolumny: "p.id", zrodloSql: "profiles p", alias: "p", tenantId: obcyId, filtr: f, zrodlo: { profil: { properties: "p.properties", kolumny: { email: "p.email", first_name: "p.first_name", last_name: "p.last_name", phone_number: "p.phone" }, id: "p.id", tenantId: "p.tenant_id" } }, teraz: TERAZ });
    expect(q.sql).toContain("me.tenant_id = p.tenant_id");
    expect(q.sql).toMatch(/where p\.tenant_id = \$1::uuid/);
    const { rows } = await getPool().query(q.sql, q.parametry);
    expect(rows).toHaveLength(1); // tylko profil obcego tenanta, nigdy nasze
    expect(profile.some((p) => p.id === rows[0].id)).toBe(false);
  });

  it("„od startu automatyzacji” poza automatyzacją: błąd, nie cichy wynik", () => {
    const f: Filtr = { grupy: [{ warunki: [{ typ: "metryka_profilu", metryka: { nazwa: "Placed Order" }, operator: "rowna", wartosc: 0, okno: { od: "startu_flow" } }] }] };
    expect(() => ocenFiltr(f, { historia: { zdarzenia: [], przebiegi: [] }, teraz: TERAZ })).toThrow(BladKontekstuFiltra);
    expect(() => zapytanieFiltrowane({ kolumny: "1", zrodloSql: "profiles p", alias: "p", tenantId, filtr: f, zrodlo: { profil: { properties: "p.properties", kolumny: { email: "p.email", first_name: "p.first_name", last_name: "p.last_name", phone_number: "p.phone" }, id: "p.id", tenantId: "p.tenant_id" } }, teraz: TERAZ })).toThrow(/poza automatyzacją/);
  });

  it("schematy: filtr wyzwalacza nie przyjmie historii, filtr profilu nie przyjmie właściwości zdarzenia; opis po polsku", () => {
    const historia = { grupy: [{ warunki: [{ typ: "metryka_profilu", metryka: { nazwa: "Placed Order" }, operator: "rowna", wartosc: 0, okno: { od: "startu_flow" } }] }] };
    expect(schematFiltraZdarzenia.safeParse(historia).success).toBe(false);
    expect(schematFiltraProfilu.safeParse(historia).success).toBe(true);
    expect(schematFiltraProfilu.safeParse({ grupy: [{ warunki: [{ typ: "wlasciwosc_zdarzenia", pole: "x", typPola: "string", operator: "rowna", wartosc: "a" }] }] }).success).toBe(false);
    // miedzy wymaga pary od <= do, pojedynczy operator jednej liczby
    expect(schematFiltraProfilu.safeParse({ grupy: [{ warunki: [{ ...historia.grupy[0].warunki[0], operator: "miedzy", wartosc: [3, 1] }] }] }).success).toBe(false);
    expect(schematFiltraProfilu.safeParse({ grupy: [{ warunki: [{ ...historia.grupy[0].warunki[0], wartosc: [0, 1] }] }] }).success).toBe(false);
    expect(schematFiltraProfilu.safeParse({ grupy: [{ warunki: [{ ...historia.grupy[0].warunki[0], wartosc: -1 }] }] }).success).toBe(false);
    expect(opiszFiltr(schematFiltraProfilu.parse(historia))).toBe("„Placed Order” (każde źródło) ani razu od wejścia do automatyzacji");
    expect(OPERATORY.number).toEqual(expect.arrayContaining([...OPERATORY_LICZNIKA]));
  });
});
