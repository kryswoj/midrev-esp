/**
 * Webhooki sklepu: tematy, stan i jego normalizacja (B3).
 *
 * Endpoint przyjmujący webhooki istniał wcześniej, ale nikt ich po stronie sklepu
 * nie zakładał. Skutek jest cichy: po jednorazowym imporcie historii dane sklepu
 * stają w miejscu, atrybucja liczy na starych zamówieniach, a automatyzacja na
 * zdarzeniu "zamówienie utworzone" nigdy nie strzela. Dlatego rejestracja jest
 * częścią podłączania sklepu, a jej stan ma nazwę, datę i miejsce na ekranie.
 */

/**
 * Tematy webhooków WooCommerce. Nazwy NIE są zgadywane: pochodzą z
 * `WC_Webhook::get_default_topic_hooks()` w kodzie wtyczki
 * (`includes/class-wc-webhook.php`), czyli z tego samego miejsca, którego używa
 * walidator `wc_is_webhook_valid_topic()` przy POST /wp-json/wc/v3/webhooks.
 * Pełna lista dopuszczalnych tematów tamże: coupon./customer./order./product.
 * z zdarzeniami created/updated/deleted/restored (+ product.published).
 *
 * Bierzemy minimum potrzebne CDP: zamówienia (przychód, atrybucja, automatyzacje)
 * i klienci (profil powstaje też bez zamówienia, np. rejestracja w sklepie).
 *
 * Tematy `customer.*` maja WLASNA sciezke w fazie 2 (`usecases/przetworz-zdarzenie.ts`):
 * upsert profilu bez zgody marketingowej (zalozenie konta w sklepie to nie zgoda, FR27)
 * i zdarzenie `customer.created` / `customer.updated` w strumieniu. Klucz idempotencji
 * niesie BYT z tematu (`kluczZdarzeniaWebhooka`), wiec klient 8 i zamowienie 8 nie
 * dziela przestrzeni kluczy (znalezisko audytu #4, 24.09).
 */
export const TEMATY_WEBHOOKOW = [
  "order.created",
  "order.updated",
  "customer.created",
  "customer.updated",
] as const;

export type TematWebhooka = (typeof TEMATY_WEBHOOKOW)[number];

/**
 * Czy temat jest jednym z subskrybowanych. Endpoint zapisuje WYLACZNIE te: `order.deleted`
 * czy `customer.deleted` (payload `{id}`) zapisane jako zdarzenie nie da sie przetworzyc
 * i krazy w kolejce z alertem co dobe (review #4).
 */
export function tematObslugiwany(temat: string): temat is TematWebhooka {
  return (TEMATY_WEBHOOKOW as readonly string[]).includes(temat);
}

/** Byt opisany kluczem idempotencji - ten sam slownik co `PortPlatformy.kluczIdempotencji`. */
export type BytWebhooka = "order" | "customer" | "product";

/**
 * Byt z tematu webhooka Woo ("order.updated" -> "order"). Nieznany temat to null,
 * nie "order": zgadywanie tutaj oznaczaloby mapowanie cudzego payloadu jako zamowienia.
 */
export function bytTematu(temat: string): BytWebhooka | null {
  const prefiks = temat.split(".")[0];
  return prefiks === "order" || prefiks === "customer" || prefiks === "product" ? prefiks : null;
}

/**
 * Klucz idempotencji zdarzenia z webhooka. Opisuje BYT, nie kanal (AD-24): to samo
 * zamowienie przyslane webhookiem i zaciagniete importem ma identyczny klucz
 * `woocommerce:{tenant}:{byt}:{id}:{wersja}`, wiec import i webhook nie wstawia go
 * dwa razy. Wersja bytu = data modyfikacji ze zrodla (nie status: order.updated z ta
 * sama wartoscia statusu, ale inna kwota, mialby ten sam klucz - review R2), z
 * fallbackiem na date utworzenia (klient Woo bez modyfikacji ma `date_modified_gmt: null`).
 */
export function kluczZdarzeniaWebhooka(
  tenantId: string,
  byt: BytWebhooka,
  dane: { id: string | number; date_modified_gmt?: string | null; date_created_gmt?: string | null; status?: string | null },
): string {
  const wersja = String(dane.date_modified_gmt ?? dane.date_created_gmt ?? dane.status ?? "?");
  return `woocommerce:${tenantId}:${byt}:${String(dane.id)}:${wersja}`;
}

/** Byt z zapisanego klucza idempotencji - faza 2 czyta z niego, jak mapowac payload. */
export function bytZKlucza(klucz: string): BytWebhooka | null {
  const czesc = klucz.split(":")[2];
  return czesc === "order" || czesc === "customer" || czesc === "product" ? czesc : null;
}

/** Webhook tak, jak opisuje go sklep. `status` surowy: active | paused | disabled. */
export interface WebhookSklepu {
  id: number;
  nazwa: string;
  status: string;
  temat: string;
  adresDostawy: string;
  zmodyfikowanyAt: string | null;
}

/**
 * Stan jednego tematu po odczycie zwrotnym ze sklepu. "aktywny" wolno ustawić
 * WYŁĄCZNIE na podstawie GET po utworzeniu, nigdy na podstawie kodu odpowiedzi
 * POST-a: Woo potrafi oddać 201 i zostawić webhooka w stanie paused albo wyłączyć
 * go później po serii nieudanych dostaw (failure_count).
 */
export type StanTematu = "aktywny" | "wstrzymany" | "wylaczony" | "brak" | "blad";

export interface WpisWebhooka {
  temat: string;
  webhookId: number | null;
  stan: StanTematu;
  /** Surowy status ze sklepu - do diagnostyki, nie na ekran (DESIGN: zero enumów platformy). */
  statusZrodla: string | null;
  /** Kiedy stan potwierdził ODCZYT ZWROTNY ze sklepu. Null = nie potwierdzony. */
  potwierdzonyAt: string | null;
  blad: string | null;
}

export interface StanWebhookow {
  /** Adres, pod który sklep ma dosyłać zdarzenia. Zapisany, bo zmiana APP_URL unieważnia rejestrację. */
  adresDostawy: string;
  /** Kiedy ostatnio pytaliśmy sklep o stan (odczyt zwrotny), nie kiedy wysłaliśmy POST. */
  sprawdzonyAt: string;
  wpisy: WpisWebhooka[];
  /** Błąd całej operacji (np. klucze bez prawa zapisu). Null, gdy rejestracja przeszła. */
  blad: string | null;
  /** Ile nadmiarowych webhooków pod naszym adresem usunięto przy ostatnim przebiegu. */
  usunieteDuplikaty?: number;
  /** Ostatni alert o ciszy - żeby nie wysyłać go co przebieg joba. */
  ostatniAlertCiszyAt?: string | null;
}

export function normalizujStatus(status: string | null | undefined): StanTematu {
  switch ((status ?? "").toLowerCase()) {
    case "active":
      return "aktywny";
    case "paused":
      return "wstrzymany";
    case "disabled":
      return "wylaczony";
    default:
      return "blad";
  }
}

/** Czy sklep realnie dosyła dane: każdy potrzebny temat potwierdzony jako aktywny. */
export function wszystkieAktywne(stan: StanWebhookow | null | undefined): boolean {
  if (!stan || stan.blad) return false;
  if (stan.wpisy.length < TEMATY_WEBHOOKOW.length) return false;
  return stan.wpisy.every((w) => w.stan === "aktywny" && w.potwierdzonyAt !== null);
}

/** Adres dostawy dla sklepu. Jeden kształt w kodzie i w bazie - inaczej dedup nie ma czego porównać. */
export function adresDostawy(appUrl: string, storeId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/woo/${storeId}`;
}
