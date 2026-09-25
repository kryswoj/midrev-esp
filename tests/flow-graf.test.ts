import { describe, expect, it } from "vitest";
import {
  ostrzezeniaGrafu,
  cofnijGraf,
  nowaHistoriaGrafu,
  opiszWezel,
  ponowGraf,
  pustyGraf,
  usunWezel,
  wstawWezel,
  zapiszGraf,
  zwalidujGraf,
  type Graf,
  type Wezel,
} from "../src/domain/automatyzacje/graf";
import { sciezkaSvg, ulozGraf, SZEROKOSC_KARTY } from "../src/domain/automatyzacje/uklad";

// Wykonywalna specyfikacja grafu automatyzacji: czysta domena, bez bazy.

const EMAIL_ID = "01a00000-0000-7000-8000-000000000001";
const SEG_ID = "01a00000-0000-7000-8000-000000000002";
const LIST_ID = "01a00000-0000-7000-8000-000000000003";
const EMAIL_ID_2 = "01a00000-0000-7000-8000-000000000004";

function email(id: string, next: string | null, emailId = EMAIL_ID): Wezel {
  return { id, typ: "email", emailId, links: { next } };
}

function powitalny(): Graf {
  // wyzwalacz -> email1 -> opoznienie -> warunek(kupil?) -> [Tak: koniec] [Nie: email2 -> koniec]
  return {
    wersja: 1,
    start: "wyzwalacz",
    ustawienia: { wyjsciePoZakupie: false },
    wezly: [
      { id: "wyzwalacz", typ: "wyzwalacz", zdarzenie: "popup.submitted", links: { next: "e1" } },
      email("e1", "op"),
      { id: "op", typ: "opoznienie", ilosc: 2, jednostka: "dni", links: { next: "w" } },
      { id: "w", typ: "warunek", regula: { rodzaj: "kupil_od_wejscia" }, links: { next_if_true: "k1", next_if_false: "e2" } },
      { id: "k1", typ: "koniec" },
      email("e2", "k2", EMAIL_ID_2),
      { id: "k2", typ: "koniec" },
    ],
  };
}

const ctx = { emaile: { [EMAIL_ID]: { temat: "Witaj", maTresc: true }, [EMAIL_ID_2]: { temat: "Drugi", maTresc: true } }, listy: new Set([LIST_ID]), segmenty: new Set([SEG_ID]) };

describe("Graf automatyzacji: walidacja (bramka włączenia)", () => {
  it("poprawny graf powitalny z warunkiem przechodzi bez błędów", () => {
    const { graf, bledy } = zwalidujGraf(powitalny(), ctx);
    expect(graf).not.toBeNull();
    expect(bledy).toEqual([]);
  });

  it("gałąź bez końca blokuje: warunek z pustym „Nie”", () => {
    const g = powitalny();
    g.wezly = g.wezly.map((w) => (w.id === "w" ? { ...w, links: { next_if_true: "k1", next_if_false: null } } as Wezel : w)).filter((w) => !["e2", "k2"].includes(w.id));
    const { bledy } = zwalidujGraf(g, ctx);
    expect(bledy.map((b) => b.tresc)).toContain("Gałąź „Nie” nie ma końca.");
    expect(bledy.find((b) => b.tresc.includes("Nie"))?.wezelId).toBe("w");
  });

  it("pętla jest wykrywana: ostatni mail zawraca do opóźnienia", () => {
    const g = powitalny();
    g.wezly = g.wezly.map((w) => (w.id === "e2" ? email("e2", "op", EMAIL_ID_2) : w));
    const { bledy } = zwalidujGraf(g, ctx);
    expect(bledy.some((b) => b.tresc.includes("pętla"))).toBe(true);
  });

  it("brak wyzwalacza, pusty mail i krok odłączony od ścieżki to osobne, nazwane błędy", () => {
    const g = powitalny();
    g.wezly.push(email("sierota", "k2"));
    const { bledy } = zwalidujGraf(g, { ...ctx, emaile: { [EMAIL_ID]: { temat: "", maTresc: false } } });
    expect(bledy.some((b) => b.wezelId === "sierota" && b.tresc.includes("połączony"))).toBe(true);
    expect(bledy.some((b) => b.wezelId === "e1" && b.tresc.includes("tematu"))).toBe(true);

    const bezStartu = { ...powitalny(), wezly: powitalny().wezly.filter((w) => w.typ !== "wyzwalacz") };
    expect(zwalidujGraf(bezStartu, ctx).bledy.some((b) => b.tresc.includes("dokładnie jeden wyzwalacz"))).toBe(true);
  });

  it("ta sama wiadomość w dwóch krokach blokuje włączenie (druga osoba dostałaby ją raz)", () => {
    const g = powitalny();
    g.wezly = g.wezly.map((w) => (w.id === "e2" ? email("e2", "k2") : w));
    const { bledy } = zwalidujGraf(g, ctx);
    expect(bledy.some((b) => b.tresc.includes("w dwóch krokach"))).toBe(true);
  });

  it("R2#12: warunek wartości zamówienia zaraz po „złożone zamówienie” daje ostrzeżenie; po opóźnieniu już nie", () => {
    const bez = wstawWezel(pustyGraf("order.created"), { po: "wyzwalacz", port: "next" }, {
      id: "w", typ: "warunek", regula: { rodzaj: "wartosc_zamowienia", minMinor: 10000 }, links: { next_if_true: null, next_if_false: null },
    });
    expect(ostrzezeniaGrafu(bez).map((o) => o.wezelId)).toEqual(["w"]);
    const zOpoznieniem = wstawWezel(bez, { po: "wyzwalacz", port: "next" }, { id: "op", typ: "opoznienie", ilosc: 1, jednostka: "godziny", links: { next: null } });
    expect(ostrzezeniaGrafu(zOpoznieniem)).toEqual([]);
  });

  it("odrzuca definicję spoza schematu (np. zły procent testu A/B) z czytelnym komunikatem", () => {
    const g = powitalny() as any;
    g.wezly.push({ id: "ab", typ: "ab_split", procentA: 150, links: { a: "k1", b: "k2" } });
    const { graf, bledy } = zwalidujGraf(g, ctx);
    expect(graf).toBeNull();
    expect(bledy[0].tresc).toMatch(/nie przeszła walidacji/);
  });

  it("wyzwalacz „dołączenie do listy” wymaga istniejącej listy, a warunek segmentu istniejącego segmentu", () => {
    const g = pustyGraf("list.joined");
    expect(zwalidujGraf(g, ctx).bledy[0].tresc).toMatch(/wymaga wybrania listy/);
    const zeSegmentem = wstawWezel(pustyGraf("order.created"), { po: "wyzwalacz", port: "next" }, {
      id: "w", typ: "warunek", regula: { rodzaj: "w_segmencie", segmentId: "01a00000-0000-7000-8000-00000000dead" }, links: { next_if_true: null, next_if_false: null },
    });
    expect(zwalidujGraf(zeSegmentem, ctx).bledy.map((b) => b.tresc)).toContain("Segment z warunku już nie istnieje.");
  });
});

describe("Graf automatyzacji: operacje edytora", () => {
  it("wstawienie kroku liniowego przepina ścieżkę, a rozgałęzienia dostaje własne końce", () => {
    let g = pustyGraf("popup.submitted");
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, email("e1", null));
    expect((g.wezly.find((w) => w.id === "wyzwalacz") as any).links).toEqual({ next: "e1" });
    expect((g.wezly.find((w) => w.id === "e1") as any).links).toEqual({ next: "koniec" });

    g = wstawWezel(g, { po: "e1", port: "next" }, { id: "w", typ: "warunek", regula: { rodzaj: "ma_zgode" }, links: { next_if_true: null, next_if_false: null } });
    const w = g.wezly.find((x) => x.id === "w") as any;
    expect(w.links.next_if_true).toBe("koniec");
    const nowyKoniec = w.links.next_if_false;
    expect(g.wezly.find((x) => x.id === nowyKoniec)?.typ).toBe("koniec");
    expect(zwalidujGraf(g, ctx).bledy).toEqual([]);
  });

  it("usunięcie kroku liniowego zszywa ścieżkę, usunięcie warunku zostawia gałąź „Tak” i sprząta „Nie”", () => {
    const g = powitalny();
    const bezOpoznienia = usunWezel(g, "op");
    expect((bezOpoznienia.wezly.find((w) => w.id === "e1") as any).links).toEqual({ next: "w" });
    expect(bezOpoznienia.wezly.some((w) => w.id === "op")).toBe(false);

    const bezWarunku = usunWezel(g, "w");
    expect((bezWarunku.wezly.find((w) => w.id === "op") as any).links).toEqual({ next: "k1" });
    expect(bezWarunku.wezly.map((w) => w.id).sort()).toEqual(["e1", "k1", "op", "wyzwalacz"]);
    expect(zwalidujGraf(bezWarunku, ctx).bledy).toEqual([]);
  });

  it("wyzwalacza i końca nie da się usunąć", () => {
    const g = powitalny();
    expect(usunWezel(g, "wyzwalacz")).toBe(g);
    expect(usunWezel(g, "k1")).toBe(g);
  });

  it("historia: cofnij i ponów przywracają dokładnie poprzedni graf", () => {
    const a = pustyGraf("popup.submitted");
    const b = wstawWezel(a, { po: "wyzwalacz", port: "next" }, email("e1", null));
    let h = zapiszGraf(nowaHistoriaGrafu(a), b);
    expect(h.biezacy).toBe(b);
    h = cofnijGraf(h);
    expect(h.biezacy).toBe(a);
    h = ponowGraf(h);
    expect(h.biezacy).toBe(b);
  });

  it("opisy węzłów są po polsku i jednowierszowe", () => {
    const g = powitalny();
    expect(opiszWezel(g.wezly[0])).toBe("Gdy ktoś zapisze się przez formularz");
    expect(opiszWezel(g.wezly[2])).toBe("Czekaj 2 dni");
    expect(opiszWezel(g.wezly[3])).toBe("Czy kupił od wejścia do automatyzacji?");
    expect(opiszWezel({ id: "c", typ: "czekaj_do", dni: [1, 3], godzina: "09:30", links: { next: null } })).toBe("Do pn, śr, godz. 09:30");
  });
});

describe("Układ kanwy", () => {
  it("wyzwalacz na górze, ścieżka w dół, gałęzie warunku obok siebie i wyśrodkowane pod rodzicem", () => {
    const u = ulozGraf(powitalny(), () => 100);
    const poz = Object.fromEntries(u.wezly.map((w) => [w.id, w]));
    expect(poz.wyzwalacz.y).toBeLessThan(poz.e1.y);
    expect(poz.e1.y).toBeLessThan(poz.op.y);
    expect(poz.op.y).toBeLessThan(poz.w.y);
    // gałęzie Tak (k1) i Nie (e2) na tym samym poziomie, Tak po lewej
    expect(poz.k1.y).toBe(poz.e2.y);
    expect(poz.k1.x).toBeLessThan(poz.e2.x);
    // rodzic wyśrodkowany nad ROZPIĘTOŚCIĄ poddrzew dzieci (koniec jest węższy od karty)
    const srodekDzieci = (poz.k1.x + (poz.e2.x + poz.e2.w)) / 2;
    expect(Math.abs(poz.w.x + poz.w.w / 2 - srodekDzieci)).toBeLessThan(1);
    // liniowe kroki nie nachodzą na siebie w pionie
    expect(poz.e1.y).toBeGreaterThanOrEqual(poz.wyzwalacz.y + poz.wyzwalacz.h);
    expect(poz.e1.w).toBe(SZEROKOSC_KARTY);
    // każda krawędź ma szczelinę „+”, gałęzie warunku mają etykiety Tak / Nie
    expect(u.krawedzie).toHaveLength(6);
    const galezie = u.krawedzie.filter((k) => k.od === "w");
    expect(galezie.map((k) => k.etykieta)).toEqual(["Tak", "Nie"]);
    expect(galezie.every((k) => k.etykietaPunkt !== null && k.punkty.length === 4)).toBe(true);
    expect(u.szerokosc).toBeGreaterThan(SZEROKOSC_KARTY + 96);
  });

  it("ścieżka SVG łamanej ma zaokrąglone narożniki (Q) i zaczyna się od pierwszego punktu", () => {
    const d = sciezkaSvg([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 100, y: 40 }, { x: 100, y: 80 }]);
    expect(d.startsWith("M 0 0")).toBe(true);
    expect((d.match(/Q/g) ?? []).length).toBe(2);
    expect(d.endsWith("L 100 80")).toBe(true);
  });
});
