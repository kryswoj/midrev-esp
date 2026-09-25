import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { przeczytajOgraniczone } from "../../../przeczytaj-ograniczone";
import { getPool } from "../../../../../adapters/db/pool";
import { odszyfruj } from "../../../../../adapters/crypto";
import { dodajZadanie } from "../../../../../jobs/kolejka";
import { bytTematu, kluczZdarzeniaWebhooka, tematObslugiwany } from "../../../../../adapters/store/webhooki";

const schematId = z.string().uuid();

/**
 * Ingest webhooków WooCommerce (FR12, FR13) w dwóch fazach (AD-4):
 * faza 1 (tutaj): weryfikacja podpisu HMAC, zapis surowego zdarzenia, odpowiedź 200
 * poniżej pół sekundy. Faza 2 (worker): przetworzenie do modelu domenowego.
 *
 * Klucz idempotencji opisuje BYT, nie kanał (AD-24): to samo zamówienie przysłane
 * webhookiem i zaciągnięte importem historycznym ma ten sam klucz i nie wejdzie dwa razy.
 * Kształt klucza MUSI być identyczny z tym w imporcie (`kluczZdarzeniaWebhooka`):
 * woocommerce:{tenant}:{byt}:{id}:{date_modified_gmt}. Byt pochodzi z TEMATU webhooka
 * (order.* / customer.*), nie jest zaszyty: klient nr 8 i zamówienie nr 8 z tą samą
 * datą miały wcześniej jeden klucz i drugie ginęło jako duplikat (audyt #4).
 */
// zamowienie Woo z dlugimi line_items miewa dziesiatki KB; 1 MB to sufit z zapasem,
// a bez sufitu endpoint bez uwierzytelnienia przyjmuje dowolnie duze cialo do pamieci
const MAKS_CIALO_WEBHOOKA_B = 1_048_576;

export async function POST(zadanie: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  // zly format uuid w zapytaniu pg konczy sie bledem skladni i piecsetka;
  // dla nadawcy to po prostu nieznany sklep
  if (!schematId.safeParse(storeId).success) {
    return new NextResponse("nieznany sklep", { status: 404 });
  }
  const cialo = await przeczytajOgraniczone(zadanie, MAKS_CIALO_WEBHOOKA_B);
  if (cialo === null) return new NextResponse("za duże ciało", { status: 413 });
  const pool = getPool();

  const { rows } = await pool.query(
    "select tenant_id, credentials_encrypted from stores where id = $1",
    [storeId],
  );
  const sklep = rows[0];
  if (!sklep) return new NextResponse("nieznany sklep", { status: 404 });

  // Woo podpisuje ciało HMAC-SHA256 sekretem webhooka; trzymamy go razem z kluczami REST.
  let sekret: string | undefined;
  try {
    const poswiadczenia = JSON.parse(odszyfruj(sklep.credentials_encrypted));
    sekret = poswiadczenia.webhookSecret ?? poswiadczenia.cs;
  } catch {
    sekret = undefined;
  }
  // sklep bez sekretu nie moze niczego zweryfikowac: odpowiedz jak przy zlym
  // podpisie, a nie 500 - wyjatek zdradzalby, ze cos jest nie tak z konfiguracja
  if (!sekret) return new NextResponse("zły podpis", { status: 401 });
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
  // temat jest OBOWIĄZKOWY: bez nagłówka nie wiadomo, czy payload to zamówienie, czy
  // klient, a zgadywanie "order" mapowało klienta jako zamówienie (audyt #4)
  const temat = zadanie.headers.get("x-wc-webhook-topic") ?? "";
  // temat spoza subskrypcji (np. order.deleted skonfigurowany recznie w sklepie): ACK 200
  // bez zapisu - zapisane zdarzenie nie mialoby czym sie przetworzyc i krazyloby
  // w kolejce (review #4). 4xx kazalby Woo ponawiac i po serii bledow wylaczyc webhooka.
  if (!tematObslugiwany(temat)) return new NextResponse("temat pominięty", { status: 200 });
  const byt = bytTematu(temat);
  if (!byt) return new NextResponse("nieobsługiwany temat", { status: 400 });
  const zewnetrzneId = String(dane.id ?? "");
  if (!zewnetrzneId) return new NextResponse("brak id", { status: 400 });
  // data ZE ZRODLA jest warunkiem zapisu (AD-10): payload bez niej nigdy nie da sie
  // zmapowac, a klucz z fallbacku na status zostawialby zatrute zdarzenie na zawsze
  if (typeof dane.date_created_gmt !== "string" || !dane.date_created_gmt) {
    return new NextResponse("brak date_created_gmt", { status: 400 });
  }

  const klucz = kluczZdarzeniaWebhooka(sklep.tenant_id, byt, { ...dane, id: zewnetrzneId });

  // Zapis zdarzenia i job w JEDNEJ transakcji: gdyby job powstawał osobno i padł,
  // retry nadawcy trafiłby w idempotencję zapisu (duplikat) i zdarzenie zostałoby
  // nieprzetworzone na zawsze (znalezisko review). Duplikat jeszcze NIEPRZETWORZONY
  // też dostaje job - drugi job jest nieszkodliwy, bo handler sprawdza processed_at.
  const klient = await pool.connect();
  let nowe = false;
  try {
    await klient.query("begin");
    const wynik = await klient.query<{ id: string }>(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
       values ($1, $2, 'woocommerce', $3, $4)
       on conflict (tenant_id, store_id, source, idempotency_key) do nothing
       returning id`,
      [sklep.tenant_id, storeId, klucz, cialo],
    );
    nowe = wynik.rowCount === 1;
    let rawEventId = wynik.rows[0]?.id;
    if (!rawEventId) {
      const zastane = await klient.query<{ id: string }>(
        `select id from raw_events
          where tenant_id = $1 and store_id = $2 and source = 'woocommerce'
            and idempotency_key = $3 and processed_at is null`,
        [sklep.tenant_id, storeId, klucz],
      );
      rawEventId = zastane.rows[0]?.id;
    }
    if (rawEventId) {
      await dodajZadanie(
        sklep.tenant_id,
        "przetworz_zdarzenie",
        { rawEventId, storeId, temat },
        { przez: klient },
      );
    }
    await klient.query("commit");
  } catch (blad) {
    await klient.query("rollback");
    throw blad;
  } finally {
    klient.release();
  }
  return new NextResponse(nowe ? "przyjęte" : "duplikat", { status: 200 });
}
