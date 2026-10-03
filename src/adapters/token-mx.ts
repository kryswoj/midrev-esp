import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { config } from "../config";

/**
 * Token `_mx` w linkach z maili (plan 6, decyzja D5): przekierowanie `/r` dokleja go do celu
 * na domenie sklepu, a skrypt `midrev.js` na tej stronie rozpoznaje osobę, która kliknęła
 * (odpowiednik `_kx` Klaviyo).
 *
 *   - AES-256-GCM nad (tenant_id, profile_id, wystawiono): NIEPRZEZROCZYSTY. W adresie nie ma
 *     e-maila ani jawnego identyfikatora profilu, więc token w logach GA4, w historii
 *     przeglądarki czy w nagłówku Referer nie zdradza, kim jest osoba.
 *   - Weryfikowalny bez bazy, ważny 90 dni (D5). Wersja klucza w pierwszym bajcie: rotacja =
 *     nowa wersja, stara odrzucana po wycofaniu.
 *   - Klucz pochodny (HMAC) od SECRETS_KEY z osobnym przeznaczeniem: bez nowej zmiennej
 *     środowiskowej na produkcji, a i tak inny niż klucz szyfrowania poświadczeń.
 *   - Token daje wyłącznie ZAPIS zdarzeń w imieniu osoby przez klucz publiczny strony
 *     (tak samo jak znajomość jej e-maila). Niczego nie odczytuje.
 *
 * Format: base64url( wersja(1) | iv(12) | tag(16) | szyfrogram(36) ) = 65 B → 87 znaków.
 */

const WERSJA = 1;
const PRZEZNACZENIE = "midrev-esp:token-mx:v1";
export const WAZNOSC_TOKENU_MX_S = 90 * 24 * 3600;
/** zegar przeglądarki/serwera: token „z przyszłości” dalej niż o tyle = podróbka */
const TOLERANCJA_PRZYSZLOSCI_S = 300;
export const WZOR_TOKENU_MX = /^[A-Za-z0-9_-]{87}$/;

let kluczPamiec: Buffer | undefined;

function kluczDomyslny(): Buffer {
  if (!kluczPamiec) {
    kluczPamiec = createHmac("sha256", Buffer.from(config().SECRETS_KEY, "hex")).update(PRZEZNACZENIE).digest();
  }
  return kluczPamiec;
}

function uuidNaBajty(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("niepoprawny uuid");
  return Buffer.from(hex, "hex");
}

function bajtyNaUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function wystawTokenMx(
  dane: { tenantId: string; profileId: string },
  teraz = Date.now(),
  klucz: Buffer = kluczDomyslny(),
): string {
  const jawne = Buffer.alloc(36);
  uuidNaBajty(dane.tenantId).copy(jawne, 0);
  uuidNaBajty(dane.profileId).copy(jawne, 16);
  jawne.writeUInt32BE(Math.floor(teraz / 1000), 32);
  const iv = randomBytes(12);
  const naglowek = Buffer.from([WERSJA]);
  const szyfr = createCipheriv("aes-256-gcm", klucz, iv);
  szyfr.setAAD(naglowek);
  const zaszyfrowane = Buffer.concat([szyfr.update(jawne), szyfr.final()]);
  return Buffer.concat([naglowek, iv, szyfr.getAuthTag(), zaszyfrowane]).toString("base64url");
}

export interface DaneTokenuMx {
  tenantId: string;
  profileId: string;
  wystawiono: Date;
}

/** null = token zły, podrobiony, z innej wersji klucza, wygasły albo z przyszłości. */
export function odczytajTokenMx(token: unknown, teraz = Date.now(), klucz: Buffer = kluczDomyslny()): DaneTokenuMx | null {
  if (typeof token !== "string" || !WZOR_TOKENU_MX.test(token)) return null;
  const b = Buffer.from(token, "base64url");
  if (b.length !== 65 || b[0] !== WERSJA) return null;
  try {
    const deszyfr = createDecipheriv("aes-256-gcm", klucz, b.subarray(1, 13));
    deszyfr.setAAD(b.subarray(0, 1));
    deszyfr.setAuthTag(b.subarray(13, 29));
    const jawne = Buffer.concat([deszyfr.update(b.subarray(29)), deszyfr.final()]);
    const wystawionoS = jawne.readUInt32BE(32);
    const terazS = Math.floor(teraz / 1000);
    if (wystawionoS > terazS + TOLERANCJA_PRZYSZLOSCI_S) return null;
    if (terazS - wystawionoS > WAZNOSC_TOKENU_MX_S) return null;
    return {
      tenantId: bajtyNaUuid(jawne.subarray(0, 16)),
      profileId: bajtyNaUuid(jawne.subarray(16, 32)),
      wystawiono: new Date(wystawionoS * 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Czy host celu kliknięcia należy do domen strony tenanta (`site_keys.link_domains`).
 * Dopasowanie: dokładnie domena albo jej subdomena (`sklep.pl` obejmuje `www.sklep.pl`),
 * nigdy sufiks napisu (`zlysklep.pl` NIE pasuje do `sklep.pl`).
 */
export function hostWDomenach(host: string, domeny: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return domeny.some((d) => {
    const dd = d.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    return dd.length > 0 && (h === dd || h.endsWith("." + dd));
  });
}

/**
 * Cel kliknięcia z doklejonym `_mx`. Tylko http(s) na domenie tenanta; poprzedni `_mx`
 * (np. wklejony do treści maila) jest zastępowany, nie dublowany. Fragment (#) zostaje.
 */
export function celZTokenemMx(cel: string, token: string, domeny: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(cel);
  } catch {
    return null;
  }
  // tylko https: token działa jak poświadczenie (90 dni), po http wyciekłby w sieci i proxy
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (!hostWDomenach(u.hostname, domeny)) return null;
  u.searchParams.delete("_mx");
  u.searchParams.append("_mx", token);
  return u.toString();
}
