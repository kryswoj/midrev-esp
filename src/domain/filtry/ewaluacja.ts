import { parsujDate, type Filtr, type PoleStandardoweProfilu, type Warunek, type WarunekFlow, type WarunekMetryki } from "./typy";

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

/** Zdarzenie z historii profilu (warunek `metryka_profilu`). */
export interface ZdarzenieProfilu {
  id: string;
  integracja: string;
  nazwa: string;
  occurredAtMs: number;
  properties: Record<string, unknown>;
}

/** Przebieg osoby w automatyzacji (warunek `byl_w_flow`). */
export interface PrzebiegProfilu {
  id: string;
  flowId: string;
  enteredAtMs: number;
}

/**
 * Kontekst automatyzacji, w ktorej liczony jest filtr: `od startu flow` i `ten flow`.
 * W SQL te same wartosci ida jako parametry (`KontekstFlowSql`).
 */
export interface KontekstFlow {
  flowId: string;
  /** wejscie osoby (entered_at przebiegu = czas zdarzenia wyzwalajacego) */
  startMs: number;
  /** zdarzenie, ktore wprowadzilo osobe: nie liczy sie "od startu flow" */
  zdarzenieWyzwalajaceId: string | null;
  /** biezacy przebieg: nie liczy sie w "byl w tej automatyzacji" */
  uczestnikId: string | null;
}

export interface DaneDoFiltra {
  /** properties zdarzenia (top-level, jak w Klaviyo) */
  zdarzenie?: Record<string, unknown> | null;
  profil?: ProfilDoFiltra | null;
  /** historia profilu: zdarzenia i przebiegi (w silniku liczy je SQL; tu dla testow parytetu) */
  historia?: { zdarzenia: ZdarzenieProfilu[]; przebiegi: PrzebiegProfilu[] } | null;
  flow?: KontekstFlow | null;
  /** "teraz" dla operatora "w ostatnich N dniach"; musi byc tym samym, co idzie do SQL */
  teraz: Date;
}

const DZIEN_MS = 86_400_000;

/** Wlasna wlasciwosc obiektu (nigdy z prototypu: `__proto__`, `constructor`). */
function wlasna(obj: Record<string, unknown> | null | undefined, klucz: string): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  return Object.prototype.hasOwnProperty.call(obj, klucz) ? obj[klucz] : undefined;
}

function wartoscPola(w: Extract<Warunek, { typ: "wlasciwosc_zdarzenia" | "wlasciwosc_profilu" }>, d: DaneDoFiltra): unknown {
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

/** Porownanie licznika z wartoscia warunku (operatory liczby, bez rzutowania). */
export function porownajLicznik(n: number, operator: WarunekMetryki["operator"], x: WarunekMetryki["wartosc"]): boolean {
  if (operator === "miedzy") {
    const [a, b] = x as [number, number];
    return n >= a && n <= b;
  }
  const v = x as number;
  switch (operator) {
    case "rowna": return n === v;
    case "rozna": return n !== v;
    case "wieksza": return n > v;
    case "wieksza_rowna": return n >= v;
    case "mniejsza": return n < v;
    case "mniejsza_rowna": return n <= v;
  }
}

/** Blad konfiguracji: warunek "od startu flow" liczony poza automatyzacja. */
export class BladKontekstuFiltra extends Error {}

function ocenMetryke(w: WarunekMetryki, d: DaneDoFiltra): boolean {
  if (!d.historia) throw new BladKontekstuFiltra("filtr: warunek po historii profilu bez historii");
  let od = -Infinity;
  let wyklucz: string | null = null;
  if (w.okno.od === "startu_flow") {
    if (!d.flow) throw new BladKontekstuFiltra("filtr: „od startu automatyzacji” poza automatyzacją");
    od = d.flow.startMs;
    wyklucz = d.flow.zdarzenieWyzwalajaceId;
  } else if (w.okno.od === "ostatnich_dni") {
    od = d.teraz.getTime() - w.okno.dni * DZIEN_MS;
  }
  const n = d.historia.zdarzenia.filter(
    (e) =>
      e.nazwa === w.metryka.nazwa &&
      (w.metryka.integracja === undefined || e.integracja === w.metryka.integracja) &&
      e.occurredAtMs >= od &&
      e.occurredAtMs <= d.teraz.getTime() &&
      e.id !== wyklucz &&
      (w.gdzie ?? []).every((g) => ocenWarunek(g, { zdarzenie: e.properties, teraz: d.teraz })),
  ).length;
  return porownajLicznik(n, w.operator, w.wartosc);
}

function ocenFlow(w: WarunekFlow, d: DaneDoFiltra): boolean {
  if (!d.historia) throw new BladKontekstuFiltra("filtr: warunek po historii profilu bez historii");
  let flowId: string;
  if (w.flow === "biezacy") {
    if (!d.flow) throw new BladKontekstuFiltra("filtr: „ta automatyzacja” poza automatyzacją");
    flowId = d.flow.flowId;
  } else flowId = w.flow;
  const od = w.okno.od === "ostatnich_dni" ? d.teraz.getTime() - w.okno.dni * DZIEN_MS : -Infinity;
  const byl = d.historia.przebiegi.some((p) => p.flowId === flowId && p.enteredAtMs >= od && p.enteredAtMs <= d.teraz.getTime() && p.id !== (d.flow?.uczestnikId ?? null));
  return byl === w.jest;
}

export function ocenWarunek(w: Warunek, d: DaneDoFiltra): boolean {
  if (w.typ === "metryka_profilu") return ocenMetryke(w, d);
  if (w.typ === "byl_w_flow") return ocenFlow(w, d);
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
