// Jeden wewnętrzny kontrakt danych sklepowych (AD-8). Woo, Shopify i Shoper mapują się
// na te typy, a reszta systemu nie wie, z jakiej platformy pochodzi zamówienie.
// Żaden typ tutaj nie pochodzi z biblioteki konkretnej platformy.

export type Waluta = string; // ISO 4217

export interface KlientSklepu {
  externalId: string;
  email: string | null;
  imie: string | null;
  nazwisko: string | null;
  telefon: string | null;
  /** Data założenia konta w sklepie. Zawsze ze źródła (AD-10). */
  occurredAt: Date;
  /** Data ostatniej zmiany danych ZE ŹRÓDŁA (kolejność webhooków nie jest gwarantowana). */
  zmodyfikowaneAt: Date;
  surowe: unknown;
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
  /** Data ostatniej modyfikacji ZE ŹRÓDŁA - rozstrzyga, który payload jest nowszy,
   *  bo kolejność dostarczania webhooków nie jest gwarantowana. */
  zmodyfikowaneAt: Date;
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
  /** Łączna liczba pozycji wg sklepu (nagłówek X-WP-Total), nie długość tej strony. */
  lacznie: number;
  /** Łączna liczba stron wg sklepu (X-WP-TotalPages). Paginacja idzie do tej liczby, nie do zaszytego sufitu. */
  stron: number;
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
    /** Tylko zamówienia złożone od tej daty (zakres importu). */
    od?: Date;
    /** Tryb lekki do PLANOWANIA: bez pozycji i pełnego dokumentu, tylko nagłówek
     *  (id, status, e-mail, kwota, daty). `surowe` jest wtedy okrojone - nie zapisywać. */
    lekko?: boolean;
  }): Promise<StronaWynikow<ZamowienieSklepu>>;
  pobierzProdukty(strona: number, naStrone: number): Promise<StronaWynikow<ProduktSklepu>>;
  /** Liczba zamówień w sklepie w danym okresie. Podstawa ekranu zgodności (FR14). */
  policzZamowienia(od?: Date, do_?: Date): Promise<number>;
  /** Liczba kont klientów w sklepie - do planu importu (ile profili powstanie). */
  policzKlientow(): Promise<number>;
  /**
   * Klucz idempotencji opisuje BYT, nie kanał (AD-24). Ta sama funkcja obsługuje
   * webhook i import historyczny, więc to samo zamówienie nie wejdzie dwiema drogami.
   */
  kluczIdempotencji(byt: "order" | "customer" | "product", externalId: string, wersja: string): string;
}
