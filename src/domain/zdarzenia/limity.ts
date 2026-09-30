/**
 * Limity zdarzenia (plan 1.2 i AD-39) jako czyste funkcje: te same reguły w synchronicznej
 * walidacji API (400 od razu, jak Klaviyo) i w `zapiszZdarzenie` (ostatnia linia obrony dla
 * zapisów wewnętrznych). Klaviyo: 400 właściwości top-level, 100 KB na napis, nazwa metryki
 * krótsza niż 128 znaków, `time` od 1990 do roku w przód.
 */

export const MAKS_WLASCIWOSCI = 400;
export const MAKS_BAJTOW_NAPISU = 100 * 1024;
export const MAKS_NAZWA_METRYKI = 127;
export const MAKS_UNIQUE_ID = 255;
export const NAJWCZESNIEJ = Date.UTC(1990, 0, 1);
export const MAKS_METRYK_NA_TENANTA = 200;
/** zagnieżdżenie properties: głębiej = odrzucenie (ochrona przed rekurencją przy walidacji i renderze) */
export const MAKS_ZAGLEBIENIE = 10;

export interface NaruszenieLimitu {
  /** wskaźnik JSON (RFC 6901) względem `properties`, np. `/quiz_state` */
  wskaznik: string;
  opis: string;
}

/** Najpóźniejszy dopuszczalny czas zdarzenia: rok od `teraz`. */
export function najpozniej(teraz: number): number {
  const d = new Date(teraz);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime();
}

export function sprawdzCzas(occurredAt: Date, teraz = Date.now()): string | null {
  const t = occurredAt.getTime();
  if (!Number.isFinite(t)) return "niepoprawny czas zdarzenia";
  if (t < NAJWCZESNIEJ) return "czas zdarzenia przed 1990-01-01";
  if (t > najpozniej(teraz)) return "czas zdarzenia dalej niż rok w przód";
  return null;
}

export function sprawdzNazweMetryki(nazwa: unknown): string | null {
  if (typeof nazwa !== "string") return "nazwa metryki musi być tekstem";
  const n = nazwa.trim();
  if (n.length < 1) return "nazwa metryki jest pusta";
  if (n.length > MAKS_NAZWA_METRYKI) return `nazwa metryki dłuższa niż ${MAKS_NAZWA_METRYKI} znaków`;
  if (/[\u0000-\u001f\u007f]/.test(n)) return "nazwa metryki zawiera znaki sterujące";
  return null;
}

function escWskaznika(k: string): string {
  return k.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Właściwości zdarzenia: obiekt, najwyżej 400 kluczy top-level, każdy napis (także
 * zagnieżdżony) do 100 KB w UTF-8, zagnieżdżenie do 10 poziomów. Zwraca pierwsze
 * naruszenie albo null.
 */
export function sprawdzWlasciwosci(properties: unknown): NaruszenieLimitu | null {
  if (properties === undefined || properties === null) return null;
  if (typeof properties !== "object" || Array.isArray(properties)) {
    return { wskaznik: "", opis: "properties musi być obiektem" };
  }
  const klucze = Object.keys(properties as object);
  if (klucze.length > MAKS_WLASCIWOSCI) {
    return { wskaznik: "", opis: `więcej niż ${MAKS_WLASCIWOSCI} właściwości (${klucze.length})` };
  }
  const stos: { w: unknown; sciezka: string; glebokosc: number }[] = [{ w: properties, sciezka: "", glebokosc: 0 }];
  while (stos.length) {
    const { w, sciezka, glebokosc } = stos.pop()!;
    if (typeof w === "string") {
      if (Buffer.byteLength(w, "utf8") > MAKS_BAJTOW_NAPISU) {
        return { wskaznik: sciezka, opis: `napis dłuższy niż ${MAKS_BAJTOW_NAPISU / 1024} KB` };
      }
      continue;
    }
    if (typeof w === "number" && !Number.isFinite(w)) {
      return { wskaznik: sciezka, opis: "liczba musi być skończona" };
    }
    if (w && typeof w === "object") {
      if (glebokosc >= MAKS_ZAGLEBIENIE) return { wskaznik: sciezka, opis: `zagnieżdżenie głębsze niż ${MAKS_ZAGLEBIENIE}` };
      if (Array.isArray(w)) {
        w.forEach((x, i) => stos.push({ w: x, sciezka: `${sciezka}/${i}`, glebokosc: glebokosc + 1 }));
      } else {
        for (const [k, x] of Object.entries(w as Record<string, unknown>)) {
          if (Buffer.byteLength(k, "utf8") > MAKS_BAJTOW_NAPISU) return { wskaznik: sciezka, opis: "za długi klucz" };
          stos.push({ w: x, sciezka: `${sciezka}/${escWskaznika(k)}`, glebokosc: glebokosc + 1 });
        }
      }
    }
  }
  return null;
}

/** Waluty bez części ułamkowej (ISO 4217, wykładnik 0) i z trzema miejscami. Reszta: 2. */
const WYKLADNIK_0 = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"]);
const WYKLADNIK_3 = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function wykladnikWaluty(waluta: string): number {
  const w = waluta.toUpperCase();
  if (WYKLADNIK_0.has(w)) return 0;
  if (WYKLADNIK_3.has(w)) return 3;
  return 2;
}

/**
 * `$value` (jednostki główne, jak w Klaviyo: 199.99) → jednostki minor wg waluty (AD-11).
 * Bez mnożenia liczb zmiennoprzecinkowych: `199.99 * 100` daje 19998.999…
 * Zwraca null dla wartości, której nie da się odczytać (wtedy zdarzenie jest zapisane
 * bez `value_minor`, a oryginał zostaje w properties).
 */
export function naMinor(wartosc: unknown, waluta: string): bigint | null {
  let tekst: string;
  if (typeof wartosc === "number") {
    if (!Number.isFinite(wartosc)) return null;
    // toFixed(10) usuwa artefakty binarne (0.1 + 0.2) bez utraty groszy
    tekst = wartosc.toFixed(10);
  } else if (typeof wartosc === "string") {
    tekst = wartosc.trim().replace(",", ".");
  } else {
    return null;
  }
  const m = /^(-?)(\d{1,15})(?:\.(\d+))?$/.exec(tekst);
  if (!m) return null;
  const exp = wykladnikWaluty(waluta);
  const ulamek = (m[3] ?? "").padEnd(exp + 1, "0");
  const glowne = BigInt(m[2]) * 10n ** BigInt(exp);
  let minor = glowne + (exp > 0 ? BigInt(ulamek.slice(0, exp)) : 0n);
  // zaokrąglenie połówkowe od zera na pierwszej odciętej cyfrze
  if (Number(ulamek[exp]) >= 5) minor += 1n;
  return m[1] === "-" ? -minor : minor;
}
