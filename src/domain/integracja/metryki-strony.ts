/**
 * Metryki przeglądarki (skrypt midrev.js i `/client/events`). Wszystkie pod integracją
 * `midrev` (jak w planie Shopera), nazwy 1:1 z Klaviyo, żeby szablony flow i filtry
 * przeniesione z Klaviyo działały bez zmian.
 */

export const METRYKI_STRONY = {
  aktywnyNaStronie: "Active on Site",
  ogladanyProdukt: "Viewed Product",
  dodanoDoKoszyka: "Added to Cart",
  rozpoczetoZamowienie: "Started Checkout",
} as const;

export const STANDARDOWE_METRYKI_STRONY: ReadonlySet<string> = new Set(Object.values(METRYKI_STRONY));

/**
 * Nazwy, których przeglądarka NIE może wysłać: metryki wbudowane liczone przez sam system
 * (formularze, e-mail, RODO, techniczne). Przeglądarka z kluczem publicznym podszywająca
 * się pod „Submitted Form” wyzwalałaby powitania bez zapisu, a „Received Email” fałszowałby
 * raporty. Porównanie bez wielkości liter i białych znaków na brzegach.
 */
const ZASTRZEZONE = [
  "Submitted Form",
  "Viewed Form",
  "Viewed Form Step",
  "Received Email",
  "Opened Email",
  "Clicked Email",
  "Bounced Email",
  "Dropped Email",
  "Marked Email as Spam",
  "Unsubscribed",
  "Unsubscribed from Email Marketing",
  "Subscribed to Email Marketing",
  "Subscribed to List",
  "Unsubscribed from List",
  "Placed Order",
  "Ordered Product",
  "Fulfilled Order",
  "Cancelled Order",
  "Refunded Order",
].map((n) => n.toLowerCase());

export function czyNazwaZastrzezona(nazwa: string): boolean {
  const n = nazwa.trim().toLowerCase();
  if (ZASTRZEZONE.includes(n)) return true;
  // techniczne (customer.*, rodo.*) i wszystko, co wygląda jak typ systemowy
  return /^(customer|rodo|popup|order|list|system)\./.test(n);
}

/** Ile WŁASNYCH (niestandardowych) metryk przeglądarka może założyć jednemu tenantowi. */
export const MAKS_WLASNYCH_METRYK_STRONY = 50;
