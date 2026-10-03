import type { NextRequest } from "next/server";
import { rozlaczWtyczke } from "../../../../../../usecases/integracja/woo-wtyczka";
import { bladWewnetrzny, bramkaWtyczki, json } from "../../wspolne";

/** „Odłącz” we wtyczce: usuwa nasze webhooki w sklepie i oznacza sklep jako odłączony. */
export async function POST(zadanie: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const b = await bramkaWtyczki(zadanie, storeId, "rozlacz", 4096);
  if ("odpowiedz" in b) return b.odpowiedz;
  try {
    return json(200, { ok: true, ...(await rozlaczWtyczke(b.auth)) });
  } catch (e) {
    return bladWewnetrzny("rozlacz", e);
  }
}
