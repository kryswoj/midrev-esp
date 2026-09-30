import { describe, expect, it } from "vitest";
import {
  kompilujFiltr,
  ocenFiltr,
  ocenWarunek,
  opiszFiltr,
  Parametry,
  parsujDate,
  schematFiltra,
  schematFiltraZdarzenia,
  schematWarunku,
  zapytanieFiltrowane,
  type Filtr,
  type Warunek,
} from "../src/domain/filtry";

// Wykonywalna specyfikacja jezyka filtrow (AD-42), czesc bez bazy. Parytet TS/SQL:
// tests/filtry-parytet.test.ts.

const TERAZ = new Date("2026-09-30T12:00:00Z");
const ev = (p: Record<string, unknown>) => ({ zdarzenie: p, teraz: TERAZ });
const w = (x: Omit<Extract<Warunek, { typ: "wlasciwosc_zdarzenia" }>, "typ">): Warunek => ({ typ: "wlasciwosc_zdarzenia", ...x });

describe("Filtry: semantyka", () => {
  it("tekst: dokładnie, z wielkością liter; zawiera / zaczyna się / jest w", () => {
    expect(ocenWarunek(w({ pole: "slug", typPola: "string", operator: "rowna", wartosc: "longevity" }), ev({ slug: "longevity" }))).toBe(true);
    expect(ocenWarunek(w({ pole: "slug", typPola: "string", operator: "rowna", wartosc: "longevity" }), ev({ slug: "Longevity" }))).toBe(false);
    expect(ocenWarunek(w({ pole: "slug", typPola: "string", operator: "zawiera", wartosc: "gev" }), ev({ slug: "longevity" }))).toBe(true);
    expect(ocenWarunek(w({ pole: "slug", typPola: "string", operator: "zaczyna_sie", wartosc: "long" }), ev({ slug: "longevity" }))).toBe(true);
    expect(ocenWarunek(w({ pole: "slug", typPola: "string", operator: "jest_w", wartosc: ["a", "longevity"] }), ev({ slug: "longevity" }))).toBe(true);
    expect(ocenWarunek(w({ pole: "slug", typPola: "string", operator: "nie_jest_w", wartosc: ["a"] }), ev({ slug: "longevity" }))).toBe(true);
  });

  it("brak pola: prawdziwe wyłącznie „nieustawione” (także dla operatorów przeczących)", () => {
    const brak = ev({});
    expect(ocenWarunek(w({ pole: "x", typPola: "string", operator: "rozna", wartosc: "a" }), brak)).toBe(false);
    expect(ocenWarunek(w({ pole: "x", typPola: "string", operator: "nie_zawiera", wartosc: "a" }), brak)).toBe(false);
    expect(ocenWarunek(w({ pole: "x", typPola: "list", operator: "nie_zawiera", wartosc: "a" }), brak)).toBe(false);
    expect(ocenWarunek(w({ pole: "x", typPola: "string", operator: "nieustawione" }), brak)).toBe(true);
    expect(ocenWarunek(w({ pole: "x", typPola: "string", operator: "nieustawione" }), ev({ x: null }))).toBe(true);
    expect(ocenWarunek(w({ pole: "x", typPola: "string", operator: "ustawione" }), ev({ x: "" }))).toBe(true);
  });

  it("niezgodny typ: fałsz, bez rzutowania (liczba w tekście nie jest liczbą)", () => {
    expect(ocenWarunek(w({ pole: "n", typPola: "number", operator: "rowna", wartosc: 5 }), ev({ n: "5" }))).toBe(false);
    expect(ocenWarunek(w({ pole: "n", typPola: "number", operator: "rozna", wartosc: 5 }), ev({ n: "5" }))).toBe(false);
    expect(ocenWarunek(w({ pole: "n", typPola: "string", operator: "rowna", wartosc: "5" }), ev({ n: 5 }))).toBe(false);
    expect(ocenWarunek(w({ pole: "b", typPola: "boolean", operator: "prawda" }), ev({ b: "true" }))).toBe(false);
    expect(ocenWarunek(w({ pole: "n", typPola: "number", operator: "miedzy", wartosc: [1, 10] }), ev({ n: 10 }))).toBe(true);
  });

  it("daty: tylko ISO z kontrolą pól; bez strefy = UTC; „w ostatnich N dniach” względem teraz", () => {
    expect(parsujDate("2026-02-31")).toBeNull();
    expect(parsujDate("2028-02-29")).not.toBeNull();
    expect(parsujDate("2026-09-30T10:00:00")).toBe(Date.UTC(2026, 8, 30, 10));
    expect(parsujDate("2026-09-30T12:00:00+02:00")).toBe(Date.UTC(2026, 8, 30, 10));
    expect(parsujDate("30.09.2026")).toBeNull();
    expect(parsujDate("0999-01-01")).toBeNull();
    const d = w({ pole: "d", typPola: "date", operator: "w_ostatnich_dniach", wartosc: 7 });
    expect(ocenWarunek(d, ev({ d: "2026-09-25" }))).toBe(true);
    expect(ocenWarunek(d, ev({ d: "2026-09-01" }))).toBe(false);
    expect(ocenWarunek(d, ev({ d: "2026-10-05" }))).toBe(false);
    expect(ocenWarunek(w({ pole: "d", typPola: "date", operator: "przed", wartosc: "2026-01-01" }), ev({ d: "2025-12-31T23:59:59Z" }))).toBe(true);
  });

  it("lista: zawiera element (porównanie elementu, nie zawieranie zagnieżdżone)", () => {
    const z = w({ pole: "items", typPola: "list", operator: "zawiera", wartosc: "a" });
    expect(ocenWarunek(z, ev({ items: ["b", "a"] }))).toBe(true);
    expect(ocenWarunek(z, ev({ items: [["a"]] }))).toBe(false);
    expect(ocenWarunek(w({ pole: "items", typPola: "list", operator: "pusta" }), ev({ items: [] }))).toBe(true);
    expect(ocenWarunek(w({ pole: "items", typPola: "list", operator: "pusta" }), ev({}))).toBe(false);
  });

  it("grupy AND, warunki w grupie OR: przypadek 6× ProductID w jednej grupie (konto Sports-med)", () => {
    const f: Filtr = {
      grupy: [
        { warunki: ["101", "102", "103", "104", "105", "106"].map((id) => w({ pole: "ProductID", typPola: "string", operator: "rowna", wartosc: id })) },
        { warunki: [w({ pole: "$value", typPola: "number", operator: "wieksza", wartosc: 100 })] },
      ],
    };
    expect(ocenFiltr(f, ev({ ProductID: "104", $value: 199 }))).toBe(true);
    expect(ocenFiltr(f, ev({ ProductID: "104", $value: 50 }))).toBe(false);
    expect(ocenFiltr(f, ev({ ProductID: "999", $value: 199 }))).toBe(false);
    expect(ocenFiltr({ grupy: [] }, ev({}))).toBe(true);
    expect(opiszFiltr(f)).toContain(" lub ");
  });

  it("właściwości z prototypu nie istnieją (__proto__, constructor)", () => {
    expect(ocenWarunek(w({ pole: "constructor", typPola: "string", operator: "ustawione" }), ev({}))).toBe(false);
    expect(ocenWarunek(w({ pole: "__proto__", typPola: "string", operator: "ustawione" }), ev({}))).toBe(false);
    const wlasny = JSON.parse('{"__proto__": "x"}');
    expect(ocenWarunek(w({ pole: "__proto__", typPola: "string", operator: "rowna", wartosc: "x" }), ev(wlasny))).toBe(true);
  });

  it("walidacja schematu: operator z innego typu i zła wartość są odrzucane", () => {
    expect(schematWarunku.safeParse({ typ: "wlasciwosc_zdarzenia", pole: "x", typPola: "number", operator: "zawiera", wartosc: "a" }).success).toBe(false);
    expect(schematWarunku.safeParse({ typ: "wlasciwosc_zdarzenia", pole: "x", typPola: "number", operator: "rowna", wartosc: "5" }).success).toBe(false);
    expect(schematWarunku.safeParse({ typ: "wlasciwosc_zdarzenia", pole: "x", typPola: "date", operator: "po", wartosc: "2026-02-30" }).success).toBe(false);
    expect(schematWarunku.safeParse({ typ: "wlasciwosc_zdarzenia", pole: "x", typPola: "string", operator: "ustawione", wartosc: "a" }).success).toBe(false);
    expect(schematFiltra.safeParse({ grupy: [{ warunki: [] }] }).success).toBe(false);
    // typy warunkow E4b nie przechodza (nie ma ich w silniku, wiec nie moze ich byc w definicji)
    expect(schematWarunku.safeParse({ typ: "metryka_profilu", metricId: "x" }).success).toBe(false);
  });
});

describe("Filtry: kompilacja do SQL", () => {
  it("klucze i wartości wyłącznie jako parametry; żadnego tekstu z definicji w SQL", () => {
    const zly = "x' or 1=1 --";
    const f: Filtr = { grupy: [{ warunki: [w({ pole: zly, typPola: "string", operator: "rowna", wartosc: zly })] }] };
    const p = new Parametry();
    const sql = kompilujFiltr(f, { zdarzenie: "e.properties" }, p, TERAZ);
    expect(sql).not.toContain(zly);
    expect(p.wartosci).toEqual([zly, zly]);
  });

  it("pełne zapytanie: predykat tenant_id = $1 składa helper (strukturalnie), alias walidowany", () => {
    const f: Filtr = { grupy: [{ warunki: [w({ pole: "a", typPola: "string", operator: "rowna", wartosc: "b" })] }] };
    const q = zapytanieFiltrowane({ kolumny: "t.id", zrodloSql: "metric_events t", alias: "t", tenantId: "01a00000-0000-7000-8000-000000000001", filtr: f, zrodlo: { zdarzenie: "t.properties" }, teraz: TERAZ });
    expect(q.sql).toMatch(/^select t\.id from metric_events t where t\.tenant_id = \$1::uuid and \(/);
    expect(q.parametry[0]).toBe("01a00000-0000-7000-8000-000000000001");
    expect(() => zapytanieFiltrowane({ kolumny: "1", zrodloSql: "x", alias: "t; drop table x", tenantId: "t", filtr: f, zrodlo: { zdarzenie: "t.properties" }, teraz: TERAZ })).toThrow(/alias/);
  });

  it("filtr wyzwalacza przyjmuje tylko warunki po zdarzeniu", () => {
    const profilowy = { grupy: [{ warunki: [{ typ: "wlasciwosc_profilu", pole: { rodzaj: "standard", nazwa: "email" }, typPola: "string", operator: "nieustawione" }] }] };
    expect(schematFiltra.safeParse(profilowy).success).toBe(true);
    expect(schematFiltraZdarzenia.safeParse(profilowy).success).toBe(false);
  });
});
