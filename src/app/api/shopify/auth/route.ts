import { NextResponse, type NextRequest } from "next/server";
import { adresKlienta } from "../../../../adapters/ip-klienta";
import { sprawdzLimit } from "../../../../usecases/api/limity";
import { CIASTECZKO_STANU, rozpocznijInstalacje, WAZNOSC_STANU_MS } from "../../../../usecases/shopify/instalacja";

/**
 * `GET /api/shopify/auth?shop=…&hmac=…&timestamp=…` = `application_url` aplikacji Shopify.
 * Shopify otwiera go po instalacji z linku custom distribution (i przy każdym otwarciu
 * aplikacji w adminie). Publiczna trasa: chroni ją podpis HMAC sekretem aplikacji sklepu.
 * Odpowiedź: przekierowanie na /admin/oauth/authorize + ciasteczko HttpOnly ze stanem.
 */
export const dynamic = "force-dynamic";

export async function GET(zadanie: NextRequest) {
  if (!sprawdzLimit("shopify-auth", adresKlienta(zadanie.headers) ?? "nieznane", { naSekunde: 5, naMinute: 60 }).ok) {
    return new NextResponse("za dużo żądań", { status: 429, headers: { "Retry-After": "60" } });
  }
  const w = await rozpocznijInstalacje(zadanie.nextUrl.searchParams);
  if (!w.ok) return new NextResponse(w.powod, { status: w.status, headers: { "Cache-Control": "no-store" } });
  const odp = NextResponse.redirect(w.przekierowanie, { status: 302 });
  odp.headers.set("Cache-Control", "no-store");
  odp.cookies.set(CIASTECZKO_STANU, w.stan, {
    httpOnly: true,
    secure: zadanie.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/api/shopify",
    maxAge: Math.floor(WAZNOSC_STANU_MS / 1000),
  });
  return odp;
}
