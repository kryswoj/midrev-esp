import type { DefinicjaMetrykiWbudowanej } from "../../domain/zdarzenia/kontrakt";

/**
 * Metryki serwerowe Shopify spoza ról zamówień portu „Sklep” (plan E.3): integracja `shopify`,
 * nazwy 1:1 z Klaviyo. Placed Order / Ordered Product / Fulfilled / Cancelled liczy wspólny
 * `upsertZamowienie` (`metrykaZamowienia("shopify", rola)`). Zachowania z przeglądarki (Viewed
 * Product, Added to Cart) idą z piksela pod `midrev`. Placed Order NIGDY z piksela (E.7).
 */
export const METRYKI_SHOPIFY = {
  /** checkouts/* z e-mailem; unique_id `sc:{token checkoutu}` */
  rozpoczetyCheckout: { integracja: "shopify", nazwa: "Started Checkout", mozeWyzwalac: true, ukryta: false },
  /** refunds/create; unique_id `ref:{id zwrotu}`, kwota z transakcji zwrotu (także częściowy) */
  zwroconeZamowienie: { integracja: "shopify", nazwa: "Refunded Order", mozeWyzwalac: true, ukryta: false },
} as const satisfies Record<string, DefinicjaMetrykiWbudowanej>;
