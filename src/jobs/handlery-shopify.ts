import { krokImportuShopify } from "../usecases/shopify/import";
import type { Zadanie } from "./kolejka";

/**
 * Shopify (0047): import historii przez Bulk Operations. Jeden krok na wywołanie; krok sam
 * dodaje następny job, gdy operacja bulk po stronie Shopify jeszcze trwa. Webhooki Shopify
 * idą przez wspólny job `przetworz_zdarzenie` (rozdział po `raw_events.source`).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const HANDLERY_SHOPIFY: Record<string, (z: Zadanie) => Promise<void>> = {
  async import_shopify(z) {
    const runId = String(z.payload.runId ?? "");
    if (!UUID.test(runId)) throw new Error("import_shopify: brak poprawnego runId w payloadzie");
    await krokImportuShopify(z.tenant_id, runId);
  },
};
