// Wspolne dla globalSetup i setup-env: skad testy biora adres bazy i czego im nie wolno.
// Nie jest to plik testowy (brak *.test.ts), vitest go nie uruchamia sam.
//
// Testy NIGDY nie chodza na bazie deweloperskiej: tam pracuje serwer :3005 i zywy worker,
// ktory obslugiwal testowe sklepy, a testy zostawialy w panelu smieciowych tenantow.
// Osobna baza `midrev_esp_test` w tym samym kontenerze Postgresa.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KATALOG_PROJEKTU = join(import.meta.dirname, "..");

/** Domyslny adres bazy testowej w sandboxie (docker-compose.yml, port 5433). */
export const DOMYSLNA_BAZA_TESTOWA = "postgresql://midrev:midrev@localhost:5433/midrev_esp_test";

/** Pary klucz=wartosc z .env, bez nadpisywania czegokolwiek w process.env. */
export function odczytajPlikEnv(): Map<string, string> {
  const pary = new Map<string, string>();
  const sciezka = join(KATALOG_PROJEKTU, ".env");
  if (!existsSync(sciezka)) return pary;
  for (const linia of readFileSync(sciezka, "utf-8").split("\n")) {
    const przyciete = linia.trim();
    if (!przyciete || przyciete.startsWith("#")) continue;
    const eq = przyciete.indexOf("=");
    if (eq === -1) continue;
    pary.set(przyciete.slice(0, eq).trim(), przyciete.slice(eq + 1).trim());
  }
  return pary;
}

/**
 * Adres bazy testowej: TEST_DATABASE_URL ze srodowiska, potem z .env, potem domyslny
 * adres sandboxa. Celowo NIE wyprowadzamy go z DATABASE_URL (dopisujac `_test`): przy
 * DATABASE_URL wskazujacym na produkcje globalSetup zakladalby baze na serwerze produkcji.
 */
export function adresBazyTestowej(): string {
  return process.env.TEST_DATABASE_URL || odczytajPlikEnv().get("TEST_DATABASE_URL") || DOMYSLNA_BAZA_TESTOWA;
}

/** Nazwa bazy z adresu postgresql://... (bez parametrow zapytania). */
export function nazwaBazy(adres: string): string {
  let url: URL;
  try {
    url = new URL(adres);
  } catch {
    throw new Error("Adres bazy testowej nie jest poprawnym URL-em postgresql://");
  }
  return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
}

/**
 * Twarde zabezpieczenie: testy czyszcza tabele (delete from tenants ...), wiec baza bez
 * sufiksu `_test` = odmowa startu. Komunikat pokazuje nazwe bazy, nigdy hasla z adresu.
 */
export function wymagajBazyTestowej(adres: string | undefined, skad: string): string {
  if (!adres) {
    throw new Error(`[testy] ${skad}: brak DATABASE_URL - testy nie wiedza, na jakiej bazie maja chodzic.`);
  }
  const nazwa = nazwaBazy(adres);
  if (!/^[a-z0-9_]+_test$/.test(nazwa)) {
    throw new Error(
      `[testy] ODMOWA STARTU (${skad}): DATABASE_URL wskazuje na baze "${nazwa || "(brak nazwy)"}", ` +
        `a testy wolno uruchamiac wylacznie na bazie z sufiksem "_test". ` +
        `Testy kasuja dane - na bazie deweloperskiej albo produkcyjnej zniszczylyby je. ` +
        `Ustaw TEST_DATABASE_URL na baze *_test (domyslnie ${nazwaBazy(DOMYSLNA_BAZA_TESTOWA)}).`,
    );
  }
  return adres;
}
