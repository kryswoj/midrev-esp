import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { FormatObrazu } from "./format";

/**
 * Składowanie plików biblioteki obrazów: <cwd>/var/obrazy/{tenantId}/{id}.{ext}.
 *
 * Ścieżka powstaje WYŁĄCZNIE z identyfikatorów nadanych przez serwer (UUID tenanta i
 * obrazu, sprawdzone wyrażeniem) oraz z rozszerzenia z zamkniętej listy. Nazwa pliku od
 * użytkownika nigdy tu nie trafia, więc „../../.env" nie ma jak stać się ścieżką.
 * Dodatkowo wynik jest sprawdzany, czy leży pod katalogiem biblioteki — pas i szelki.
 *
 * `var/` jest w .gitignore. Panel i worker chodzą z tego samego katalogu repo.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATY: readonly FormatObrazu[] = ["png", "jpg", "gif", "webp"];

export function katalogObrazow(): string {
  return resolve(process.cwd(), "var", "obrazy");
}

export function sciezkaObrazu(tenantId: string, id: string, ext: string): string {
  if (!UUID.test(tenantId) || !UUID.test(id)) throw new Error("niepoprawny identyfikator obrazu");
  if (!FORMATY.includes(ext as FormatObrazu)) throw new Error("niepoprawne rozszerzenie obrazu");
  const baza = katalogObrazow();
  const sciezka = join(baza, tenantId.toLowerCase(), `${id.toLowerCase()}.${ext}`);
  if (!sciezka.startsWith(baza + sep)) throw new Error("ścieżka obrazu poza katalogiem biblioteki");
  return sciezka;
}

/**
 * Zapis atomowy: najpierw plik tymczasowy obok, potem rename. Trasa publiczna nigdy nie
 * zobaczy pliku w połowie zapisu, a przerwany zapis nie zostawia pliku pod właściwą nazwą.
 */
export async function zapiszPlikObrazu(sciezka: string, bajty: Uint8Array): Promise<void> {
  await mkdir(dirname(sciezka), { recursive: true, mode: 0o700 });
  const tymczasowy = `${sciezka}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tymczasowy, bajty, { mode: 0o600, flag: "wx" });
    await rename(tymczasowy, sciezka);
  } catch (blad) {
    await rm(tymczasowy, { force: true });
    throw blad;
  }
}

export async function czytajPlikObrazu(sciezka: string): Promise<Buffer | null> {
  try {
    return await readFile(sciezka);
  } catch {
    return null;
  }
}

export async function usunPlikObrazu(sciezka: string): Promise<void> {
  await rm(sciezka, { force: true });
}
