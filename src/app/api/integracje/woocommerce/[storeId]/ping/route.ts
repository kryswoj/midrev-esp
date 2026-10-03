import type { NextRequest } from "next/server";
import { pingWtyczki } from "../../../../../../usecases/integracja/woo-wtyczka";
import { bladWewnetrzny, bramkaWtyczki, json } from "../../wspolne";

/** Ping wtyczki: zdrowie połączenia i aktualna konfiguracja (klauzula zgody, klucz strony). */
export async function POST(zadanie: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const b = await bramkaWtyczki(zadanie, storeId, "ping", 4096);
  if ("odpowiedz" in b) return b.odpowiedz;
  try {
    const wersja = typeof (b.cialo as { wersja?: unknown })?.wersja === "string" ? String((b.cialo as { wersja: string }).wersja) : null;
    return json(200, { ok: true, konfiguracja: await pingWtyczki(b.auth, wersja) });
  } catch (e) {
    return bladWewnetrzny("ping", e);
  }
}
