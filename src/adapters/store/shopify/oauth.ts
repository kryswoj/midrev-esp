import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OAuth instalacji aplikacji Shopify (authorization code grant, token offline) i podpisy
 * HMAC. Czyste funkcje bez bazy; jedyne wyjście do sieci to `wymienKodNaToken` z wstrzykiwanym
 * `fetch` (testy podają atrapę, żaden test nie woła prawdziwego Shopify).
 *
 * Źródła (shopify.dev):
 *   - authorization code grant: weryfikacja `hmac` zapytania = HMAC-SHA256 (sekret aplikacji)
 *     z parametrów bez `hmac`/`signature`, posortowanych, sklejonych `k=v&k=v`, zapis hex;
 *     `shop` musi pasować do `^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$`; `state` = nonce,
 *     który aplikacja porównuje z wartością związaną z przeglądarką,
 *   - webhooki: `X-Shopify-Hmac-Sha256` = base64(HMAC-SHA256(sekret, SUROWE ciało)).
 *
 * Wszystkie porównania podpisów w stałym czasie. Sekret ani token nigdy nie trafiają do
 * komunikatu błędu (historia: tokeny w logach).
 */

/** Wersja Admin API. Jedno miejsce; zmiana = przegląd mapowania (pola potrafią znikać). */
export const WERSJA_API_SHOPIFY = "2026-07";

/**
 * Zakresy aplikacji (plan A.2). `read_all_orders` (zamówienia starsze niż 60 dni) wymaga
 * ZGODY Shopify w Dev Dashboard; bez niej import obejmie tylko ostatnie 60 dni (instalacja
 * działa, raport importu mówi to wprost).
 */
export const ZAKRESY_WYMAGANE = [
  "read_orders",
  "read_products",
  "read_customers",
  "read_checkouts",
  "write_pixels",
  "read_customer_events",
] as const;
export const ZAKRESY_OPCJONALNE = ["read_all_orders"] as const;

const WZOR_DOMENY = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Domena sklepu z parametru `shop`: tylko `{nazwa}.myshopify.com`, małe litery. Null = odrzuć. */
export function domenaSklepu(surowa: unknown): string | null {
  if (typeof surowa !== "string") return null;
  const d = surowa.trim().toLowerCase();
  if (d.length > 255 || !WZOR_DOMENY.test(d)) return null;
  return d;
}

/**
 * Domena z tego, co wpisze operator w kreatorze: „sklep”, „sklep.myshopify.com”,
 * „https://sklep.myshopify.com/admin”. Domeny własnej (sklep.pl) nie da się zamienić na
 * myshopify bez zapytania do Shopify, więc ją odrzucamy z czytelnym komunikatem.
 */
export function domenaZWpisu(wpis: string): string | null {
  let t = wpis.trim().toLowerCase();
  if (!t) return null;
  t = t.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (/^[a-z0-9][a-z0-9-]*$/.test(t)) t = `${t}.myshopify.com`;
  return domenaSklepu(t);
}

function rowne(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Weryfikacja `hmac` w zapytaniu od Shopify (wejście instalacji i callback OAuth).
 * `parametry` to WSZYSTKIE parametry zapytania, tak jak przyszły (bez dekodowania podwójnego).
 * Parametr powtórzony (`ids[]=1&ids[]=2`) Shopify skleja jako `["1", "2"]`; tu odrzucamy
 * powtórzenia poza tablicami, bo w OAuth ich nie ma, a dawałyby pole do manipulacji.
 */
export function zweryfikujHmacZapytania(parametry: URLSearchParams, sekret: string): boolean {
  const podpis = parametry.get("hmac");
  if (!podpis || !/^[0-9a-f]{64}$/i.test(podpis) || !sekret) return false;
  const klucze = new Map<string, string[]>();
  for (const [k, v] of parametry) {
    if (k === "hmac" || k === "signature") continue;
    const lista = klucze.get(k) ?? [];
    lista.push(v);
    klucze.set(k, lista);
  }
  const czesci: string[] = [];
  for (const k of [...klucze.keys()].sort()) {
    const v = klucze.get(k)!;
    if (v.length > 1 && !k.endsWith("[]")) return false;
    const wartosc = v.length > 1 ? `["${v.join('", "')}"]` : v[0];
    // znaki rozdzielające escapowane jak w bibliotekach Shopify (shopify-api-js)
    czesci.push(`${k.replace(/[&=%]/g, encodeURIComponent)}=${wartosc.replace(/[&%]/g, encodeURIComponent)}`);
  }
  const oczekiwany = createHmac("sha256", sekret).update(czesci.join("&"), "utf8").digest("hex");
  return rowne(podpis.toLowerCase(), oczekiwany);
}

/** Znacznik czasu z zapytania nie starszy niż `maksSek` (i nie z przyszłości ponad minutę). */
export function swiezyZnacznik(timestamp: string | null, teraz = Date.now(), maksSek = 3600): boolean {
  if (!timestamp || !/^\d{9,11}$/.test(timestamp)) return false;
  const t = Number(timestamp) * 1000;
  return t <= teraz + 60_000 && teraz - t <= maksSek * 1000;
}

/** Podpis webhooka. Ciało MUSI być surowe (przed JSON.parse): inny zapis spacji = inny podpis. */
export function zweryfikujHmacWebhooka(cialo: string | Buffer, naglowek: string | null, sekret: string): boolean {
  if (!naglowek || !sekret || naglowek.length > 100) return false;
  const oczekiwany = createHmac("sha256", sekret).update(cialo).digest("base64");
  return rowne(naglowek.trim(), oczekiwany);
}

/** Nowy stan OAuth (nonce) i jego hasz do bazy. Jawny stan idzie tylko do Shopify i ciasteczka. */
export function nowyStan(): { stan: string; hasz: string } {
  const stan = randomBytes(32).toString("base64url");
  return { stan, hasz: haszStanu(stan) };
}

export function haszStanu(stan: string): string {
  return createHash("sha256").update(stan, "utf8").digest("hex");
}

export function adresAutoryzacji(o: { domena: string; clientId: string; redirectUri: string; stan: string; zakresy?: readonly string[] }): string {
  const u = new URL(`https://${o.domena}/admin/oauth/authorize`);
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("scope", (o.zakresy ?? [...ZAKRESY_WYMAGANE, ...ZAKRESY_OPCJONALNE]).join(","));
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("state", o.stan);
  // bez grant_options[]=per-user: token OFFLINE (praca w tle: webhooki, import, worker)
  return u.toString();
}

export interface TokenShopify {
  accessToken: string;
  zakresy: string[];
  /** Tylko przy tokenie wygasającym (`expiring=1`, wymóg aplikacji publicznych). */
  wygasaAt: Date | null;
  refreshToken: string | null;
  refreshWygasaAt: Date | null;
}

export class BladOAuthShopify extends Error {}

/**
 * Wymiana `code` na token offline: POST https://{shop}/admin/oauth/access_token.
 * `expiring: true` prosi o token wygasający (60 min + refresh 90 dni). Aplikacja custom go nie
 * wymaga; kod obsługuje oba kształty odpowiedzi, żeby przejście na publiczną nie było migracją.
 */
export async function wymienKodNaToken(
  o: { domena: string; clientId: string; clientSecret: string; kod: string; expiring?: boolean },
  fetchImpl: typeof fetch = fetch,
  teraz = Date.now(),
): Promise<TokenShopify> {
  if (!domenaSklepu(o.domena)) throw new BladOAuthShopify("niepoprawna domena sklepu");
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(o.kod)) throw new BladOAuthShopify("niepoprawny kod autoryzacji");
  const cialo: Record<string, unknown> = { client_id: o.clientId, client_secret: o.clientSecret, code: o.kod };
  if (o.expiring) cialo.expiring = 1;
  let odp: Response;
  try {
    odp = await fetchImpl(`https://${o.domena}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(cialo),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BladOAuthShopify("Shopify nie odpowiedział przy wymianie kodu");
  }
  if (!odp.ok) throw new BladOAuthShopify(`Shopify odrzucił wymianę kodu (HTTP ${odp.status})`);
  let dane: Record<string, unknown>;
  try {
    dane = (await odp.json()) as Record<string, unknown>;
  } catch {
    throw new BladOAuthShopify("nieczytelna odpowiedź Shopify przy wymianie kodu");
  }
  const token = typeof dane.access_token === "string" ? dane.access_token : "";
  if (!token || token.length > 512) throw new BladOAuthShopify("odpowiedź Shopify bez tokenu");
  const zakresy = typeof dane.scope === "string" ? dane.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const sek = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(teraz + v * 1000) : null);
  return {
    accessToken: token,
    zakresy,
    wygasaAt: sek(dane.expires_in),
    refreshToken: typeof dane.refresh_token === "string" ? dane.refresh_token : null,
    refreshWygasaAt: sek(dane.refresh_token_expires_in),
  };
}

/**
 * Których WYMAGANYCH zakresów brakuje w nadanym tokenie. `write_X` implikuje `read_X`
 * (Shopify zwraca wtedy tylko `write_X`).
 */
export function brakujaceZakresy(nadane: readonly string[]): string[] {
  const zbior = new Set(nadane);
  return ZAKRESY_WYMAGANE.filter((z) => !zbior.has(z) && !(z.startsWith("read_") && zbior.has(`write_${z.slice(5)}`)));
}
