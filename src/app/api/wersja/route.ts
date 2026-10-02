import { NextResponse } from "next/server";
import { aktualnaSesja } from "../../../adapters/auth-sesja";

/**
 * Wersja działającego wydania dla strażnika wersji w panelu (src/app/ui/straznik-wersji.tsx).
 * Wartość wkompilowana z pliku REVISION (next.config.ts); bez niego pusta.
 *
 * Trasa CHRONIONA (nie ma jej w src/trasy-publiczne.ts): middleware odsyła anonimowych
 * na /logowanie, a tutaj dodatkowo twarda weryfikacja sesji. Bez sesji 401, a strażnik
 * traktuje każdą odpowiedź inną niż 200 z JSON-em jako „nie wiadomo” i nic nie robi.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const sesja = await aktualnaSesja();
  if (!sesja) return NextResponse.json({ blad: "brak sesji" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ wersja: process.env.ESP_WERSJA ?? "" }, { headers: { "Cache-Control": "no-store" } });
}
