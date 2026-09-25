import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Skladowanie wgranych plikow importu.
 *
 * Sciezka na dysku jest budowana WYLACZNIE z identyfikatorow nadanych przez baze
 * (tenant_id, id przebiegu), nigdy z nazwy pliku od uzytkownika. Nazwa od uzytkownika
 * jest odkazona i sluzy tylko do wyswietlenia. Dzieki temu "../../.env" w nazwie pliku
 * nie ma jak stac sie sciezka.
 *
 * Katalog: <cwd>/var/importy. Worker i panel chodza z tego samego katalogu repo, wiec
 * plik wgrany przez panel jest widoczny dla workera bez dodatkowej konfiguracji.
 */

export const MAKS_ROZMIAR_PLIKU = 50 * 1024 * 1024;
export type RodzajPliku = "profiles" | "suppressions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function katalogImportow(): string {
  return resolve(process.cwd(), "var", "importy");
}

export function sciezkaPliku(tenantId: string, jobId: string, rodzaj: RodzajPliku): string {
  if (!UUID.test(tenantId) || !UUID.test(jobId)) throw new Error("niepoprawny identyfikator pliku importu");
  return join(katalogImportow(), tenantId.toLowerCase(), `${jobId.toLowerCase()}-${rodzaj}.csv`);
}

/** Nazwa do wyswietlenia: sama nazwa bazowa, bezpieczne znaki, ograniczona dlugosc. */
export function odkazNazwePliku(surowa: string | null | undefined): string {
  const baza = String(surowa ?? "").split(/[\\/]/).pop() ?? "";
  const czysta = baza.replace(/[^\p{L}\p{N}._ -]/gu, "").trim().slice(0, 120);
  return czysta || "plik.csv";
}

/**
 * Zapis strumienia do pliku z twardym limitem rozmiaru. Przekroczenie limitu przerywa
 * zapis i kasuje czesciowy plik: nie ma stanu "za duzy plik lezy na dysku".
 */
export async function zapiszStrumien(
  zrodlo: AsyncIterable<Uint8Array>,
  sciezka: string,
  limit = MAKS_ROZMIAR_PLIKU,
): Promise<{ ok: true; rozmiar: number } | { ok: false; powod: "za_duzy" | "pusty" }> {
  await mkdir(dirname(sciezka), { recursive: true });
  const zapis = createWriteStream(sciezka, { flags: "w", mode: 0o600 });
  let rozmiar = 0;
  let przekroczony = false;
  try {
    for await (const kawalek of zrodlo) {
      rozmiar += kawalek.byteLength;
      if (rozmiar > limit) {
        przekroczony = true;
        break;
      }
      if (!zapis.write(kawalek)) {
        await new Promise<void>((res, rej) => {
          zapis.once("drain", res);
          zapis.once("error", rej);
        });
      }
    }
  } finally {
    await new Promise<void>((res, rej) => zapis.end((blad: unknown) => (blad ? rej(blad) : res())));
  }
  if (przekroczony) {
    await rm(sciezka, { force: true });
    return { ok: false, powod: "za_duzy" };
  }
  if (rozmiar === 0) {
    await rm(sciezka, { force: true });
    return { ok: false, powod: "pusty" };
  }
  return { ok: true, rozmiar };
}

export function otworzPlik(sciezka: string): AsyncIterable<Uint8Array> {
  return createReadStream(sciezka, { highWaterMark: 256 * 1024 });
}

export async function plikIstnieje(sciezka: string): Promise<boolean> {
  try {
    const s = await stat(sciezka);
    return s.isFile();
  } catch {
    return false;
  }
}

export async function usunPlik(sciezka: string): Promise<void> {
  await rm(sciezka, { force: true });
}
