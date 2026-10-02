import { describe, expect, it } from "vitest";
import {
  grafDoZapisu,
  opiszWezel,
  ostrzezeniaGrafu,
  podniesDoV2,
  pustyGraf,
  schematGrafu,
  schematGrafuV1,
  triggerEventGrafu,
  zwalidujGraf,
  type Graf,
  type GrafV1,
} from "../src/domain/automatyzacje/graf";
import { kanonicznyJson } from "../src/usecases/tresc/zapisz-tresc";
import { BIBLIOTEKA } from "../src/usecases/automatyzacje/journeye";

// Graf v2 (E4a, story 4.1): wyzwalacz metryczny / listowy, ponowne wejscie. Upgrader v1 -> v2
// i zapis w najstarszym formacie, ktory wyraza graf (AD-46: rollback kodu czyta definicje).

const E1 = "01a00000-0000-7000-8000-000000000001";
const E2 = "01a00000-0000-7000-8000-000000000002";
const L1 = "01a00000-0000-7000-8000-000000000003";
const S1 = "01a00000-0000-7000-8000-000000000004";

/** Ksztalty v1 wystepujace w bazie: migracja 0019 (z opoznieniem i bez), kanwa, biblioteka. */
const DEFINICJE_V1: GrafV1[] = [
  // 0019: journey bez opoznienia
  { wersja: 1, start: "wyzwalacz", ustawienia: { wyjsciePoZakupie: false }, wezly: [
    { id: "wyzwalacz", typ: "wyzwalacz", zdarzenie: "popup.submitted", links: { next: "email" } },
    { id: "email", typ: "email", emailId: E1, links: { next: "koniec" } },
    { id: "koniec", typ: "koniec" },
  ] },
  // 0019: journey z opoznieniem, wyzwalacz zamowieniem
  { wersja: 1, start: "wyzwalacz", ustawienia: { wyjsciePoZakupie: false }, wezly: [
    { id: "wyzwalacz", typ: "wyzwalacz", zdarzenie: "order.created", links: { next: "opoznienie" } },
    { id: "opoznienie", typ: "opoznienie", ilosc: 60, jednostka: "minuty", links: { next: "email" } },
    { id: "email", typ: "email", emailId: E1, links: { next: "koniec" } },
    { id: "koniec", typ: "koniec" },
  ] },
  // kanwa: lista z masowymi, wszystkie typy wezlow, wyjscie po zakupie
  { wersja: 1, start: "wyzwalacz", ustawienia: { wyjsciePoZakupie: true }, wezly: [
    { id: "wyzwalacz", typ: "wyzwalacz", zdarzenie: "list.joined", listId: L1, takzeMasowe: true, links: { next: "cz" } },
    { id: "cz", typ: "czekaj_do", dni: [1, 3], godzina: "09:30", links: { next: "w" } },
    { id: "w", typ: "warunek", etykieta: "Segment?", regula: { rodzaj: "w_segmencie", segmentId: S1 }, links: { next_if_true: "ab", next_if_false: "k1" } },
    { id: "ab", typ: "ab_split", procentA: 30, links: { a: "e1", b: "p" } },
    { id: "e1", typ: "email", emailId: E1, links: { next: "k2" } },
    { id: "p", typ: "profil", akcja: { rodzaj: "usun_z_listy", listId: L1 }, links: { next: "e2" } },
    { id: "e2", typ: "email", emailId: E2, links: { next: "k3" } },
    { id: "k1", typ: "koniec" }, { id: "k2", typ: "koniec" }, { id: "k3", typ: "koniec" },
  ] },
  // szkic listowy bez wybranej listy (zapisywany przez kanwe v1)
  { wersja: 1, start: "wyzwalacz", ustawienia: { wyjsciePoZakupie: false }, wezly: [
    { id: "wyzwalacz", typ: "wyzwalacz", zdarzenie: "list.joined", links: { next: "koniec" } },
    { id: "koniec", typ: "koniec" },
  ] },
];

describe("Graf v2: upgrader v1 i zapis wstecznie zgodny", () => {
  it("każda definicja v1 parsuje się do v2 i zapisuje z powrotem bajt w bajt jako v1", () => {
    for (const v1 of DEFINICJE_V1) {
      expect(schematGrafuV1.safeParse(v1).success).toBe(true);
      const g = schematGrafu.parse(v1);
      expect(g.wersja).toBe(2);
      expect(g.ustawienia.ponowneWejscie).toEqual({ tryb: "raz" });
      expect(kanonicznyJson(grafDoZapisu(g))).toBe(kanonicznyJson(v1));
    }
  });

  it("upgrade nie zmienia przebiegu: te same węzły, krawędzie i start; wyzwalacz jako metryka wbudowana", () => {
    for (const v1 of DEFINICJE_V1) {
      const g = podniesDoV2(v1);
      expect(g.start).toBe(v1.start);
      expect(g.wezly.map((w) => w.id)).toEqual(v1.wezly.map((w) => w.id));
      for (let i = 0; i < v1.wezly.length; i++) {
        const a = v1.wezly[i], b = g.wezly[i];
        if (a.typ !== "wyzwalacz") expect(b).toEqual(a);
        else expect((b as { links: unknown }).links).toEqual(a.links);
      }
    }
    const pop = podniesDoV2(DEFINICJE_V1[0]).wezly[0];
    expect(pop).toMatchObject({ zrodlo: { rodzaj: "metryka", metryka: { integracja: "midrev", nazwa: "Submitted Form" } } });
    const zam = podniesDoV2(DEFINICJE_V1[1]).wezly[0];
    expect(zam).toMatchObject({ zrodlo: { rodzaj: "metryka", metryka: { integracja: "woocommerce", nazwa: "Placed Order" } } });
    expect(triggerEventGrafu(podniesDoV2(DEFINICJE_V1[2]))).toBe("list.joined");
  });

  it("walidacja v1 po upgradzie daje te same wyniki co przed (graf poprawny = poprawny)", () => {
    const ctx = { emaile: { [E1]: { temat: "A", maTresc: true }, [E2]: { temat: "B", maTresc: true } }, listy: new Set([L1]), segmenty: new Set([S1]) };
    for (const v1 of DEFINICJE_V1.slice(0, 3)) expect(zwalidujGraf(v1, ctx).bledy).toEqual([]);
    expect(zwalidujGraf(DEFINICJE_V1[3], ctx).bledy.map((b) => b.tresc)).toContain("Wyzwalacz „dołączenie do listy” wymaga wybrania listy.");
    // ostrzezenie "wartosc zamowienia zaraz po zamowieniu" dziala po upgradzie
    const zOstrzezeniem: GrafV1 = { wersja: 1, start: "wyzwalacz", ustawienia: { wyjsciePoZakupie: false }, wezly: [
      { id: "wyzwalacz", typ: "wyzwalacz", zdarzenie: "order.created", links: { next: "w" } },
      { id: "w", typ: "warunek", regula: { rodzaj: "wartosc_zamowienia", minMinor: 100 }, links: { next_if_true: "k", next_if_false: "k2" } },
      { id: "k", typ: "koniec" }, { id: "k2", typ: "koniec" },
    ] };
    expect(ostrzezeniaGrafu(schematGrafu.parse(zOstrzezeniem))).toHaveLength(1);
  });

  it("szablony biblioteki są v2 i zapisują się jako v1 (nic w nich nie wymaga v2)", () => {
    for (const s of BIBLIOTEKA) {
      const g = s.zbuduj((i) => [E1, E2, L1][i]);
      expect(g.wersja).toBe(2);
      expect(grafDoZapisu(g).wersja).toBe(1);
    }
  });

  it("graf z nową funkcją zostaje v2: filtr wyzwalacza, metryka niestandardowa, ponowne wejście", () => {
    const zFiltrem = pustyGraf({ rodzaj: "metryka", metryka: { integracja: "midrev", nazwa: "Submitted Form" }, filtr: { grupy: [{ warunki: [{ typ: "wlasciwosc_zdarzenia", pole: "form_id", typPola: "string", operator: "rowna", wartosc: "x" }] }] } });
    const wlasna = pustyGraf({ rodzaj: "metryka", metryka: { integracja: "api", nazwa: "Quiz Ukończony" } });
    const ponowne: Graf = { ...pustyGraf("popup.submitted"), ustawienia: { wyjsciePoZakupie: false, ponowneWejscie: { tryb: "po", ilosc: 30, jednostka: "dni" } } };
    for (const g of [zFiltrem, wlasna, ponowne]) {
      expect(grafDoZapisu(g).wersja).toBe(2);
      expect(kanonicznyJson(schematGrafu.parse(JSON.parse(JSON.stringify(grafDoZapisu(g)))))).toBe(kanonicznyJson(g));
    }
    expect(triggerEventGrafu(wlasna)).toBe("metryka:api:Quiz Ukończony");
    expect(opiszWezel(zFiltrem.wezly[0])).toContain("form_id równa się „x”");
  });

  it("błąd v1 ma czytelną ścieżkę (bez „invalid union”)", () => {
    const zly = { ...DEFINICJE_V1[0], wezly: [{ id: "wyzwalacz", typ: "wyzwalacz", zdarzenie: "nieznane", links: { next: "k" } }] };
    // sciezka zostaje czytelna w bledzie schematu (logi, testy)...
    const p = schematGrafu.safeParse(zly);
    expect(p.success).toBe(false);
    expect(p.error!.issues[0].path.join(".")).toBe("wezly.0.zdarzenie");
    // ...ale operator dostaje komunikat po polsku przy kroku, bez sciezki obiektu (fala 1 UX)
    const r = zwalidujGraf(zly);
    expect(r.graf).toBeNull();
    expect(r.bledy[0]).toMatchObject({ wezelId: "wyzwalacz" });
    expect(r.bledy[0].tresc).not.toMatch(/wezly\.|invalid/i);
  });
});

describe("Graf v2: walidacja wyzwalacza metrycznego i ponownego wejścia", () => {
  const metryki = new Map([
    ["api|Quiz Ukończony", { canTrigger: true }],
    ["midrev|Opened Email", { canTrigger: false }],
    ["api|Martwa", { canTrigger: false }],
  ]);

  it("metryka, która nie może wyzwalać (otwarcia, kliknięcia, can_trigger = false), blokuje włączenie", () => {
    for (const nazwa of ["Opened Email", "Clicked Email"]) {
      const g = pustyGraf({ rodzaj: "metryka", metryka: { integracja: "midrev", nazwa } });
      expect(zwalidujGraf(g).bledy.some((b) => b.tresc.includes("nie może uruchamiać"))).toBe(true);
    }
    const g = pustyGraf({ rodzaj: "metryka", metryka: { integracja: "api", nazwa: "Martwa" } });
    expect(zwalidujGraf(g, { metryki }).bledy.some((b) => b.tresc.includes("nie może uruchamiać"))).toBe(true);
  });

  it("metryka spoza katalogu tenanta blokuje; wbudowana v1 jest zawsze dozwolona", () => {
    expect(zwalidujGraf(pustyGraf({ rodzaj: "metryka", metryka: { integracja: "api", nazwa: "Inny tenant" } }), { metryki, grafV2Dostepny: true }).bledy.some((b) => b.tresc.includes("nie ma w tym koncie"))).toBe(true);
    expect(zwalidujGraf(pustyGraf({ rodzaj: "metryka", metryka: { integracja: "api", nazwa: "Quiz Ukończony" } }), { metryki, grafV2Dostepny: true }).bledy).toEqual([]);
    expect(zwalidujGraf(pustyGraf("order.created"), { metryki }).bledy).toEqual([]);
  });

  it("bez MIDREV_GRAF_V2: filtr wyzwalacza i metryka spoza wbudowanych blokują (definicja musi zostać v1 na wypadek rollbacku kodu)", () => {
    const wlasna = pustyGraf({ rodzaj: "metryka", metryka: { integracja: "api", nazwa: "Quiz Ukończony" } });
    const zFiltrem = pustyGraf({ rodzaj: "metryka", metryka: { integracja: "midrev", nazwa: "Submitted Form" }, filtr: { grupy: [{ warunki: [{ typ: "wlasciwosc_zdarzenia", pole: "form_id", typPola: "string", operator: "rowna", wartosc: "x" }] }] } });
    expect(zwalidujGraf(wlasna, { metryki }).bledy.some((b) => b.tresc.includes("MIDREV_GRAF_V2"))).toBe(true);
    expect(zwalidujGraf(zFiltrem).bledy.some((b) => b.tresc.includes("filtr wyzwalacza"))).toBe(true);
    expect(zwalidujGraf(zFiltrem, { grafV2Dostepny: true }).bledy).toEqual([]);
    expect(zwalidujGraf(pustyGraf("popup.submitted")).bledy).toEqual([]);
  });

  it("ponowne wejście inne niż „raz” blokuje włączenie, dopóki nie jest dostępne (przed 0036)", () => {
    const g: Graf = { ...pustyGraf("popup.submitted"), ustawienia: { wyjsciePoZakupie: false, ponowneWejscie: { tryb: "zawsze" } } };
    expect(zwalidujGraf(g).bledy.some((b) => b.tresc.includes("Ponowne wejście"))).toBe(true);
    expect(zwalidujGraf(g, { ponowneWejscieDostepne: false }).bledy.some((b) => b.tresc.includes("Ponowne wejście"))).toBe(true);
    expect(zwalidujGraf(g, { ponowneWejscieDostepne: true }).bledy).toEqual([]);
  });

  it("D4: nowe flow metryczne domyślnie „zawsze” (gdy dostępne), listowe i bez dostępności „raz”", () => {
    expect(pustyGraf("popup.submitted", undefined, { ponowneWejscieDostepne: true }).ustawienia.ponowneWejscie).toEqual({ tryb: "zawsze" });
    expect(pustyGraf("list.joined", L1, { ponowneWejscieDostepne: true }).ustawienia.ponowneWejscie).toEqual({ tryb: "raz" });
    expect(pustyGraf("popup.submitted").ustawienia.ponowneWejscie).toEqual({ tryb: "raz" });
  });
});
