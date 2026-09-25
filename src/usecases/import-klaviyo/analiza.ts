import { czytajCsv } from "./csv";
import { otworzPlik } from "./pliki";

/**
 * Pierwsze przejscie po wgranym pliku: naglowki, probka i liczba wierszy. Strumieniowo,
 * wiec 50 MB nie laduje w pamieci; probka to pierwsze N rekordow, reszta jest tylko
 * liczona.
 */
export interface AnalizaPliku {
  naglowki: string[];
  probka: string[][];
  /** rekordy danych (bez naglowka), lacznie z uszkodzonymi */
  wierszy: number;
  uszkodzonych: number;
}

export const ROZMIAR_PROBKI = 20;

export async function przeanalizujPlik(sciezka: string, rozmiarProbki = ROZMIAR_PROBKI): Promise<AnalizaPliku | { blad: string }> {
  let naglowki: string[] | null = null;
  const probka: string[][] = [];
  let wierszy = 0;
  let uszkodzonych = 0;
  for await (const rekord of czytajCsv(otworzPlik(sciezka))) {
    if (!naglowki) {
      if (rekord.blad) return { blad: `Nagłówek pliku jest uszkodzony: ${rekord.blad}.` };
      naglowki = rekord.pola.map((p) => p.trim());
      if (naglowki.every((n) => !n)) return { blad: "Pierwsza linia pliku jest pusta. Plik CSV z Klaviyo zaczyna się od nazw kolumn." };
      continue;
    }
    wierszy += 1;
    if (rekord.blad) uszkodzonych += 1;
    if (probka.length < rozmiarProbki) probka.push(dopasuj(rekord.pola, naglowki.length));
  }
  if (!naglowki) return { blad: "Plik jest pusty." };
  if (wierszy === 0) return { blad: "Plik ma tylko nagłówek, bez ani jednego wiersza danych." };
  return { naglowki, probka, wierszy, uszkodzonych };
}

/** Wiersz wyrownany do liczby kolumn naglowka: brakujace puste, nadmiarowe uciete. */
export function dopasuj(pola: string[], ile: number): string[] {
  if (pola.length === ile) return pola;
  const w = pola.slice(0, ile);
  while (w.length < ile) w.push("");
  return w;
}
