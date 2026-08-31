import { AdapterWoo, type PoswiadczeniaWoo } from "../adapters/store/woo/adapter";
import { zaszyfruj } from "../adapters/crypto";
import { zapiszSklep } from "../adapters/db/repozytoria";
import type { WynikWeryfikacji } from "../domain/store/contract";

export type WynikPodlaczenia =
  | { ok: true; storeId: string; mozliwosci: Record<string, boolean> }
  | { ok: false; blad: string; szczegoly?: string };

/**
 * Podłączenie sklepu (FR8, FR9). Poświadczenia są sprawdzane ZAKRES PO ZAKRESIE zanim
 * cokolwiek zapiszemy, bo klucze bez uprawnienia do zamówień przechodzą zwykły test
 * połączenia, a potem import kończy się pustym wynikiem wyglądającym jak sklep bez historii.
 */
export async function podlaczSklepWoo(
  tenantId: string,
  poswiadczenia: PoswiadczeniaWoo,
): Promise<WynikPodlaczenia> {
  const adapter = new AdapterWoo(tenantId, poswiadczenia);
  const weryfikacja: WynikWeryfikacji = await adapter.weryfikujPoswiadczenia();

  if (!weryfikacja.ok) {
    if (weryfikacja.powod === "brak-uprawnien") {
      return {
        ok: false,
        blad: `Klucze nie mają uprawnienia do: ${weryfikacja.brakujaceUprawnienia.join(", ")}`,
        szczegoly: "Merchant musi wygenerować klucze z prawem odczytu tych zasobów.",
      };
    }
    if (weryfikacja.powod === "bledne-poswiadczenia") {
      return { ok: false, blad: "Sklep odrzucił klucze", szczegoly: weryfikacja.szczegoly };
    }
    return { ok: false, blad: "Sklep nie odpowiada", szczegoly: weryfikacja.szczegoly };
  }

  const sklep = await zapiszSklep(tenantId, {
    platform: "woocommerce",
    baseUrl: poswiadczenia.baseUrl,
    // szyfrogram, nie tekst (AD-13)
    credentialsEncrypted: zaszyfruj(
      JSON.stringify({ ck: poswiadczenia.consumerKey, cs: poswiadczenia.consumerSecret }),
    ),
    capabilities: adapter.mozliwosci() as unknown as Record<string, boolean>,
    status: "connected",
  });

  return { ok: true, storeId: sklep.id, mozliwosci: sklep.capabilities };
}
