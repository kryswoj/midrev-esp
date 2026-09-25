import { NextResponse } from "next/server";
import { eksportujProfil, zapiszSladEksportu } from "../../../../../../usecases/profil-rodo";
import { wymaganaSesja, wymaganyTenant } from "../../../../../autoryzacja";

/**
 * Eksport danych osoby do pliku JSON (FR21).
 *
 * Route handler, a nie server action, bo action nie potrafi oddać pliku do
 * pobrania - musiałby przelecieć przez JavaScript w przeglądarce, a ten ekran
 * ma działać także wtedy, gdy skrypt się nie wczyta.
 *
 * Wyłącznie POST: eksport zapisuje ślad w logu RODO, a GET-y bywają prefetchowane
 * przez przeglądarki i skanery, co robiłoby wpisy w logu bez udziału człowieka.
 * Ciasteczko sesji jest sameSite=lax, więc formularz z obcej strony nie przeniesie
 * sesji i żądanie skończy się na logowaniu.
 */
export async function POST(
  _zadanie: Request,
  ctx: { params: Promise<{ tenantId: string; profileId: string }> },
) {
  const { tenantId: zadany, profileId } = await ctx.params;
  // handler weryfikuje SAM (AD-21): jest osiągalny z sieci bez renderowania layoutu
  const { tenantId } = await wymaganyTenant(zadany);
  const sesja = await wymaganaSesja();

  const dane = await eksportujProfil(tenantId, profileId);
  if (!dane) {
    return new NextResponse("Nie znaleziono profilu", { status: 404 });
  }
  await zapiszSladEksportu(tenantId, profileId, sesja.email);

  const dzis = new Date().toISOString().slice(0, 10);
  const nazwa = `profil-${profileId.slice(0, 8)}-${dzis}.json`;
  return new NextResponse(JSON.stringify(dane, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${nazwa}"`,
      // dane osobowe nie mają czego szukać w pamięci podręcznej po drodze
      "cache-control": "no-store",
    },
  });
}
