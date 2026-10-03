import { getPool } from "../../adapters/db/pool";
import { celZTokenemMx, hostWDomenach, wystawTokenMx } from "../../adapters/token-mx";
import { zgodyNaSledzenie } from "../wysylka/zgody";
import { kluczStronyTenanta } from "./klucz-strony";

/**
 * Decyzja D5: przekierowanie `/r` dokleja `_mx` (token identyfikacji, 90 dni) do celu
 * kliknięcia WYŁĄCZNIE gdy:
 *   - tenant ma aktywny klucz strony z włączonym „rozpoznawaniem z linków”,
 *   - host celu należy do domen strony tenanta (nigdy obce domeny: token nie wycieka do
 *     cudzych serwisów linkowanych w newsletterze),
 *   - wiadomość ma profil i ten profil ma zgodę na śledzenie kliknięć (polityka tenanta),
 *   - profil nie jest zanonimizowany (RODO).
 * W adresie nie ma e-maila ani jawnego id profilu (token AES-GCM). Każdy błąd = cel bez
 * zmian: identyfikacja to dodatek, kliknięcie nie może przez nią przestać działać.
 */
export async function celZIdentyfikacja(tenantId: string, profileId: string | null, cel: string, teraz = Date.now()): Promise<string> {
  if (!profileId) return cel;
  try {
    const klucz = await kluczStronyTenanta(tenantId);
    if (!klucz || !klucz.identyfikacjaZLinkow || klucz.domeny.length === 0) return cel;
    if (!hostWDomenach(new URL(cel).hostname, klucz.domeny)) return cel;
    const pool = getPool();
    const zgody = await zgodyNaSledzenie(pool, tenantId, profileId);
    if (!zgody.klikniecia) return cel;
    const { rows } = await pool.query<{ jest: boolean }>(
      `select exists (select 1 from profiles where tenant_id = $1 and id = $2 and email is not null) as jest`,
      [tenantId, profileId],
    );
    if (!rows[0]?.jest) return cel;
    return celZTokenemMx(cel, wystawTokenMx({ tenantId, profileId }, teraz), klucz.domeny) ?? cel;
  } catch (b) {
    console.warn(`[r] token _mx pominięty: ${b instanceof Error ? b.message : "błąd"}`);
    return cel;
  }
}
