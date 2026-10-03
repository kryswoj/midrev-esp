import { BEZ_WARTOSCI, ETYKIETY_OPERATOROW, type Filtr, type OknoWarunku, type OperatorLicznika, type Warunek } from "./typy";

/** Operatory licznika jako slowa ("zrobil co najmniej 2 razy"). */
export const ETYKIETY_LICZNIKA: Record<OperatorLicznika, string> = {
  rowna: "dokładnie",
  rozna: "inaczej niż",
  wieksza: "więcej niż",
  wieksza_rowna: "co najmniej",
  mniejsza: "mniej niż",
  mniejsza_rowna: "najwyżej",
  miedzy: "od … do",
};

function razy(n: number): string {
  return n === 1 ? "raz" : "razy";
}

export function opiszOkno(o: OknoWarunku): string {
  if (o.od === "startu_flow") return "od wejścia do automatyzacji";
  if (o.od === "ostatnich_dni") return `w ostatnich ${o.dni} ${o.dni === 1 ? "dniu" : "dniach"}`;
  return "kiedykolwiek";
}

/** Jednozdaniowy opis warunku do kanwy i ścieżki osoby, np. `ProductID równa się „123”`. */
export function opiszWarunek(w: Warunek): string {
  if (w.typ === "metryka_profilu") {
    const m = `„${w.metryka.nazwa}”${w.metryka.integracja ? "" : " (każde źródło)"}`;
    const x = w.wartosc;
    const ile = Array.isArray(x)
      ? `od ${x[0]} do ${x[1]} razy`
      : w.operator === "rowna" && x === 0
        ? "ani razu"
        : `${ETYKIETY_LICZNIKA[w.operator]} ${x} ${razy(x)}`;
    const gdzie = w.gdzie?.length ? `, gdzie ${w.gdzie.map(opiszWarunek).join(" i ")}` : "";
    return `${m} ${ile} ${opiszOkno(w.okno)}${gdzie}`;
  }
  if (w.typ === "byl_w_flow") {
    const flow = w.flow === "biezacy" ? "w tej automatyzacji" : "we wskazanej automatyzacji";
    const okno = w.okno.od === "ostatnich_dni" ? ` w ostatnich ${w.okno.dni} dniach` : "";
    return `${w.jest ? "był" : "nie był"} ${flow}${okno}`;
  }
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
