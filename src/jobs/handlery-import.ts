import { wykonajImport } from "../usecases/import-klaviyo/wykonaj";
import type { Zadanie } from "./kolejka";

/**
 * Handler importu z Klaviyo do wpiecia w mape HANDLERY workera (worker.ts nalezy do
 * innego wlasciciela - ten sam wzorzec co handlery-automatyzacje.ts):
 *
 *   import { HANDLERY_IMPORTU } from "./handlery-import";
 *   const HANDLERY = { ...HANDLERY_AUTOMATYZACJI, ...HANDLERY_IMPORTU, ... };
 *
 * Idempotentny (at-least-once, AD-5): wykonajImport przejmuje przebieg tylko ze statusu
 * planned/running/failed, a kazdy zapis jest upsertem albo insertem chronionym
 * unikalnoscia. Ponowienie po padzie workera dopisuje tylko to, czego brakuje.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const HANDLERY_IMPORTU: Record<string, (z: Zadanie) => Promise<void>> = {
  async import_klaviyo(z) {
    const jobId = String(z.payload.jobId ?? "");
    if (!UUID.test(jobId)) throw new Error(`import_klaviyo: brak poprawnego jobId w payloadzie`);
    const wynik = await wykonajImport(z.tenant_id, jobId);
    if (!wynik) {
      // przebieg juz zamkniety (done) albo nie istnieje: nic do zrobienia, bez bledu
      console.log(`[import] tenant ${z.tenant_id}: przebieg ${jobId} pominięty (już zakończony albo nie istnieje)`);
      return;
    }
    // log mowi, co licza liczniki: zgody z rowCount (faktyczny INSERT) i z odczytu zwrotnego
    console.log(
      `[import] tenant ${z.tenant_id}: przebieg ${jobId} zakończony w ${wynik.trwaloSek}s; wierszy ${wynik.wierszy}, ` +
        `profile nowe ${wynik.profileNowe}, zaktualizowane ${wynik.profileZaktualizowane}, zgody nadane ${wynik.zgodyNadane} ` +
        `(już były ${wynik.zgodyJuzByly}), pominięte przez supresję globalną ${wynik.pominieteGlobalnie}, błędy ${wynik.bledy}; ` +
        `odczyt zwrotny: zgody z przebiegu ${wynik.odczyt?.zgodyZTegoPrzebiegu ?? "?"}`,
    );
  },
};
