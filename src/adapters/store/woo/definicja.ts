import { createHmac, timingSafeEqual } from "node:crypto";
import type { BytSklepu, RolaStatusu } from "../../../domain/store/contract";
import { bytTematu, kluczZdarzeniaWebhooka, tematObslugiwany, TEMATY_WEBHOOKOW } from "../webhooki";
import type { DefinicjaPlatformy } from "../rejestr";
import { AdapterWoo, mapujKlientaWoo, mapujProduktWoo, mapujZamowienieWoo } from "./adapter";

/**
 * WooCommerce w porcie „Sklep”. Zachowanie 1:1 z dotychczasową trasą
 * `/api/webhooks/woo/[storeId]` i fazą 2 (przetworz-zdarzenie.ts): te same tematy,
 * ten sam podpis, ten sam klucz idempotencji `woocommerce:{tenant}:{byt}:{id}:{wersja}`.
 */

/** Statusy Woo, które emitują metrykę statusu (jak Klaviyo na Woo: Fulfilled przy `completed`). */
const ROLE_STATUSOW: Record<string, RolaStatusu> = {
  completed: "fulfilled_order",
  cancelled: "cancelled_order",
  refunded: "refunded_order",
};

export const DEFINICJA_WOO: DefinicjaPlatformy = {
  platforma: "woocommerce",
  zrodloSurowych: "woocommerce",

  utworzAdapter(tenantId, baseUrl, p) {
    return new AdapterWoo(tenantId, { baseUrl, consumerKey: String(p.ck ?? ""), consumerSecret: String(p.cs ?? "") });
  },

  // Sekret podpisu trzymamy razem z kluczami REST; sklepy sprzed B3 podpisywały consumer secretem.
  sekretWebhooka(p) {
    const s = p.webhookSecret ?? p.cs;
    return typeof s === "string" && s ? s : null;
  },

  webhooki: {
    tematy: TEMATY_WEBHOOKOW,
    sciezkaDostawy: (storeId) => `/api/webhooks/woo/${storeId}`,
    temat: (n) => n.get("x-wc-webhook-topic") ?? "",
    zweryfikujPodpis(n, cialo, sekret) {
      const podpis = n.get("x-wc-webhook-signature") ?? "";
      const oczekiwany = createHmac("sha256", sekret).update(cialo, "utf8").digest("base64");
      const a = Buffer.from(podpis);
      const b = Buffer.from(oczekiwany);
      return a.length === b.length && timingSafeEqual(a, b);
    },
    // Woo wysyła na starcie ping bez podpisu ("webhook_id=..."): 200, żeby webhook dał się aktywować
    ping: (_n, cialo) => cialo.startsWith("webhook_id="),
    obslugiwany: tematObslugiwany,
    bytTematu: (t) => bytTematu(t) as BytSklepu | null,
    klucz(tenantId, byt, dane) {
      const id = String(dane?.id ?? "");
      if (!id) return { blad: "brak id" };
      // data ZE ZRODLA jest warunkiem zapisu (AD-10)
      if (typeof dane.date_created_gmt !== "string" || !dane.date_created_gmt) return { blad: "brak date_created_gmt" };
      return { klucz: kluczZdarzeniaWebhooka(tenantId, byt, { ...dane, id }) };
    },
  },

  mapujZamowienie: mapujZamowienieWoo,
  mapujKlienta: mapujKlientaWoo,
  mapujProdukt: (p) => mapujProduktWoo(p),
  rolaStatusu: (status) => ROLE_STATUSOW[status] ?? null,

  // identycznie jak klucz webhooka: data modyfikacji ze źródła, fallback na datę utworzenia (AD-24)
  wersjaBytu(byt) {
    const s = byt.surowe as { date_modified_gmt?: string | null; date_created_gmt?: string | null } | null;
    return String(s?.date_modified_gmt ?? s?.date_created_gmt ?? byt.zmodyfikowaneAt.toISOString());
  },
};
