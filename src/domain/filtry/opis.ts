import { BEZ_WARTOSCI, ETYKIETY_OPERATOROW, type Filtr, type Warunek } from "./typy";

/** Jednozdaniowy opis warunku do kanwy i ścieżki osoby, np. `ProductID równa się „123”`. */
export function opiszWarunek(w: Warunek): string {
  const pole = w.typ === "wlasciwosc_zdarzenia" ? w.pole : `profil.${w.pole.nazwa}`;
  const op = ETYKIETY_OPERATOROW[w.operator as keyof typeof ETYKIETY_OPERATOROW] ?? w.operator;
  if (BEZ_WARTOSCI.has(w.operator)) return `${pole} ${op}`;
  const x = w.wartosc;
  let wartosc: string;
  if (Array.isArray(x)) wartosc = w.operator === "miedzy" ? `${x[0]} i ${x[1]}` : x.map((e) => `„${e}”`).join(", ");
  else if (w.operator === "w_ostatnich_dniach") wartosc = `${x} dni`;
  else wartosc = typeof x === "string" ? `„${x}”` : String(x);
  return `${pole} ${op} ${wartosc}`;
}

export function opiszFiltr(f: Filtr | null | undefined): string {
  if (!f || !f.grupy.length) return "";
  return f.grupy
    .map((g) => (g.warunki.length > 1 ? `(${g.warunki.map(opiszWarunek).join(" lub ")})` : opiszWarunek(g.warunki[0])))
    .join(" i ");
}
