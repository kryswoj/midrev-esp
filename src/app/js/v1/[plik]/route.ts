import { NextResponse, type NextRequest } from "next/server";
import { adresSledzenia } from "../../../../config";
import { kluczStronyPublicznie } from "../../../../usecases/integracja/klucz-strony";
import { aktywnyPopup } from "../../../../usecases/popupy/zarzadzaj";
import { originBezDanych, zanotujSygnal } from "../../../../usecases/integracja/podglad";
import { WERSJA_MIDREV_JS, zbudujMidrevJs } from "../../runtime-midrev";

/**
 * `GET /js/v1/{klucz strony}.js`: skrypt `midrev.js` z konfiguracją klucza (plan 6, plan
 * integracji E.2). Wersja w ścieżce (`v1`): zmiana niezgodna wstecz = nowa ścieżka, stare
 * tagi na stronach dalej działają.
 *
 * Zły albo unieważniony klucz: 200 z pustym skryptem (tag na stronie sklepu ma być
 * bezobjawowy, jak w /s), krótki cache. Pobranie skryptu trafia do podglądu „Sprawdź
 * połączenie” (sam origin strony z nagłówka Referer, bez ścieżki).
 */

export const dynamic = "force-dynamic";

function naglowki(cache: string): Record<string, string> {
  return {
    "Content-Type": "application/javascript; charset=utf-8",
    "X-Script-Version": WERSJA_MIDREV_JS,
    "Cache-Control": cache,
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  };
}

export async function GET(zadanie: NextRequest, ctx: { params: Promise<{ plik: string }> }) {
  const { plik } = await ctx.params;
  const m = /^([A-Za-z0-9]{6,10})\.js$/.exec(plik);
  const klucz = m ? await kluczStronyPublicznie(m[1]) : null;
  if (!klucz) {
    return new NextResponse(`/* midrev.js v${WERSJA_MIDREV_JS}: nieznany albo unieważniony klucz strony */\n`, { headers: naglowki("public, max-age=60") });
  }
  const origin = originBezDanych(zadanie.headers.get("referer"));
  zanotujSygnal(klucz.id, { rodzaj: "skrypt", metryka: null, sciezka: null, origin });

  const adres = adresSledzenia();
  const formy = klucz.zaladujFormularze && (await aktywnyPopup(klucz.tenantId)) ? `${adres}/s/${klucz.tenantId}` : null;
  const js = zbudujMidrevJs({ id: klucz.id, api: adres, zgoda: klucz.wymagajZgodyCookies, ga4: klucz.ga4, shim: true, formy });
  // 5 min: zmiana ustawień w panelu (GA4, zgoda) dociera do stron szybko, a ruch jest z cache
  return new NextResponse(js, { headers: naglowki("public, max-age=300") });
}
