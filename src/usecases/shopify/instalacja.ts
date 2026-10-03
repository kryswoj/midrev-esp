import { getPool } from "../../adapters/db/pool";
import { Sekret } from "../../adapters/crypto";
import {
  adresAutoryzacji,
  BladOAuthShopify,
  brakujaceZakresy,
  domenaSklepu,
  haszStanu,
  nowyStan,
  swiezyZnacznik,
  wymienKodNaToken,
  zweryfikujHmacZapytania,
} from "../../adapters/store/shopify/oauth";
import { adresDostawyShopify, ustawMetapolaInstalacji, wlaczPiksel, zarejestrujWebhookiShopify, type WynikRejestracji } from "../../adapters/store/shopify/webhooki";
import { adresSledzenia, config } from "../../config";
import { wyslijAlert } from "../../jobs/alerty";
import { zapewnijKluczStrony, wyczyscPamiecKluczy } from "../integracja/klucz-strony";
import { ustawRoleMetrykStrony } from "../integracja/role-metryk";
import { metrykaPoKluczu } from "../zdarzenia/metryki";
import { METRYKI_SHOPIFY } from "./metryki";
import { fetchShopify, klientDla, sklepPoDomenie, sklepShopify, zaszyfrujPoswiadczenia, type SklepShopify } from "./sklep";

/**
 * Instalacja aplikacji Shopify (plan A.2) w modelu „custom distribution”:
 *
 *   1. operator zapisuje w kreatorze domenę sklepu + client_id/secret aplikacji (pending),
 *   2. klient klika link instalacyjny z Dev Dashboard; Shopify instaluje aplikację i otwiera
 *      `application_url` = GET /api/shopify/auth?shop&hmac&timestamp (podpisane sekretem
 *      TEJ aplikacji) → `rozpocznijInstalacje`: HMAC, świeżość, nowy state → przekierowanie na
 *      /admin/oauth/authorize (Shopify od razu wraca, bo zakresy są już zatwierdzone),
 *   3. GET /api/shopify/callback?code&hmac&shop&state&timestamp → `dokonczInstalacje`:
 *      HMAC, state (baza: hasz, jednorazowy, 10 min, ten sam sklep; ciasteczko: ta sama
 *      przeglądarka), wymiana code → token offline, szyfrogram, potem `poInstalacji`.
 *
 * Kolejność bramek jest celowa: nic nie dotyka bazy ani Shopify przed weryfikacją podpisu,
 * a stan jest zużywany atomowo (`update ... where used_at is null returning`).
 */

export const WAZNOSC_STANU_MS = 10 * 60_000;
export const CIASTECZKO_STANU = "mrv_shopify_state";

export type WynikStartu = { ok: true; przekierowanie: string; stan: string } | { ok: false; status: number; powod: string };

export function adresCallbacku(): string {
  return `${config().APP_URL}/api/shopify/callback`;
}

export async function rozpocznijInstalacje(parametry: URLSearchParams, teraz = Date.now()): Promise<WynikStartu> {
  const domena = domenaSklepu(parametry.get("shop"));
  if (!domena) return { ok: false, status: 400, powod: "niepoprawny sklep" };
  const sklep = await sklepPoDomenie(domena);
  // nieznany sklep i zły podpis: ta sama odpowiedź (nie zdradzamy, które sklepy znamy)
  if (!sklep || !zweryfikujHmacZapytania(parametry, sklep.poswiadczenia.clientSecret.ujawnij())) {
    return { ok: false, status: 401, powod: "zły podpis" };
  }
  if (!swiezyZnacznik(parametry.get("timestamp"), teraz)) return { ok: false, status: 401, powod: "przeterminowane żądanie" };

  const { stan, hasz } = nowyStan();
  await getPool().query(
    `insert into shopify_oauth_states (state_hash, tenant_id, store_id, shop_domain, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [hasz, sklep.tenantId, sklep.id, domena, new Date(teraz + WAZNOSC_STANU_MS)],
  );
  // sprzątanie starych stanów przy okazji (tanie, indeks po expires_at)
  await getPool().query("delete from shopify_oauth_states where expires_at < now() - interval '1 day'");
  return {
    ok: true,
    stan,
    przekierowanie: adresAutoryzacji({ domena, clientId: sklep.poswiadczenia.clientId, redirectUri: adresCallbacku(), stan }),
  };
}

export type WynikCallbacku =
  | { ok: true; tenantId: string; storeId: string; ostrzezenia: string[] }
  | { ok: false; status: number; powod: string };

export async function dokonczInstalacje(parametry: URLSearchParams, stanZCiastka: string | null, teraz = Date.now()): Promise<WynikCallbacku> {
  const domena = domenaSklepu(parametry.get("shop"));
  if (!domena) return { ok: false, status: 400, powod: "niepoprawny sklep" };
  const sklep = await sklepPoDomenie(domena);
  if (!sklep || !zweryfikujHmacZapytania(parametry, sklep.poswiadczenia.clientSecret.ujawnij())) {
    return { ok: false, status: 401, powod: "zły podpis" };
  }
  if (!swiezyZnacznik(parametry.get("timestamp"), teraz)) return { ok: false, status: 401, powod: "przeterminowane żądanie" };
  const stan = parametry.get("state") ?? "";
  // ciasteczko = ta sama przeglądarka, która zaczęła instalację (ochrona przed podrzuceniem
  // cudzego kodu autoryzacji, login CSRF); porównanie haszy = stały czas
  if (!stan || !stanZCiastka || haszStanu(stan) !== haszStanu(stanZCiastka)) {
    return { ok: false, status: 403, powod: "stan instalacji nie pasuje do tej przeglądarki" };
  }
  const { rows } = await getPool().query<{ store_id: string }>(
    `update shopify_oauth_states set used_at = now()
      where state_hash = $1 and used_at is null and expires_at > $2
        and shop_domain = $3 and store_id = $4 and tenant_id = $5
      returning store_id`,
    [haszStanu(stan), new Date(teraz), domena, sklep.id, sklep.tenantId],
  );
  if (!rows[0]) return { ok: false, status: 403, powod: "stan instalacji nieważny, zużyty albo z innego sklepu" };

  const kod = parametry.get("code") ?? "";
  let token;
  try {
    token = await wymienKodNaToken(
      { domena, clientId: sklep.poswiadczenia.clientId, clientSecret: sklep.poswiadczenia.clientSecret.ujawnij(), kod },
      fetchShopify(),
      teraz,
    );
  } catch (b) {
    const opis = b instanceof BladOAuthShopify ? b.message : "błąd wymiany kodu";
    await zapiszBlad(sklep, `Instalacja nie powiodła się: ${opis}`);
    return { ok: false, status: 502, powod: opis };
  }
  const braki = brakujaceZakresy(token.zakresy);
  const posw = {
    ...sklep.poswiadczenia,
    accessToken: new Sekret(token.accessToken),
    zakresy: token.zakresy,
    wygasaAt: token.wygasaAt?.toISOString() ?? null,
    refreshToken: token.refreshToken ? new Sekret(token.refreshToken) : null,
  };
  await getPool().query(
    `update stores set credentials_encrypted = $3, status = $4, last_error = $5, installed_at = now(), uninstalled_at = null
      where tenant_id = $1 and id = $2`,
    [
      sklep.tenantId,
      sklep.id,
      zaszyfrujPoswiadczenia(posw),
      braki.length ? "error" : "connected",
      braki.length ? `Aplikacja nie dostała zakresów: ${braki.join(", ")}. Dodaj je w Dev Dashboard i zainstaluj ponownie.` : null,
    ],
  );
  const ostrzezenia: string[] = [];
  if (braki.length) ostrzezenia.push(`Brak zakresów: ${braki.join(", ")}`);
  if (!token.zakresy.includes("read_all_orders")) {
    ostrzezenia.push("Bez zakresu read_all_orders import obejmie tylko zamówienia z ostatnich 60 dni (Shopify wymaga zgody na ten zakres).");
  }
  if (!braki.length) {
    const po = await poInstalacji(sklep.tenantId, sklep.id);
    ostrzezenia.push(...po.ostrzezenia);
  }
  return { ok: true, tenantId: sklep.tenantId, storeId: sklep.id, ostrzezenia };
}

async function zapiszBlad(sklep: SklepShopify, opis: string) {
  await getPool().query("update stores set last_error = $3 where tenant_id = $1 and id = $2", [sklep.tenantId, sklep.id, opis.slice(0, 500)]);
}

export interface StanInstalacji {
  webhooki: WynikRejestracji[];
  piksel: { id: string | null; blad: string | null };
  metapola: string | null;
  domenaPubliczna: string | null;
  waluta: string | null;
  nazwa: string | null;
  sprawdzonoAt: string;
}

const SKLEP = `query { shop { name currencyCode primaryDomain { url } } }`;

/**
 * Kroki po instalacji (idempotentne, przycisk „Sprawdź połączenie” woła je ponownie):
 * dane sklepu, webhooki (odczyt zwrotny), piksel, metapola dla app embed, klucz strony,
 * role metryk. Błąd jednego kroku nie cofa instalacji: trafia do stanu i na ekran.
 */
export async function poInstalacji(tenantId: string, storeId: string): Promise<{ stan: StanInstalacji; ostrzezenia: string[] }> {
  const sklep = await sklepShopify(tenantId, storeId);
  if (!sklep) throw new Error("sklep Shopify nie istnieje w tym tenancie");
  const klient = klientDla(sklep);
  const ostrzezenia: string[] = [];

  let domenaPubliczna: string | null = null;
  let waluta: string | null = null;
  let nazwa: string | null = null;
  try {
    const d = await klient.zapytanie<{ shop: { name: string; currencyCode: string; primaryDomain: { url: string } | null } }>(SKLEP, {}, 2);
    nazwa = d.shop.name?.slice(0, 200) ?? null;
    waluta = /^[A-Z]{3}$/.test(d.shop.currencyCode ?? "") ? d.shop.currencyCode : null;
    const u = d.shop.primaryDomain?.url ? new URL(d.shop.primaryDomain.url) : null;
    domenaPubliczna = u && u.protocol === "https:" ? u.origin : null;
  } catch (b) {
    ostrzezenia.push(`Nie udało się odczytać danych sklepu: ${b instanceof Error ? b.message : "błąd"}`);
  }

  const webhooki = await zarejestrujWebhookiShopify(klient, adresDostawyShopify(config().APP_URL)).catch((b) => {
    ostrzezenia.push(`Rejestracja powiadomień nie powiodła się: ${b instanceof Error ? b.message : "błąd"}`);
    return [] as WynikRejestracji[];
  });
  const nieaktywne = webhooki.filter((w) => w.stan !== "aktywny");
  if (nieaktywne.length) ostrzezenia.push(`Nie działają powiadomienia: ${nieaktywne.map((w) => w.temat).join(", ")}`);

  const klucz = await zapewnijKluczStrony(tenantId);
  // domeny sklepu na liście domen strony: CORS przy `restrict_origins` i doklejanie `_mx`.
  // Przy pełnej liście (20) domen nie dopisujemy, ale zgodę i platformę ustawiamy zawsze.
  const domeny = [sklep.domena, domenaPubliczna ? new URL(domenaPubliczna).hostname : null].filter((x): x is string => Boolean(x));
  await getPool().query(
    // require_cookie_consent: na Shopify zgodę daje baner sklepu (Customer Privacy API) przez
    // most w app embed; midrev.js nie może śledzić, zanim ten most powie „tak”
    `update site_keys set platform = 'shopify', require_cookie_consent = true,
            link_domains = case when cardinality(link_domains) + cardinality($3::text[]) <= 20
              then (select coalesce(array_agg(distinct d), '{}') from (select unnest(link_domains) as d union select unnest($3::text[])) x)
              else link_domains end,
            updated_at = now()
      where tenant_id = $1 and id = $2`,
    [tenantId, klucz.id, domeny],
  );
  wyczyscPamiecKluczy();

  const api = adresSledzenia();
  const piksel = await wlaczPiksel(klient, { siteKey: klucz.id, apiUrl: api });
  if (piksel.blad) ostrzezenia.push(`Piksel nie został włączony: ${piksel.blad}`);
  const metapola = await ustawMetapolaInstalacji(klient, { siteKey: klucz.id, scriptUrl: `${api}/js/v1/${klucz.id}.js` });
  if (metapola) ostrzezenia.push(`Nie udało się zapisać ustawień dla motywu: ${metapola}`);

  await ustawRoleShopify(tenantId);

  const stan: StanInstalacji = { webhooki, piksel, metapola, domenaPubliczna, waluta, nazwa, sprawdzonoAt: new Date().toISOString() };
  await getPool().query(
    `update stores set capabilities = $3::jsonb where tenant_id = $1 and id = $2`,
    [
      tenantId,
      storeId,
      JSON.stringify({ zamowienia: true, klienci: true, produkty: true, porzuconyKoszyk: true, webhooki: nieaktywne.length === 0 && webhooki.length > 0, shopify: stan }),
    ],
  );
  return { stan, ostrzezenia };
}

/**
 * Role metryk (plan E.3): Shopify ma Placed Order i Started Checkout z serwera (webhooki),
 * więc USTAWIA te dwie role (nadpisuje custom z przeglądarki). Viewed Product, Added to Cart,
 * Active on Site idą z piksela pod `midrev` (nie nadpisują ustawionych).
 */
export async function ustawRoleShopify(tenantId: string): Promise<void> {
  const pool = getPool();
  for (const [rola, metryka] of [
    ["placed_order", METRYKI_SHOPIFY.zlozoneZamowienie],
    ["started_checkout", METRYKI_SHOPIFY.rozpoczetyCheckout],
  ] as const) {
    const m = await metrykaPoKluczu(pool, tenantId, metryka, { utworz: true, wbudowana: true, mozeWyzwalac: true, ukryta: false });
    if (!m) continue;
    await pool.query(
      `insert into metric_mappings (tenant_id, role, metric_id) values ($1, $2, $3)
       on conflict (tenant_id, role) do update set metric_id = excluded.metric_id, updated_at = now()`,
      [tenantId, rola, m.id],
    );
  }
  await ustawRoleMetrykStrony(tenantId);
}

/** app/uninstalled: token przestał działać po stronie Shopify; usuwamy go u nas i alarmujemy. */
export async function oznaczOdinstalowanie(tenantId: string, storeId: string): Promise<void> {
  const sklep = await sklepShopify(tenantId, storeId);
  if (!sklep) return;
  await getPool().query(
    `update stores set credentials_encrypted = $3, status = 'error', uninstalled_at = now(),
            last_error = 'Aplikacja MidRev została odinstalowana w Shopify. Dane przestały dochodzić.'
      where tenant_id = $1 and id = $2`,
    [tenantId, storeId, zaszyfrujPoswiadczenia({ ...sklep.poswiadczenia, accessToken: null, refreshToken: null, wygasaAt: null })],
  );
  await wyslijAlert(`Shopify: aplikacja odinstalowana w sklepie ${sklep.domena} (sklep ${storeId}). Zamówienia i piksel przestały dochodzić.`, {
    poziom: "uwaga",
    tenantId,
  });
}
