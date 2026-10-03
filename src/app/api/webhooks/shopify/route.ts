import { NextResponse, type NextRequest } from "next/server";
import { przeczytajOgraniczone } from "../../przeczytaj-ograniczone";
import { przyjmijWebhookShopify } from "../../../../usecases/shopify/przyjecie";

/**
 * Webhooki Shopify (wszystkie tematy + obowiązkowe RODO z `shopify.app.toml`). Sklep po
 * `X-Shopify-Shop-Domain`, podpis `X-Shopify-Hmac-Sha256` z SUROWEGO ciała, idempotencja po
 * `X-Shopify-Webhook-Id`. Logika w `usecases/shopify/przyjecie.ts`.
 */
export const dynamic = "force-dynamic";

// zamówienie z setkami pozycji to kilkaset KB; 2 MB z zapasem, bez sufitu endpoint bez
// uwierzytelnienia przyjmowałby dowolnie duże ciało do pamięci
const MAKS_CIALO_B = 2 * 1_048_576;

export async function POST(zadanie: NextRequest) {
  const cialo = await przeczytajOgraniczone(zadanie, MAKS_CIALO_B);
  if (cialo === null) return new NextResponse("za duże ciało", { status: 413 });
  const h = zadanie.headers;
  const w = await przyjmijWebhookShopify(cialo, {
    temat: h.get("x-shopify-topic"),
    domena: h.get("x-shopify-shop-domain"),
    hmac: h.get("x-shopify-hmac-sha256"),
    webhookId: h.get("x-shopify-webhook-id"),
    wyzwolonoAt: h.get("x-shopify-triggered-at"),
  });
  return new NextResponse(w.tresc, { status: w.status });
}
