// Jeden wewnętrzny kontrakt danych sklepowych (AD-8). Woo, Shopify i Shoper mapują się
// na te typy, a reszta systemu nie wie, z jakiej platformy pochodzi zamówienie.
// Żaden typ tutaj nie pochodzi z biblioteki konkretnej platformy.
//
// PORT „SKLEP” (plan integracji E.1). Opis dla adapterów innych platform (Shopify, Shoper):
// research/wlasny-esp/integracje-2026-10-03/KONTRAKT-PORT-SKLEP.md. Krótko: adapter
// implementuje `PortSklepu` (połączenie, odczyt, webhooki po stronie sklepu) i rejestruje
// `DefinicjaPlatformy` (mapowanie payloadów, weryfikacja podpisu webhooka, role statusów)
// w `src/adapters/store/rejestr.ts`. Reszta (zapis zamówień, metryki, role, koszyki, zgody,
// katalog) jest wspólna i nie wie, z jakiej platformy przyszły dane.

export type Waluta = string; // ISO 4217

/** Platformy sklepowe znane systemowi (CHECK `stores.platform`, 0046). */
export const PLATFORMY_SKLEPU = ["woocommerce", "shopify", "shoper", "custom"] as const;
export type PlatformaSklepu = (typeof PLATFORMY_SKLEPU)[number];

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
  /** Id pozycji w zamówieniu ze źródła (unique_id metryki „Ordered Product”); brak = numer pozycji. */
  lineId?: string | null;
  /** Id produktu w sklepie (ProductID w metryce, filtr flow Sports-med). */
  productId?: string | null;
  /** Wartość pozycji po rabatach w groszach (`$value` metryki „Ordered Product”). */
  sumaMinor?: number | null;
  /** Id wariantu w sklepie (Woo `variation_id`, Shopify `variant.id`); null = produkt prosty. */
  variantId?: string | null;
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
  /**
   * Token koszyka, z którego powstało zamówienie (Woo: meta `_mrv_cart_token` z wtyczki,
   * Shopify: `cart_token`/`checkout_token`). Zamyka dokładnie ten koszyk w `carts`.
   */
  tokenKoszyka?: string | null;
  surowe: unknown;
}

export interface WariantSklepu {
  externalId: string;
  sku: string | null;
  tytul: string | null;
  url: string | null;
  obrazUrl: string | null;
  cenaMinor: number | null;
  /** cena przed promocją (przekreślona w bloku produktu) */
  cenaPrzedMinor: number | null;
  wMagazynie: boolean | null;
  stan: number | null;
  aktywny: boolean;
}

export interface ProduktSklepu {
  externalId: string;
  nazwa: string;
  sku: string | null;
  cenaMinor: number;
  waluta: Waluta;
  kategorie: string[];
  /** Pola katalogu (E.4). Opcjonalne: adapter, który ich nie zna, zostawia puste. */
  url?: string | null;
  obrazUrl?: string | null;
  opisKrotki?: string | null;
  cenaPrzedMinor?: number | null;
  marka?: string | null;
  wMagazynie?: boolean | null;
  stan?: number | null;
  /** false = produkt wycofany/szkic/usunięty: w katalogu `active=false`, nigdy nie kasujemy */
  aktywny?: boolean;
  warianty?: WariantSklepu[];
  /** data modyfikacji ZE ŹRÓDŁA (kursor synchronizacji przyrostowej) */
  zmodyfikowaneAt?: Date | null;
}

/** Zgoda marketingowa e-mail zgłoszona przez sklep (E.6). */
export interface ZgodaSklepu {
  email: string;
  stan: "granted" | "withdrawn";
  /** kiedy osoba wyraziła/wycofała zgodę ZE ŹRÓDŁA (reguła „nowszy wypis wygrywa”) */
  kiedy: Date;
  /** `consents.source`, np. `checkout_woocommerce`, `shopify` */
  zrodlo: string;
  /** treść klauzuli, jeśli źródło ją zna (Woo: z wersji w `store_consent_versions`) */
  tresc?: string | null;
  storeConsentVersionId?: string | null;
  /** opis dowodu do `consents.method_detail` (numer zamówienia, poziom opt-in, wersja) */
  szczegol?: string | null;
}

/** Pozycja koszyka w kształcie `carts.items` (E.5). */
export interface PozycjaKoszyka {
  product_id: string;
  variant_id: string | null;
  title: string;
  qty: number;
  price_minor: string | null;
  image_url: string | null;
  url: string | null;
}

/** Stan koszyka/checkoutu zgłoszony przez sklep (wtyczka Woo, webhook Shopify `checkouts/*`). */
export interface KoszykSklepu {
  token: string;
  etap: "cart" | "checkout";
  pozycje: PozycjaKoszyka[];
  wartoscMinor: number | null;
  waluta: Waluta | null;
  /** link „wróć do koszyka” działający na innym urządzeniu; tylko na domenie sklepu */
  linkPowrotu: string | null;
  zmodyfikowaneAt: Date;
}

/**
 * Role metryk (tabela `metric_mappings`, 0044 + 0046). Szablon flow wskazuje ROLĘ, a połączenie
 * sklepu ustawia, która metryka ją pełni: „po zakupie” na Woo i na Shopify to ten sam szablon.
 */
export const ROLE_ZAMOWIEN = ["placed_order", "ordered_product", "fulfilled_order", "cancelled_order", "refunded_order"] as const;
export type RolaZamowienia = (typeof ROLE_ZAMOWIEN)[number];
export const ROLE_ZACHOWAN = ["started_checkout", "added_to_cart", "viewed_product", "active_on_site"] as const;
export type RolaMetryki = RolaZamowienia | (typeof ROLE_ZACHOWAN)[number];

/** Nazwy metryk zamówień (jak w Klaviyo) pod integracją platformy sklepu. */
export const NAZWY_METRYK_ZAMOWIEN: Record<RolaZamowienia, string> = {
  placed_order: "Placed Order",
  ordered_product: "Ordered Product",
  fulfilled_order: "Fulfilled Order",
  cancelled_order: "Cancelled Order",
  refunded_order: "Refunded Order",
};

/** Role statusów zamówienia, które emitują własną metrykę przy zmianie statusu. */
export type RolaStatusu = Extract<RolaZamowienia, "fulfilled_order" | "cancelled_order" | "refunded_order">;

/** Co dana platforma potrafi u tego konkretnego sklepu (AD-8, AD-29). */
export interface MozliwosciPlatformy {
  zamowienia: boolean;
  klienci: boolean;
  produkty: boolean;
  /** Porzucony koszyk: Woo nie ma tego natywnie, Shoper prawdopodobnie też nie. */
  porzuconyKoszyk: boolean;
  webhooki: boolean;
  /** Katalog z wariantami, zdjęciem i adresem (E.4). */
  katalog?: boolean;
  /** Added to Cart / Started Checkout liczone po stronie serwera (wtyczka Woo, webhook Shopify). */
  checkoutSerwerowy?: boolean;
  /** Link „wróć do koszyka” działający na innym urządzeniu. */
  linkKoszyka?: boolean;
  /** Zgody marketingowe ze sklepu (checkbox w checkoucie, Shopify emailMarketingConsent). */
  zgody?: boolean;
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

/** Byt opisany kluczem idempotencji (`{platforma}:{tenant}:{byt}:{id}:{wersja}`, AD-24). */
export type BytSklepu = "order" | "customer" | "product";

/**
 * Webhook tak, jak opisuje go sklep. `id` liczbowe w Woo, tekstowe (GID) w Shopify.
 * `status` surowy (Woo: active | paused | disabled); normalizuje go `normalizujStatus`.
 */
export interface WebhookSklepu {
  id: number | string;
  nazwa: string;
  status: string;
  temat: string;
  adresDostawy: string;
  zmodyfikowanyAt: string | null;
}

/**
 * Webhooki PO STRONIE SKLEPU (rejestracja, odczyt zwrotny, dedup). Wspólna procedura
 * `zarejestrujWebhoki` (usecases/podlacz-sklep.ts) woła wyłącznie te metody.
 */
export interface PortWebhookow {
  listujWebhooki(): Promise<WebhookSklepu[]>;
  pobierzWebhook(id: number | string): Promise<WebhookSklepu | null>;
  utworzWebhook(dane: { nazwa: string; temat: string; adresDostawy: string; sekret: string }): Promise<WebhookSklepu>;
  zaktualizujWebhook(
    id: number | string,
    dane: { sekret?: string; status?: "active" | "paused" | "disabled"; adresDostawy?: string },
  ): Promise<WebhookSklepu>;
  usunWebhook(id: number | string): Promise<void>;
}

/**
 * Port „Sklep” (E.1). Rozszerza dawny `PortPlatformy` o platformę `custom`, webhooki
 * i katalog. Wszystkie daty ZE ŹRÓDŁA (AD-10); import = `source='import'`, backfill.
 */
export interface PortSklepu extends Partial<PortWebhookow> {
  readonly platforma: PlatformaSklepu;
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
  /** Katalog: produkty z wariantami, adresem i zdjęciem. `zmienioneOd` = przyrost. */
  pobierzProdukty(strona: number, naStrone: number, opcje?: { zmienioneOd?: Date }): Promise<StronaWynikow<ProduktSklepu>>;
  /** Jedno zamówienie (dociąganie po webhooku z niepełnym payloadem, Shoper). */
  pobierzZamowienie?(externalId: string): Promise<ZamowienieSklepu | null>;
  /** Liczba zamówień w sklepie w danym okresie. Podstawa ekranu zgodności (FR14). */
  policzZamowienia(od?: Date, do_?: Date): Promise<number>;
  /** Liczba kont klientów w sklepie - do planu importu (ile profili powstanie). */
  policzKlientow(): Promise<number>;
  /**
   * Klucz idempotencji opisuje BYT, nie kanał (AD-24). Ta sama funkcja obsługuje
   * webhook i import historyczny, więc to samo zamówienie nie wejdzie dwiema drogami.
   */
  kluczIdempotencji(byt: BytSklepu, externalId: string, wersja: string): string;
}

/** Dawna nazwa portu (AD-8). Zostaje dla zgodności importów. */
export type PortPlatformy = PortSklepu;
