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
  // sklep: webhooki Woo/Shopify (podpis HMAC, nie sesja)
  "/api/webhooks",
  // monitoring z zewnątrz: bez danych, tylko stan (200/503)
  "/api/zdrowie",
] as const;

export function czyTrasaPubliczna(sciezka: string): boolean {
  return TRASY_PUBLICZNE.some((p) => sciezka === p || sciezka.startsWith(p + "/"));
}
