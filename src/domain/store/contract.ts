// Jeden wewnętrzny kontrakt danych sklepowych (AD-8). Woo, Shopify i Shoper mapują się
// na te typy, a reszta systemu nie wie, z jakiej platformy pochodzi zamówienie.
// Żaden typ tutaj nie pochodzi z biblioteki konkretnej platformy.

export type Waluta = string; // ISO 4217

export interface KlientSklepu {
  externalId: string;
  email: string | null;
  imie: string | null;
  nazwisko: string | null;
  /** Data założenia konta w sklepie. Zawsze ze źródła (AD-10). */
  occurredAt: Date;
}

export interface PozycjaZamowienia {
  sku: string | null;
  nazwa: string;
  ilosc: number;
  /** Cena jednostkowa w groszach (AD-11). Nigdy liczba zmiennoprzecinkowa. */
  cenaMinor: number;
}

export interface ZamowienieSklepu {
  externalId: string;
  numer: string | null;
  status: string;
  email: string | null;
  imie: string | null;
  nazwisko: string | null;
  sumaMinor: number;
  waluta: Waluta;
  /** Data złożenia zamówienia ZE ŹRÓDŁA. Bez niej zapis jest błędem (AD-10). */
  occurredAt: Date;
  pozycje: PozycjaZamowienia[];
  surowe: unknown;
}

export interface ProduktSklepu {
  externalId: string;
  nazwa: string;
  sku: string | null;
  cenaMinor: number;
  waluta: Waluta;
  kategorie: string[];
}

/** Co dana platforma potrafi u tego konkretnego sklepu (AD-8, AD-29). */
export interface MozliwosciPlatformy {
  zamowienia: boolean;
  klienci: boolean;
  produkty: boolean;
  /** Porzucony koszyk: Woo nie ma tego natywnie, Shoper prawdopodobnie też nie. */
  porzuconyKoszyk: boolean;
  webhooki: boolean;
}

export interface WynikWeryfikacji {
  ok: boolean;
  /** Zakresy, których zabrakło. Puste, gdy ok. */
  brakujaceUprawnienia: string[];
  /** Rozróżnia brak odpowiedzi od odmowy uwierzytelnienia. */
  powod?: "brak-odpowiedzi" | "bledne-poswiadczenia" | "brak-uprawnien";
  szczegoly?: string;
}

export interface StronaWynikow<T> {
  pozycje: T[];
  lacznie: number;
}

/** Port platformy sklepowej (AD-7 dla wysyłki, AD-8 tutaj). */
export interface PortPlatformy {
  readonly platforma: "woocommerce" | "shopify" | "shoper";
  weryfikujPoswiadczenia(): Promise<WynikWeryfikacji>;
  mozliwosci(): MozliwosciPlatformy;
  pobierzKlientow(strona: number, naStrone: number): Promise<StronaWynikow<KlientSklepu>>;
  pobierzZamowienia(opcje: {
    strona: number;
    naStrone: number;
    od?: Date;
  }): Promise<StronaWynikow<ZamowienieSklepu>>;
  pobierzProdukty(strona: number, naStrone: number): Promise<StronaWynikow<ProduktSklepu>>;
  /** Liczba zamówień w sklepie w danym okresie. Podstawa ekranu zgodności (FR14). */
  policzZamowienia(od?: Date, do_?: Date): Promise<number>;
  /**
   * Klucz idempotencji opisuje BYT, nie kanał (AD-24). Ta sama funkcja obsługuje
   * webhook i import historyczny, więc to samo zamówienie nie wejdzie dwiema drogami.
   */
  kluczIdempotencji(byt: "order" | "customer" | "product", externalId: string, wersja: string): string;
}
