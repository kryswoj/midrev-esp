import type { NextRequest } from "next/server";
import { BladParowania, sparujWtyczke } from "../../../../../usecases/integracja/woo-wtyczka";
import { przeczytajOgraniczone } from "../../../przeczytaj-ograniczone";
import { bladWewnetrzny, json, LIMIT_PAROWANIA, limitIp } from "../wspolne";

/**
 * Parowanie wtyczki (kod z panelu + klucz REST założony przez wtyczkę). Publiczne, bo woła je
 * serwer sklepu; ochrona: kod jednorazowy o ≥ 125 bitach, limit per IP, weryfikacja kluczy
 * odczytem ze sklepu. Komunikat błędu jest dla administratora sklepu (po polsku, bez danych konta).
 */
export async function POST(zadanie: NextRequest) {
  const limit = limitIp(zadanie, "paruj", LIMIT_PAROWANIA);
  if (limit) return limit;
  const surowe = await przeczytajOgraniczone(zadanie, 16_384);
  if (surowe === null) return json(413, { blad: "za_duze_cialo" });
  let cialo: unknown;
  try {
    cialo = JSON.parse(surowe);
  } catch {
    return json(400, { blad: "nieczytelne_cialo" });
  }
  try {
    return json(200, await sparujWtyczke(cialo));
  } catch (b) {
    if (b instanceof BladParowania) return json(400, { blad: b.kod, komunikat: b.message });
    return bladWewnetrzny("paruj", b);
  }
}
