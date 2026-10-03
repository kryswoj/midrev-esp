import { getPool } from "../../adapters/db/pool";
import { hashAdresu } from "../../adapters/hash-adresu";
import { idZGid } from "../../adapters/store/shopify/mapowanie";
import { wyslijAlert } from "../../jobs/alerty";
import { anonimizujProfil } from "../profil-rodo";
import { sklepShopify, zaszyfrujPoswiadczenia } from "./sklep";

/**
 * Obowiązkowe webhooki RODO Shopify (compliance topics) podpięte pod nasze RODO:
 *
 *   customers/data_request → wpis `shopify_gdpr_requests` (needs_operator) + alert: eksport
 *     robi operator w karcie profilu (`eksportujProfil`) i przekazuje sprzedawcy; Shopify nie
 *     przyjmuje danych od aplikacji, a automatyczna wysyłka eksportu e-mailem byłaby wyciekiem
 *     przy pomyłce adresu,
 *   customers/redact → `anonimizujProfil` dla profilu osoby (adres z payloadu ALBO jej
 *     zamówienia z `orders_to_redact`); bez profilu: nagrobek (hasz adresu + id klienta
 *     Shopify), żeby kolejny webhook nie odtworzył osoby, i zaślepienie jej zamówień,
 *   shop/redact (48 h po odinstalowaniu) → zaślepienie surowych dokumentów i `orders.raw`
 *     tego sklepu, usunięcie koszyków sklepu i tokenu; profile (lista marketingowa
 *     sprzedawcy, często z innych źródeł) zostają, decyzja operatora po alercie.
 *
 * Idempotencja: wpis żądania unikalny po `X-Shopify-Webhook-Id`. Surowy payload (ma e-mail)
 * jest zaślepiany dopiero PO wykonaniu operacji, w tej samej transakcji co `processed_at`:
 * błąd w środku = ponowienie joba z kompletnym payloadem. Dowód obsłużenia nie zawiera adresu.
 */

const AKTOR = "shopify:compliance-webhook";

export async function obsluzZadanieRodo(tenantId: string, rawEventId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ store_id: string; payload: any; idempotency_key: string; processed_at: Date | null }>(
    `select store_id, payload, idempotency_key, processed_at from raw_events
      where tenant_id = $1 and id = $2 and source = 'shopify'`,
    [tenantId, rawEventId],
  );
  const r = rows[0];
  if (!r || r.processed_at || r.payload?.anonimizowano) return;
  const temat = String(r.payload?._midrev?.temat ?? "");
  const webhookId = r.idempotency_key.split(":")[4] ?? rawEventId;
  const klientId = idZGid(r.payload?.customer?.id);
  const email = typeof r.payload?.customer?.email === "string" && r.payload.customer.email.trim() ? r.payload.customer.email.trim().toLowerCase() : null;
  const zamowienia: string[] = (Array.isArray(r.payload?.orders_to_redact) ? r.payload.orders_to_redact : Array.isArray(r.payload?.orders_requested) ? r.payload.orders_requested : [])
    .map((x: unknown) => idZGid(x))
    .filter((x: string | null): x is string => Boolean(x))
    .slice(0, 5000);

  await pool.query(
    `insert into shopify_gdpr_requests (tenant_id, store_id, topic, webhook_id, shopify_customer_id, email_hash, orders_count)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tenant_id, store_id, webhook_id) do nothing`,
    [tenantId, r.store_id, temat, webhookId, klientId, email ? hashAdresu(email) : null, zamowienia.length],
  );

  const profile = await profileOsoby(tenantId, r.store_id, email, zamowienia);
  let status: "done" | "needs_operator" = "done";
  const wynik: Record<string, unknown> = { profile: profile.length };
  let alert: string | null = null;

  if (temat === "customers/data_request") {
    status = "needs_operator";
    wynik.profileIds = profile;
    alert = profile.length
      ? `Shopify: żądanie dostępu do danych klienta (RODO art. 15) w sklepie ${r.store_id}. Wygeneruj eksport w karcie profilu (${profile.join(", ")}) i przekaż sprzedawcy w ciągu 30 dni.`
      : `Shopify: żądanie dostępu do danych klienta w sklepie ${r.store_id}; nie mamy profilu tej osoby. Odpowiedz sprzedawcy, że nie przetwarzamy jej danych.`;
  } else if (temat === "customers/redact") {
    let zanonimizowane = 0;
    for (const pid of profile) {
      const w = await anonimizujProfil(tenantId, pid, { aktor: AKTOR, powod: "żądanie usunięcia danych przekazane przez Shopify" });
      if (w) zanonimizowane++;
    }
    wynik.zanonimizowane = zanonimizowane;
    wynik.zaslepioneZamowienia = await zaslepZamowieniaBezProfilu(tenantId, r.store_id, email, klientId, zamowienia);
  } else if (temat === "shop/redact") {
    Object.assign(wynik, await zaslepSklep(tenantId, r.store_id));
    alert = `Shopify: shop/redact dla sklepu ${r.store_id}. Surowe dane sklepu zaślepione, token usunięty. Profile zostały (lista marketingowa klienta) - zdecyduj z klientem, czy je usunąć.`;
  }

  const klient = await pool.connect();
  try {
    await klient.query("begin");
    await klient.query(
      `update shopify_gdpr_requests set status = $4, result = $5::jsonb, processed_at = now()
        where tenant_id = $1 and store_id = $2 and webhook_id = $3`,
      [tenantId, r.store_id, webhookId, status, JSON.stringify(wynik)],
    );
    await klient.query(
      `update raw_events set payload = jsonb_build_object('anonimizowano', true, 'temat', $3::text),
              processed_at = now(), process_error = 'rodo:shopify'
        where tenant_id = $1 and id = $2`,
      [tenantId, rawEventId, temat],
    );
    await klient.query("commit");
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
  if (alert) await wyslijAlert(alert, { poziom: "uwaga", tenantId });
}

/** Profile osoby: po adresie (tylko ten tenant) i po zamówieniach TEGO sklepu z żądania. */
async function profileOsoby(tenantId: string, storeId: string, email: string | null, zamowienia: string[]): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `select id from profiles where tenant_id = $1 and $2::text is not null and lower(btrim(email)) = $2
     union
     select o.profile_id from orders o
      where o.tenant_id = $1 and o.store_id = $3 and o.external_id = any($4::text[]) and o.profile_id is not null`,
    [tenantId, email, storeId, zamowienia],
  );
  return rows.map((x) => x.id);
}

/**
 * Zamówienia z żądania bez profilu (gość albo profil już usunięty): zaślepka `orders.raw` i
 * surowych zdarzeń tych zamówień; nagrobek po haszu adresu i id klienta Shopify.
 */
async function zaslepZamowieniaBezProfilu(tenantId: string, storeId: string, email: string | null, klientId: string | null, zamowienia: string[]): Promise<number> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    if (email) {
      await klient.query(
        `insert into rodo_nagrobki (tenant_id, email_hash, store_id, external_customer_ids)
         values ($1, $2, $3, $4)
         on conflict (tenant_id, email_hash) do update set
           external_customer_ids = (select array_agg(distinct x) from unnest(rodo_nagrobki.external_customer_ids || excluded.external_customer_ids) x),
           store_id = coalesce(rodo_nagrobki.store_id, excluded.store_id)`,
        [tenantId, hashAdresu(email), storeId, klientId ? [klientId] : []],
      );
    }
    const { rowCount } = await klient.query(
      `update orders set raw = '{"zanonimizowane": true}'::jsonb
        where tenant_id = $1 and store_id = $2 and external_id = any($3::text[]) and not (raw ? 'zanonimizowane')`,
      [tenantId, storeId, zamowienia],
    );
    await klient.query(
      `update raw_events set payload = jsonb_build_object('anonimizowano', true), processed_at = coalesce(processed_at, now()),
              process_error = coalesce(process_error, 'anonimizowano')
        where tenant_id = $1 and store_id = $2 and source = 'shopify' and not (payload ? 'anonimizowano')
          and split_part(idempotency_key, ':', 3) in ('order', 'refund') and split_part(idempotency_key, ':', 4) = any($3::text[])`,
      [tenantId, storeId, zamowienia],
    );
    await klient.query(
      `update raw_events set payload = jsonb_build_object('anonimizowano', true), processed_at = coalesce(processed_at, now()),
              process_error = coalesce(process_error, 'anonimizowano')
        where tenant_id = $1 and store_id = $2 and source = 'shopify' and not (payload ? 'anonimizowano')
          and $4::text is not null and split_part(idempotency_key, ':', 3) in ('customer', 'consent') and split_part(idempotency_key, ':', 4) = $4`,
      [tenantId, storeId, zamowienia, klientId],
    );
    if (email) {
      await klient.query(
        "delete from carts where tenant_id = $1 and store_id = $2 and lower(btrim(email)) = $3",
        [tenantId, storeId, email],
      );
    }
    await klient.query("commit");
    return rowCount ?? 0;
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}

async function zaslepSklep(tenantId: string, storeId: string): Promise<Record<string, number>> {
  const sklep = await sklepShopify(tenantId, storeId);
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const surowe = await klient.query(
      `update raw_events set payload = jsonb_build_object('anonimizowano', true), processed_at = coalesce(processed_at, now()),
              process_error = coalesce(process_error, 'anonimizowano')
        where tenant_id = $1 and store_id = $2 and source = 'shopify' and not (payload ? 'anonimizowano')
          and coalesce(payload -> '_midrev' ->> 'temat', '') <> 'shop/redact'`,
      [tenantId, storeId],
    );
    const zamowienia = await klient.query(
      `update orders set raw = '{"zanonimizowane": true}'::jsonb where tenant_id = $1 and store_id = $2 and not (raw ? 'zanonimizowane')`,
      [tenantId, storeId],
    );
    const koszyki = await klient.query("delete from carts where tenant_id = $1 and store_id = $2", [tenantId, storeId]);
    if (sklep) {
      await klient.query(
        `update stores set credentials_encrypted = $3, status = 'error',
                last_error = 'Sklep usunięty po stronie Shopify (shop/redact). Dane surowe zaślepione.'
          where tenant_id = $1 and id = $2`,
        [tenantId, storeId, zaszyfrujPoswiadczenia({ ...sklep.poswiadczenia, accessToken: null, refreshToken: null, wygasaAt: null })],
      );
    }
    await klient.query("commit");
    return { surowe: surowe.rowCount ?? 0, zamowienia: zamowienia.rowCount ?? 0, koszyki: koszyki.rowCount ?? 0 };
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}
