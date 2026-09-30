import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config";

/**
 * Klucze API tenantów (0032, plan 2.2).
 *
 * Klucz: `mrv_pk_` + 32 losowe bajty w base62 (43 znaki), pokazany RAZ przy utworzeniu.
 * W bazie leży tylko HMAC-SHA256(API_KEY_PEPPER, klucz). Hash, nie szyfrowanie: klucza
 * nigdy nie odtwarzamy. Wysoka entropia = bcrypt/argon nic nie dodają, a spowolniłyby
 * każde żądanie API.
 *
 * Sandbox bez API_KEY_PEPPER: pieprz pochodny od SECRETS_KEY (poza sandboksem config
 * odmawia startu bez własnego pieprzu).
 */

const PRZEDROSTEK = "mrv_pk_";
const DLUGOSC_CIALA = 43;
const ALFABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PRZEZNACZENIE = "midrev-esp:api-keys:pepper:v1";
export const WZOR_KLUCZA = /^mrv_pk_[0-9A-Za-z]{43}$/;

let pieprz: Buffer | undefined;

function klucz(): Buffer {
  if (!pieprz) {
    const c = config();
    pieprz = c.API_KEY_PEPPER
      ? Buffer.from(c.API_KEY_PEPPER, "hex")
      : createHmac("sha256", Buffer.from(c.SECRETS_KEY, "hex")).update(PRZEZNACZENIE).digest();
  }
  return pieprz;
}

function base62(bajty: Buffer): string {
  let n = BigInt("0x" + bajty.toString("hex"));
  let wynik = "";
  while (n > 0n) {
    wynik = ALFABET[Number(n % 62n)] + wynik;
    n /= 62n;
  }
  return wynik.padStart(DLUGOSC_CIALA, "0");
}

/** Nowy klucz: jawny tekst (do jednorazowego pokazania), prefiks do UI/logów i hash do bazy. */
export function wygenerujKluczApi(): { jawny: string; prefiks: string; hash: Buffer } {
  const jawny = PRZEDROSTEK + base62(randomBytes(32));
  return { jawny, prefiks: jawny.slice(0, PRZEDROSTEK.length + 5), hash: hashKluczaApi(jawny) };
}

export function hashKluczaApi(jawny: string): Buffer {
  return createHmac("sha256", klucz()).update(jawny, "utf8").digest();
}

/** Porównanie w stałym czasie (dla testów i ewentualnych porównań poza indeksem bazy). */
export function tenSamHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Klucz z nagłówka `Authorization`: `Klaviyo-API-Key <klucz>` (jak Klaviyo, credential
 * n8n) albo `Bearer <klucz>`. Klucz NIGDY z query stringa (trafia do logów proxy).
 * Zwraca null przy braku albo złym formacie (401 bez zapytania do bazy).
 */
export function kluczZNaglowka(naglowek: string | null): string | null {
  if (!naglowek) return null;
  const m = /^\s*(?:Klaviyo-API-Key|Bearer)\s+(\S+)\s*$/i.exec(naglowek);
  if (!m) return null;
  return WZOR_KLUCZA.test(m[1]) ? m[1] : null;
}
