import { NextResponse, type NextRequest } from "next/server";
import { usunObraz } from "../../../../../usecases/obrazy/biblioteka";
import { wymaganyTenant } from "../../../../autoryzacja";

/**
 * Usunięcie obrazu z biblioteki. Tenant z URL-a sprawdzony z sesją (AD-21), obraz
 * szukany WYŁĄCZNIE w obrębie tego tenanta (id obcego obrazu = 404). Blokada, gdy obraz
 * jest w kampanii poza szkicem albo w automatyzacji, wraca jako 409 z powodem po polsku.
 * Metoda DELETE z obcej strony wymaga preflightu CORS, więc nie da się jej przemycić
 * formularzem (CSRF).
 */

export const dynamic = "force-dynamic";

export async function DELETE(_zadanie: NextRequest, ctx: { params: Promise<{ tenantId: string; imageId: string }> }) {
  const { tenantId: zadany, imageId } = await ctx.params;
  const { tenantId } = await wymaganyTenant(zadany);
  const wynik = await usunObraz(tenantId, imageId);
  if (!wynik.ok) return NextResponse.json({ ok: false, blad: wynik.blad }, { status: wynik.status, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ ok: true, szkice: wynik.szkice }, { headers: { "cache-control": "no-store" } });
}
