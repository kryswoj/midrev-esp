import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "../../../../../adapters/db/pool";
import { odszyfruj } from "../../../../../adapters/crypto";
import { dodajZadanie } from "../../../../../jobs/kolejka";

/**
 * Ingest webhooków WooCommerce (FR12, FR13) w dwóch fazach (AD-4):
 * faza 1 (tutaj): weryfikacja podpisu HMAC, zapis surowego zdarzenia, odpowiedź 200
 * poniżej pół sekundy. Faza 2 (worker): przetworzenie do modelu domenowego.
 *
 * Klucz idempotencji opisuje BYT, nie kanał (AD-24): to samo zamówienie przysłane
 * webhookiem i zaciągnięte importem historycznym ma ten sam klucz i nie wejdzie dwa razy.
 * Kształt klucza MUSI być identyczny z tym w imporcie: woocommerce:{tenant}:order:{id}:{status}.
 */
export async function POST(zadanie: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const cialo = await zadanie.text();
  const pool = getPool();

  const { rows } = await pool.query(
    "select tenant_id, credentials_encrypted from stores where id = $1",
    [storeId],
  );
  const sklep = rows[0];
  if (!sklep) return new NextResponse("nieznany sklep", { status: 404 });

  // Woo podpisuje ciało HMAC-SHA256 sekretem webhooka; trzymamy go razem z kluczami REST.
  const poswiadczenia = JSON.parse(odszyfruj(sklep.credentials_encrypted));
  const sekret: string = poswiadczenia.webhookSecret ?? poswiadczenia.cs;
  const podpis = zadanie.headers.get("x-wc-webhook-signature") ?? "";
  const oczekiwany = createHmac("sha256", sekret).update(cialo, "utf8").digest("base64");
  const a = Buffer.from(podpis);
  const b = Buffer.from(oczekiwany);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    // Woo wysyła na starcie ping bez podpisu ("webhook_id=..."): odpowiadamy 200,
    // żeby webhook dał się aktywować, ale niczego nie zapisujemy.
    if (cialo.startsWith("webhook_id=")) return new NextResponse("ping", { status: 200 });
    return new NextResponse("zły podpis", { status: 401 });
  }

  let dane: any;
  try {
    dane = JSON.parse(cialo);
  } catch {
    return new NextResponse("nieczytelne ciało", { status: 400 });
  }
  const temat = zadanie.headers.get("x-wc-webhook-topic") ?? "order.updated";
  const zewnetrzneId = String(dane.id ?? "");
  if (!zewnetrzneId) return new NextResponse("brak id", { status: 400 });

  const klucz = `woocommerce:${sklep.tenant_id}:order:${zewnetrzneId}:${dane.status ?? "?"}`;
  const wynik = await pool.query(
    `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
     values ($1, $2, 'woocommerce', $3, $4)
     on conflict (tenant_id, store_id, source, idempotency_key) do nothing
     returning id`,
    [sklep.tenant_id, storeId, klucz, cialo],
  );

  // przetworzenie w tle; duplikat (rowCount 0) nie tworzy drugiego zadania
  if (wynik.rowCount) {
    await dodajZadanie(sklep.tenant_id, "przetworz_zdarzenie", {
      rawEventId: wynik.rows[0].id,
      storeId,
      temat,
    });
  }
  return new NextResponse(wynik.rowCount ? "przyjęte" : "duplikat", { status: 200 });
}
