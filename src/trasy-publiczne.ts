/**
 * JEDNA lista tras dostępnych bez sesji panelu. Czyta ją middleware (pierwsze sito,
 * edge: ten plik nie może niczego importować), a test `tests/trasy-publiczne.test.ts`
 * zderza ją z drzewem `src/app`: każda trasa musi być albo tutaj, albo na jawnej liście
 * tras chronionych w teście. Nowa trasa bez decyzji = czerwony test.
 *
 * Skąd ta lista: pixel otwarć `/api/o` brakował tu przez kilka tygodni, a na serwerze
 * dev nikt tego nie widział (dev nie stosował middleware). W buildzie produkcyjnym
 * klient pocztowy dostawał zamiast GIF-a przekierowanie na /logowanie, a raporty
 * pokazywałyby po cichu 0% otwarć (audyt 28.09, P0-2).
 *
 * Trasa publiczna NIE znaczy „bez ochrony": każda z nich sama sprawdza token, podpis
 * albo limit. Middleware tylko nie odsyła jej na ekran logowania.
 *
 * Dopasowanie po CAŁYCH segmentach: "/r" łapie "/r/abc", ale nie "/raporty".
 * Uwaga przy dopisywaniu: prefiks obejmuje wszystko pod spodem, więc publiczny ma być
 * możliwie wąski segment (np. "/api/webhooks", a nie "/api").
 */
export const TRASY_PUBLICZNE = [
  // ekran logowania (strona + server action)
  "/logowanie",
  // zasoby Nexta (JS, CSS, obrazy statyczne) i ikona karty
  "/_next",
  "/favicon.ico",
  // odbiorca maila, bez konta:
  "/r", //         przekierowanie kliknięcia z tokenem per odbiorca
  "/u", //         wypis: GET strona z przyciskiem, POST one-click (RFC 8058)
  "/api/o", //     pixel otwarć
  "/o", //         obrazy z biblioteki wstawione w maile
  // klient agencji bez konta: podgląd i akceptacja kampanii po tokenie (strona + akcja)
  "/akceptacja",
  // strona sklepu: skrypt popupów i zgłoszenie zapisu (CORS, limit, walidacja)
  "/s",
  "/api/popup",
  // sklep: webhooki Woo/Shopify (podpis HMAC, nie sesja); SES/SNS: podpis SNS (0040)
  "/api/webhooks",
  // informatyk klienta bez konta: rekordy DNS do wpisania (token 14 dni, tylko odczyt)
  "/dns",
  // monitoring z zewnątrz: bez danych, tylko stan (200/503)
  "/api/zdrowie",
  // API zgodne z Klaviyo (klucz API tenanta w nagłówku Authorization, nie sesja);
  // docelowo pod osobnym hostem api.midrev.pl (deploy/Caddyfile)
  "/api/events",
  // integracja „custom” jak Klaviyo (0044): skrypt midrev.js po kluczu publicznym strony
  // i Client API (`?company_id=` = klucz publiczny; tylko zapis, CORS, limity per IP i klucz)
  "/js/v1",
  "/client/events",
  "/client/profiles",
  "/client/subscriptions",
] as const;

/**
 * Trasy API zgodne z Klaviyo, które klienci wołają Z UKOŚNIKIEM na końcu (`/api/events/`,
 * tak jak w workflowach n8n). Next domyślnie odpowiada na to 308, a przekierowanie POST-a
 * z ciałem to ryzyko utraty zdarzenia po stronie klienta. next.config ma
 * `skipTrailingSlashRedirect`, a middleware przepisuje (rewrite, bez 308) te ścieżki na
 * wersję bez ukośnika. Pozostałe ścieżki z ukośnikiem dostają dotychczasowe 308.
 */
export const TRASY_API_Z_UKOSNIKIEM = ["/api/events", "/client/events", "/client/profiles", "/client/subscriptions"] as const;

export function czyTrasaPubliczna(sciezka: string): boolean {
  return TRASY_PUBLICZNE.some((p) => sciezka === p || sciezka.startsWith(p + "/"));
}
