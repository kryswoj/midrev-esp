/**
 * Mapowanie kolumn pliku Klaviyo na pola profilu. Rozpoznanie naglowkow jest
 * automatyczne (format eksportu Klaviyo z help.klaviyo.com: "Email", "First Name",
 * "Last Name", "Phone Number", "Email Marketing Consent", "Email Marketing Consent
 * Timestamp", "Source", "Email Suppressions" plus wlasciwosci wlasne pod ich nazwami),
 * a operator moze kazde przypisanie poprawic recznie na ekranie.
 */

export const POLA_PROFILU = [
  "email",
  "imie",
  "nazwisko",
  "telefon",
  "zgoda",
  "zgoda_data",
  "zrodlo",
  "supresja",
  "wlasciwosc",
  "pomin",
] as const;

export type PoleProfilu = (typeof POLA_PROFILU)[number];

export const OPIS_POLA: Record<PoleProfilu, { etykieta: string; opis: string }> = {
  email: { etykieta: "Adres e-mail", opis: "Wymagany. Tożsamość profilu po normalizacji (małe litery, bez spacji na brzegach)." },
  imie: { etykieta: "Imię", opis: "Uzupełnia puste imię profilu, nie nadpisuje istniejącego." },
  nazwisko: { etykieta: "Nazwisko", opis: "Uzupełnia puste nazwisko profilu." },
  telefon: { etykieta: "Telefon", opis: "Uzupełnia pusty telefon profilu." },
  zgoda: { etykieta: "Zgoda e-mail", opis: "SUBSCRIBED nadaje zgodę (razem z datą), UNSUBSCRIBED wyklucza z wysyłek tego sklepu." },
  zgoda_data: { etykieta: "Data zgody", opis: "Wymagana do nadania zgody. Bez daty zgoda nie powstaje." },
  zrodlo: { etykieta: "Źródło zgody", opis: "Skąd Klaviyo miało zgodę (formularz, checkout). Trafia do rejestru zgód jako szczegół." },
  supresja: { etykieta: "Supresja e-mail", opis: "Niepuste pole = adres wykluczony w Klaviyo; nie dostanie zgody, trafi do wykluczeń sklepu." },
  wlasciwosc: { etykieta: "Właściwość własna", opis: "Zapisana na profilu pod nazwą kolumny (np. Shopify Tags, City)." },
  pomin: { etykieta: "Pomiń kolumnę", opis: "Kolumna nie trafia nigdzie." },
};

export const POLA_SUPRESJI = ["email", "powod", "data", "pomin"] as const;
export type PoleSupresji = (typeof POLA_SUPRESJI)[number];

export const OPIS_POLA_SUPRESJI: Record<PoleSupresji, { etykieta: string; opis: string }> = {
  email: { etykieta: "Adres e-mail", opis: "Wymagany." },
  powod: { etykieta: "Powód", opis: "Wypis, skarga, odbicie, ręczne. Bez tej kolumny każdy adres traktujemy jak wypis ze sklepu." },
  data: { etykieta: "Data", opis: "Kiedy adres został wykluczony. Bez niej wpis dostaje datę importu." },
  pomin: { etykieta: "Pomiń kolumnę", opis: "Kolumna nie trafia nigdzie." },
};

function klucz(naglowek: string): string {
  return naglowek.trim().toLowerCase().replace(/^\$/, "").replace(/[\s_-]+/g, " ");
}

const SYNONIMY: [PoleProfilu, string[]][] = [
  ["email", ["email", "email address", "e-mail", "e mail", "adres e-mail", "adres email", "adres e mail", "mail"]],
  ["imie", ["first name", "firstname", "imię", "imie", "given name"]],
  ["nazwisko", ["last name", "lastname", "nazwisko", "surname", "family name"]],
  ["telefon", ["phone number", "phone", "telefon", "numer telefonu", "mobile", "sms number"]],
  ["zgoda_data", [
    "email marketing consent timestamp", "email consent timestamp", "consent timestamp",
    "email marketing consent date", "subscribed at", "subscribe date", "subscription date",
    "data zgody", "opt in date", "opt in timestamp", "consent date",
  ]],
  ["zgoda", ["email marketing consent", "email consent", "accepts marketing", "consent", "zgoda", "zgoda e-mail", "zgoda email", "subscribed", "marketing consent"]],
  ["zrodlo", ["source", "email marketing consent method", "consent method", "źródło", "zrodlo", "signup source", "email marketing consent method detail"]],
  ["supresja", ["email suppressions", "email suppression", "suppressed", "suppression"]],
];

// Kolumny z eksportu Klaviyo, ktore warto zachowac jako wlasciwosci profilu bez pytania.
const WLASCIWOSCI_DOMYSLNE = new Set([
  "city", "country", "region", "zip", "zip code", "postal code", "organization", "title",
  "locale", "address1", "address2", "shopify tags", "accepts marketing", "created",
  "date added", "updated", "last active", "timezone", "external id", "birthday",
  "miasto", "kraj", "kod pocztowy", "firma",
]);

// Kolumny techniczne Klaviyo, ktorych nie ma sensu przenosic.
const POMIJANE = new Set(["profile id", "klaviyo id", "id", "anonymous id", "ip", "latitude", "longitude", "image"]);

/** Automatyczne przypisanie kolumn pliku profili. Pierwsza pasujaca kolumna wygrywa. */
export function rozpoznajKolumny(naglowki: string[]): PoleProfilu[] {
  const zajete = new Set<PoleProfilu>();
  return naglowki.map((n) => {
    const k = klucz(n);
    if (!k) return "pomin";
    for (const [pole, warianty] of SYNONIMY) {
      if (warianty.includes(k) && !zajete.has(pole)) {
        zajete.add(pole);
        return pole;
      }
    }
    if (POMIJANE.has(k)) return "pomin";
    if (WLASCIWOSCI_DOMYSLNE.has(k)) return "wlasciwosc";
    // "SMS Marketing Consent" itp. nie sa zgoda e-mail; reszta nieznanych czeka na decyzje
    return "pomin";
  });
}

const SYNONIMY_SUPRESJI: [PoleSupresji, string[]][] = [
  ["email", ["email", "email address", "e-mail", "e mail", "adres e-mail", "adres email"]],
  ["powod", ["reason", "suppression reason", "suppression type", "type", "powód", "powod", "status"]],
  ["data", ["timestamp", "suppression timestamp", "suppressed at", "date", "suppression date", "created", "data", "unsubscribed at"]],
];

export function rozpoznajKolumnySupresji(naglowki: string[]): PoleSupresji[] {
  const zajete = new Set<PoleSupresji>();
  return naglowki.map((n) => {
    const k = klucz(n);
    for (const [pole, warianty] of SYNONIMY_SUPRESJI) {
      if (warianty.includes(k) && !zajete.has(pole)) {
        zajete.add(pole);
        return pole;
      }
    }
    return "pomin";
  });
}

export interface WynikWalidacjiMapowania {
  ok: boolean;
  bledy: string[];
  ostrzezenia: string[];
}

/**
 * Sprawdzenie mapowania przed zapisem. Blad zatrzymuje, ostrzezenie wymaga swiadomego
 * potwierdzenia na ekranie (import bez zgody jest legalny - np. baza kontaktowa - ale
 * nie moze zdarzyc sie przez przeoczenie).
 */
export function sprawdzMapowanie(mapowanie: PoleProfilu[], naglowki: string[]): WynikWalidacjiMapowania {
  const bledy: string[] = [];
  const ostrzezenia: string[] = [];
  if (mapowanie.length !== naglowki.length) bledy.push("Mapowanie nie pasuje do liczby kolumn pliku.");
  const ile = (pole: PoleProfilu) => mapowanie.filter((p) => p === pole).length;
  for (const pole of POLA_PROFILU) {
    if (pole === "wlasciwosc" || pole === "pomin") continue;
    if (ile(pole) > 1) bledy.push(`Pole „${OPIS_POLA[pole].etykieta}” jest przypisane do ${ile(pole)} kolumn. Może być tylko jedna.`);
  }
  if (ile("email") === 0) bledy.push("Wskaż kolumnę z adresem e-mail. Bez niej nie ma czego importować.");
  const nazwyWlasciwosci = new Set<string>();
  mapowanie.forEach((p, i) => {
    if (p !== "wlasciwosc") return;
    const nazwa = naglowki[i]?.trim();
    if (!nazwa) bledy.push(`Kolumna ${i + 1} bez nagłówka nie może być właściwością własną.`);
    else if (nazwyWlasciwosci.has(nazwa)) bledy.push(`Dwie kolumny o nazwie „${nazwa}” jako właściwości własne. Pomiń jedną.`);
    nazwyWlasciwosci.add(nazwa);
  });
  if (ile("zgoda") === 0 && ile("zgoda_data") === 0) {
    ostrzezenia.push("Bez kolumny zgody i daty zgody import NIE nada nikomu zgody marketingowej. Wysyłka do tych osób będzie zablokowana, dopóki zgoda nie przyjdzie z innego źródła.");
  } else if (ile("zgoda") > 0 && ile("zgoda_data") === 0) {
    ostrzezenia.push("Jest kolumna zgody, ale nie ma daty zgody. Zgoda bez daty zdarzenia nie może powstać (nie wolno wpisać daty importu), więc nikt nie dostanie zgody. Osoby ze statusem UNSUBSCRIBED nadal trafią do wykluczeń.");
  } else if (ile("zgoda") === 0 && ile("zgoda_data") > 0) {
    ostrzezenia.push("Jest data zgody bez kolumny statusu: każdy wiersz z poprawną datą dostanie zgodę. Upewnij się, że plik zawiera wyłącznie osoby zapisane.");
  }
  return { ok: bledy.length === 0, bledy, ostrzezenia };
}

export function sprawdzMapowanieSupresji(mapowanie: PoleSupresji[], naglowki: string[]): WynikWalidacjiMapowania {
  const bledy: string[] = [];
  const ostrzezenia: string[] = [];
  if (mapowanie.length !== naglowki.length) bledy.push("Mapowanie nie pasuje do liczby kolumn pliku.");
  const ile = (pole: PoleSupresji) => mapowanie.filter((p) => p === pole).length;
  if (ile("email") !== 1) bledy.push("Wskaż dokładnie jedną kolumnę z adresem e-mail.");
  if (ile("powod") > 1) bledy.push("Powód może być przypisany do jednej kolumny.");
  if (ile("data") > 1) bledy.push("Data może być przypisana do jednej kolumny.");
  if (ile("powod") === 0) ostrzezenia.push("Bez kolumny powodu każdy adres z pliku trafi do wykluczeń tego sklepu jako wypis. Skargi i odbicia nie zostaną rozpoznane jako wykluczenia globalne.");
  if (ile("data") === 0) ostrzezenia.push("Bez kolumny daty wpisy wykluczeń dostaną datę importu.");
  return { ok: bledy.length === 0, bledy, ostrzezenia };
}

export function jestPolemProfilu(w: unknown): w is PoleProfilu {
  return typeof w === "string" && (POLA_PROFILU as readonly string[]).includes(w);
}

export function jestPolemSupresji(w: unknown): w is PoleSupresji {
  return typeof w === "string" && (POLA_SUPRESJI as readonly string[]).includes(w);
}
