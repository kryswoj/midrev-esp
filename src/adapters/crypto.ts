import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config";

// Poświadczenia sklepów szyfrowane w spoczynku (AD-13, NFR7). Wyciek zrzutu bazy
// kompromituje sklep klienta, nie tylko nas.

const ALGORYTM = "aes-256-gcm";

export function zaszyfruj(jawny: string): Buffer {
  const klucz = Buffer.from(config().SECRETS_KEY, "hex");
  const iv = randomBytes(12);
  const szyfr = createCipheriv(ALGORYTM, klucz, iv);
  const dane = Buffer.concat([szyfr.update(jawny, "utf8"), szyfr.final()]);
  return Buffer.concat([iv, szyfr.getAuthTag(), dane]);
}

export function odszyfruj(szyfrogram: Buffer): string {
  const klucz = Buffer.from(config().SECRETS_KEY, "hex");
  const iv = szyfrogram.subarray(0, 12);
  const tag = szyfrogram.subarray(12, 28);
  const dane = szyfrogram.subarray(28);
  const deszyfr = createDecipheriv(ALGORYTM, klucz, iv);
  deszyfr.setAuthTag(tag);
  return deszyfr.update(dane, undefined, "utf8") + deszyfr.final("utf8");
}

/**
 * Opakowanie na sekret. Bez tego łatwo wrzucić poświadczenia do logu przez zwykłe
 * `console.log(obiekt)` albo `JSON.stringify`. Tutaj obie drogi dają gwiazdki.
 */
export class Sekret {
  #wartosc: string;
  constructor(wartosc: string) {
    this.#wartosc = wartosc;
  }
  ujawnij(): string {
    return this.#wartosc;
  }
  toString(): string {
    return "[sekret]";
  }
  toJSON(): string {
    return "[sekret]";
  }
}
