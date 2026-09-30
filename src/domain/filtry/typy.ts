import { z } from "zod";

/**
 * Jeden jezyk filtrow (AD-42). To samo AST obsluguje filtr wyzwalacza, a w kolejnych
 * etapach splity, filtr profilu, dodatkowe filtry wiadomosci i segmenty.
 *
 *   Filtr   = { grupy: Grupa[] }        grupy laczone AND
 *   Grupa   = { warunki: Warunek[] }    warunki w grupie laczone OR (jak w Klaviyo:
 *                                       6x ProductID w jednej grupie = "ktorykolwiek")
 *
 * Semantyka (jedna dla ewaluatora TS i kompilatora SQL, pilnuje jej test parytetu):
 *  - porownania tekstu DOKLADNE, z wielkoscia liter (Klaviyo);
 *  - brak pola albo JSON null: prawdziwe jest wylacznie "nieustawione";
 *  - niezgodny typ (liczba zamiast tekstu itp.): falsz, bez rzutowania, takze dla
 *    operatorow przeczacych ("rozne od" na liczbie = falsz, nie prawda);
 *  - daty wylacznie ISO 8601 (YYYY-MM-DD, opcjonalnie godzina do milisekund i strefa;
 *    bez strefy = UTC), z kontrola zakresu pol. Inny zapis = niezgodny typ;
 *  - liczby wylacznie liczby JSON, |x| < 1e300 (porownanie w double po obu stronach).
 *
 * Etap E4a obejmuje warunki po wlasciwosciach zdarzenia i profilu. Warunki
 * `metryka_profilu`, `czlonkostwo`, `zgoda`, `byl_w_flow` (plan 3.2) dochodza w E4b:
 * celowo NIE ma ich w schemacie, zeby definicja nie mogla zawierac filtra, ktorego silnik
 * nie wykonuje (operator widzialby filtr, ktory niczego nie filtruje).
 */

export const TYPY_POL = ["string", "number", "boolean", "date", "list"] as const;
export type TypPola = (typeof TYPY_POL)[number];

export const OPERATORY = {
  string: ["rowna", "rozna", "zawiera", "nie_zawiera", "zaczyna_sie", "jest_w", "nie_jest_w", "ustawione", "nieustawione"],
  number: ["rowna", "rozna", "wieksza", "wieksza_rowna", "mniejsza", "mniejsza_rowna", "miedzy", "ustawione", "nieustawione"],
  boolean: ["prawda", "falsz", "ustawione", "nieustawione"],
  date: ["przed", "po", "w_ostatnich_dniach", "miedzy", "ustawione", "nieustawione"],
  list: ["zawiera", "nie_zawiera", "pusta", "niepusta", "ustawione", "nieustawione"],
} as const satisfies Record<TypPola, readonly string[]>;

export type Operator = (typeof OPERATORY)[TypPola][number];

export const ETYKIETY_OPERATOROW: Record<Operator, string> = {
  rowna: "równa się",
  rozna: "różne od",
  zawiera: "zawiera",
  nie_zawiera: "nie zawiera",
  zaczyna_sie: "zaczyna się od",
  jest_w: "jest jednym z",
  nie_jest_w: "nie jest żadnym z",
  ustawione: "jest ustawione",
  nieustawione: "nie jest ustawione",
  wieksza: ">",
  wieksza_rowna: "≥",
  mniejsza: "<",
  mniejsza_rowna: "≤",
  miedzy: "między",
  prawda: "prawda",
  falsz: "fałsz",
  przed: "przed",
  po: "po",
  w_ostatnich_dniach: "w ostatnich N dniach",
  pusta: "jest pusta",
  niepusta: "nie jest pusta",
};

export const ETYKIETY_TYPOW: Record<TypPola, string> = {
  string: "tekst",
  number: "liczba",
  boolean: "tak/nie",
  date: "data",
  list: "lista",
};

/** Pola standardowe profilu dostepne w filtrach (nazwy jak w Klaviyo). */
export const POLA_STANDARDOWE_PROFILU = ["email", "first_name", "last_name", "phone_number"] as const;
export type PoleStandardoweProfilu = (typeof POLA_STANDARDOWE_PROFILU)[number];

/** Operatory bez wartosci. */
export const BEZ_WARTOSCI: ReadonlySet<string> = new Set(["ustawione", "nieustawione", "prawda", "falsz", "pusta", "niepusta"]);

const MAX_TEKST = 1000;
const MAX_LISTA = 100;
const kluczPola = z.string().min(1).max(255);
const tekst = z.string().max(MAX_TEKST);
const liczba = z.number().finite().refine((x) => Math.abs(x) < 1e300, "liczba poza zakresem");
const prymityw = z.union([tekst, liczba, z.boolean()]);

// Wartosc waliduje superRefine (zalezna od typu pola i operatora), tu tylko jej ksztalt.
const wartosc = z.union([
  tekst,
  liczba,
  z.boolean(),
  z.array(tekst).min(1).max(MAX_LISTA),
  z.tuple([liczba, liczba]),
  z.tuple([tekst, tekst]),
]).optional();

const polaWarunku = {
  typPola: z.enum(TYPY_POL),
  operator: z.string().min(1).max(40),
  wartosc,
};

export const schematWarunku = z.discriminatedUnion("typ", [
  z.object({ typ: z.literal("wlasciwosc_zdarzenia"), pole: kluczPola, ...polaWarunku }),
  z.object({
    typ: z.literal("wlasciwosc_profilu"),
    pole: z.discriminatedUnion("rodzaj", [
      z.object({ rodzaj: z.literal("standard"), nazwa: z.enum(POLA_STANDARDOWE_PROFILU) }),
      z.object({ rodzaj: z.literal("wlasna"), nazwa: kluczPola }),
    ]),
    ...polaWarunku,
  }),
]).superRefine((w, ctx) => {
  const blad = bladWartosci(w.typPola, w.operator, w.wartosc);
  if (blad) ctx.addIssue({ code: "custom", message: blad, path: ["wartosc"] });
});

export type Warunek = z.infer<typeof schematWarunku>;

export const schematFiltra = z.object({
  grupy: z.array(z.object({ warunki: z.array(schematWarunku).min(1).max(50) })).max(20),
});
export type Filtr = z.infer<typeof schematFiltra>;
export type Grupa = Filtr["grupy"][number];

// ── Daty ────────────────────────────────────────────────────────────────────

/**
 * Wzorzec daty. MUSI byc identyczny z tym w funkcji SQL `filtr_data` (0035): parytet
 * TS/SQL stoi na tym, ze obie strony przyjmuja dokladnie ten sam zbior zapisow.
 */
export const WZORZEC_DATY =
  "^([1-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])(?:[T ]([01][0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9])(?:\\.([0-9]{1,3}))?)?(Z|[+-](?:[01][0-9]|2[0-3]):?[0-5][0-9])?)?$";
const DATA = new RegExp(WZORZEC_DATY);

/** Data ISO -> epoka w ms, albo null (zly zapis, 31 lutego, strefa bez godziny itp.). */
export function parsujDate(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = DATA.exec(s);
  if (!m) return null;
  const [, r, mc, d, g, mi, se, ms, strefa] = m;
  const rok = Number(r), miesiac = Number(mc), dzien = Number(d);
  const dniMiesiaca = new Date(Date.UTC(rok, miesiac, 0)).getUTCDate();
  if (dzien > dniMiesiaca) return null;
  let t = Date.UTC(rok, miesiac - 1, dzien, Number(g ?? 0), Number(mi ?? 0), Number(se ?? 0), ms ? Number(ms.padEnd(3, "0")) : 0);
  if (strefa && strefa !== "Z") {
    const znak = strefa[0] === "-" ? -1 : 1;
    const cyfry = strefa.slice(1).replace(":", "");
    t -= znak * (Number(cyfry.slice(0, 2)) * 60 + Number(cyfry.slice(2, 4))) * 60_000;
  }
  return t;
}

// ── Walidacja wartosci wzgledem operatora ───────────────────────────────────

function jestTekstem(x: unknown): x is string {
  return typeof x === "string" && x.length <= MAX_TEKST;
}
function jestLiczba(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 1e300;
}

/** Czytelny powod, dla ktorego (typ, operator, wartosc) nie ma sensu; null = poprawne. */
export function bladWartosci(typ: TypPola, operator: string, w: unknown): string | null {
  if (!(OPERATORY[typ] as readonly string[]).includes(operator)) {
    return `Operator „${operator}” nie pasuje do typu „${ETYKIETY_TYPOW[typ]}”.`;
  }
  if (BEZ_WARTOSCI.has(operator)) return w === undefined ? null : "Ten operator nie przyjmuje wartości.";
  switch (typ) {
    case "string":
      if (operator === "jest_w" || operator === "nie_jest_w") {
        return Array.isArray(w) && w.length >= 1 && w.length <= MAX_LISTA && w.every(jestTekstem) ? null : "Podaj od 1 do 100 wartości tekstowych.";
      }
      return jestTekstem(w) ? null : "Podaj tekst.";
    case "number":
      if (operator === "miedzy") {
        return Array.isArray(w) && w.length === 2 && jestLiczba(w[0]) && jestLiczba(w[1]) && w[0] <= w[1] ? null : "Podaj dwie liczby: od i do (od ≤ do).";
      }
      return jestLiczba(w) ? null : "Podaj liczbę.";
    case "date":
      if (operator === "w_ostatnich_dniach") {
        return typeof w === "number" && Number.isInteger(w) && w >= 1 && w <= 36_500 ? null : "Podaj liczbę dni (1–36500).";
      }
      if (operator === "miedzy") {
        if (!Array.isArray(w) || w.length !== 2) return "Podaj dwie daty: od i do.";
        const a = parsujDate(w[0]), b = parsujDate(w[1]);
        return a !== null && b !== null && a <= b ? null : "Podaj dwie poprawne daty (RRRR-MM-DD), od ≤ do.";
      }
      return parsujDate(w) !== null ? null : "Podaj datę w formacie RRRR-MM-DD (opcjonalnie z godziną).";
    case "list":
      return prymityw.safeParse(w).success ? null : "Podaj wartość elementu listy (tekst, liczbę albo tak/nie).";
    case "boolean":
      return null;
  }
}

/** Pusty filtr = brak ograniczen (kazde zdarzenie pasuje). */
export function filtrPusty(f: Filtr | undefined | null): boolean {
  return !f || f.grupy.length === 0;
}
