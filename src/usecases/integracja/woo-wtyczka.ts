import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { zaszyfruj } from "../../adapters/crypto";
import { getPool } from "../../adapters/db/pool";
import { odszyfrujPoswiadczenia } from "../../adapters/store/fabryka";
import { config, adresSledzenia } from "../../config";
import { METRYKI_STRONY } from "../../domain/integracja/metryki-strony";
import type { KoszykSklepu, PozycjaKoszyka } from "../../domain/store/contract";
import { naMinor } from "../../domain/zdarzenia/limity";
import { dodajZadanie } from "../../jobs/kolejka";
import { wyslijAlert } from "../../jobs/alerty";
import { podlaczSklepWoo } from "../podlacz-sklep";
import { zapiszKoszykSklepu } from "../katalog/koszyki";
import { identyfikujProfil } from "../zdarzenia/identyfikacja";
import { metrykaPoKluczu } from "../zdarzenia/metryki";
import { zapewnijPartycjeMiesiaca } from "../zdarzenia/partycje";
import { BladZdarzenia, zapiszZdarzenie } from "../zdarzenia/zapisz-zdarzenie";
import { normalizujDomene, wyczyscPamiecKluczy, zapewnijKluczStrony } from "./klucz-strony";
import { ustawRoleMetrykStrony } from "./role-metryk";
import { zapiszZgodeSklepu } from "./zgody-sklepu";

/**
 * Wtyczka „MidRev ESP for WooCommerce” po stronie ESP (plan integracji B.3, W1–W3):
 *
 *  1. PAROWANIE. Operator generuje w panelu jednorazowy kod (≥ 125 bitów, ważny 2 h, w bazie
 *     tylko SHA-256). Administrator sklepu wkleja go we wtyczce; wtyczka sama zakłada u siebie
 *     klucz REST (read_write) i wysyła go nam razem z kodem. My sprawdzamy klucz ZAKRES PO
 *     ZAKRESIE (ta sama droga co ręczne klucze), zakładamy webhooki z odczytem zwrotnym,
 *     zapisujemy sklep i oddajemy wtyczce: id sklepu, klucz strony (midrev.js) i sekret wtyczki
 *     (HMAC). Zero kopiowania kluczy przez człowieka. Kod z adresem sklepu (opcjonalnie podanym
 *     w panelu) nie sparuje innego sklepu.
 *  2. ZDARZENIA SERWER-SERWER (Added to Cart, Started Checkout, identify z checkoutu, zgoda
 *     z checkboxa). Podpis HMAC-SHA256(sekret wtyczki, `{ts}.{ciało}`), okno ±10 min, każde
 *     zdarzenie ma id nadane przez wtyczkę = klucz idempotencji (ponowienie z kolejki wtyczki
 *     nie zdubluje zdarzenia). Faza 1: `raw_events` (kanał `plugin`) + job; faza 2: worker.
 *  3. ZGODA Z CHECKOUTU. Wtyczka pokazuje klauzulę w wersji z naszej bazy i odsyła NUMER wersji;
 *     do rejestru zgód idzie tekst z `store_consent_versions`, nie z żądania.
 *
 * Metryki zachowań pod integracją `midrev` (jak midrev.js na custom), więc szablon flow
 * „porzucony koszyk” jest jeden dla Woo i custom (role `added_to_cart`, `started_checkout`).
 */

export const RODZAJ_JOBA_WTYCZKI = "przetworz_zdarzenie_wtyczki";
export const ZRODLO_WTYCZKI = "wtyczka";
const WAZNOSC_KODU_MS = 2 * 3600 * 1000;
export const OKNO_PODPISU_S = 600;
const ALFABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bez 0/O/1/I

function sha256(t: string): Buffer {
  return createHash("sha256").update(t, "utf8").digest();
}

/** Kod w postaci kanonicznej (wielkie litery, bez spacji i myślników) albo null. */
export function normalizujKod(surowy: unknown): string | null {
  if (typeof surowy !== "string") return null;
  const k = surowy.toUpperCase().replace(/[\s-]/g, "");
  return /^MRV[A-Z2-9]{25}$/.test(k) ? k : null;
}

function nowyKod(): { kanoniczny: string; czytelny: string } {
  const bajty = randomBytes(25);
  let znaki = "";
  for (const b of bajty) znaki += ALFABET[b % 32];
  const grupy = znaki.match(/.{5}/g)!;
  return { kanoniczny: `MRV${znaki}`, czytelny: `MRV-${grupy.join("-")}` };
}

/** Adres sklepu w postaci, w jakiej trzymamy `stores.base_url` (origin + ścieżka bez końcowego /). */
export function normalizujAdresSklepu(surowy: string): string | null {
  try {
    const u = new URL(surowy.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    const sciezka = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${sciezka}`;
  } catch {
    return null;
  }
}

function hostBezWww(adres: string): string {
  return new URL(adres).hostname.toLowerCase().replace(/^www\./, "");
}

// ── 1. Parowanie ────────────────────────────────────────────────────────────────

export interface KodParowania {
  kod: string;
  wygasa: Date;
  /** strona ustawień wtyczki w WP z kodem w adresie (tylko gdy operator podał adres sklepu) */
  link: string | null;
}

export async function utworzKodParowania(
  tenantId: string,
  opcje: { adresSklepu?: string | null; userId?: string | null } = {},
): Promise<KodParowania> {
  const adres = opcje.adresSklepu?.trim() ? normalizujAdresSklepu(opcje.adresSklepu) : null;
  if (opcje.adresSklepu?.trim() && !adres) throw new BladParowania("Adres sklepu musi zaczynać się od https:// (albo http://).");
  const { kanoniczny, czytelny } = nowyKod();
  const wygasa = new Date(Date.now() + WAZNOSC_KODU_MS);
  await getPool().query(
    `insert into store_connect_tokens (tenant_id, platform, purpose, token_hash, base_url, expires_at, created_by)
     values ($1, 'woocommerce', 'wtyczka', $2, $3, $4, $5)`,
    [tenantId, sha256(kanoniczny), adres, wygasa, opcje.userId ?? null],
  );
  const link = adres ? `${adres}/wp-admin/admin.php?page=midrev-esp&mrv_kod=${encodeURIComponent(czytelny)}` : null;
  return { kod: czytelny, wygasa, link };
}

export class BladParowania extends Error {
  constructor(message: string, readonly kod: string = "odmowa") {
    super(message);
  }
}

const schematParowania = z.object({
  kod: z.string().max(64),
  home_url: z.string().max(500),
  site_url: z.string().max(500).optional(),
  consumer_key: z.string().regex(/^ck_[a-f0-9]{40}$/),
  consumer_secret: z.string().regex(/^cs_[a-f0-9]{40}$/),
  plugin_version: z.string().max(40).regex(/^[0-9A-Za-z.+-]+$/).optional(),
  wc_version: z.string().max(40).optional(),
});

export interface WynikParowania {
  store_id: string;
  site_key: string | null;
  plugin_secret: string;
  script_url: string | null;
  api_url: string;
  konfiguracja: KonfiguracjaWtyczki;
}

/**
 * Parowanie wtyczki. Kolejność ma znaczenie:
 *   1. kod zajmowany atomowo (`used_at`), zanim zrobimy cokolwiek w sklepie: dwa równoległe
 *      żądania z tym samym kodem nie podłączą dwóch sklepów,
 *   2. weryfikacja kluczy i webhooki (wspólne `podlaczSklepWoo`); porażka ZWALNIA kod, żeby
 *      administrator mógł poprawić problem (np. HTTPS) i spróbować jeszcze raz tym samym,
 *   3. sekret wtyczki NOWY przy każdym parowaniu (stary sekret innej instalacji przestaje działać).
 */
export async function sparujWtyczke(cialo: unknown): Promise<WynikParowania> {
  const w = schematParowania.safeParse(cialo);
  if (!w.success) throw new BladParowania("Niepoprawne dane parowania.", "niepoprawne");
  const kod = normalizujKod(w.data.kod);
  if (!kod) throw new BladParowania("Ten kod nie wygląda na kod parowania MidRev.", "zly_kod");
  const adres = normalizujAdresSklepu(w.data.home_url);
  if (!adres) throw new BladParowania("Adres sklepu musi zaczynać się od https:// (albo http://).", "zly_adres");

  const pool = getPool();
  const { rows } = await pool.query<{ id: string; tenant_id: string; base_url: string | null }>(
    `update store_connect_tokens set used_at = now()
      where token_hash = $1 and purpose = 'wtyczka' and used_at is null and expires_at > now()
      returning id, tenant_id, base_url`,
    [sha256(kod)],
  );
  const token = rows[0];
  if (!token) throw new BladParowania("Kod parowania jest nieważny, wygasł albo został już użyty. Wygeneruj nowy w panelu MidRev.", "zly_kod");
  const zwolnij = () => pool.query("update store_connect_tokens set used_at = null where id = $1 and store_id is null", [token.id]);
  if (token.base_url && hostBezWww(token.base_url) !== hostBezWww(adres)) {
    await zwolnij();
    throw new BladParowania(`Ten kod wygenerowano dla sklepu ${new URL(token.base_url).host}, a nie ${new URL(adres).host}.`, "inny_sklep");
  }

  const pluginSecret = randomBytes(32).toString("hex");
  let wynik;
  try {
    wynik = await podlaczSklepWoo(
      token.tenant_id,
      { baseUrl: adres, consumerKey: w.data.consumer_key, consumerSecret: w.data.consumer_secret },
      { metoda: "wtyczka", dodatkowe: { pluginSecret } },
    );
  } catch (b) {
    await zwolnij();
    throw b;
  }
  if (!wynik.ok) {
    await zwolnij();
    throw new BladParowania(`${wynik.blad}${wynik.szczegoly ? ` (${wynik.szczegoly})` : ""}`, "sklep");
  }
  await pool.query("update store_connect_tokens set store_id = $2 where id = $1", [token.id, wynik.storeId]);
  await pool.query(
    "update stores set plugin_version = $3, plugin_seen_at = now() where tenant_id = $1 and id = $2",
    [token.tenant_id, wynik.storeId, w.data.plugin_version ?? null],
  );

  // Kroki po połączeniu są POMOCNICZE: sklep w ESP już działa (klucze, webhooki), więc ich błąd
  // nie może skończyć się odpowiedzią „nie połączono” (wtyczka skasowałaby wtedy klucz REST, który
  // ESP właśnie zapisał). Błąd = ostrzeżenie w logu i alert; wtyczka dociągnie konfigurację pingiem.
  let siteKey: string | null = null;
  try {
    siteKey = await przygotujStroneSklepu(token.tenant_id, wynik.storeId, adres);
  } catch (b) {
    const opis = b instanceof Error ? b.message : "błąd";
    console.warn(`[wtyczka] parowanie: kroki pomocnicze nieudane (${opis})`);
    await wyslijAlert(`parowanie wtyczki Woo (sklep ${wynik.storeId}): sklep połączony, ale kroki pomocnicze padły: ${opis}`, { poziom: "uwaga", tenantId: token.tenant_id }).catch(() => {});
  }

  return {
    store_id: wynik.storeId,
    site_key: siteKey,
    plugin_secret: pluginSecret,
    script_url: siteKey ? `${adresSledzenia().replace(/\/+$/, "")}/js/v1/${siteKey}.js` : null,
    api_url: config().APP_URL.replace(/\/+$/, ""),
    konfiguracja: await konfiguracjaWtyczki(token.tenant_id, wynik.storeId),
  };
}

/** midrev.js na sklepie: klucz strony w trybie woo, domena sklepu, role zachowań, klauzula kasy. */
async function przygotujStroneSklepu(tenantId: string, storeId: string, adres: string): Promise<string> {
  const pool = getPool();
  const klucz = await zapewnijKluczStrony(tenantId);
  // host bez kropki (sandbox) nie jest domeną: wtedy bez dopisywania do listy domen
  let domena: string | null = null;
  try {
    domena = normalizujDomene(new URL(adres).hostname);
  } catch {
    domena = null;
  }
  await pool.query(
    `update site_keys set platform = 'woocommerce',
            link_domains = case when $2::text is null or $2 = any(link_domains) or cardinality(link_domains) >= 20 then link_domains else array_append(link_domains, $2) end,
            allowed_origins = case when $2::text is null or $2 = any(allowed_origins) or cardinality(allowed_origins) >= 20 then allowed_origins else array_append(allowed_origins, $2) end,
            ga4_datalayer = false, updated_at = now()
      where tenant_id = $1 and id = $3`,
    [tenantId, domena, klucz.id],
  );
  wyczyscPamiecKluczy();
  await ustawRoleMetrykStrony(tenantId);
  await zapewnijKlauzuleCheckoutu(tenantId, storeId);
  return klucz.id;
}

// ── Klauzula zgody w checkoucie (wersjonowana) ────────────────────────────────────

export interface KlauzulaCheckoutu {
  id: string;
  wersja: number;
  tresc: string;
  polityka: string | null;
}

export async function klauzulaCheckoutu(tenantId: string, storeId: string): Promise<KlauzulaCheckoutu | null> {
  const { rows } = await getPool().query(
    `select id, version, wording, privacy_url from store_consent_versions
      where tenant_id = $1 and store_id = $2 and superseded_at is null`,
    [tenantId, storeId],
  );
  return rows[0] ? { id: rows[0].id, wersja: rows[0].version, tresc: rows[0].wording, polityka: rows[0].privacy_url } : null;
}

/** Domyślna klauzula przy pierwszym parowaniu (operator zmienia ją w panelu; jak 0041 dla popupów). */
async function zapewnijKlauzuleCheckoutu(tenantId: string, storeId: string): Promise<void> {
  if (await klauzulaCheckoutu(tenantId, storeId)) return;
  const { rows } = await getPool().query<{ nazwa: string }>(
    "select left(coalesce(nullif(btrim(sender_company_name), ''), name), 200) as nazwa from tenants where id = $1",
    [tenantId],
  );
  const tresc =
    `Chcę otrzymywać od ${rows[0]?.nazwa ?? "sklepu"} wiadomości e-mail z nowościami i ofertami. ` +
    "Zgodę mogę wycofać w każdej chwili, klikając link w stopce wiadomości.";
  await zapiszKlauzuleCheckoutu(tenantId, storeId, { tresc, polityka: null }).catch(() => {
    /* równoległe parowanie założyło wersję 1 */
  });
}

export class BladKlauzuli extends Error {}

/** Nowa wersja klauzuli (stara dostaje `superseded_at`; wersje są niezmienne, 0046). */
export async function zapiszKlauzuleCheckoutu(
  tenantId: string,
  storeId: string,
  dane: { tresc: string; polityka: string | null },
): Promise<KlauzulaCheckoutu> {
  const tresc = dane.tresc.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (tresc.length < 20 || tresc.length > 2000) throw new BladKlauzuli("Treść zgody musi mieć od 20 do 2000 znaków.");
  const polityka = dane.polityka?.trim() || null;
  if (polityka && (!/^https?:\/\/[^\s<>"]+$/i.test(polityka) || polityka.length > 500)) {
    throw new BladKlauzuli("Adres polityki prywatności musi zaczynać się od https:// i mieć do 500 znaków.");
  }
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows: s } = await klient.query("select 1 from stores where tenant_id = $1 and id = $2 for update", [tenantId, storeId]);
    if (!s[0]) throw new BladKlauzuli("Nie ma takiego sklepu.");
    const { rows: biez } = await klient.query(
      "select id, version, wording, privacy_url from store_consent_versions where tenant_id = $1 and store_id = $2 and superseded_at is null",
      [tenantId, storeId],
    );
    if (biez[0] && biez[0].wording === tresc && (biez[0].privacy_url ?? null) === polityka) {
      await klient.query("commit");
      return { id: biez[0].id, wersja: biez[0].version, tresc, polityka };
    }
    if (biez[0]) await klient.query("update store_consent_versions set superseded_at = now() where id = $1", [biez[0].id]);
    const { rows } = await klient.query(
      `insert into store_consent_versions (tenant_id, store_id, version, wording, privacy_url)
       values ($1, $2, coalesce((select max(version) from store_consent_versions where store_id = $2), 0) + 1, $3, $4)
       returning id, version`,
      [tenantId, storeId, tresc, polityka],
    );
    await klient.query("commit");
    return { id: rows[0].id, wersja: rows[0].version, tresc, polityka };
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}

// ── Konfiguracja dla wtyczki ─────────────────────────────────────────────────────

export interface KonfiguracjaWtyczki {
  site_key: string | null;
  script_url: string | null;
  zgoda: { wersja: number; tresc: string; polityka: string | null } | null;
  /** czy wtyczka ma pokazywać checkbox (klauzula ustawiona) */
  checkbox: boolean;
}

export async function konfiguracjaWtyczki(tenantId: string, storeId: string): Promise<KonfiguracjaWtyczki> {
  const { rows } = await getPool().query<{ id: string }>(
    "select id from site_keys where tenant_id = $1 and revoked_at is null",
    [tenantId],
  );
  const klauzula = await klauzulaCheckoutu(tenantId, storeId);
  return {
    site_key: rows[0]?.id ?? null,
    script_url: rows[0] ? `${adresSledzenia().replace(/\/+$/, "")}/js/v1/${rows[0].id}.js` : null,
    zgoda: klauzula ? { wersja: klauzula.wersja, tresc: klauzula.tresc, polityka: klauzula.polityka } : null,
    checkbox: Boolean(klauzula),
  };
}

// ── 2. Uwierzytelnienie żądań wtyczki ───────────────────────────────────────────

export interface WtyczkaUwierzytelniona {
  tenantId: string;
  storeId: string;
  baseUrl: string;
}

/** Podpis żądania wtyczki (to samo liczy PHP: base64(hmac_sha256("{ts}.{body}", sekret))). */
export function podpisWtyczki(sekret: string, ts: string, cialo: string): string {
  return createHmac("sha256", sekret).update(`${ts}.${cialo}`, "utf8").digest("base64");
}

/**
 * Sklep po id + podpis. Każda porażka = null (trasa odpowiada 401 bez rozróżniania, czy sklep
 * istnieje). Sklep odłączony (`disconnected`) nie przyjmuje zdarzeń, nawet z dobrym podpisem.
 */
export async function uwierzytelnijWtyczke(
  storeId: string,
  naglowki: Headers,
  cialo: string,
  teraz = Date.now(),
): Promise<WtyczkaUwierzytelniona | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storeId)) return null;
  const ts = naglowki.get("x-mrv-timestamp") ?? "";
  const podpis = naglowki.get("x-mrv-signature") ?? "";
  if (!/^\d{9,11}$/.test(ts) || !podpis) return null;
  if (Math.abs(teraz / 1000 - Number(ts)) > OKNO_PODPISU_S) return null;
  const { rows } = await getPool().query<{ tenant_id: string; base_url: string; status: string; credentials_encrypted: Buffer }>(
    "select tenant_id, base_url, status, credentials_encrypted from stores where id = $1 and platform = 'woocommerce'",
    [storeId],
  );
  const s = rows[0];
  if (!s || s.status === "disconnected") return null;
  let sekret: unknown;
  try {
    sekret = odszyfrujPoswiadczenia(s.credentials_encrypted).pluginSecret;
  } catch {
    return null;
  }
  if (typeof sekret !== "string" || !sekret) return null;
  const a = Buffer.from(podpis);
  const b = Buffer.from(podpisWtyczki(sekret, ts, cialo));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { tenantId: s.tenant_id, storeId, baseUrl: s.base_url };
}

// ── 3. Zdarzenia z wtyczki: faza 1 ───────────────────────────────────────────────

const tekst = (maks: number) => z.string().max(maks);
const kwota = z.union([z.string().max(32), z.number().finite()]);

const schematPozycji = z.object({
  product_id: z.union([z.string().max(64), z.number().int().nonnegative()]),
  variation_id: z.union([z.string().max(64), z.number().int().nonnegative()]).nullish(),
  name: tekst(500),
  sku: tekst(255).nullish(),
  qty: z.number().int().min(1).max(9999),
  price: kwota.nullish(),
  image: tekst(2000).nullish(),
  url: tekst(2000).nullish(),
  categories: z.array(tekst(255)).max(20).nullish(),
});

const schematKoszyka = z.object({
  token: z.string().regex(/^[A-Za-z0-9]{16,64}$/),
  pozycje: z.array(schematPozycji).max(100),
  wartosc: kwota.nullish(),
  waluta: z.string().regex(/^[A-Z]{3}$/).nullish(),
  link: tekst(2000).nullish(),
});

const schematZdarzeniaWtyczki = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
  typ: z.enum(["added_to_cart", "started_checkout", "identify", "consent"]),
  czas: z.string().max(40),
  email: tekst(320).nullish(),
  imie: tekst(255).nullish(),
  nazwisko: tekst(255).nullish(),
  telefon: tekst(40).nullish(),
  anonymous_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullish(),
  koszyk: schematKoszyka.nullish(),
  dodany: schematPozycji.nullish(),
  zgoda: z.object({ wersja: z.number().int().min(1).max(100_000), zamowienie: tekst(64).nullish() }).nullish(),
});

const schematPaczki = z.object({
  zdarzenia: z.array(schematZdarzeniaWtyczki).min(1).max(50),
  wtyczka: z.object({ wersja: tekst(40).nullish() }).nullish(),
});

export type ZdarzenieWtyczki = z.infer<typeof schematZdarzeniaWtyczki>;

export type WynikPrzyjeciaWtyczki =
  | { status: "przyjete"; nowe: number; duplikaty: number; konfiguracja: KonfiguracjaWtyczki }
  | { status: "odrzucone"; opis: string };

export async function przyjmijZdarzeniaWtyczki(auth: WtyczkaUwierzytelniona, cialo: unknown, przyjeto = new Date()): Promise<WynikPrzyjeciaWtyczki> {
  const w = schematPaczki.safeParse(cialo);
  if (!w.success) {
    const i = w.error.issues[0];
    return { status: "odrzucone", opis: `${i.path.join(".")}: ${i.message}`.slice(0, 300) };
  }
  const pool = getPool();
  const klient = await pool.connect();
  let nowe = 0;
  let duplikaty = 0;
  try {
    await klient.query("begin");
    for (const z of w.data.zdarzenia) {
      const { rows } = await klient.query<{ id: string }>(
        `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload, received_at, channel)
         values ($1, $2, $3, $4, $5::jsonb, $6, 'plugin')
         on conflict (tenant_id, store_id, source, idempotency_key) do nothing
         returning id`,
        [auth.tenantId, auth.storeId, ZRODLO_WTYCZKI, `wtyczka:${auth.storeId}:${z.id}`, JSON.stringify(z), przyjeto],
      );
      if (rows[0]) {
        nowe++;
        await dodajZadanie(auth.tenantId, RODZAJ_JOBA_WTYCZKI, { rawEventId: rows[0].id }, { przez: klient });
      } else duplikaty++;
    }
    await klient.query(
      "update stores set plugin_seen_at = now(), plugin_version = coalesce($3, plugin_version) where tenant_id = $1 and id = $2",
      [auth.tenantId, auth.storeId, w.data.wtyczka?.wersja ?? null],
    );
    await klient.query("commit");
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
  return { status: "przyjete", nowe, duplikaty, konfiguracja: await konfiguracjaWtyczki(auth.tenantId, auth.storeId) };
}

/** Ping wtyczki (strona ustawień, cron co godzinę): zdrowie połączenia + konfiguracja. */
export async function pingWtyczki(auth: WtyczkaUwierzytelniona, wersja: string | null): Promise<KonfiguracjaWtyczki> {
  await getPool().query(
    "update stores set plugin_seen_at = now(), plugin_version = coalesce($3, plugin_version) where tenant_id = $1 and id = $2",
    [auth.tenantId, auth.storeId, wersja && /^[0-9A-Za-z.+-]{1,40}$/.test(wersja) ? wersja : null],
  );
  return konfiguracjaWtyczki(auth.tenantId, auth.storeId);
}

/**
 * „Odłącz” we wtyczce: kasujemy NASZE webhooki w sklepie (póki klucz REST jeszcze działa;
 * wtyczka unieważnia go zaraz po tym), sklep dostaje status `disconnected` i nie przyjmuje
 * zdarzeń ani webhooków. Historia (zamówienia, profile, zgody) zostaje.
 */
export async function rozlaczWtyczke(auth: WtyczkaUwierzytelniona): Promise<{ usunieteWebhooki: number }> {
  let usuniete = 0;
  try {
    const { adapterSklepu } = await import("../../adapters/store/fabryka");
    const { adresDostawySklepu } = await import("../../adapters/store/webhooki");
    const { adapter, definicja } = await adapterSklepu(auth.tenantId, auth.storeId);
    if (adapter.listujWebhooki && adapter.usunWebhook && definicja.webhooki) {
      const adres = adresDostawySklepu(config().APP_URL, definicja.webhooki.sciezkaDostawy(auth.storeId));
      for (const wh of await adapter.listujWebhooki()) {
        if (wh.adresDostawy !== adres) continue;
        await adapter.usunWebhook(wh.id);
        usuniete++;
      }
    }
  } catch (b) {
    console.warn(`[wtyczka] odłączenie: webhooków nie udało się usunąć (${b instanceof Error ? b.message.replace(/(ck|cs)_[a-z0-9]+/gi, "$1_…") : "błąd"})`);
  }
  await getPool().query(
    "update stores set status = 'disconnected', last_error = 'Odłączono we wtyczce' where tenant_id = $1 and id = $2",
    [auth.tenantId, auth.storeId],
  );
  return { usunieteWebhooki: usuniete };
}

// ── 4. Zdarzenia z wtyczki: faza 2 (worker) ──────────────────────────────────────

function idPozycji(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && s !== "0" ? s.slice(0, 64) : null;
}

function adresHttp(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function pozycjaKoszyka(p: z.infer<typeof schematPozycji>, waluta: string): PozycjaKoszyka {
  const cena = p.price !== null && p.price !== undefined ? naMinor(p.price, waluta) : null;
  return {
    product_id: String(p.product_id).slice(0, 64),
    variant_id: idPozycji(p.variation_id),
    title: p.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) || `Produkt ${p.product_id}`,
    qty: p.qty,
    price_minor: cena !== null && cena >= 0n ? cena.toString() : null,
    image_url: adresHttp(p.image),
    url: adresHttp(p.url),
  };
}

function naGlowne(minor: string | null, waluta: string): number | null {
  if (minor === null) return null;
  const exp = waluta === "JPY" || waluta === "KRW" ? 0 : 2;
  return Number((Number(minor) / 10 ** exp).toFixed(exp));
}

/** Właściwości w kształcie Klaviyo (Added to Cart / Started Checkout na Woo w Klaviyo). */
function wlasciwosciKoszyka(pozycje: PozycjaKoszyka[], koszyk: { token: string; link: string | null; wartosc: string | null }, waluta: string) {
  return {
    $value: naGlowne(koszyk.wartosc, waluta),
    ItemNames: pozycje.map((p) => p.title),
    Categories: [],
    CheckoutURL: koszyk.link,
    $cart_token: koszyk.token,
    Items: pozycje.map((p) => ({
      ProductID: p.product_id,
      VariantID: p.variant_id,
      ProductName: p.title,
      Quantity: p.qty,
      ItemPrice: naGlowne(p.price_minor, waluta),
      RowTotal: p.price_minor !== null ? naGlowne(String(BigInt(p.price_minor) * BigInt(p.qty)), waluta) : null,
      ProductURL: p.url,
      ImageURL: p.image_url,
    })),
  };
}

function haszPozycji(pozycje: PozycjaKoszyka[]): string {
  return createHash("sha256")
    .update(pozycje.map((p) => `${p.product_id}:${p.variant_id ?? ""}:${p.qty}`).sort().join("|"))
    .digest("hex")
    .slice(0, 16);
}

export interface WynikPrzetworzeniaWtyczki {
  status: "zapisane" | "zidentyfikowane" | "pominiete" | "odrzucone" | "duplikat";
  powod?: string;
  profileId?: string;
}

export async function przetworzZdarzenieWtyczki(tenantId: string, rawEventId: string): Promise<WynikPrzetworzeniaWtyczki> {
  const pool = getPool();
  const { rows: pod } = await pool.query<{ received_at: Date }>(
    "select received_at from raw_events where tenant_id = $1 and id = $2 and channel = 'plugin' and processed_at is null",
    [tenantId, rawEventId],
  );
  if (!pod[0]) return { status: "pominiete" };
  await zapewnijPartycjeMiesiaca(pod[0].received_at).catch(() => {});

  const klient = await pool.connect();
  let alert: string | null = null;
  try {
    await klient.query("begin");
    const { rows } = await klient.query<{ store_id: string; payload: any; received_at: Date; processed_at: Date | null }>(
      "select store_id, payload, received_at, processed_at from raw_events where tenant_id = $1 and id = $2 and channel = 'plugin' for update",
      [tenantId, rawEventId],
    );
    const r = rows[0];
    if (!r || r.processed_at) {
      await klient.query("rollback");
      return { status: "pominiete" };
    }
    const zakoncz = async (blad: string | null, zaslep = false) => {
      await klient.query(
        `update raw_events set processed_at = now(), process_error = $3,
                payload = case when $4::boolean then jsonb_build_object('anonimizowano', true) else payload end
          where tenant_id = $1 and id = $2`,
        [tenantId, rawEventId, blad, zaslep],
      );
    };
    if (r.payload?.anonimizowano) {
      await zakoncz("anonimizowano");
      await klient.query("commit");
      return { status: "pominiete", powod: "anonimizowano" };
    }
    const w = schematZdarzeniaWtyczki.safeParse(r.payload);
    if (!w.success) {
      await zakoncz("niepoprawne:schemat");
      await klient.query("commit");
      return { status: "odrzucone", powod: "schemat" };
    }
    const z = w.data;
    const { rows: sk } = await klient.query<{ base_url: string; status: string; currency: string | null }>(
      `select s.base_url, s.status, t.currency from stores s join tenants t on t.id = s.tenant_id
        where s.tenant_id = $1 and s.id = $2`,
      [tenantId, r.store_id],
    );
    if (!sk[0]) {
      await zakoncz("sklep:nie_istnieje");
      await klient.query("commit");
      return { status: "odrzucone", powod: "sklep" };
    }
    const waluta = z.koszyk?.waluta ?? sk[0].currency ?? "PLN";
    // czas zdarzenia: z serwera sklepu, ale nie z przyszłości i nie starszy niż godzina przed
    // odebraniem (kolejka wtyczki ponawia do doby; starsze zdarzenie = backfill, nie wyzwala flow)
    const zglaszany = Date.parse(z.czas);
    const odebrano = r.received_at.getTime();
    const kiedy = new Date(Number.isFinite(zglaszany) ? Math.min(zglaszany, odebrano) : odebrano);

    const email = z.email?.trim().toLowerCase() || null;
    const ident = {
      id: null,
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null,
      telefon: null,
      externalId: null,
      anonymousId: z.anonymous_id ?? null,
    };
    let profileId: string | null = null;
    if (ident.email || ident.anonymousId) {
      if (!ident.email) {
        // sam identyfikator przeglądarki: tylko gdy midrev.js już powiązał go z osobą
        const { rows: p } = await klient.query("select id from profiles where tenant_id = $1 and anonymous_id = $2 limit 1", [tenantId, ident.anonymousId]);
        profileId = p[0]?.id ?? null;
      } else {
        // tryb „klient”: e-mail wpisany w checkoucie nie nadpisuje danych istniejącego profilu
        const wynik = await identyfikujProfil(klient, tenantId, ident, { imie: z.imie ?? null, nazwisko: z.nazwisko ?? null }, 0, { tryb: "klient" });
        if (wynik.odrzucone) {
          await zakoncz(wynik.powod === "rodo" ? "rodo:nagrobek" : `niepoprawne:${wynik.powod}`, wynik.powod === "rodo");
          await klient.query("commit");
          return { status: "odrzucone", powod: wynik.powod };
        }
        profileId = wynik.profileId;
      }
    }

    // koszyk: stan zapisujemy także dla gościa bez profilu (link i pozycje czekają na e-mail)
    let pozycje: PozycjaKoszyka[] = [];
    if (z.koszyk && (z.typ === "added_to_cart" || z.typ === "started_checkout")) {
      pozycje = z.koszyk.pozycje.map((p) => pozycjaKoszyka(p, waluta));
      const wartosc = z.koszyk.wartosc !== null && z.koszyk.wartosc !== undefined ? naMinor(z.koszyk.wartosc, waluta) : null;
      const koszyk: KoszykSklepu = {
        token: z.koszyk.token,
        etap: z.typ === "started_checkout" ? "checkout" : "cart",
        pozycje,
        wartoscMinor: wartosc !== null && wartosc >= 0n ? Number(wartosc) : null,
        waluta,
        linkPowrotu: z.koszyk.link ?? null,
        zmodyfikowaneAt: kiedy,
      };
      await zapiszKoszykSklepu(klient, {
        tenantId,
        storeId: r.store_id,
        profileId,
        email: ident.email,
        koszyk,
        hostSklepu: new URL(sk[0].base_url).hostname.replace(/^www\./, ""),
      });
    }

    if (!profileId) {
      await zakoncz(null);
      await klient.query("commit");
      return { status: "pominiete", powod: "gosc_bez_identyfikatora" };
    }

    if (z.typ === "consent") {
      if (!z.zgoda || !ident.email) {
        await zakoncz("niepoprawne:zgoda_bez_danych");
        await klient.query("commit");
        return { status: "odrzucone", powod: "zgoda" };
      }
      const { rows: v } = await klient.query<{ id: string; wording: string; privacy_url: string | null }>(
        "select id, wording, privacy_url from store_consent_versions where tenant_id = $1 and store_id = $2 and version = $3",
        [tenantId, r.store_id, z.zgoda.wersja],
      );
      if (!v[0]) {
        await zakoncz("niepoprawne:nieznana_wersja_klauzuli");
        await klient.query("commit");
        alert = `wtyczka Woo zgłosiła zgodę z nieznaną wersją klauzuli ${z.zgoda.wersja} (sklep ${r.store_id}); zgoda NIE zapisana`;
        return { status: "odrzucone", powod: "wersja" };
      }
      const zamowienie = z.zgoda.zamowienie ? `, zamówienie ${z.zgoda.zamowienie.replace(/[^\w#-]/g, "")}` : "";
      const wynik = await zapiszZgodeSklepu(klient, tenantId, profileId, {
        email: ident.email,
        stan: "granted",
        kiedy,
        zrodlo: "checkout_woocommerce",
        tresc: v[0].wording,
        storeConsentVersionId: v[0].id,
        szczegol: `checkbox w checkoucie sklepu (wtyczka MidRev)${zamowienie}, klauzula w wersji ${z.zgoda.wersja}${v[0].privacy_url ? `, polityka prywatności: ${v[0].privacy_url}` : ""}`,
      });
      await zakoncz(null);
      await klient.query("commit");
      return { status: wynik === "zapisana" ? "zapisane" : "pominiete", powod: wynik, profileId };
    }

    if (z.typ === "identify") {
      await zakoncz(null);
      await klient.query("commit");
      return { status: "zidentyfikowane", profileId };
    }

    if (!z.koszyk) {
      await zakoncz("niepoprawne:brak_koszyka");
      await klient.query("commit");
      return { status: "odrzucone", powod: "koszyk" };
    }
    const wartoscMinor = z.koszyk.wartosc !== null && z.koszyk.wartosc !== undefined ? naMinor(z.koszyk.wartosc, waluta) : null;
    const wartosc = wartoscMinor !== null && wartoscMinor >= 0n ? wartoscMinor.toString() : null;
    const bazowe = wlasciwosciKoszyka(pozycje, { token: z.koszyk.token, link: z.koszyk.link ?? null, wartosc }, waluta);
    const nazwa = z.typ === "added_to_cart" ? METRYKI_STRONY.dodanoDoKoszyka : METRYKI_STRONY.rozpoczetoZamowienie;
    let properties: Record<string, unknown> = bazowe;
    let uniqueId: string;
    if (z.typ === "added_to_cart") {
      const d = z.dodany ? pozycjaKoszyka(z.dodany, waluta) : pozycje[pozycje.length - 1];
      properties = {
        ...bazowe,
        AddedItemProductID: d?.product_id ?? null,
        AddedItemVariantID: d?.variant_id ?? null,
        AddedItemProductName: d?.title ?? null,
        AddedItemQuantity: d?.qty ?? null,
        AddedItemPrice: d ? naGlowne(d.price_minor, waluta) : null,
        AddedItemImageURL: d?.image_url ?? null,
        AddedItemURL: d?.url ?? null,
      };
      // jedno dodanie = jedno zdarzenie (id nadane przez wtyczkę); ponowienie z kolejki = duplikat
      uniqueId = `atc:${z.id}`;
    } else {
      // Started Checkout raz na token i zawartość (Klaviyo: jeden na checkout); zmiana koszyka = nowe
      uniqueId = `sc:${z.koszyk.token}:${haszPozycji(pozycje)}`;
    }
    const metryka = await metrykaPoKluczu(klient, tenantId, { integracja: "midrev", nazwa }, { utworz: true, wbudowana: true, mozeWyzwalac: true, ukryta: false });
    if (!metryka) throw new Error("metryka zachowania nie powstała");
    let zapis;
    try {
      await klient.query("savepoint zdarzenie_wtyczki");
      zapis = await zapiszZdarzenie(klient, {
        tenantId,
        metryka: { integracja: "midrev", nazwa, wbudowana: true, mozeWyzwalac: true, ukryta: false },
        profileId,
        occurredAt: kiedy,
        ingestedAt: r.received_at,
        uniqueId,
        properties,
        valueCurrency: waluta,
        source: "webhook",
      });
      await klient.query("release savepoint zdarzenie_wtyczki");
    } catch (b) {
      if (!(b instanceof BladZdarzenia)) throw b;
      await klient.query("rollback to savepoint zdarzenie_wtyczki");
      await zakoncz(`niepoprawne:${b.message}`.slice(0, 500));
      await klient.query("commit");
      return { status: "odrzucone", powod: b.message };
    }
    await zakoncz(null);
    await klient.query("commit");
    return { status: zapis.duplikat ? "duplikat" : "zapisane", profileId };
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
    if (alert) await wyslijAlert(alert, { poziom: "uwaga", tenantId });
  }
}

// ── 5. /wc-auth: „wersja podstawowa” bez wtyczki (plan B.1, decyzja D3) ───────────

/**
 * Start `/wc-auth/v1/authorize`: jednorazowy stan (purpose `wc_auth`, 30 min) przypięty do
 * tenanta i adresu sklepu. Woo po „Zatwierdź” wysyła klucze POST-em na `callback_url`
 * (WYŁĄCZNIE https, wymóg Woo) z `user_id` = nasz stan.
 */
export async function startWcAuth(tenantId: string, adresSklepu: string, userId: string | null): Promise<{ url: string }> {
  const adres = normalizujAdresSklepu(adresSklepu);
  if (!adres) throw new BladParowania("Adres sklepu musi zaczynać się od https://.", "zly_adres");
  const stan = randomBytes(24).toString("base64url");
  await getPool().query(
    `insert into store_connect_tokens (tenant_id, platform, purpose, token_hash, base_url, expires_at, created_by)
     values ($1, 'woocommerce', 'wc_auth', $2, $3, now() + interval '30 minutes', $4)`,
    [tenantId, sha256(stan), adres, userId],
  );
  const app = config().APP_URL.replace(/\/+$/, "");
  const u = new URL(`${adres}/wc-auth/v1/authorize`);
  u.searchParams.set("app_name", "MidRev ESP");
  u.searchParams.set("scope", "read_write");
  u.searchParams.set("user_id", stan);
  u.searchParams.set("return_url", `${app}/t/${tenantId}/sklepy/woocommerce?wc_auth=powrot`);
  u.searchParams.set("callback_url", `${app}/api/integracje/woocommerce/wc-auth`);
  return { url: u.toString() };
}

const schematWcAuth = z.object({
  key_id: z.union([z.number(), z.string()]).optional(),
  user_id: z.string().min(16).max(64),
  consumer_key: z.string().regex(/^ck_[a-f0-9]{40}$/),
  consumer_secret: z.string().regex(/^cs_[a-f0-9]{40}$/),
  key_permissions: z.string().max(20).optional(),
});

/** Callback `/wc-auth`: klucze od Woo → ta sama droga co ręczne klucze (metoda `wc_auth`). */
export async function przyjmijKluczeWcAuth(cialo: unknown): Promise<{ ok: true; storeId: string } | { ok: false; blad: string }> {
  const w = schematWcAuth.safeParse(cialo);
  if (!w.success) return { ok: false, blad: "niepoprawne dane" };
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; tenant_id: string; base_url: string }>(
    `update store_connect_tokens set used_at = now()
      where token_hash = $1 and purpose = 'wc_auth' and used_at is null and expires_at > now()
      returning id, tenant_id, base_url`,
    [sha256(w.data.user_id)],
  );
  const t = rows[0];
  if (!t) return { ok: false, blad: "nieważny stan" };
  // porażka zwalnia stan (review r1): administrator poprawia problem i zatwierdza ponownie
  const zwolnij = () => pool.query("update store_connect_tokens set used_at = null where id = $1 and store_id is null", [t.id]);
  if (w.data.key_permissions && w.data.key_permissions !== "read_write") {
    await zwolnij();
    return { ok: false, blad: "klucze bez prawa zapisu (webhooki wymagają read_write)" };
  }
  let wynik;
  try {
    wynik = await podlaczSklepWoo(
      t.tenant_id,
      { baseUrl: t.base_url, consumerKey: w.data.consumer_key, consumerSecret: w.data.consumer_secret },
      { metoda: "wc_auth" },
    );
  } catch (b) {
    await zwolnij();
    throw b;
  }
  if (!wynik.ok) {
    await zwolnij();
    return { ok: false, blad: wynik.blad };
  }
  await pool.query("update store_connect_tokens set store_id = $2 where id = $1", [t.id, wynik.storeId]);
  return { ok: true, storeId: wynik.storeId };
}

// ── Pomocnicze dla testów i panelu ───────────────────────────────────────────────

/** Szyfrogram poświadczeń z sekretem wtyczki (tylko testy). */
export function _poswiadczeniaZSekretem(ck: string, cs: string, pluginSecret: string): Buffer {
  return zaszyfruj(JSON.stringify({ ck, cs, webhookSecret: randomBytes(16).toString("hex"), pluginSecret }));
}
