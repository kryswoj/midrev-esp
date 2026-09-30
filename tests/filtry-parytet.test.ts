import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { closePool, getPool } from "../src/adapters/db/pool";
import {
  BEZ_WARTOSCI,
  OPERATORY,
  POLA_STANDARDOWE_PROFILU,
  TYPY_POL,
  kompilujFiltr,
  ocenFiltr,
  Parametry,
  schematFiltra,
  type Filtr,
  type TypPola,
  type Warunek,
} from "../src/domain/filtry";

// Test parytetu (AD-42): dla wygenerowanych przypadkow ewaluator TS i kompilacja do SQL
// MUSZA dawac ten sam wynik. Generator jest deterministyczny (ziarno), a pula wartosci
// celowo mala, zeby warunki czesto trafialy: rowne/rozne, wielkosc liter, brak pola, null,
// typy niezgodne, daty poprawne i "prawie poprawne" (31 lutego), listy zagniezdzone,
// liczby calkowite i ulamki, JSON-owe 1.0 vs 1.

function losowanie(ziarno: number) {
  let s = ziarno >>> 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    r,
    wybierz: <T,>(t: readonly T[]): T => t[Math.floor(r() * t.length)],
  };
}

const TEKSTY = ["a", "A", "ab", "abc", "longevity", "Longevity", "", "x y", "żółć", "1", "true", "2026-09-30"];
const LICZBY = [0, 1, -1, 1.5, 2, 10, 100, 199.99, -0.5, 1e6];
const DATY = ["2026-09-30", "2026-09-29T23:00:00Z", "2026-09-30T12:00:00+02:00", "2026-02-31", "2026-01-01T00:00:00.123Z", "2025-12-31", "2026-10-05T10:00", "30.09.2026", "2026-09-30T25:00:00Z", "2026-09-24"];
const TERAZ = new Date("2026-09-30T12:00:00Z");

function losowaWartoscJson(l: ReturnType<typeof losowanie>): unknown {
  switch (Math.floor(l.r() * 9)) {
    case 0: return l.wybierz(TEKSTY);
    case 1: return l.wybierz(LICZBY);
    case 2: return l.r() < 0.5;
    case 3: return l.wybierz(DATY);
    case 4: return null;
    case 5: return [l.wybierz(TEKSTY), l.wybierz(LICZBY)];
    case 6: return [];
    case 7: return [[l.wybierz(TEKSTY)]];
    default: return { zagniezdzone: l.wybierz(TEKSTY) };
  }
}

const POLA = ["p1", "p2", "p3", "$value", "Product ID"];

function losoweProperties(l: ReturnType<typeof losowanie>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const p of POLA) if (l.r() < 0.75) o[p] = losowaWartoscJson(l);
  return o;
}

function losowaWartoscWarunku(l: ReturnType<typeof losowanie>, typ: TypPola, operator: string): unknown {
  if (BEZ_WARTOSCI.has(operator)) return undefined;
  switch (typ) {
    case "string":
      return operator === "jest_w" || operator === "nie_jest_w" ? [l.wybierz(TEKSTY), l.wybierz(TEKSTY)] : l.wybierz(TEKSTY);
    case "number": {
      if (operator === "miedzy") {
        const a = l.wybierz(LICZBY), b = l.wybierz(LICZBY);
        return [Math.min(a, b), Math.max(a, b)];
      }
      return l.wybierz(LICZBY);
    }
    case "date": {
      const poprawne = DATY.filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d) && d !== "2026-02-31" && !d.includes("T25"));
      if (operator === "w_ostatnich_dniach") return l.wybierz([1, 7, 30]);
      if (operator === "miedzy") return ["2026-09-01", "2026-09-30T12:00:00Z"];
      return l.wybierz(poprawne);
    }
    case "list":
      return l.r() < 0.6 ? l.wybierz(TEKSTY) : l.wybierz(LICZBY);
    default:
      return undefined;
  }
}

function losowyWarunek(l: ReturnType<typeof losowanie>): Warunek | null {
  const typPola = l.wybierz(TYPY_POL);
  const operator = l.wybierz(OPERATORY[typPola] as readonly string[]);
  const wartosc = losowaWartoscWarunku(l, typPola, operator);
  const kandydat: Warunek = l.r() < 0.6
    ? { typ: "wlasciwosc_zdarzenia", pole: l.wybierz(POLA), typPola, operator, wartosc } as Warunek
    : l.r() < 0.5
      ? { typ: "wlasciwosc_profilu", pole: { rodzaj: "standard", nazwa: l.wybierz(POLA_STANDARDOWE_PROFILU) }, typPola, operator, wartosc } as Warunek
      : { typ: "wlasciwosc_profilu", pole: { rodzaj: "wlasna", nazwa: l.wybierz(POLA) }, typPola, operator, wartosc } as Warunek;
  const f = schematFiltra.safeParse({ grupy: [{ warunki: [kandydat] }] });
  return f.success ? f.data.grupy[0].warunki[0] : null;
}

interface Wiersz {
  id: number;
  properties: Record<string, unknown>;
  profil: { email: string | null; first_name: string | null; last_name: string | null; phone_number: string | null; properties: Record<string, unknown> };
}

describe("Filtry: parytet TS vs SQL (wygenerowane przypadki)", () => {
  const TENANT = "01a00000-0000-7000-8000-00000000fa11";
  const INNY = "01a00000-0000-7000-8000-00000000fa12";
  let klient: pg.PoolClient;
  const wiersze: Wiersz[] = [];

  beforeAll(async () => {
    klient = await getPool().connect();
    await klient.query(`create temp table filtr_parytet (
      tenant_id uuid not null, id int not null, properties jsonb not null,
      email text, first_name text, last_name text, phone text, pprops jsonb not null)`);
    const l = losowanie(20260930);
    for (let i = 0; i < 80; i++) {
      const tekstLubNull = () => (l.r() < 0.3 ? null : l.wybierz(TEKSTY));
      wiersze.push({
        id: i,
        properties: losoweProperties(l),
        profil: { email: tekstLubNull(), first_name: tekstLubNull(), last_name: tekstLubNull(), phone_number: tekstLubNull(), properties: losoweProperties(l) },
      });
    }
    for (const w of wiersze) {
      for (const t of [TENANT, INNY]) {
        await klient.query(
          "insert into filtr_parytet values ($1, $2, $3, $4, $5, $6, $7, $8)",
          [t, w.id, JSON.stringify(w.properties), w.profil.email, w.profil.first_name, w.profil.last_name, w.profil.phone_number, JSON.stringify(w.profil.properties)],
        );
      }
    }
  });

  afterAll(async () => {
    await klient.query("drop table if exists filtr_parytet").catch(() => {});
    klient.release();
    await closePool();
  });

  const zrodlo = {
    zdarzenie: "t.properties",
    profil: { properties: "t.pprops", kolumny: { email: "t.email", first_name: "t.first_name", last_name: "t.last_name", phone_number: "t.phone" } },
  };

  async function porownaj(f: Filtr): Promise<string | null> {
    const p = new Parametry([TENANT]);
    const warunek = kompilujFiltr(f, zrodlo, p, TERAZ);
    const { rows } = await klient.query(`select t.id from filtr_parytet t where t.tenant_id = $1 and (${warunek}) order by t.id`, p.wartosci);
    const sql = rows.map((r) => r.id as number);
    const ts = wiersze.filter((w) => ocenFiltr(f, { zdarzenie: w.properties, profil: w.profil, teraz: TERAZ })).map((w) => w.id);
    if (JSON.stringify(sql) !== JSON.stringify(ts)) return `${JSON.stringify(f)}\n SQL: ${JSON.stringify(sql)}\n TS:  ${JSON.stringify(ts)}`;
    return null;
  }

  it("600 pojedynczych warunków: każdy typ i operator, ten sam zbiór wierszy", async () => {
    const l = losowanie(42);
    const rozjazdy: string[] = [];
    const pokryte = new Set<string>();
    let sprawdzone = 0;
    while (sprawdzone < 600) {
      const w = losowyWarunek(l);
      if (!w) continue;
      sprawdzone++;
      pokryte.add(`${w.typPola}:${w.operator}`);
      const r = await porownaj({ grupy: [{ warunki: [w] }] });
      if (r) rozjazdy.push(r);
    }
    expect(rozjazdy.slice(0, 5)).toEqual([]);
    // kazda para (typ, operator) wystapila przynajmniej raz
    for (const t of TYPY_POL) for (const o of OPERATORY[t]) expect(pokryte.has(`${t}:${o}`), `${t}:${o}`).toBe(true);
  });

  it("200 filtrów złożonych: grupy AND, warunki OR", async () => {
    const l = losowanie(7);
    const rozjazdy: string[] = [];
    for (let i = 0; i < 200; i++) {
      const grupy: Filtr["grupy"] = [];
      const ileGrup = 1 + Math.floor(l.r() * 3);
      for (let g = 0; g < ileGrup; g++) {
        const warunki: Warunek[] = [];
        const ile = 1 + Math.floor(l.r() * 4);
        while (warunki.length < ile) {
          const w = losowyWarunek(l);
          if (w) warunki.push(w);
        }
        grupy.push({ warunki });
      }
      const r = await porownaj({ grupy });
      if (r) rozjazdy.push(r);
    }
    expect(rozjazdy.slice(0, 5)).toEqual([]);
  });

  it("filtr pusty = wszystkie wiersze TEGO tenanta, żaden z innego", async () => {
    const p = new Parametry([TENANT]);
    const { rows } = await klient.query(`select count(*)::int as n from filtr_parytet t where t.tenant_id = $1 and (${kompilujFiltr({ grupy: [] }, zrodlo, p, TERAZ)})`, p.wartosci);
    expect(rows[0].n).toBe(wiersze.length);
  });

  it("zła data w danych (31 lutego, godzina 25) nie wywraca zapytania, tylko nie pasuje", async () => {
    const r = await porownaj({ grupy: [{ warunki: [{ typ: "wlasciwosc_zdarzenia", pole: "p1", typPola: "date", operator: "po", wartosc: "1990-01-01" }] }] });
    expect(r).toBeNull();
  });
});
