import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";

/**
 * Token zapisu cząstkowego formularza. Krok z e-mailem (profil + zgoda) oddaje przeglądarce
 * podpisany token; kolejne kroki („podaj telefon”, „co Cię interesuje”) uzupełniają TEN SAM
 * profil, nie wysyłając ponownie adresu i nie tworząc nowej zgody.
 *
 * Token wiąże formularz i profil, ma ważność 2 h i podpis HMAC-SHA256 kluczem pochodnym od
 * SECRETS_KEY (osobne przeznaczenie, więc nie da się go użyć jako innego podpisu). Bez
 * ważnego tokenu kolejny krok nie zmieni żadnego profilu, a token z formularza A nie działa
 * na formularzu B.
 */

const PRZEZNACZENIE = "midrev-esp:formularze:token-kroku:v1";
export const WAZNOSC_TOKENU_MS = 2 * 60 * 60 * 1000;

let klucz: Buffer | undefined;
function kluczPodpisu(): Buffer {
  if (!klucz) klucz = createHmac("sha256", Buffer.from(config().SECRETS_KEY, "hex")).update(PRZEZNACZENIE).digest();
  return klucz;
}

function podpis(tresc: string): string {
  return createHmac("sha256", kluczPodpisu()).update(tresc, "utf8").digest("base64url");
}

export function wystawToken(formId: string, profileId: string, teraz = Date.now()): string {
  const tresc = Buffer.from(JSON.stringify({ f: formId, p: profileId, e: teraz + WAZNOSC_TOKENU_MS }), "utf8").toString("base64url");
  return `${tresc}.${podpis(tresc)}`;
}

/** Profil z tokenu albo null (zły podpis, inny formularz, po terminie, śmieci). */
export function sprawdzToken(token: unknown, formId: string, teraz = Date.now()): string | null {
  if (typeof token !== "string" || token.length > 400) return null;
  const [tresc, sygnatura, nadmiar] = token.split(".");
  if (!tresc || !sygnatura || nadmiar !== undefined) return null;
  const oczekiwany = Buffer.from(podpis(tresc));
  const podany = Buffer.from(sygnatura);
  if (oczekiwany.length !== podany.length || !timingSafeEqual(oczekiwany, podany)) return null;
  try {
    const dane = JSON.parse(Buffer.from(tresc, "base64url").toString("utf8")) as { f?: unknown; p?: unknown; e?: unknown };
    if (dane.f !== formId || typeof dane.p !== "string" || typeof dane.e !== "number" || dane.e < teraz) return null;
    return dane.p;
  } catch {
    return null;
  }
}
