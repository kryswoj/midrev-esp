import type { NextRequest } from "next/server";
import { przyjmijZdarzeniaWtyczki } from "../../../../../../usecases/integracja/woo-wtyczka";
import { bladWewnetrzny, bramkaWtyczki, json } from "../../wspolne";

/** Zdarzenia serwer-serwer z wtyczki (paczka ≤ 50, podpis HMAC). 202 = przyjęte do kolejki. */
export async function POST(zadanie: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const b = await bramkaWtyczki(zadanie, storeId, "zdarzenia", 262_144);
  if ("odpowiedz" in b) return b.odpowiedz;
  try {
    const w = await przyjmijZdarzeniaWtyczki(b.auth, b.cialo);
    if (w.status === "odrzucone") return json(400, { blad: "niepoprawne", opis: w.opis });
    return json(202, { nowe: w.nowe, duplikaty: w.duplikaty, konfiguracja: w.konfiguracja });
  } catch (e) {
    return bladWewnetrzny("zdarzenia", e);
  }
}
