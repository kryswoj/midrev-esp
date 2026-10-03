import type { NextRequest } from "next/server";
import { BladParowania, sprawdzKodParowania } from "../../../../../../usecases/integracja/woo-wtyczka";
import { przeczytajOgraniczone } from "../../../../przeczytaj-ograniczone";
import { bladWewnetrzny, json, LIMIT_PAROWANIA, limitIp } from "../../wspolne";

/** Krok 1 parowania (bez kluczy): z jakim kontem połączy się sklep. Limit per IP jak parowanie. */
export async function POST(zadanie: NextRequest) {
  const limit = limitIp(zadanie, "paruj", LIMIT_PAROWANIA);
  if (limit) return limit;
  const surowe = await przeczytajOgraniczone(zadanie, 4096);
  if (surowe === null) return json(413, { blad: "za_duze_cialo" });
  let cialo: unknown;
  try {
    cialo = JSON.parse(surowe);
  } catch {
    return json(400, { blad: "nieczytelne_cialo" });
  }
  try {
    return json(200, await sprawdzKodParowania(cialo));
  } catch (b) {
    if (b instanceof BladParowania) return json(400, { blad: b.kod, komunikat: b.message });
    return bladWewnetrzny("paruj-sprawdz", b);
  }
}
