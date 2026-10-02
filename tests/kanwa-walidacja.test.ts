import { describe, expect, it } from "vitest";
import {
  BLAD_BEZ_AKCJI,
  bledySchematuGrafu,
  niedokonczoneWarunki,
  pustyGraf,
  schematGrafu,
  szkicDoZapisu,
  wstawWezel,
  zwalidujGraf,
  type Graf,
} from "../src/domain/automatyzacje/graf";

// Fala 1 UX (pkt 3): pusty warunek filtra to stan roboczy, nie blad grafu; komunikaty po
// polsku przy kroku; flow bez akcji nie jest "Gotowy do wlaczenia".

const E1 = "01a00000-0000-7000-8000-000000000001";

function zFiltrem(warunki: unknown[][]): Graf {
  const g = pustyGraf({ rodzaj: "metryka", metryka: { integracja: "midrev", nazwa: "Submitted Form" } });
  const zmieniony = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "mail", typ: "email", emailId: E1, links: { next: null } });
  return {
    ...zmieniony,
    wezly: zmieniony.wezly.map((w) =>
      w.typ === "wyzwalacz" && w.zrodlo.rodzaj === "metryka"
        ? ({ ...w, zrodlo: { ...w.zrodlo, filtr: { grupy: warunki.map((ws) => ({ warunki: ws })) } } } as typeof w)
        : w,
    ),
  };
}

const pusty = { typ: "wlasciwosc_zdarzenia", pole: "", typPola: "string", operator: "rowna", wartosc: "" };
const pelny = { typ: "wlasciwosc_zdarzenia", pole: "ProductID", typPola: "string", operator: "rowna", wartosc: "123" };
const bezWartosci = { typ: "wlasciwosc_zdarzenia", pole: "Cena", typPola: "number", operator: "miedzy", wartosc: [10, 1] };

describe("Szkic roboczy: niedokończone warunki", () => {
  it("pusty warunek nie przechodzi schematu, ale szkic do zapisu go pomija i jest poprawnym grafem", () => {
    const g = zFiltrem([[pusty]]);
    expect(schematGrafu.safeParse(g).success).toBe(false);
    const n = niedokonczoneWarunki(g);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ wezelId: "wyzwalacz", grupa: 0, warunek: 0 });
    expect(n[0].tresc).toBe("Wpisz nazwę właściwości zdarzenia albo usuń pusty warunek.");
    const s = szkicDoZapisu(g);
    expect(schematGrafu.safeParse(s).success).toBe(true);
    const w = s.wezly.find((x) => x.typ === "wyzwalacz")!;
    // filtr bez grup znika calkiem: zapis w v1 wciaz mozliwy (rollback kodu)
    expect(w.typ === "wyzwalacz" && w.zrodlo.rodzaj === "metryka" && w.zrodlo.filtr).toBeUndefined();
  });

  it("zostawia dokończone warunki i grupy, usuwa tylko niedokończone", () => {
    const g = zFiltrem([[pelny, pusty], [bezWartosci]]);
    const s = szkicDoZapisu(g);
    const w = s.wezly.find((x) => x.typ === "wyzwalacz")!;
    expect(w.typ === "wyzwalacz" && w.zrodlo.rodzaj === "metryka" ? w.zrodlo.filtr : null).toEqual({ grupy: [{ warunki: [pelny] }] });
    expect(niedokonczoneWarunki(g).map((x) => [x.grupa, x.warunek])).toEqual([[0, 1], [1, 0]]);
    expect(niedokonczoneWarunki(g)[1].tresc).toMatch(/^Uzupełnij wartość warunku „Cena”/);
  });

  it("graf bez niedokończonych warunków wraca jako ten sam obiekt (bez zmian w zapisie)", () => {
    const g = zFiltrem([[pelny]]);
    expect(szkicDoZapisu(g)).toBe(g);
    const p = pustyGraf("popup.submitted");
    expect(szkicDoZapisu(p)).toBe(p);
  });
});

describe("Komunikaty walidacji po polsku", () => {
  it("niedokończony warunek w surowej definicji daje komunikat przy wyzwalaczu, bez ścieżki i angielskiego", () => {
    const { graf, bledy } = zwalidujGraf(zFiltrem([[pusty]]));
    expect(graf).toBeNull();
    expect(bledy).toHaveLength(1);
    expect(bledy[0].wezelId).toBe("wyzwalacz");
    expect(bledy[0].tresc).not.toMatch(/wezly\.|Too small|expected|zrodlo/);
    expect(bledy[0].tresc).toMatch(/niedokończony warunek/);
  });

  it("nieznane błędy schematu nie zdradzają ścieżki obiektu", () => {
    const b = bledySchematuGrafu({ wezly: [{ id: "x", typ: "opoznienie" }] }, [{ path: ["wezly", 0, "ilosc"], message: "Too small" }]);
    expect(b).toEqual([{ wezelId: "x", tresc: "Krok „Opóźnienie”: podaj liczbę od 1 do 100 000." }]);
    const ogolny = bledySchematuGrafu({}, [{ path: ["start"], message: "Required" }]);
    expect(ogolny[0].tresc).not.toMatch(/start|Required/);
  });
});

describe("Bramka: co najmniej jedna akcja", () => {
  it("wyzwalacz -> koniec nie jest gotowy do włączenia", () => {
    const { bledy } = zwalidujGraf(pustyGraf("popup.submitted"), { wymagajAkcji: true });
    expect(bledy).toEqual([{ wezelId: "wyzwalacz", tresc: BLAD_BEZ_AKCJI }]);
  });

  it("sam warunek bez akcji też nie wystarcza; e-mail na dowolnej gałęzi wystarcza", () => {
    const g0 = pustyGraf("popup.submitted");
    const zWarunkiem = wstawWezel(g0, { po: "wyzwalacz", port: "next" }, { id: "w", typ: "warunek", regula: { rodzaj: "ma_zgode" }, links: { next_if_true: null, next_if_false: null } });
    expect(zwalidujGraf(zWarunkiem, { wymagajAkcji: true }).bledy.map((b) => b.tresc)).toContain(BLAD_BEZ_AKCJI);
    const zMailem = wstawWezel(zWarunkiem, { po: "w", port: "next_if_false" }, { id: "m", typ: "email", emailId: E1, links: { next: null } });
    expect(zwalidujGraf(zMailem, { wymagajAkcji: true }).bledy).toEqual([]);
  });

  it("bez flagi (dotychczasowi wywołujący) reguła nie działa", () => {
    expect(zwalidujGraf(pustyGraf("popup.submitted")).bledy).toEqual([]);
  });
});
