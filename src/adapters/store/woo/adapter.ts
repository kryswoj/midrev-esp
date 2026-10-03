import type {
  BytSklepu,
  KlientSklepu,
  MozliwosciPlatformy,
  PortSklepu,
  ProduktSklepu,
  StronaWynikow,
  WariantSklepu,
  WebhookSklepu,
  WynikWeryfikacji,
  ZamowienieSklepu,
} from "../../../domain/store/contract";
import { naGrosze } from "../../../domain/kwoty";

export interface PoswiadczeniaWoo {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

/**
 * Mapowanie surowego zamówienia Woo na model domenowy. Wyciągnięte z adaptera,
 * bo z tego samego kształtu korzysta import historyczny (REST) i webhook (faza 2):
 * dwa mapowania rozjechałyby się przy pierwszej zmianie.
 */
/** Kwota pozycji bywa pusta w starych zamówieniach: brak zamiast błędu całego mapowania. */
function groszeAlboNull(kwota: unknown): number | null {
  if (typeof kwota !== "string" && typeof kwota !== "number") return null;
  try {
    return naGrosze(kwota);
  } catch {
    return null;
  }
}

export function mapujZamowienieWoo(z: any): ZamowienieSklepu {
  // data ZE ŹRÓDŁA jest obowiązkowa (AD-10): bez niej `new Date(undefined + "Z")` dawało
  // Invalid Date, które Postgres odrzucał dopiero przy zapisie, bez nazwy przyczyny (N6)
  if (!z || typeof z.date_created_gmt !== "string" || !z.date_created_gmt) {
    throw new Error(`Zamówienie ${String(z?.id ?? "?")} bez date_created_gmt - nie zapisuję bez daty ze źródła`);
  }
  return {
    externalId: String(z.id),
    numer: z.number ?? null,
    status: z.status,
    email: z.billing?.email || null,
    imie: z.billing?.first_name || null,
    nazwisko: z.billing?.last_name || null,
    sumaMinor: naGrosze(z.total),
    waluta: z.currency ?? "PLN",
    // Woo podaje czas UTC bez sufiksu, stąd doklejone "Z".
    occurredAt: new Date(z.date_created_gmt + "Z"),
    zmodyfikowaneAt: new Date((z.date_modified_gmt ?? z.date_created_gmt) + "Z"),
    pozycje: (z.line_items ?? []).map((p: any) => ({
      sku: p.sku || null,
      nazwa: p.name,
      ilosc: Number(p.quantity),
      cenaMinor: naGrosze(p.price ?? "0"),
      lineId: p.id !== undefined && p.id !== null ? String(p.id) : null,
      productId: p.product_id ? String(p.product_id) : null,
      sumaMinor: groszeAlboNull(p.total),
      variantId: p.variation_id ? String(p.variation_id) : null,
    })),
    tokenKoszyka: tokenKoszykaZMeta(z.meta_data),
    surowe: z,
  };
}

/**
 * Token koszyka zapisany przez wtyczkę MidRev w meta zamówienia (`_mrv_cart_token`). REST v3
 * pokazuje meta z podkreślnikiem tylko, gdy wtyczka zarejestruje ją jako widoczną; brak = null
 * (koszyk zamknie wtedy dopasowanie po osobie i czasie).
 */
function tokenKoszykaZMeta(meta: unknown): string | null {
  if (!Array.isArray(meta)) return null;
  for (const m of meta) {
    if (m && typeof m === "object" && (m as any).key === "_mrv_cart_token" && typeof (m as any).value === "string") {
      const v = (m as any).value.trim();
      if (/^[A-Za-z0-9]{16,64}$/.test(v)) return v;
    }
  }
  return null;
}

/** Tekst bez HTML i białych znaków na brzegach (opis krótki, nazwa wariantu). */
function bezHtml(v: unknown, maks: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, maks) : null;
}

function adres(v: unknown): string | null {
  if (typeof v !== "string" || !/^https?:\/\//i.test(v) || v.length > 2000) return null;
  return v;
}

function liczbaAlboNull(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Wariant Woo (`/products/{id}/variations`) na wspólny kształt katalogu (E.4). Cena
 * przekreślona tylko przy promocji (regular > price), inaczej null.
 */
export function mapujWariantWoo(v: any): WariantSklepu {
  const cena = groszeAlboNull(v?.price);
  const regularna = groszeAlboNull(v?.regular_price);
  const atrybuty = Array.isArray(v?.attributes) ? v.attributes.map((a: any) => a?.option).filter(Boolean).join(" / ") : "";
  return {
    externalId: String(v.id),
    sku: v.sku || null,
    tytul: atrybuty ? atrybuty.slice(0, 500) : null,
    url: adres(v.permalink),
    obrazUrl: adres(v.image?.src),
    cenaMinor: cena,
    cenaPrzedMinor: regularna !== null && cena !== null && regularna > cena ? regularna : null,
    wMagazynie: v.stock_status ? v.stock_status !== "outofstock" : null,
    stan: liczbaAlboNull(v.stock_quantity),
    aktywny: (v.status ?? "publish") === "publish",
  };
}

/** Produkt Woo (REST v3 i webhook `product.*`) na wspólny kształt katalogu (E.4). */
export function mapujProduktWoo(p: any, warianty?: WariantSklepu[]): ProduktSklepu {
  const cena = groszeAlboNull(p?.price) ?? 0;
  const regularna = groszeAlboNull(p?.regular_price);
  return {
    externalId: String(p.id),
    nazwa: bezHtml(p.name, 500) ?? `Produkt ${String(p.id)}`,
    sku: p.sku || null,
    cenaMinor: cena,
    waluta: "PLN",
    kategorie: (p.categories ?? []).map((k: any) => k.name).filter((x: unknown) => typeof x === "string").slice(0, 20),
    url: adres(p.permalink),
    obrazUrl: adres(p.images?.[0]?.src),
    opisKrotki: bezHtml(p.short_description, 5000),
    cenaPrzedMinor: regularna !== null && regularna > cena ? regularna : null,
    marka: Array.isArray(p.brands) && p.brands[0]?.name ? String(p.brands[0].name).slice(0, 255) : null,
    wMagazynie: p.stock_status ? p.stock_status !== "outofstock" : null,
    stan: liczbaAlboNull(p.stock_quantity),
    aktywny: (p.status ?? "publish") === "publish" && p.catalog_visibility !== "hidden",
    // produkt zmienny bez pobranej listy wariantów (webhook product.*): warianty NIEZNANE, nie
    // puste - pusta lista wyłączyłaby w katalogu wszystkie warianty (review r1)
    warianty: warianty ?? (p.type === "variable" ? undefined : []),
    zmodyfikowaneAt: typeof p.date_modified_gmt === "string" && p.date_modified_gmt ? new Date(p.date_modified_gmt + "Z") : null,
  };
}

/**
 * Mapowanie klienta Woo (konto w sklepie) na model domenowy. Ten sam kształt dla
 * importu (`/customers`) i webhooka `customer.*` (faza 2). Klient Woo bez żadnej
 * modyfikacji ma `date_modified_gmt: null` - wtedy wersją jest data utworzenia.
 * Telefon bierzemy z adresu rozliczeniowego; poza nim Woo go nie trzyma.
 */
export function mapujKlientaWoo(k: any): KlientSklepu {
  if (!k || typeof k.date_created_gmt !== "string" || !k.date_created_gmt) {
    throw new Error(`Klient ${String(k?.id ?? "?")} bez date_created_gmt - nie zapisuję bez daty ze źródła`);
  }
  return {
    externalId: String(k.id),
    email: k.email || null,
    imie: k.first_name || k.billing?.first_name || null,
    nazwisko: k.last_name || k.billing?.last_name || null,
    telefon: k.billing?.phone || null,
    occurredAt: new Date(k.date_created_gmt + "Z"),
    zmodyfikowaneAt: new Date((k.date_modified_gmt ?? k.date_created_gmt) + "Z"),
    surowe: k,
  };
}

/** Pola zamówienia wystarczające do PLANU importu (e-mail, kwota, daty) - bez pozycji i metadanych. */
const POLA_ZAMOWIENIA_LEKKO = "id,number,status,billing,total,currency,date_created_gmt,date_modified_gmt";

/**
 * Adapter WooCommerce (AD-8). Uwierzytelnianie Basic po HTTPS, dokładnie tak, jak
 * w prawdziwym sklepie klienta. Lokalny sandbox udaje HTTPS dla ścieżek REST po swojej
 * stronie, więc adapter nie ma tu żadnego wyjątku "na testy".
 */
export class AdapterWoo implements PortSklepu {
  readonly platforma = "woocommerce" as const;
  #p: PoswiadczeniaWoo;
  #tenantId: string;

  constructor(tenantId: string, poswiadczenia: PoswiadczeniaWoo) {
    this.#tenantId = tenantId;
    this.#p = poswiadczenia;
  }

  #naglowki(): HeadersInit {
    const auth = Buffer.from(`${this.#p.consumerKey}:${this.#p.consumerSecret}`).toString("base64");
    return { Authorization: `Basic ${auth}`, Accept: "application/json" };
  }

  async #pobierz(sciezka: string, parametry: Record<string, string | number> = {}) {
    const url = new URL(`/wp-json/wc/v3/${sciezka}`, this.#p.baseUrl);
    for (const [k, v] of Object.entries(parametry)) url.searchParams.set(k, String(v));
    const odpowiedz = await fetch(url, { headers: this.#naglowki() });
    return odpowiedz;
  }

  /**
   * Jedna strona listy z nagłówkami paginacji. Odpowiedź inna niż 2xx to BŁĄD z nazwą
   * (kod Woo + HTTP), nie pusta strona: bez tego 5xx sklepu wyglądało jak "koniec
   * danych" i import kończył się zielonym komunikatem na połowie historii (audyt #13, N7).
   */
  async #pobierzStrone(
    sciezka: string,
    parametry: Record<string, string | number>,
  ): Promise<{ dane: any[]; lacznie: number; stron: number }> {
    const odpowiedz = await this.#pobierz(sciezka, parametry);
    if (!odpowiedz.ok) {
      let kod = `HTTP ${odpowiedz.status}`;
      try {
        const tresc = (await odpowiedz.json()) as { code?: string };
        if (tresc?.code) kod = `${tresc.code} (HTTP ${odpowiedz.status})`;
      } catch {
        /* nie-JSON: zostaje sam kod HTTP */
      }
      const opis = Object.entries(parametry)
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      throw new Error(`Sklep odrzucił GET ${sciezka}?${opis}: ${kod}`);
    }
    const dane = await odpowiedz.json();
    if (!Array.isArray(dane)) {
      throw new Error(`Sklep oddał na GET ${sciezka} coś, co nie jest listą`);
    }
    // brak nagłówków paginacji (proxy/WAF/cache je zdejmuje) NIE jest "jedną stroną":
    // tak wyglądał cichy sukces na setce zamówień z ośmiu tysięcy (review #10)
    const lacznie = odpowiedz.headers.get("x-wp-total");
    const stron = odpowiedz.headers.get("x-wp-totalpages");
    if (lacznie === null || stron === null || !/^\d+$/.test(lacznie) || !/^\d+$/.test(stron)) {
      throw new Error(
        `Sklep nie podał nagłówków X-WP-Total/X-WP-TotalPages na GET ${sciezka} - kompletności listy nie da się potwierdzić`,
      );
    }
    return { dane, lacznie: Number(lacznie), stron: Number(stron) };
  }

  async weryfikujPoswiadczenia(): Promise<WynikWeryfikacji> {
    // Sprawdzamy KAŻDY potrzebny zakres osobno. Klucze tylko do produktów przechodzą
    // ogólny test połączenia, a potem import zamówień kończy się pustym wynikiem
    // i wygląda jak "sklep bez historii" zamiast jak brak uprawnień (FR9).
    const zakresy: Array<[string, string]> = [
      ["orders", "zamówienia"],
      ["customers", "klienci"],
      ["products", "produkty"],
    ];
    const brakujace: string[] = [];
    for (const [sciezka, nazwa] of zakresy) {
      let odpowiedz: Response;
      try {
        odpowiedz = await this.#pobierz(sciezka, { per_page: 1 });
      } catch (blad) {
        return {
          ok: false,
          brakujaceUprawnienia: [],
          powod: "brak-odpowiedzi",
          szczegoly: blad instanceof Error ? blad.message : String(blad),
        };
      }
      if (odpowiedz.status === 401) {
        const tresc = await odpowiedz.text();
        // Woo odpowiada 401 zarówno na złe klucze, jak i na klucze bez zakresu.
        // Rozróżnienie leży w treści, a bez niego operator nie wie, co poprawić.
        if (tresc.includes("woocommerce_rest_cannot_view")) brakujace.push(nazwa);
        else
          return {
            ok: false,
            brakujaceUprawnienia: [],
            powod: "bledne-poswiadczenia",
            szczegoly: "Sklep odrzucił klucze",
          };
      } else if (!odpowiedz.ok) {
        return {
          ok: false,
          brakujaceUprawnienia: [],
          powod: "brak-odpowiedzi",
          szczegoly: `HTTP ${odpowiedz.status}`,
        };
      }
    }
    return brakujace.length
      ? { ok: false, brakujaceUprawnienia: brakujace, powod: "brak-uprawnien" }
      : { ok: true, brakujaceUprawnienia: [] };
  }

  mozliwosci(): MozliwosciPlatformy {
    return {
      zamowienia: true,
      klienci: true,
      produkty: true,
      // Woo nie ma natywnego zdarzenia porzuconego koszyka. Deklarujemy to wprost,
      // żeby interfejs nie oferował operatorowi automatyzacji, która tu nie zadziała.
      porzuconyKoszyk: false,
      webhooki: true,
      katalog: true,
    };
  }

  kluczIdempotencji(byt: BytSklepu, externalId: string, wersja: string): string {
    return `woocommerce:${this.#tenantId}:${byt}:${externalId}:${wersja}`;
  }

  /** Konta klientów (rola `customer` - domyślna dla tego endpointu; administratorzy sklepu nie są klientami). */
  async pobierzKlientow(strona: number, naStrone: number): Promise<StronaWynikow<KlientSklepu>> {
    const { dane, lacznie, stron } = await this.#pobierzStrone("customers", {
      page: strona,
      per_page: naStrone,
      orderby: "id",
      order: "asc",
    });
    return { lacznie, stron, pozycje: dane.map(mapujKlientaWoo) };
  }

  async pobierzZamowienia(opcje: {
    strona: number;
    naStrone: number;
    od?: Date;
    lekko?: boolean;
  }): Promise<StronaWynikow<ZamowienieSklepu>> {
    const parametry: Record<string, string | number> = {
      page: opcje.strona,
      per_page: opcje.naStrone,
      // stały porządek po id, nie po dacie: zamówienia z tą samą datą (seed, import
      // hurtowy) potrafią zamieniać się miejscami między stronami przy sortowaniu po
      // dacie i ta sama pozycja wraca dwa razy, a inna znika (review R2)
      orderby: "id",
      order: "asc",
      status: "any",
    };
    if (opcje.od) parametry.after = opcje.od.toISOString();
    if (opcje.lekko) parametry._fields = POLA_ZAMOWIENIA_LEKKO;
    const { dane, lacznie, stron } = await this.#pobierzStrone("orders", parametry);
    return { lacznie, stron, pozycje: dane.map(mapujZamowienieWoo) };
  }

  /**
   * Katalog (E.4): produkty z wariantami. Warianty produktu zmiennego to osobne zapytanie
   * na produkt (`/products/{id}/variations`), więc strona 100 produktów zmiennych = 101 żądań;
   * przy synchronizacji przyrostowej (`zmienioneOd`, Woo `modified_after`) to kilka produktów.
   * Wszystkie statusy (`status=any`): wycofany produkt ma trafić do katalogu jako nieaktywny,
   * a nie zniknąć bez śladu.
   */
  async pobierzProdukty(
    strona: number,
    naStrone: number,
    opcje: { zmienioneOd?: Date } = {},
  ): Promise<StronaWynikow<ProduktSklepu>> {
    const parametry: Record<string, string | number> = { page: strona, per_page: naStrone, orderby: "id", order: "asc", status: "any" };
    if (opcje.zmienioneOd) {
      parametry.modified_after = opcje.zmienioneOd.toISOString();
      parametry.dates_are_gmt = "true";
    }
    const { dane, lacznie, stron } = await this.#pobierzStrone("products", parametry);
    const pozycje: ProduktSklepu[] = [];
    for (const p of dane) {
      let warianty: WariantSklepu[] | undefined;
      if (p.type === "variable") {
        warianty = Array.isArray(p.variations) && p.variations.length ? await this.pobierzWarianty(String(p.id)) : [];
      }
      pozycje.push(mapujProduktWoo(p, warianty));
    }
    return { lacznie, stron, pozycje };
  }

  /** Wszystkie warianty produktu (do 100 stron po 100; więcej wariantów niż 10 tys. to nie sklep). */
  async pobierzWarianty(productId: string): Promise<WariantSklepu[]> {
    const wynik: WariantSklepu[] = [];
    for (let strona = 1; strona <= 100; strona++) {
      const { dane, stron } = await this.#pobierzStrone(`products/${encodeURIComponent(productId)}/variations`, {
        page: strona,
        per_page: 100,
        status: "any",
      });
      wynik.push(...dane.map(mapujWariantWoo));
      if (strona >= stron || dane.length === 0) break;
    }
    return wynik;
  }

  /** Jedno zamówienie po id (dociąganie po webhooku). 404 = null. */
  async pobierzZamowienie(externalId: string): Promise<ZamowienieSklepu | null> {
    const odpowiedz = await this.#pobierz(`orders/${encodeURIComponent(externalId)}`);
    if (odpowiedz.status === 404) return null;
    if (!odpowiedz.ok) throw new Error(`Sklep odrzucił GET orders/${externalId}: HTTP ${odpowiedz.status}`);
    return mapujZamowienieWoo(await odpowiedz.json());
  }

  // ── Webhooki po stronie sklepu (B3) ──────────────────────────────────────────
  //
  // WooCommerce dostarcza webhooki z wp-crona, więc sklep bez ruchu nie wyśle nic,
  // dopóki ktoś nie uderzy w wp-cron.php. Dodatkowo WordPress blokuje dostawę na
  // adresy prywatne (filtr http_request_host_is_external) i na porty inne niż
  // 80, 443 i 8080 (filtr http_allowed_safe_ports) - to są dwie ciche przyczyny
  // "zarejestrowałem, a nic nie przychodzi" przy sklepie na prawdziwym hostingu.

  async #zapis(
    metoda: "POST" | "PUT" | "DELETE",
    sciezka: string,
    cialo?: Record<string, unknown>,
  ): Promise<any> {
    const url = new URL(`/wp-json/wc/v3/${sciezka}`, this.#p.baseUrl);
    const odpowiedz = await fetch(url, {
      method: metoda,
      headers: { ...this.#naglowki(), "content-type": "application/json" },
      body: cialo ? JSON.stringify(cialo) : undefined,
    });
    if (!odpowiedz.ok) {
      // treść błędu Woo niesie kod ("woocommerce_rest_cannot_create") - bez niego
      // operator nie odróżni kluczy bez prawa zapisu od sklepu, który leży.
      let kod = `HTTP ${odpowiedz.status}`;
      try {
        const tresc = (await odpowiedz.json()) as { code?: string; message?: string };
        if (tresc?.code) kod = `${tresc.code} (HTTP ${odpowiedz.status})`;
      } catch {
        /* sklep oddał coś, co nie jest JSON-em - zostaje sam kod HTTP */
      }
      throw new Error(`${metoda} ${sciezka}: ${kod}`);
    }
    return odpowiedz.json();
  }

  #mapujWebhook(w: any): WebhookSklepu {
    return {
      id: Number(w.id),
      nazwa: String(w.name ?? ""),
      status: String(w.status ?? ""),
      temat: String(w.topic ?? ""),
      adresDostawy: String(w.delivery_url ?? ""),
      zmodyfikowanyAt: w.date_modified_gmt ? `${w.date_modified_gmt}Z` : null,
    };
  }

  /**
   * Wszystkie webhooki sklepu, ze wszystkimi statusami. `status=all` jawnie, bo
   * webhook wstrzymany albo wyłączony MUSI być widoczny - inaczej dedup go nie
   * zobaczy i przy ponownym podłączeniu powstanie duplikat obok martwego wpisu.
   */
  async listujWebhooki(): Promise<WebhookSklepu[]> {
    const wszystkie: WebhookSklepu[] = [];
    for (let strona = 1; strona <= 20; strona++) {
      const odpowiedz = await this.#pobierz("webhooks", {
        page: strona,
        per_page: 100,
        status: "all",
      });
      if (!odpowiedz.ok) throw new Error(`GET webhooks: HTTP ${odpowiedz.status}`);
      const dane = (await odpowiedz.json()) as any[];
      wszystkie.push(...dane.map((w) => this.#mapujWebhook(w)));
      const stron = Number(odpowiedz.headers.get("x-wp-totalpages") ?? 1);
      if (strona >= stron || dane.length === 0) break;
    }
    return wszystkie;
  }

  async pobierzWebhook(id: number | string): Promise<WebhookSklepu | null> {
    const odpowiedz = await this.#pobierz(`webhooks/${id}`);
    if (odpowiedz.status === 404) return null;
    if (!odpowiedz.ok) throw new Error(`GET webhooks/${id}: HTTP ${odpowiedz.status}`);
    return this.#mapujWebhook(await odpowiedz.json());
  }

  /**
   * Utworzenie webhooka. `status` przy POST jest przez Woo IGNOROWANY (kontroler
   * REST bierze go tylko przy PUT), więc świeży webhook wychodzi jako active,
   * ale to jest założenie o kodzie wtyczki, nie dowód: stan i tak potwierdza
   * osobny odczyt zwrotny.
   */
  async utworzWebhook(dane: {
    nazwa: string;
    temat: string;
    adresDostawy: string;
    sekret: string;
  }): Promise<WebhookSklepu> {
    const wynik = await this.#zapis("POST", "webhooks", {
      name: dane.nazwa,
      topic: dane.temat,
      delivery_url: dane.adresDostawy,
      secret: dane.sekret,
      status: "active",
    });
    return this.#mapujWebhook(wynik);
  }

  /**
   * Ustawienie sekretu i statusu na istniejącym webhooku. Sekretu nie da się
   * odczytać z API, więc przy ponownym podłączeniu NADPISUJEMY go naszym -
   * inaczej sklep podpisywałby dostawy kluczem, którego nie znamy, a endpoint
   * odrzucałby wszystko jako zły podpis. Cisza zamiast błędu, znowu.
   */
  async zaktualizujWebhook(
    id: number | string,
    dane: { sekret?: string; status?: "active" | "paused" | "disabled"; adresDostawy?: string },
  ): Promise<WebhookSklepu> {
    const cialo: Record<string, unknown> = {};
    if (dane.sekret !== undefined) cialo.secret = dane.sekret;
    if (dane.status !== undefined) cialo.status = dane.status;
    if (dane.adresDostawy !== undefined) cialo.delivery_url = dane.adresDostawy;
    return this.#mapujWebhook(await this.#zapis("PUT", `webhooks/${id}`, cialo));
  }

  /** Kasowanie tylko przez `force`: Woo bez tego wrzuca webhooka do kosza i nadal go listuje. */
  async usunWebhook(id: number | string): Promise<void> {
    await this.#zapis("DELETE", `webhooks/${id}?force=true`);
  }

  async policzZamowienia(od?: Date, do_?: Date): Promise<number> {
    const parametry: Record<string, string | number> = { per_page: 1, status: "any", _fields: "id" };
    if (od) parametry.after = od.toISOString();
    if (do_) parametry.before = do_.toISOString();
    return (await this.#pobierzStrone("orders", parametry)).lacznie;
  }

  async policzKlientow(): Promise<number> {
    return (await this.#pobierzStrone("customers", { per_page: 1, _fields: "id" })).lacznie;
  }
}
