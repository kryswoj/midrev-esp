import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Hasla przez scrypt z node:crypto (zero zaleznosci). Scrypt jest pamieciozerny,
// wiec atak slownikowy na GPU/ASIC placi pamiecia, nie tylko cyklami - dokladnie
// to, czego wymaga notatka Story 1.4 ("algorytm pamieciozerny").
//
// Parametry wg zalecen OWASP dla scrypt: N=2^17, r=8, p=1, klucz 64 B.
// Koszt pojedynczej weryfikacji to ok. 100-200 ms i 128 MB pamieci - duzo jak na
// serwer HTTP, ale logowanie to operacja rzadka, a to jest panel z danymi
// osobowymi klientow sklepow. Parametry sa zapisane w kazdym hashu, wiec ich
// przyszla zmiana nie uniewaznia istniejacych hasel.

const LOG2_N = 17;
const R = 8;
const P = 1;
const DLUGOSC_KLUCZA = 64;
const DLUGOSC_SOLI = 16;

// node:crypto domyslnie ogranicza scrypt do 32 MB; bez podniesienia limitu
// N=2^17 konczy sie bledem "memory limit exceeded"
function limitPamieci(n: number, r: number): number {
  return 128 * n * r * 2;
}

function scryptAsync(
  haslo: string,
  sol: Buffer,
  n: number,
  r: number,
  p: number,
  dlugosc: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(haslo, sol, dlugosc, { N: n, r, p, maxmem: limitPamieci(n, r) }, (blad, klucz) => {
      if (blad) reject(blad);
      else resolve(klucz);
    });
  });
}

/**
 * Format: scrypt$log2N$r$p$sol(base64url)$klucz(base64url).
 * Sola losowa per hash: dwa identyczne hasla daja rozne hashe, wiec tablica
 * teczowa policzona raz nie otwiera wszystkich kont naraz.
 */
export async function zahaszujHaslo(haslo: string): Promise<string> {
  const sol = randomBytes(DLUGOSC_SOLI);
  const klucz = await scryptAsync(haslo, sol, 2 ** LOG2_N, R, P, DLUGOSC_KLUCZA);
  return ["scrypt", LOG2_N, R, P, sol.toString("base64url"), klucz.toString("base64url")].join("$");
}

export async function zweryfikujHaslo(haslo: string, hash: string): Promise<boolean> {
  const czesci = hash.split("$");
  if (czesci.length !== 6 || czesci[0] !== "scrypt") return false;
  const log2n = Number(czesci[1]);
  const r = Number(czesci[2]);
  const p = Number(czesci[3]);
  // granice odrzucaja uszkodzony rekord, zanim scrypt dostanie absurdalne N,
  // ktore zamieniloby weryfikacje w atak DoS na wlasny serwer
  if (!Number.isInteger(log2n) || log2n < 10 || log2n > 20) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32) return false;
  if (!Number.isInteger(p) || p < 1 || p > 16) return false;

  const sol = Buffer.from(czesci[4], "base64url");
  const oczekiwany = Buffer.from(czesci[5], "base64url");
  if (sol.length === 0 || oczekiwany.length === 0) return false;

  const policzony = await scryptAsync(haslo, sol, 2 ** log2n, r, p, oczekiwany.length);
  // porownanie w stalym czasie: zwykle Buffer.equals konczy na pierwszej roznicy
  // i czas odpowiedzi zdradza, ile bajtow sie zgadza
  return policzony.length === oczekiwany.length && timingSafeEqual(policzony, oczekiwany);
}
