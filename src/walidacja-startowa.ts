import { existsSync } from "node:fs";
import { join } from "node:path";
import { config, opisKonfiguracji, type Konfiguracja } from "./config";

/**
 * Walidacja środowiska przy STARCIE procesu (panel: src/instrumentation.ts, worker:
 * src/jobs/worker.ts). Bez niej panel startował bez DATABASE_URL i padał dopiero na
 * pierwszym żądaniu, a worker wklejał do maili domyślny adres po gołym IP.
 *
 * JEDEN sposób ładowania środowiska na produkcji: plik podany w systemd
 * `EnvironmentFile=` (ten sam dla unitu panelu i workera). Pliki `.env*` w katalogu
 * aplikacji są poza sandboksem ZABRONIONE, bo każdy proces czyta je inaczej: Next
 * wczytuje sam `.env`, `.env.local`, `.env.production` i `.env.production.local`,
 * a worker (node) nie wczytuje żadnego, chyba że dostanie `--env-file`. Zmienna
 * wpisana do `.env.production` trafiała do panelu, a worker jechał na domyślnych
 * wartościach, bez żadnego błędu (audyt 28.09, P0-3).
 */
export const PLIKI_ENV_ZABRONIONE_POZA_SANDBOKSEM = [".env", ".env.local", ".env.production", ".env.production.local"];

export interface WynikWalidacji {
  opis: string;
}

export function sprawdzSrodowiskoStartowe(
  proces: "panel" | "worker",
  katalog = process.cwd(),
  // wstrzykiwana w testach; domyślnie konfiguracja procesu, która rzuca z nazwą zmiennej
  // (nigdy z wartością), gdy jest niekompletna albo niebezpieczna poza sandboksem
  k: Konfiguracja = config(),
): WynikWalidacji {
  if (!k.MIDREV_SANDBOX) {
    // turbopackIgnore: ścieżka z cwd procesu, nie zasób do dołączenia do buildu
    const znalezione = PLIKI_ENV_ZABRONIONE_POZA_SANDBOKSEM.filter((p) => existsSync(join(/*turbopackIgnore: true*/ katalog, p)));
    if (znalezione.length) {
      throw new Error(
        `Konfiguracja niebezpieczna — w katalogu aplikacji leżą pliki ${znalezione.join(", ")}. ` +
          `Na produkcji środowisko idzie WYŁĄCZNIE z pliku systemd EnvironmentFile= (ten sam dla panelu i workera); ` +
          `pliki .env* czyta tylko Next, więc panel i worker rozjechałyby się po cichu. Usuń je albo przenieś wartości do EnvironmentFile.`,
      );
    }
  }
  return { opis: `[${proces}] ${k === config() ? opisKonfiguracji() : "konfiguracja wstrzyknięta"}` };
}

/**
 * Start panelu (wołane z src/instrumentation.ts, wyłącznie w runtime nodejs). Na buildzie
 * produkcyjnym zła konfiguracja kończy proces (systemd zobaczy błąd i nie uzna panelu za
 * działający). W `next dev` zostaje wyjątek: nie zabijamy serwera, który ktoś ogląda.
 */
export function zweryfikujStartPanelu(): void {
  try {
    const { opis } = sprawdzSrodowiskoStartowe("panel");
    console.log(`${opis} — konfiguracja poprawna`);
  } catch (blad) {
    console.error(`[panel] START ODRZUCONY: ${blad instanceof Error ? blad.message : String(blad)}`);
    // NODE_ENV z procesu wprost: config() właśnie rzucił, więc nie da się go czytać
    if (process.env.NODE_ENV === "production") process.exit(1);
    throw blad;
  }
}
