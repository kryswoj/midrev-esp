import { NextResponse, type NextRequest } from "next/server";
import { MAKS_ROZMIAR_OBRAZU, obrazyTenanta, wgrajObraz } from "../../../../usecases/obrazy/biblioteka";
import { wymaganyTenant } from "../../../autoryzacja";

/**
 * Biblioteka obrazów tenanta: GET = lista (siatka miniatur w edytorze), POST = wgranie.
 *
 * Handler weryfikuje SAM (AD-21): tenant z URL-a to deklaracja, dostęp rozstrzyga sesja.
 * Ciało POST to SUROWY plik (nie multipart), czytany z twardym limitem 5 MB — nagłówek
 * Content-Length to tylko deklaracja klienta, więc limit liczymy na bajtach, które
 * faktycznie przyszły. Nagłówek x-nazwa-pliku jest WYMAGANY: własny nagłówek wymusza
 * preflight CORS, więc formularz ani fetch z obcej strony nie przemyci tu żądania
 * z ciasteczkiem sesji (CSRF).
 */

export const dynamic = "force-dynamic";

function odpowiedzBledu(status: number, blad: string) {
  return NextResponse.json({ ok: false, blad }, { status, headers: { "cache-control": "no-store" } });
}

async function czytajBajty(zadanie: NextRequest, maks: number): Promise<Uint8Array | null> {
  const strumien = zadanie.body;
  if (!strumien) return new Uint8Array();
  const czytnik = strumien.getReader();
  const kawalki: Uint8Array[] = [];
  let bajtow = 0;
  try {
    for (;;) {
      const { done, value } = await czytnik.read();
      if (done) break;
      bajtow += value.byteLength;
      if (bajtow > maks) {
        await czytnik.cancel();
        return null;
      }
      kawalki.push(value);
    }
  } finally {
    czytnik.releaseLock();
  }
  return new Uint8Array(Buffer.concat(kawalki));
}

export async function GET(_zadanie: NextRequest, ctx: { params: Promise<{ tenantId: string }> }) {
  const { tenantId: zadany } = await ctx.params;
  const { tenantId } = await wymaganyTenant(zadany);
  const obrazy = await obrazyTenanta(tenantId);
  return NextResponse.json({ ok: true, obrazy }, { headers: { "cache-control": "no-store" } });
}

export async function POST(zadanie: NextRequest, ctx: { params: Promise<{ tenantId: string }> }) {
  const { tenantId: zadany } = await ctx.params;
  const { tenantId, sesja } = await wymaganyTenant(zadany);

  const nazwaSurowa = zadanie.headers.get("x-nazwa-pliku");
  if (nazwaSurowa === null) return odpowiedzBledu(400, "Brak nazwy pliku.");
  let nazwa: string;
  try {
    nazwa = decodeURIComponent(nazwaSurowa);
  } catch {
    return odpowiedzBledu(400, "Nieczytelna nazwa pliku.");
  }

  const dlugosc = Number(zadanie.headers.get("content-length") ?? "0");
  if (dlugosc > MAKS_ROZMIAR_OBRAZU) return odpowiedzBledu(413, "Obraz jest większy niż 5 MB.");
  const bajty = await czytajBajty(zadanie, MAKS_ROZMIAR_OBRAZU);
  if (bajty === null) return odpowiedzBledu(413, "Obraz jest większy niż 5 MB.");

  const wynik = await wgrajObraz(tenantId, { bajty, nazwa, autor: sesja.email ?? null, kiedy: new Date() });
  if (!wynik.ok) return odpowiedzBledu(wynik.status, wynik.blad);
  return NextResponse.json({ ok: true, obraz: wynik.obraz }, { status: 201, headers: { "cache-control": "no-store" } });
}
