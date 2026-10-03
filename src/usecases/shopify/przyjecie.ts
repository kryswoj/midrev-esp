import { getPool } from "../../adapters/db/pool";
import { parsujJsonShopify } from "../../adapters/store/shopify/json";
import { zweryfikujHmacWebhooka } from "../../adapters/store/shopify/oauth";
import { bytWebhooka, tematShopify } from "../../adapters/store/shopify/webhooki";
import { dodajZadanie } from "../../jobs/kolejka";
import { sklepPoDomenie } from "./sklep";

/**
 * Faza 1 webhooka Shopify (AD-4): podpis → zapis surowego zdarzenia + job w JEDNEJ transakcji
 * → 200. Przetwarzanie w workerze (faza 2, `przetworzZdarzenieShopify`), żeby odpowiedzieć
 * Shopify szybko (limit 5 s, potem ponowienia przez 48 h).
 *
 * Bramki po kolei, zanim cokolwiek trafi do bazy:
 *   1. temat z listy (inny: 200 bez zapisu, żeby Shopify nie ponawiał i nie wyłączył subskrypcji),
 *   2. sklep po `X-Shopify-Shop-Domain` (tylko wskazówka, czym sprawdzić podpis),
 *   3. `X-Shopify-Hmac-Sha256` z SUROWEGO ciała sekretem aplikacji TEGO sklepu (stały czas),
 *   4. `X-Shopify-Webhook-Id` obowiązkowy: ponowienie tej samej dostawy ma ten sam id, więc
 *      klucz `shopify:{tenant}:{byt}:{id}:{webhookId}` daje idempotencję. 3. i 4. człon jak
 *      w Woo (byt, id zamówienia/klienta), żeby predykat RODO i nagrobki działały bez zmian.
 *
 * Tenant pochodzi WYŁĄCZNIE z wiersza sklepu, którego sekret zweryfikował podpis (AD-40).
 */

export type WynikPrzyjecia = { status: number; tresc: string };

const WZOR_WEBHOOK_ID = /^[A-Za-z0-9-]{8,100}$/;

export async function przyjmijWebhookShopify(
  cialo: string,
  naglowki: { temat: string | null; domena: string | null; hmac: string | null; webhookId: string | null; wyzwolonoAt: string | null },
): Promise<WynikPrzyjecia> {
  const temat = tematShopify(naglowki.temat);
  if (!temat) return { status: 200, tresc: "temat pominięty" };
  const sklep = naglowki.domena ? await sklepPoDomenie(naglowki.domena) : null;
  if (!sklep || !zweryfikujHmacWebhooka(cialo, naglowki.hmac, sklep.poswiadczenia.clientSecret.ujawnij())) {
    return { status: 401, tresc: "zły podpis" };
  }
  if (!naglowki.webhookId || !WZOR_WEBHOOK_ID.test(naglowki.webhookId)) return { status: 400, tresc: "brak X-Shopify-Webhook-Id" };
  let dane: unknown;
  try {
    dane = parsujJsonShopify(cialo);
  } catch {
    return { status: 400, tresc: "nieczytelne ciało" };
  }
  if (!dane || typeof dane !== "object" || Array.isArray(dane)) return { status: 400, tresc: "ciało nie jest obiektem" };
  const byt = bytWebhooka(temat, dane);
  if (!byt) return { status: 400, tresc: "brak identyfikatora bytu" };

  const klucz = `shopify:${sklep.tenantId}:${byt.byt}:${byt.id}:${naglowki.webhookId}`;
  const wyzwolono = naglowki.wyzwolonoAt && !Number.isNaN(new Date(naglowki.wyzwolonoAt).getTime()) ? naglowki.wyzwolonoAt : null;
  // temat i czas wyzwolenia razem z ciałem: job ponowiony przez `ponowZalegleSurowe` nie ma
  // tematu w swoim payloadzie, a faza 2 musi wiedzieć, czy to orders/create, czy orders/cancelled
  const payload = { ...(dane as Record<string, unknown>), _midrev: { temat, wyzwolono } };

  const klient = await getPool().connect();
  let nowe = false;
  try {
    await klient.query("begin");
    const w = await klient.query<{ id: string }>(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload, channel)
       values ($1, $2, 'shopify', $3, $4, 'webhook')
       on conflict (tenant_id, store_id, source, idempotency_key) do nothing
       returning id`,
      [sklep.tenantId, sklep.id, klucz, JSON.stringify(payload)],
    );
    nowe = w.rowCount === 1;
    let id = w.rows[0]?.id;
    if (!id) {
      // duplikat jeszcze nieprzetworzony dostaje job (jak w Woo: drugi job jest nieszkodliwy)
      const z = await klient.query<{ id: string }>(
        `select id from raw_events where tenant_id = $1 and store_id = $2 and source = 'shopify'
            and idempotency_key = $3 and processed_at is null`,
        [sklep.tenantId, sklep.id, klucz],
      );
      id = z.rows[0]?.id;
    }
    if (id) await dodajZadanie(sklep.tenantId, "przetworz_zdarzenie", { rawEventId: id, storeId: sklep.id, temat }, { przez: klient });
    await klient.query("commit");
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
  return { status: 200, tresc: nowe ? "przyjęte" : "duplikat" };
}
