import type { PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";
import { odszyfruj, Sekret, zaszyfruj } from "../../adapters/crypto";
import { KlientShopify } from "../../adapters/store/shopify/graphql";
import { domenaSklepu, domenaZWpisu } from "../../adapters/store/shopify/oauth";

/**
 * Sklep Shopify w `stores` (platform = 'shopify'): aplikacja „custom distribution” ma WŁASNE
 * client_id i client_secret per sklep (decyzja D1), więc poświadczenia aplikacji leżą razem
 * z tokenem w jednym szyfrogramie AES-256-GCM (AD-13, `SECRETS_KEY`). Sekret aplikacji
 * podpisuje też webhooki, więc endpoint webhooków czyta go stąd.
 *
 * Sekrety w pamięci procesu są opakowane w `Sekret` (toString/toJSON = gwiazdki): przypadkowe
 * `console.log(sklep)` nie wypisze tokenu (historia: tokeny w logach).
 */

export interface PoswiadczeniaShopify {
  clientId: string;
  clientSecret: Sekret;
  accessToken: Sekret | null;
  zakresy: string[];
  wygasaAt: string | null;
  refreshToken: Sekret | null;
}

export interface SklepShopify {
  id: string;
  tenantId: string;
  domena: string;
  status: "pending" | "connected" | "error";
  ostatniBlad: string | null;
  zainstalowanyAt: Date | null;
  odinstalowanyAt: Date | null;
  poswiadczenia: PoswiadczeniaShopify;
}

export class BladSklepuShopify extends Error {}

const WZOR_CLIENT_ID = /^[A-Za-z0-9_-]{16,128}$/;
const WZOR_SEKRETU = /^[A-Za-z0-9_-]{16,256}$/;

export function zaszyfrujPoswiadczenia(p: PoswiadczeniaShopify): Buffer {
  return zaszyfruj(
    JSON.stringify({
      clientId: p.clientId,
      clientSecret: p.clientSecret.ujawnij(),
      accessToken: p.accessToken?.ujawnij() ?? null,
      zakresy: p.zakresy,
      wygasaAt: p.wygasaAt,
      refreshToken: p.refreshToken?.ujawnij() ?? null,
    }),
  );
}

export function odszyfrujPoswiadczenia(szyfrogram: Buffer): PoswiadczeniaShopify {
  const d = JSON.parse(odszyfruj(szyfrogram));
  return {
    clientId: String(d.clientId ?? ""),
    clientSecret: new Sekret(String(d.clientSecret ?? "")),
    accessToken: d.accessToken ? new Sekret(String(d.accessToken)) : null,
    zakresy: Array.isArray(d.zakresy) ? d.zakresy.map(String) : [],
    wygasaAt: typeof d.wygasaAt === "string" ? d.wygasaAt : null,
    refreshToken: d.refreshToken ? new Sekret(String(d.refreshToken)) : null,
  };
}

interface Wiersz {
  id: string;
  tenant_id: string;
  shop_domain: string;
  status: SklepShopify["status"];
  last_error: string | null;
  installed_at: Date | null;
  uninstalled_at: Date | null;
  credentials_encrypted: Buffer;
}

function zWiersza(w: Wiersz): SklepShopify {
  return {
    id: w.id,
    tenantId: w.tenant_id,
    domena: w.shop_domain,
    status: w.status,
    ostatniBlad: w.last_error,
    zainstalowanyAt: w.installed_at,
    odinstalowanyAt: w.uninstalled_at,
    poswiadczenia: odszyfrujPoswiadczenia(w.credentials_encrypted),
  };
}

const KOLUMNY = "id, tenant_id, shop_domain, status, last_error, installed_at, uninstalled_at, credentials_encrypted";

/**
 * Sklep po domenie myshopify, w CAŁEJ bazie (indeks unikalny z 0047 gwarantuje jeden wiersz).
 * Używane wyłącznie przez trasy, które potem weryfikują podpis HMAC sekretem tego sklepu:
 * domena z nagłówka/zapytania to tylko wskazówka, czym sprawdzić podpis, nigdy dowód.
 */
export async function sklepPoDomenie(domena: string, db: PoolClient | null = null): Promise<SklepShopify | null> {
  const d = domenaSklepu(domena);
  if (!d) return null;
  const { rows } = await (db ?? getPool()).query<Wiersz>(`select ${KOLUMNY} from stores where platform = 'shopify' and shop_domain = $1`, [d]);
  return rows[0] ? zWiersza(rows[0]) : null;
}

export async function sklepShopify(tenantId: string, storeId: string): Promise<SklepShopify | null> {
  const { rows } = await getPool().query<Wiersz>(
    `select ${KOLUMNY} from stores where tenant_id = $1 and id = $2 and platform = 'shopify'`,
    [tenantId, storeId],
  );
  return rows[0] ? zWiersza(rows[0]) : null;
}

export async function sklepyShopifyTenanta(tenantId: string): Promise<SklepShopify[]> {
  const { rows } = await getPool().query<Wiersz>(
    `select ${KOLUMNY} from stores where tenant_id = $1 and platform = 'shopify' order by created_at desc`,
    [tenantId],
  );
  return rows.map(zWiersza);
}

/**
 * Krok 1 kreatora: operator wpisuje adres sklepu oraz client_id i client_secret aplikacji
 * utworzonej dla tego klienta w Dev Dashboard. Zapis jako `pending` (bez tokenu); token
 * przyjdzie z OAuth po kliknięciu „Zainstaluj” w linku instalacyjnym.
 *
 * Ten sam sklep w innym tenancie = odmowa (indeks globalny). Ponowny zapis w tym samym
 * tenancie zmienia dane aplikacji; zastany token zostaje tylko przy TYM SAMYM client_id
 * (inna aplikacja = inny token, stary byłby nieważny).
 */
export async function zapiszAplikacjeShopify(
  tenantId: string,
  dane: { adres: string; clientId: string; clientSecret: string },
): Promise<SklepShopify> {
  const domena = domenaZWpisu(dane.adres);
  if (!domena) throw new BladSklepuShopify("Podaj adres w postaci nazwa-sklepu.myshopify.com (znajdziesz go w panelu Shopify: Ustawienia > Domeny).");
  const clientId = dane.clientId.trim();
  const sekret = dane.clientSecret.trim();
  if (!WZOR_CLIENT_ID.test(clientId)) throw new BladSklepuShopify("Client ID aplikacji wygląda na niepełny. Skopiuj go z Dev Dashboard > aplikacja > Ustawienia.");
  if (!WZOR_SEKRETU.test(sekret)) throw new BladSklepuShopify("Client secret wygląda na niepełny. Skopiuj go z Dev Dashboard > aplikacja > Ustawienia.");

  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    await klient.query("select pg_advisory_xact_lock(hashtextextended('shopify-sklep:' || $1, 0))", [domena]);
    const zastany = await sklepPoDomenie(domena, klient);
    if (zastany && zastany.tenantId !== tenantId) {
      throw new BladSklepuShopify("Ten sklep Shopify jest już podłączony do innego konta. Najpierw odłącz go tam.");
    }
    const tenSam = zastany && zastany.poswiadczenia.clientId === clientId;
    const posw: PoswiadczeniaShopify = {
      clientId,
      clientSecret: new Sekret(sekret),
      accessToken: tenSam ? zastany.poswiadczenia.accessToken : null,
      zakresy: tenSam ? zastany.poswiadczenia.zakresy : [],
      wygasaAt: tenSam ? zastany.poswiadczenia.wygasaAt : null,
      refreshToken: tenSam ? zastany.poswiadczenia.refreshToken : null,
    };
    const status = tenSam && zastany.status === "connected" ? "connected" : "pending";
    const { rows } = await klient.query<Wiersz>(
      `insert into stores (tenant_id, platform, base_url, shop_domain, credentials_encrypted, capabilities, status)
       values ($1, 'shopify', $2, $3, $4, '{}'::jsonb, $5)
       on conflict (tenant_id, platform, base_url) do update
         set credentials_encrypted = excluded.credentials_encrypted, shop_domain = excluded.shop_domain,
             status = excluded.status, last_error = null
       returning ${KOLUMNY}`,
      [tenantId, `https://${domena}`, domena, zaszyfrujPoswiadczenia(posw), status],
    );
    await klient.query("commit");
    return zWiersza(rows[0]);
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    if (b && typeof b === "object" && "code" in b && (b as { code: string }).code === "23505") {
      throw new BladSklepuShopify("Ten sklep Shopify jest już podłączony do innego konta. Najpierw odłącz go tam.");
    }
    throw b;
  } finally {
    klient.release();
  }
}

/** Opcje testowe klienta HTTP (atrapa fetch, zegar bez czekania). Produkcja: domyślne. */
const g = globalThis as unknown as { __midrevShopifyTest?: { fetchImpl?: typeof fetch; czekaj?: (ms: number) => Promise<void> } };
export function ustawOpcjeTestoweShopify(o: { fetchImpl?: typeof fetch; czekaj?: (ms: number) => Promise<void> } | null): void {
  g.__midrevShopifyTest = o ?? undefined;
}
export function fetchShopify(): typeof fetch {
  return g.__midrevShopifyTest?.fetchImpl ?? fetch;
}

/** Klient GraphQL dla połączonego sklepu. Bez tokenu (pending, odinstalowany) = błąd z nazwą. */
export function klientDla(s: SklepShopify): KlientShopify {
  const token = s.poswiadczenia.accessToken;
  if (!token) throw new BladSklepuShopify(`sklep ${s.domena} nie ma tokenu (aplikacja nie jest zainstalowana)`);
  return new KlientShopify({
    domena: s.domena,
    token: token.ujawnij(),
    fetchImpl: fetchShopify(),
    czekaj: g.__midrevShopifyTest?.czekaj,
  });
}
