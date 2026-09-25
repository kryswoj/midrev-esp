import { kopiaBloku } from "./fabryka";
import type { Blok, DokumentMaila } from "./schemat";

/**
 * Operacje edytora na dokumencie — czyste funkcje, bez Reacta. Każda zwraca NOWY dokument
 * (niezmienność jest warunkiem historii cofania: stan sprzed zmiany musi przetrwać).
 */

export function wstawBlok(d: DokumentMaila, blok: Blok, indeks: number): DokumentMaila {
  const i = Math.max(0, Math.min(indeks, d.bloki.length));
  return { ...d, bloki: [...d.bloki.slice(0, i), blok, ...d.bloki.slice(i)] };
}

export function usunBlok(d: DokumentMaila, id: string): DokumentMaila {
  return { ...d, bloki: d.bloki.filter((b) => b.id !== id) };
}

export function duplikujBlok(d: DokumentMaila, id: string): { dokument: DokumentMaila; noweId: string | null } {
  const i = d.bloki.findIndex((b) => b.id === id);
  if (i === -1) return { dokument: d, noweId: null };
  const kopia = kopiaBloku(d.bloki[i]);
  return { dokument: wstawBlok(d, kopia, i + 1), noweId: kopia.id };
}

/** Przeniesienie bloku z pozycji `z` na pozycję `na` (indeksy w tablicy PRZED zmianą). */
export function przeniesBlok(d: DokumentMaila, z: number, na: number): DokumentMaila {
  if (z === na || z < 0 || z >= d.bloki.length) return d;
  const bloki = [...d.bloki];
  const [blok] = bloki.splice(z, 1);
  bloki.splice(Math.max(0, Math.min(na, bloki.length)), 0, blok);
  return { ...d, bloki };
}

export function przesunBlok(d: DokumentMaila, id: string, kierunek: -1 | 1): DokumentMaila {
  const i = d.bloki.findIndex((b) => b.id === id);
  if (i === -1) return d;
  return przeniesBlok(d, i, i + kierunek);
}

export function zmienBlok(d: DokumentMaila, id: string, zmiany: Partial<Blok>): DokumentMaila {
  return { ...d, bloki: d.bloki.map((b) => (b.id === id ? ({ ...b, ...zmiany, id: b.id, typ: b.typ } as Blok) : b)) };
}

// ── Historia cofania ─────────────────────────────────────────────────────────────

export interface Historia {
  przeszlosc: DokumentMaila[];
  biezacy: DokumentMaila;
  przyszlosc: DokumentMaila[];
  /** klucz scalania: kolejne zmiany z tym samym kluczem w krótkim oknie to JEDEN krok cofania */
  ostatniKlucz: string | null;
  ostatniCzas: number;
}

export const LIMIT_HISTORII = 100;
const OKNO_SCALANIA_MS = 800;

export function nowaHistoria(d: DokumentMaila): Historia {
  return { przeszlosc: [], biezacy: d, przyszlosc: [], ostatniKlucz: null, ostatniCzas: 0 };
}

/**
 * Nowy stan w historii. Pisanie w polu generuje zmianę na każdy znak — z kluczem scalania
 * (np. `tekst:<id>`) seria szybkich zmian tego samego pola to jeden krok Ctrl+Z,
 * tak jak w każdym edytorze tekstu.
 */
export function zapiszWHistorii(h: Historia, d: DokumentMaila, klucz: string | null = null, teraz = Date.now()): Historia {
  if (d === h.biezacy) return h;
  const scal = klucz !== null && klucz === h.ostatniKlucz && teraz - h.ostatniCzas < OKNO_SCALANIA_MS;
  if (scal) return { ...h, biezacy: d, przyszlosc: [], ostatniCzas: teraz };
  const przeszlosc = [...h.przeszlosc, h.biezacy].slice(-LIMIT_HISTORII);
  return { przeszlosc, biezacy: d, przyszlosc: [], ostatniKlucz: klucz, ostatniCzas: teraz };
}

export function cofnij(h: Historia): Historia {
  if (!h.przeszlosc.length) return h;
  const poprzedni = h.przeszlosc[h.przeszlosc.length - 1];
  return { przeszlosc: h.przeszlosc.slice(0, -1), biezacy: poprzedni, przyszlosc: [h.biezacy, ...h.przyszlosc], ostatniKlucz: null, ostatniCzas: 0 };
}

export function ponow(h: Historia): Historia {
  if (!h.przyszlosc.length) return h;
  const [nastepny, ...reszta] = h.przyszlosc;
  return { przeszlosc: [...h.przeszlosc, h.biezacy], biezacy: nastepny, przyszlosc: reszta, ostatniKlucz: null, ostatniCzas: 0 };
}
