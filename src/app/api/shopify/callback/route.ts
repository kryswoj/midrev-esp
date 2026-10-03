import { NextResponse, type NextRequest } from "next/server";
import { adresKlienta } from "../../../../adapters/ip-klienta";
import { config } from "../../../../config";
import { sprawdzLimit } from "../../../../usecases/api/limity";
import { CIASTECZKO_STANU, dokonczInstalacje } from "../../../../usecases/shopify/instalacja";

/**
 * `GET /api/shopify/callback?code&hmac&shop&state&timestamp` (redirect_uri OAuth). Publiczna:
 * chroni ją HMAC, stan jednorazowy w bazie i ciasteczko stanu z tej samej przeglądarki.
 * Po sukcesie: kreator w panelu (krok „Włącz w motywie”); panel i tak wymaga logowania.
 * Błąd: krótki komunikat bez szczegółów (żadnych tokenów ani sekretów w odpowiedzi).
 */
export const dynamic = "force-dynamic";

export async function GET(zadanie: NextRequest) {
  if (!sprawdzLimit("shopify-callback", adresKlienta(zadanie.headers) ?? "nieznane", { naSekunde: 5, naMinute: 60 }).ok) {
    return new NextResponse("za dużo żądań", { status: 429, headers: { "Retry-After": "60" } });
  }
  const w = await dokonczInstalacje(zadanie.nextUrl.searchParams, zadanie.cookies.get(CIASTECZKO_STANU)?.value ?? null);
  if (!w.ok) {
    const odp = new NextResponse(`Instalacja MidRev nie powiodła się: ${w.powod}. Wróć do panelu MidRev i spróbuj ponownie.`, {
      status: w.status,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
    odp.cookies.delete({ name: CIASTECZKO_STANU, path: "/api/shopify" });
    return odp;
  }
  const cel = new URL(`/t/${w.tenantId}/sklepy/shopify`, config().APP_URL);
  cel.searchParams.set("sklep", w.storeId);
  cel.searchParams.set("zainstalowano", "1");
  const odp = NextResponse.redirect(cel, { status: 302 });
  odp.headers.set("Cache-Control", "no-store");
  odp.cookies.delete({ name: CIASTECZKO_STANU, path: "/api/shopify" });
  return odp;
}
