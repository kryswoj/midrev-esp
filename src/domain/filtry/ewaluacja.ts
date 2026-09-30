import { parsujDate, type Filtr, type PoleStandardoweProfilu, type Warunek } from "./typy";

/**
 * Ewaluacja filtra w TS dla JEDNEGO zdarzenia i JEDNEGO profilu (filtr wyzwalacza liczy sie
 * na wierszu, ktory silnik juz ma w pamieci). Semantyka jest opisana w `typy.ts`; ta sama
 * semantyka w SQL to `sql.ts`, a zgodnosc obu pilnuje test parytetu na wygenerowanych
 * przypadkach (tests/filtry-parytet.test.ts).
 */

export interface ProfilDoFiltra {
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone_number?: string | null;
  properties?: Record<string, unknown> | null;
}

export interface DaneDoFiltra {
  /** properties zdarzenia (top-level, jak w Klaviyo) */
  zdarzenie?: Record<string, unknown> | null;
  profil?: ProfilDoFiltra | null;
  /** "teraz" dla operatora "w ostatnich N dniach"; musi byc tym samym, co idzie do SQL */
  teraz: Date;
}

const DZIEN_MS = 86_400_000;

/** Wlasna wlasciwosc obiektu (nigdy z prototypu: `__proto__`, `constructor`). */
function wlasna(obj: Record<string, unknown> | null | undefined, klucz: string): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  return Object.prototype.hasOwnProperty.call(obj, klucz) ? obj[klucz] : undefined;
}

function wartoscPola(w: Warunek, d: DaneDoFiltra): unknown {
  if (w.typ === "wlasciwosc_zdarzenia") return wlasna(d.zdarzenie ?? null, w.pole);
  if (w.pole.rodzaj === "standard") {
    const v = d.profil?.[w.pole.nazwa as PoleStandardoweProfilu];
    return v ?? undefined;
  }
  return wlasna(d.profil?.properties ?? null, w.pole.nazwa);
}

function liczba(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e300 ? v : null;
}

function rowneJson(a: unknown, b: unknown): boolean {
  // elementy listy porownujemy tylko z prymitywem (wartosc warunku jest prymitywem)
  return (typeof a === "string" || typeof a === "number" || typeof a === "boolean") && a === b;
}

export function ocenWarunek(w: Warunek, d: DaneDoFiltra): boolean {
  const v = wartoscPola(w, d);
  const ustawione = v !== undefined && v !== null;
  if (w.operator === "ustawione") return ustawione;
  if (w.operator === "nieustawione") return !ustawione;
  if (!ustawione) return false;
  const x = w.wartosc as unknown;
  switch (w.typPola) {
    case "string": {
      if (typeof v !== "string") return false;
      switch (w.operator) {
        case "rowna": return v === x;
        case "rozna": return v !== x;
        case "zawiera": return v.includes(x as string);
        case "nie_zawiera": return !v.includes(x as string);
        case "zaczyna_sie": return v.startsWith(x as string);
        case "jest_w": return (x as string[]).includes(v);
        case "nie_jest_w": return !(x as string[]).includes(v);
      }
      return false;
    }
    case "number": {
      const n = liczba(v);
      if (n === null) return false;
      switch (w.operator) {
        case "rowna": return n === x;
        case "rozna": return n !== x;
        case "wieksza": return n > (x as number);
        case "wieksza_rowna": return n >= (x as number);
        case "mniejsza": return n < (x as number);
        case "mniejsza_rowna": return n <= (x as number);
        case "miedzy": return n >= (x as number[])[0] && n <= (x as number[])[1];
      }
      return false;
    }
    case "boolean":
      if (typeof v !== "boolean") return false;
      return w.operator === "prawda" ? v === true : w.operator === "falsz" ? v === false : false;
    case "date": {
      const t = parsujDate(v);
      if (t === null) return false;
      switch (w.operator) {
        case "przed": return t < parsujDate(x)!;
        case "po": return t > parsujDate(x)!;
        case "miedzy": return t >= parsujDate((x as string[])[0])! && t <= parsujDate((x as string[])[1])!;
        case "w_ostatnich_dniach": {
          const teraz = d.teraz.getTime();
          return t >= teraz - (x as number) * DZIEN_MS && t <= teraz;
        }
      }
      return false;
    }
    case "list": {
      if (!Array.isArray(v)) return false;
      switch (w.operator) {
        case "zawiera": return v.some((e) => rowneJson(e, x));
        case "nie_zawiera": return !v.some((e) => rowneJson(e, x));
        case "pusta": return v.length === 0;
        case "niepusta": return v.length > 0;
      }
      return false;
    }
  }
}

/** Grupy AND, warunki w grupie OR. Pusty filtr (bez grup) przepuszcza wszystko. */
export function ocenFiltr(f: Filtr | null | undefined, d: DaneDoFiltra): boolean {
  if (!f) return true;
  return f.grupy.every((g) => g.warunki.some((w) => ocenWarunek(w, d)));
}
