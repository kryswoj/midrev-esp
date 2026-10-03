import { randomInt } from "node:crypto";
import { getPool } from "../../adapters/db/pool";

/**
 * Klucz publiczny strony (0032 `site_keys` + 0044): odpowiednik `company_id` Klaviyo.
 *
 * Klucz jest PUBLICZNY z definicji: stoi w tagu <script> na stronie sklepu. Dlatego daje
 * wyłącznie zapis (zdarzenia, identyfikacja, subskrypcja z dowodem zgody) przez trasy
 * `/client/*` i NIGDY odczyt czegokolwiek z konta. Tenant pochodzi wyłącznie z rekordu
 * klucza (AD-40).
 *
 * Jeden aktywny klucz na tenanta (unikalny indeks częściowy z 0044). Rotacja = unieważnij
 * i utwórz nowy (stary tag na stronie przestaje działać od razu).
 */

const ALFABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export const WZOR_KLUCZA_STRONY = /^[A-Za-z0-9]{6,10}$/;

export interface KluczStrony {
  id: string;
  tenantId: string;
  /** domeny strony (bez schematu): gdzie wolno doklejać `_mx` i skąd przyjmować CORS */
  domeny: string[];
  /** true = CORS tylko z `domeny`; false = każdy origin (domyślnie, jak Klaviyo) */
  ograniczOriginy: boolean;
  wymagajZgodyCookies: boolean;
  identyfikacjaZLinkow: boolean;
  ga4: boolean;
  zaladujFormularze: boolean;
  tekstZgody: string | null;
  politykaUrl: string | null;
  /** adapter piksela (0044 `platform`): custom / woocommerce / shopify / shoper */
  platforma: string;
  utworzono: Date;
}

interface Wiersz {
  id: string;
  tenant_id: string;
  link_domains: string[];
  restrict_origins: boolean;
  require_cookie_consent: boolean;
  identify_from_links: boolean;
  ga4_datalayer: boolean;
  load_forms: boolean;
  consent_wording: string | null;
  consent_privacy_url: string | null;
  platform: string;
  created_at: Date;
}

const KOLUMNY = `id, tenant_id, link_domains, restrict_origins, require_cookie_consent, identify_from_links,
  ga4_datalayer, load_forms, consent_wording, consent_privacy_url, platform, created_at`;

function zWiersza(w: Wiersz): KluczStrony {
  return {
    id: w.id,
    tenantId: w.tenant_id,
    domeny: w.link_domains ?? [],
    ograniczOriginy: w.restrict_origins,
    wymagajZgodyCookies: w.require_cookie_consent,
    identyfikacjaZLinkow: w.identify_from_links,
    ga4: w.ga4_datalayer,
    zaladujFormularze: w.load_forms,
    tekstZgody: w.consent_wording,
    politykaUrl: w.consent_privacy_url,
    platforma: w.platform ?? "custom",
    utworzono: w.created_at,
  };
}

function nowyIdentyfikator(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALFABET[randomInt(ALFABET.length)];
  return s;
}

export async function kluczStronyTenanta(tenantId: string): Promise<KluczStrony | null> {
  const { rows } = await getPool().query<Wiersz>(
    `select ${KOLUMNY} from site_keys where tenant_id = $1 and revoked_at is null`,
    [tenantId],
  );
  return rows[0] ? zWiersza(rows[0]) : null;
}

/** Klucz tenanta; jeśli go nie ma, zakłada nowy (idempotentnie, także przy wyścigu dwóch kart). */
export async function zapewnijKluczStrony(tenantId: string): Promise<KluczStrony> {
  const istniejacy = await kluczStronyTenanta(tenantId);
  if (istniejacy) return istniejacy;
  for (let proba = 0; proba < 5; proba++) {
    const { rows } = await getPool().query<Wiersz>(
      `insert into site_keys (id, tenant_id) values ($1, $2)
       on conflict do nothing
       returning ${KOLUMNY}`,
      [nowyIdentyfikator(), tenantId],
    );
    if (rows[0]) {
      wyczyscPamiecKluczy();
      return zWiersza(rows[0]);
    }
    // konflikt: albo równoległa karta założyła klucz (indeks częściowy), albo kolizja id
    const teraz = await kluczStronyTenanta(tenantId);
    if (teraz) return teraz;
  }
  throw new Error("nie udało się założyć klucza strony");
}

// ── Odczyt publiczny (gorąca ścieżka: każdy skrypt i każde zdarzenie z przeglądarki) ──

const PAMIEC_MS = 30_000;
const pamiec = new Map<string, { klucz: KluczStrony | null; do: number }>();

/**
 * Aktywny klucz po id z żądania publicznego. Krótka pamięć podręczna (30 s): unieważnienie
 * działa najpóźniej po 30 s, a boty z losowymi id nie zapychają bazy (wynik „brak” też jest
 * pamiętany, mapa ma twardy sufit).
 */
export async function kluczStronyPublicznie(id: unknown, teraz = Date.now()): Promise<KluczStrony | null> {
  if (typeof id !== "string" || !WZOR_KLUCZA_STRONY.test(id)) return null;
  const w = pamiec.get(id);
  if (w && w.do > teraz) return w.klucz;
  const { rows } = await getPool().query<Wiersz>(
    `select ${KOLUMNY} from site_keys where id = $1 and revoked_at is null`,
    [id],
  );
  const klucz = rows[0] ? zWiersza(rows[0]) : null;
  // sufit mapy bez czyszczenia całości: usuwamy najstarsze wpisy (kolejność wstawienia)
  while (pamiec.size >= 5_000) {
    const najstarszy = pamiec.keys().next().value;
    if (najstarszy === undefined) break;
    pamiec.delete(najstarszy);
  }
  pamiec.delete(id);
  pamiec.set(id, { klucz, do: teraz + PAMIEC_MS });
  return klucz;
}

export function wyczyscPamiecKluczy(): void {
  pamiec.clear();
}

// ── Ustawienia z panelu ──────────────────────────────────────────────────────────

export class BladUstawienStrony extends Error {}

const WZOR_HOSTA = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Domena z tego, co wpisze człowiek: „https://www.sklep.pl/koszyk” → „sklep.pl”.
 * `www.` ucinamy, bo domena obejmuje subdomeny (hostWDomenach). Localhost i adresy IP
 * odrzucamy: to nie jest domena sklepu, na którą wolno doklejać token z maila.
 */
export function normalizujDomene(surowa: string): string {
  let s = surowa.trim().toLowerCase();
  if (!s) throw new BladUstawienStrony("Pusta domena.");
  if (!/^[a-z]+:\/\//.test(s)) s = "https://" + s;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    throw new BladUstawienStrony(`„${surowa.slice(0, 80)}” nie wygląda na adres strony.`);
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  if (!WZOR_HOSTA.test(host)) {
    throw new BladUstawienStrony(`„${surowa.slice(0, 80)}” nie wygląda na domenę (np. mojsklep.pl).`);
  }
  return host;
}

export interface UstawieniaStrony {
  domeny: string[];
  ograniczOriginy: boolean;
  wymagajZgodyCookies: boolean;
  identyfikacjaZLinkow: boolean;
  ga4: boolean;
  zaladujFormularze: boolean;
  tekstZgody: string | null;
  politykaUrl: string | null;
}

export async function zapiszUstawieniaStrony(tenantId: string, u: UstawieniaStrony): Promise<KluczStrony> {
  const domeny = [...new Set(u.domeny.map(normalizujDomene))];
  if (domeny.length > 20) throw new BladUstawienStrony("Najwyżej 20 domen.");
  if (u.ograniczOriginy && domeny.length === 0) {
    throw new BladUstawienStrony("Żeby przyjmować zdarzenia tylko z Twojej strony, podaj jej domenę.");
  }
  const tekst = u.tekstZgody?.trim() || null;
  if (tekst && (tekst.length < 10 || tekst.length > 2000)) {
    throw new BladUstawienStrony("Treść zgody musi mieć od 10 do 2000 znaków.");
  }
  const polityka = u.politykaUrl?.trim() || null;
  if (polityka && (!/^https?:\/\//i.test(polityka) || polityka.length > 500)) {
    throw new BladUstawienStrony("Adres polityki prywatności musi zaczynać się od https:// i mieć do 500 znaków.");
  }
  await zapewnijKluczStrony(tenantId);
  const { rows } = await getPool().query<Wiersz>(
    `update site_keys set
       link_domains = $2, allowed_origins = $2, restrict_origins = $3, require_cookie_consent = $4,
       identify_from_links = $5, ga4_datalayer = $6, load_forms = $7, consent_wording = $8,
       consent_privacy_url = $9, updated_at = now()
     where tenant_id = $1 and revoked_at is null
     returning ${KOLUMNY}`,
    [tenantId, domeny, u.ograniczOriginy, u.wymagajZgodyCookies, u.identyfikacjaZLinkow, u.ga4, u.zaladujFormularze, tekst, polityka],
  );
  wyczyscPamiecKluczy();
  if (!rows[0]) throw new BladUstawienStrony("Klucz strony zniknął w trakcie zapisu. Odśwież stronę.");
  return zWiersza(rows[0]);
}

/** Rotacja: stary tag przestaje działać (po ≤ 30 s pamięci), nowy klucz od razu. */
export async function wymienKluczStrony(tenantId: string): Promise<KluczStrony> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows: stare } = await klient.query<Wiersz>(
      `update site_keys set revoked_at = now() where tenant_id = $1 and revoked_at is null returning ${KOLUMNY}`,
      [tenantId],
    );
    let nowy: Wiersz | undefined;
    for (let proba = 0; proba < 5 && !nowy; proba++) {
      const { rows } = await klient.query<Wiersz>(
        `insert into site_keys (id, tenant_id, link_domains, allowed_origins, restrict_origins, require_cookie_consent,
                                identify_from_links, ga4_datalayer, load_forms, consent_wording, consent_privacy_url, platform)
         values ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (id) do nothing returning ${KOLUMNY}`,
        [
          nowyIdentyfikator(),
          tenantId,
          stare[0]?.link_domains ?? [],
          stare[0]?.restrict_origins ?? false,
          stare[0]?.require_cookie_consent ?? true,
          stare[0]?.identify_from_links ?? true,
          stare[0]?.ga4_datalayer ?? false,
          stare[0]?.load_forms ?? true,
          stare[0]?.consent_wording ?? null,
          stare[0]?.consent_privacy_url ?? null,
          // platforma zostaje (Woo/Shopify): od niej zależy wymuszenie zgody w midrev.js (review r5)
          stare[0]?.platform ?? "custom",
        ],
      );
      nowy = rows[0];
    }
    if (!nowy) throw new Error("nie udało się wylosować nowego klucza strony");
    await klient.query("commit");
    wyczyscPamiecKluczy();
    return zWiersza(nowy);
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}
