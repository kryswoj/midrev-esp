import type { PoleProfilu, PoleSupresji } from "./mapowanie";

/**
 * Normalizacja jednego wiersza pliku po mapowaniu. Czysta funkcja, bez bazy: ta sama
 * logika liczy podglad i wykonuje import, wiec podglad nie ma jak sklamac.
 */

export const MAKS_EMAIL = 320;
export const MAKS_TEKST = 200;
export const MAKS_WLASCIWOSC = 1000;
export const MAKS_LICZBA_WLASCIWOSCI = 60;

// Pragmatyczna walidacja adresu: jedna malpa, brak bialych znakow, domena z kropka.
// Apostrof w czesci lokalnej jest dozwolony (o'brien@x.pl to prawdziwy adres), tak samo
// jak reszta atext z RFC 5322; odrzucamy tylko znaki, ktore lamia skladnie adresu.
const EMAIL = /^[^\s@"<>,;()[\]\\]+@[^\s@"<>,;()[\]\\]+\.[^\s@"<>,;()[\]\\.]{2,}$/;

export type StanZgodyZPliku = "granted" | "unsubscribed" | "none";

export interface WierszProfilu {
  linia: number;
  email: string;
  /** lower(btrim(email)) - tozsamosc profilu, ten sam wzorzec co indeks z 0001 */
  klucz: string;
  imie: string | null;
  nazwisko: string | null;
  telefon: string | null;
  zgoda: StanZgodyZPliku;
  /** data zgody ZE ZRODLA; null gdy brak albo nieczytelna */
  zgodaData: Date | null;
  zrodlo: string | null;
  supresja: boolean;
  wlasciwosci: Record<string, string>;
  /** ostrzezenia nieblokujace (profil wchodzi, ale np. bez zgody) */
  uwagi: string[];
}

export type WynikWiersza =
  | { ok: true; wiersz: WierszProfilu }
  | { ok: false; linia: number; email: string | null; powod: string };

export function normalizujEmail(surowy: string): { email: string; klucz: string } | null {
  const email = surowy.trim();
  if (!email || email.length > MAKS_EMAIL || !EMAIL.test(email)) return null;
  return { email, klucz: email.toLowerCase() };
}

/**
 * Data ze zrodla. Klaviyo eksportuje "2024-03-05 14:22:10" albo ISO z przesunieciem;
 * inne ESP daja sam dzien. Brak strefy = UTC (tak zapisuje Klaviyo). Data z przyszlosci
 * albo sprzed 1995 to blad danych, nie zgoda.
 */
export function parsujDate(surowa: string): Date | null {
  const t = surowa.trim();
  if (!t) return null;
  let iso = t;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) iso = `${t}T00:00:00Z`;
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) iso = `${t.replace(" ", "T")}Z`;
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s?(Z|[+-]\d{2}:?\d{2})$/.test(t)) iso = t.replace(" ", "T").replace(/\s(?=[+\-Z])/, "");
  else if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(t)) {
    const [d, m, r] = t.split(".");
    iso = `${r}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00Z`;
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}( \d{1,2}:\d{2}(:\d{2})?)?$/.test(t)) {
    // amerykanski MM/DD/YYYY (eksport z arkusza w USA)
    const [data, czas] = t.split(" ");
    const [m, d, r] = data.split("/");
    iso = `${r}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${czas ?? "00:00:00"}Z`;
  } else if (/^\d{10}$/.test(t)) {
    iso = new Date(Number(t) * 1000).toISOString();
  }
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;
  const teraz = Date.now();
  if (data.getTime() > teraz + 24 * 3600 * 1000) return null;
  if (data.getFullYear() < 1995) return null;
  return data;
}

export function parsujZgode(surowa: string): StanZgodyZPliku | "nieznana" {
  const t = surowa.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!t) return "none";
  if (["subscribed", "subscribe", "true", "yes", "1", "tak", "granted", "opted in", "opt in", "explicit", "consented"].includes(t)) return "granted";
  if (["unsubscribed", "unsubscribe", "false", "no", "0", "nie", "withdrawn", "opted out", "opt out", "suppressed"].includes(t)) return "unsubscribed";
  if (["never subscribed", "never", "none", "null", "n/a", "not subscribed"].includes(t)) return "none";
  return "nieznana";
}

function tekst(w: string | undefined, maks: number): string | null {
  const t = (w ?? "").trim();
  if (!t) return null;
  return t.slice(0, maks);
}

/** Zastosowanie mapowania do surowego rekordu. */
export function normalizujWiersz(
  linia: number,
  pola: string[],
  mapowanie: PoleProfilu[],
  naglowki: string[],
): WynikWiersza {
  const idx = (pole: PoleProfilu) => mapowanie.indexOf(pole);
  const wartosc = (pole: PoleProfilu) => {
    const i = idx(pole);
    return i === -1 ? undefined : pola[i];
  };

  const adres = normalizujEmail(wartosc("email") ?? "");
  if (!adres) {
    const surowy = (wartosc("email") ?? "").trim();
    return { ok: false, linia, email: surowy || null, powod: surowy ? "nieprawidłowy adres e-mail" : "pusty adres e-mail" };
  }

  const uwagi: string[] = [];
  let zgoda: StanZgodyZPliku = "none";
  const surowaZgoda = wartosc("zgoda");
  const surowaData = wartosc("zgoda_data");
  if (surowaZgoda !== undefined) {
    const z = parsujZgode(surowaZgoda);
    if (z === "nieznana") {
      return { ok: false, linia, email: adres.email, powod: `nierozpoznana wartość zgody „${surowaZgoda.trim().slice(0, 40)}”` };
    }
    zgoda = z;
  } else if (surowaData !== undefined && surowaData.trim()) {
    // sama data bez kolumny statusu: plik z samych zapisanych (ostrzezenie na mapowaniu)
    zgoda = "granted";
  }

  let zgodaData: Date | null = null;
  if (surowaData !== undefined && surowaData.trim()) {
    zgodaData = parsujDate(surowaData);
    if (!zgodaData) {
      if (zgoda === "granted") {
        return { ok: false, linia, email: adres.email, powod: `nieczytelna data zgody „${surowaData.trim().slice(0, 40)}”` };
      }
      uwagi.push("nieczytelna data, pominięta");
    }
  }
  if (zgoda === "granted" && !zgodaData) {
    // Zgoda bez daty zdarzenia nie powstaje (AD-10): profil wchodzi, zgoda nie.
    zgoda = "none";
    uwagi.push("zgoda bez daty: profil bez zgody");
  }

  const supresja = Boolean((wartosc("supresja") ?? "").trim());
  if (supresja && zgoda === "granted") {
    zgoda = "none";
    uwagi.push("adres wykluczony w Klaviyo: bez zgody");
  }

  const wlasciwosci: Record<string, string> = {};
  let ileWlasciwosci = 0;
  mapowanie.forEach((p, i) => {
    if (p !== "wlasciwosc") return;
    const nazwa = naglowki[i]?.trim();
    const w = (pola[i] ?? "").trim();
    if (!nazwa || !w) return;
    if (ileWlasciwosci >= MAKS_LICZBA_WLASCIWOSCI) return;
    ileWlasciwosci += 1;
    wlasciwosci[nazwa.slice(0, 100)] = w.slice(0, MAKS_WLASCIWOSC);
  });

  return {
    ok: true,
    wiersz: {
      linia,
      email: adres.email,
      klucz: adres.klucz,
      imie: tekst(wartosc("imie"), MAKS_TEKST),
      nazwisko: tekst(wartosc("nazwisko"), MAKS_TEKST),
      telefon: tekst(wartosc("telefon"), 40),
      zgoda,
      zgodaData,
      zrodlo: tekst(wartosc("zrodlo"), MAKS_TEKST),
      supresja,
      wlasciwosci,
      uwagi,
    },
  };
}

// --- supresje --------------------------------------------------------------------

export type RodzajSupresji = "wypis" | "skarga" | "odbicie" | "nieprawidlowy" | "reczne";

export const POWOD_SUPRESJI: Record<RodzajSupresji, { reason: string; globalna: boolean }> = {
  // wypis i wykluczenie reczne sa decyzja wobec TEGO sklepu -> tenant_suppressions
  wypis: { reason: "wypisanie w Klaviyo", globalna: false },
  reczne: { reason: "wykluczenie ręczne w Klaviyo", globalna: false },
  // skarga i twarde odbicie pala adres wszedzie -> globalne suppressions (AD-27)
  skarga: { reason: "zgłoszenie spamu w Klaviyo", globalna: true },
  odbicie: { reason: "twarde odbicie w Klaviyo", globalna: true },
  nieprawidlowy: { reason: "nieprawidłowy adres w Klaviyo", globalna: true },
};

export function parsujPowodSupresji(surowy: string | undefined): RodzajSupresji {
  const t = (surowy ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!t) return "wypis";
  if (t.includes("spam") || t.includes("complaint") || t.includes("skarg")) return "skarga";
  if (t.includes("bounce") || t.includes("odbici")) return "odbicie";
  if (t.includes("invalid") || t.includes("nieprawid")) return "nieprawidlowy";
  if (t.includes("user") || t.includes("manual") || t.includes("ręczn") || t.includes("reczn")) return "reczne";
  // unsubscribe i wszystko nieznane: bezpieczny domyslny = wypis ze sklepu
  return "wypis";
}

export interface WierszSupresji {
  linia: number;
  email: string;
  klucz: string;
  rodzaj: RodzajSupresji;
  data: Date | null;
}

export type WynikWierszaSupresji =
  | { ok: true; wiersz: WierszSupresji }
  | { ok: false; linia: number; email: string | null; powod: string };

export function normalizujWierszSupresji(linia: number, pola: string[], mapowanie: PoleSupresji[]): WynikWierszaSupresji {
  const idx = (pole: PoleSupresji) => mapowanie.indexOf(pole);
  const wartosc = (pole: PoleSupresji) => {
    const i = idx(pole);
    return i === -1 ? undefined : pola[i];
  };
  const adres = normalizujEmail(wartosc("email") ?? "");
  if (!adres) {
    const surowy = (wartosc("email") ?? "").trim();
    return { ok: false, linia, email: surowy || null, powod: surowy ? "nieprawidłowy adres e-mail" : "pusty adres e-mail" };
  }
  const surowaData = wartosc("data");
  const data = surowaData && surowaData.trim() ? parsujDate(surowaData) : null;
  return {
    ok: true,
    wiersz: { linia, email: adres.email, klucz: adres.klucz, rodzaj: parsujPowodSupresji(wartosc("powod")), data },
  };
}
