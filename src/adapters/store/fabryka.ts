import { odszyfruj } from "../crypto";
import { poswiadczeniaSklepu, sklep as pobierzSklep } from "../db/repozytoria";
import type { PortSklepu } from "../../domain/store/contract";
import { definicjaPlatformy, type DefinicjaPlatformy } from "./rejestr";

/**
 * Fabryka adaptera sklepu (plan integracji E.1): jedno miejsce, które z wiersza `stores`
 * (platforma + odszyfrowane poświadczenia) robi adapter API. Zastępuje `new AdapterWoo(...)`
 * w podłączaniu, imporcie historii, zgodności danych i synchronizacji katalogu.
 */
export interface SklepZAdapterem {
  storeId: string;
  platforma: string;
  baseUrl: string;
  adapter: PortSklepu;
  definicja: DefinicjaPlatformy;
  /** odszyfrowane poświadczenia (NIGDY do logów ani do odpowiedzi) */
  poswiadczenia: Record<string, unknown>;
}

export class BladSklepu extends Error {}

export function odszyfrujPoswiadczenia(szyfrogram: Buffer): Record<string, unknown> {
  const dane = JSON.parse(odszyfruj(szyfrogram));
  if (!dane || typeof dane !== "object" || Array.isArray(dane)) throw new BladSklepu("Poświadczenia sklepu mają zły kształt");
  return dane as Record<string, unknown>;
}

export async function adapterSklepu(tenantId: string, storeId: string): Promise<SklepZAdapterem> {
  const s = await pobierzSklep(tenantId, storeId);
  if (!s) throw new BladSklepu("Sklep nie istnieje w tym tenancie");
  const definicja = definicjaPlatformy(s.platform);
  if (!definicja) throw new BladSklepu(`Platforma ${s.platform} nie ma adaptera API`);
  const szyfrogram = await poswiadczeniaSklepu(tenantId, storeId);
  if (!szyfrogram) throw new BladSklepu("Brak poświadczeń sklepu");
  const poswiadczenia = odszyfrujPoswiadczenia(szyfrogram);
  return {
    storeId,
    platforma: s.platform,
    baseUrl: s.base_url,
    adapter: definicja.utworzAdapter(tenantId, s.base_url, poswiadczenia),
    definicja,
    poswiadczenia,
  };
}
