/**
 * Skróty klawiszowe edytora maila jako czysta funkcja: zdarzenie + kontekst → akcja.
 *
 * Model jak w Canvie i Figmie (audyt UX 02.10, P1-6): pierwszy klik zaznacza blok, drugi
 * klik albo Enter wchodzi w tekst, Esc wychodzi z tekstu do zaznaczenia bloku, drugi Esc
 * odznacza. Delete, Backspace i Ctrl+D działają WYŁĄCZNIE na zaznaczonym bloku poza edycją
 * tekstu: w trakcie pisania Backspace kasuje literę, nigdy cały blok.
 *
 * Osobny plik bez Reacta, żeby tę regułę dało się sprawdzić testem (tests/edytor-klawisze).
 */

export type AkcjaKlawisza =
  | "zapisz"
  | "cofnij"
  | "ponow"
  | "usun"
  | "duplikuj"
  | "wejdzWTekst"
  | "wyjdzZTekstu"
  | "odznacz"
  | "poprzedni"
  | "nastepny"
  | "przesunWyzej"
  | "przesunNizej";

export interface Klawisz {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface KontekstKlawisza {
  /** fokus w polu formularza (input, textarea, select) — tam działa wszystko natywnie */
  wPolu: boolean;
  /** fokus w tekście edytowanym na płótnie (contenteditable) */
  wTekscie: boolean;
  /** fokus na przycisku albo linku: Enter i spacja mają go kliknąć, nie wchodzić w tekst */
  naPrzycisku: boolean;
  /** otwarte okno (biblioteka, szablony): skróty bloków nie mogą działać „pod spodem" */
  wOknie: boolean;
  /**
   * fokus na płótnie albo nigdzie (body). Backspace wciśnięty, gdy fokus stoi na przycisku
   * w panelu właściwości albo w pasku górnym, nie może skasować zaznaczonego bloku.
   */
  naPlotnie: boolean;
  /** jest zaznaczony blok */
  zaznaczony: boolean;
  /** edycja w ogóle możliwa (nie podgląd, nie treść zamrożona po wysyłce, nie telefon) */
  edycjaMozliwa: boolean;
}

export function akcjaKlawisza(e: Klawisz, k: KontekstKlawisza): AkcjaKlawisza | null {
  const mod = Boolean(e.ctrlKey || e.metaKey);
  const klawisz = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && klawisz === "s") return "zapisz";
  if (!k.edycjaMozliwa || k.wOknie) return null;
  // w polach panelu działa natywne cofanie przeglądarki; na płótnie (także w tekście) — nasze
  if (mod && !e.altKey && (klawisz === "z" || klawisz === "y") && !k.wPolu) {
    return klawisz === "y" || e.shiftKey ? "ponow" : "cofnij";
  }
  if (k.wPolu) return null;
  if (k.wTekscie) return klawisz === "Escape" ? "wyjdzZTekstu" : null;
  if (klawisz === "Escape") return "odznacz";
  if (!k.zaznaczony || !k.naPlotnie) return null;
  if ((klawisz === "Delete" || klawisz === "Backspace") && !mod) return "usun";
  if (mod && klawisz === "d") return "duplikuj";
  if (k.naPrzycisku) return null;
  if (klawisz === "Enter" && !mod && !e.altKey && !e.shiftKey) return "wejdzWTekst";
  if (klawisz === "ArrowUp") return e.altKey ? "przesunWyzej" : mod ? null : "poprzedni";
  if (klawisz === "ArrowDown") return e.altKey ? "przesunNizej" : mod ? null : "nastepny";
  return null;
}

/** Kontekst z celu zdarzenia DOM (wydzielony, żeby edytor nie liczył tego w kilku miejscach). */
export function kontekstZCelu(cel: EventTarget | null): Pick<KontekstKlawisza, "wPolu" | "wTekscie" | "naPrzycisku" | "wOknie" | "naPlotnie"> {
  const el = cel instanceof HTMLElement ? cel : null;
  return {
    naPlotnie: !el || el === document.body || Boolean(el.closest("[data-plotno]")),
    wPolu: Boolean(el?.closest("input, textarea, select")),
    wTekscie: Boolean(el?.isContentEditable),
    naPrzycisku: Boolean(el?.closest("button, a[href], [role='menuitem'], [role='radio']")),
    wOknie: Boolean(el?.closest("[role='dialog']")) || Boolean(document.querySelector("[aria-modal='true']")),
  };
}
