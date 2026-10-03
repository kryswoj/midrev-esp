import type { NextRequest } from "next/server";
import { przyjmijKluczeWcAuth } from "../../../../../usecases/integracja/woo-wtyczka";
import { przeczytajOgraniczone } from "../../../przeczytaj-ograniczone";
import { bladWewnetrzny, json, LIMIT_PAROWANIA, limitIp } from "../wspolne";

/**
 * Callback `/wc-auth/v1/authorize` (Woo bez wtyczki, „wersja podstawowa”). Woo wysyła JSON
 * z kluczami i `user_id` = nasz jednorazowy stan. Woo traktuje odpowiedź inną niż 2xx jako
 * błąd autoryzacji i pokazuje go administratorowi, więc błąd = 400 z krótkim opisem.
 */
export async function POST(zadanie: NextRequest) {
  const limit = limitIp(zadanie, "wc-auth", LIMIT_PAROWANIA);
  if (limit) return limit;
  const surowe = await przeczytajOgraniczone(zadanie, 8192);
  if (surowe === null) return json(413, { blad: "za_duze_cialo" });
  let cialo: unknown;
  try {
    cialo = JSON.parse(surowe);
  } catch {
    return json(400, { blad: "nieczytelne_cialo" });
  }
  try {
    const w = await przyjmijKluczeWcAuth(cialo);
    return w.ok ? json(200, { ok: true }) : json(400, { blad: w.blad });
  } catch (e) {
    return bladWewnetrzny("wc-auth", e);
  }
}
