import { NextResponse, type NextRequest } from "next/server";
import { przeczytajOgraniczone } from "../../../przeczytaj-ograniczone";
import { przyjmijWebhookSklepu } from "../../../../../usecases/sklep/przyjmij-webhook";

/**
 * Ingest webhooków WooCommerce (FR12, FR13). Logika fazy 1 jest wspólna dla platform portu
 * „Sklep” (`usecases/sklep/przyjmij-webhook.ts`); ta trasa tylko czyta ciało z limitem.
 * Adres zostaje bez zmian: pod niego wskazują webhooki zarejestrowane w sklepach klientów.
 */
// zamowienie Woo z dlugimi line_items miewa dziesiatki KB; 1 MB to sufit z zapasem,
// a bez sufitu endpoint bez uwierzytelnienia przyjmuje dowolnie duze cialo do pamieci
const MAKS_CIALO_WEBHOOKA_B = 1_048_576;

export async function POST(zadanie: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  // nieznany sklep (zly uuid) przed czytaniem ciala, jak dotad
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storeId)) {
    return new NextResponse("nieznany sklep", { status: 404 });
  }
  const cialo = await przeczytajOgraniczone(zadanie, MAKS_CIALO_WEBHOOKA_B);
  const w = await przyjmijWebhookSklepu("woocommerce", storeId, zadanie.headers, cialo);
  return new NextResponse(w.tresc, { status: w.status });
}
