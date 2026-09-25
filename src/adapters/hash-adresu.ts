import { createHmac } from "node:crypto";
import { config } from "../config";

/**
 * Kluczowany hasz adresu e-mail do globalnej listy wykluczen (migracja 0022).
 *
 * HMAC-SHA256 kluczem SUPPRESSION_HASH_KEY. Gdy go nie ma (sandbox), klucz pochodny
 * od SECRETS_KEY - z ostrzezeniem, bo rotacja SECRETS_KEY uniewaznilaby wtedy
 * wszystkie zaslepki po anonimizacji RODO (produkcja bez wlasnego klucza nie startuje,
 * patrz config.ts). Adres jest normalizowany tak samo jak w bazie: `lower(btrim())`
 * po stronie SQL, a tutaj tylko domykajaco (JS `trim` zdejmuje wiecej niz PG `btrim`,
 * np. NBSP, wiec wartosc do hasza ma przychodzic juz z bazy albo przejsc przez
 * `znormalizujAdres` po obu stronach tak samo).
 */
const PRZEZNACZENIE = "midrev-esp:suppressions:email-hash:v1";

let kluczPochodny: Buffer | undefined;
let ostrzezono = false;

function klucz(): Buffer {
  if (!kluczPochodny) {
    const c = config();
    if (c.SUPPRESSION_HASH_KEY) {
      kluczPochodny = Buffer.from(c.SUPPRESSION_HASH_KEY, "hex");
    } else {
      if (!ostrzezono) {
        ostrzezono = true;
        console.warn(
          "[hash-adresu] brak SUPPRESSION_HASH_KEY - hasze wykluczen liczone kluczem pochodnym od SECRETS_KEY; rotacja SECRETS_KEY uniewazni zaslepki RODO",
        );
      }
      kluczPochodny = createHmac("sha256", Buffer.from(c.SECRETS_KEY, "hex")).update(PRZEZNACZENIE).digest();
    }
  }
  return kluczPochodny;
}

/** Czy hasze liczone sa kluczem pochodnym (brak wlasnego klucza). Skrypt backfillu odmawia wtedy pracy. */
export function kluczPochodnyOdSekretow(): boolean {
  return !config().SUPPRESSION_HASH_KEY;
}

/** Ta sama normalizacja co `lower(btrim(email))` w SQL dla zwyklych spacji; NBSP/tab zdejmowane dodatkowo. */
export function znormalizujAdres(email: string): string {
  return email.replace(/^[\s ]+|[\s ]+$/g, "").toLowerCase();
}

export function hashAdresu(email: string): string {
  return createHmac("sha256", klucz()).update(znormalizujAdres(email), "utf8").digest("hex");
}

export function hasheAdresow(emaile: Array<string | null | undefined>): string[] {
  return emaile.filter((e): e is string => typeof e === "string" && e.length > 0).map(hashAdresu);
}

/** Zaslepka wpisywana w `suppressions.email` po anonimizacji: bez adresu, ale unikalna. */
export function zaslepkaWykluczenia(hash: string): string {
  return `anonimizowano:${hash.slice(0, 16)}`;
}
