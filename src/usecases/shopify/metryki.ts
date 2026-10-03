import type { DefinicjaMetrykiWbudowanej } from "../../domain/zdarzenia/kontrakt";

/**
 * Metryki serwerowe Shopify (plan E.3): integracja `shopify`, nazwy 1:1 z Klaviyo.
 * Zachowania z przeglądarki (Viewed Product, Added to Cart) idą z piksela pod `midrev`.
 * Placed Order/Ordered Product WYŁĄCZNIE z serwera (webhook, import), nigdy z piksela (E.7).
 */
export const METRYKI_SHOPIFY = {
  zlozoneZamowienie: { integracja: "shopify", nazwa: "Placed Order", mozeWyzwalac: true, ukryta: false },
  zamowionyProdukt: { integracja: "shopify", nazwa: "Ordered Product", mozeWyzwalac: true, ukryta: false },
  zrealizowaneZamowienie: { integracja: "shopify", nazwa: "Fulfilled Order", mozeWyzwalac: true, ukryta: false },
  anulowaneZamowienie: { integracja: "shopify", nazwa: "Cancelled Order", mozeWyzwalac: true, ukryta: false },
  zwroconeZamowienie: { integracja: "shopify", nazwa: "Refunded Order", mozeWyzwalac: true, ukryta: false },
  rozpoczetyCheckout: { integracja: "shopify", nazwa: "Started Checkout", mozeWyzwalac: true, ukryta: false },
} as const satisfies Record<string, DefinicjaMetrykiWbudowanej>;
