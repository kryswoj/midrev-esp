import type {
  KlientSklepu,
  MozliwosciPlatformy,
  PortPlatformy,
  ProduktSklepu,
  StronaWynikow,
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
 * Adapter WooCommerce (AD-8). Uwierzytelnianie Basic po HTTPS, dokładnie tak, jak
 * w prawdziwym sklepie klienta. Lokalny sandbox udaje HTTPS dla ścieżek REST po swojej
 * stronie, więc adapter nie ma tu żadnego wyjątku "na testy".
 */
export class AdapterWoo implements PortPlatformy {
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
    };
  }

  kluczIdempotencji(byt: "order" | "customer" | "product", externalId: string, wersja: string): string {
    return `woocommerce:${this.#tenantId}:${byt}:${externalId}:${wersja}`;
  }

  async pobierzKlientow(strona: number, naStrone: number): Promise<StronaWynikow<KlientSklepu>> {
    const odpowiedz = await this.#pobierz("customers", { page: strona, per_page: naStrone });
    const dane = (await odpowiedz.json()) as any[];
    return {
      lacznie: Number(odpowiedz.headers.get("x-wp-total") ?? dane.length),
      pozycje: dane.map((k) => ({
        externalId: String(k.id),
        email: k.email || null,
        imie: k.first_name || null,
        nazwisko: k.last_name || null,
        occurredAt: new Date(k.date_created_gmt + "Z"),
      })),
    };
  }

  async pobierzZamowienia(opcje: {
    strona: number;
    naStrone: number;
    od?: Date;
  }): Promise<StronaWynikow<ZamowienieSklepu>> {
    const parametry: Record<string, string | number> = {
      page: opcje.strona,
      per_page: opcje.naStrone,
      orderby: "date",
      order: "asc",
      status: "any",
    };
    if (opcje.od) parametry.after = opcje.od.toISOString();
    const odpowiedz = await this.#pobierz("orders", parametry);
    const dane = (await odpowiedz.json()) as any[];
    return {
      lacznie: Number(odpowiedz.headers.get("x-wp-total") ?? dane.length),
      pozycje: dane.map((z) => ({
        externalId: String(z.id),
        numer: z.number ?? null,
        status: z.status,
        email: z.billing?.email || null,
        imie: z.billing?.first_name || null,
        nazwisko: z.billing?.last_name || null,
        sumaMinor: naGrosze(z.total),
        waluta: z.currency ?? "PLN",
        // data ZE ŹRÓDŁA (AD-10). Woo podaje czas UTC bez sufiksu, stąd doklejone "Z".
        occurredAt: new Date(z.date_created_gmt + "Z"),
        pozycje: (z.line_items ?? []).map((p: any) => ({
          sku: p.sku || null,
          nazwa: p.name,
          ilosc: Number(p.quantity),
          cenaMinor: naGrosze(p.price ?? "0"),
        })),
        surowe: z,
      })),
    };
  }

  async pobierzProdukty(strona: number, naStrone: number): Promise<StronaWynikow<ProduktSklepu>> {
    const odpowiedz = await this.#pobierz("products", { page: strona, per_page: naStrone });
    const dane = (await odpowiedz.json()) as any[];
    return {
      lacznie: Number(odpowiedz.headers.get("x-wp-total") ?? dane.length),
      pozycje: dane.map((p) => ({
        externalId: String(p.id),
        nazwa: p.name,
        sku: p.sku || null,
        cenaMinor: naGrosze(p.price || "0"),
        waluta: "PLN",
        kategorie: (p.categories ?? []).map((k: any) => k.name),
      })),
    };
  }

  async policzZamowienia(od?: Date, do_?: Date): Promise<number> {
    const parametry: Record<string, string | number> = { per_page: 1, status: "any" };
    if (od) parametry.after = od.toISOString();
    if (do_) parametry.before = do_.toISOString();
    const odpowiedz = await this.#pobierz("orders", parametry);
    return Number(odpowiedz.headers.get("x-wp-total") ?? 0);
  }
}
