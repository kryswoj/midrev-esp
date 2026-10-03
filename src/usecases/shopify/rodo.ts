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

interface ZadanieRodo {
  temat: string;
  profileIds: string[];
  zamowienia: string[];
  klientId: string | null;
}

export async function obsluzZadanieRodo(tenantId: string, rawEventId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ store_id: string; payload: any; idempotency_key: string; processed_at: Date | null }>(
    `select store_id, payload, idempotency_key, processed_at from raw_events
      where tenant_id = $1 and id = $2 and source = 'shopify'`,
    [tenantId, rawEventId],
  );
  const r = rows[0];
  if (!r || r.processed_at) return;
  const webhookId = r.idempotency_key.split(":")[4] ?? rawEventId;
  const zadanie = await przygotujZadanie(tenantId, rawEventId, r.store_id, webhookId, r.payload);
  if (!zadanie) {
    // zaślepione bez wpisu żądania: nie ma już czego wykonać, tylko domknąć
    await pool.query("update raw_events set processed_at = now(), process_error = coalesce(process_error, 'anonimizowano') where tenant_id = $1 and id = $2", [tenantId, rawEventId]);
    return;
  }

  let status: "done" | "needs_operator" = "done";
  const wynik: Record<string, unknown> = { profile: zadanie.profileIds.length, profileIds: zadanie.profileIds, zamowienia: zadanie.zamowienia.length };
  let alert: string | null = null;
  if (zadanie.temat === "customers/data_request") {
    status = "needs_operator";
    alert = zadanie.profileIds.length
      ? `Shopify: żądanie dostępu do danych klienta (RODO art. 15) w sklepie ${r.store_id}. Wygeneruj eksport w karcie profilu (${zadanie.profileIds.join(", ")}) i przekaż sprzedawcy w ciągu 30 dni.`
      : `Shopify: żądanie dostępu do danych klienta w sklepie ${r.store_id}; nie mamy profilu tej osoby. Odpowiedz sprzedawcy, że nie przetwarzamy jej danych.`;
  } else if (zadanie.temat === "customers/redact") {
    let zanonimizowane = 0;
    for (const pid of zadanie.profileIds) {
      // null = profil już usunięty (ponowienie po awarii): idempotentnie
      if (await anonimizujProfil(tenantId, pid, { aktor: AKTOR, powod: "żądanie usunięcia danych przekazane przez Shopify" })) zanonimizowane++;
    }
    wynik.zanonimizowane = zanonimizowane;
    wynik.zaslepioneZamowienia = await zaslepZamowienia(tenantId, r.store_id, zadanie.klientId, zadanie.zamowienia);
  } else if (zadanie.temat === "shop/redact") {
    // lista PRZED zaślepieniem: koszyki sklepu zaraz znikną, a też wskazują osoby (review r2)
    const profile = await profileSklepu(tenantId, r.store_id);
    Object.assign(wynik, await zaslepSklep(tenantId, r.store_id));
    // Profile osób z tego sklepu to lista marketingowa klienta agencji (administratora), często
    // zasilana też z innych źródeł; automatycznie ich nie kasujemy. Żądanie zostaje OTWARTE
    // (needs_operator) z listą profili, dopóki człowiek nie zdecyduje z klientem (review r1).
    wynik.profileIds = profile.slice(0, 5000);
    wynik.profile = profile.length;
    status = "needs_operator";
    alert = `Shopify: shop/redact dla sklepu ${r.store_id}. Surowe dane sklepu zaślepione, token usunięty. ${profile.length} profili ma zamówienia albo koszyki z tego sklepu: zdecyduj z klientem, czy je zanonimizować (żądanie otwarte w shopify_gdpr_requests).`;
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
      [tenantId, rawEventId, zadanie.temat],
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

/**
 * Pierwsze przetworzenie: z payloadu (jedyne miejsce z adresem) liczymy profile osoby i zapisujemy
 * żądanie BEZ adresu (hasz, id profili, id zamówień). Przy customers/redact w tej samej transakcji
 * nagrobek (hasz adresu + id klienta Shopify) i usunięcie koszyków z adresem. Payload samego
 * żądania zostaje do końca, ale gdyby anonimizacja go zaślepiła i coś padło, ponowienie czyta
 * dane z wiersza żądania, nie z payloadu.
 */
async function przygotujZadanie(tenantId: string, rawEventId: string, storeId: string, webhookId: string, payload: any): Promise<ZadanieRodo | null> {
  const pool = getPool();
  const { rows: zastane } = await pool.query<{ topic: string; result: any; shopify_customer_id: string | null }>(
    "select topic, result, shopify_customer_id from shopify_gdpr_requests where tenant_id = $1 and store_id = $2 and webhook_id = $3",
    [tenantId, storeId, webhookId],
  );
  if (zastane[0]) {
    return {
      temat: zastane[0].topic,
      profileIds: Array.isArray(zastane[0].result?.profileIds) ? zastane[0].result.profileIds : [],
      zamowienia: Array.isArray(zastane[0].result?.zamowieniaIds) ? zastane[0].result.zamowieniaIds : [],
      klientId: zastane[0].shopify_customer_id,
    };
  }
  if (!payload || payload.anonimizowano) return null;
  const temat = String(payload._midrev?.temat ?? "");
  const klientId = idZGid(payload.customer?.id);
  const email = typeof payload.customer?.email === "string" && payload.customer.email.trim() ? payload.customer.email.trim().toLowerCase() : null;
  const zamowienia: string[] = (Array.isArray(payload.orders_to_redact) ? payload.orders_to_redact : Array.isArray(payload.orders_requested) ? payload.orders_requested : [])
    .map((x: unknown) => idZGid(x))
    .filter((x: string | null): x is string => Boolean(x))
    .slice(0, 5000);
  const profileIds = temat === "shop/redact" ? [] : await profileOsoby(tenantId, storeId, email, zamowienia);

  const klient = await pool.connect();
  try {
    await klient.query("begin");
    await klient.query(
      `insert into shopify_gdpr_requests (tenant_id, store_id, topic, webhook_id, shopify_customer_id, email_hash, orders_count, result)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       on conflict (tenant_id, store_id, webhook_id) do nothing`,
      [tenantId, storeId, temat, webhookId, klientId, email ? hashAdresu(email) : null, zamowienia.length, JSON.stringify({ profileIds, zamowieniaIds: zamowienia })],
    );
    if (temat === "customers/redact" && email) {
      await klient.query(
        `insert into rodo_nagrobki (tenant_id, email_hash, store_id, external_customer_ids)
         values ($1, $2, $3, $4)
         on conflict (tenant_id, email_hash) do update set
           external_customer_ids = (select array_agg(distinct x) from unnest(rodo_nagrobki.external_customer_ids || excluded.external_customer_ids) x),
           store_id = coalesce(rodo_nagrobki.store_id, excluded.store_id)`,
        [tenantId, hashAdresu(email), storeId, klientId ? [klientId] : []],
      );
      await klient.query("delete from carts where tenant_id = $1 and store_id = $2 and lower(btrim(email)) = $3", [tenantId, storeId, email]);
      // surowe zdarzenia Shopify z tym adresem gdziekolwiek w treści (poza samym żądaniem, które
      // zaślepiamy na końcu): webhook innego tematu nie może przeżyć żądania usunięcia
      await klient.query(
        `update raw_events set payload = jsonb_build_object('anonimizowano', true), processed_at = coalesce(processed_at, now()),
                process_error = coalesce(process_error, 'anonimizowano')
          where tenant_id = $1 and store_id = $2 and source = 'shopify' and id <> $4 and not (payload ? 'anonimizowano')
            and payload::text ilike '%' || $3 || '%'`,
        [tenantId, storeId, email, rawEventId],
      );
    }
    await klient.query("commit");
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
  return { temat, profileIds, zamowienia, klientId };
}

/** Profile z zamówieniami albo koszykami tego sklepu (do decyzji operatora po shop/redact). */
async function profileSklepu(tenantId: string, storeId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `select profile_id as id from orders where tenant_id = $1 and store_id = $2 and profile_id is not null
     union
     select profile_id from carts where tenant_id = $1 and store_id = $2 and profile_id is not null`,
    [tenantId, storeId],
  );
  return rows.map((x) => x.id);
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
 * Zamówienia z żądania (także gościa bez profilu): zaślepka `orders.raw` i surowych zdarzeń tych
 * zamówień i konta klienta Shopify. Po identyfikatorach, bez adresu (ponowienie go nie ma).
 */
async function zaslepZamowienia(tenantId: string, storeId: string, klientId: string | null, zamowienia: string[]): Promise<number> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rowCount } = await klient.query(
      `update orders set raw = '{"zanonimizowane": true}'::jsonb
        where tenant_id = $1 and store_id = $2 and external_id = any($3::text[]) and not (raw ? 'zanonimizowane')`,
      [tenantId, storeId, zamowienia],
    );
    await klient.query(
      `update raw_events set payload = jsonb_build_object('anonimizowano', true), processed_at = coalesce(processed_at, now()),
              process_error = coalesce(process_error, 'anonimizowano')
        where tenant_id = $1 and store_id = $2 and source = 'shopify' and not (payload ? 'anonimizowano')
          and ((split_part(idempotency_key, ':', 3) in ('order', 'refund') and split_part(idempotency_key, ':', 4) = any($3::text[]))
            or ($4::text is not null and split_part(idempotency_key, ':', 3) in ('customer', 'consent') and split_part(idempotency_key, ':', 4) = $4))`,
      [tenantId, storeId, zamowienia, klientId],
    );
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
