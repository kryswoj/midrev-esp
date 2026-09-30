import { type NextRequest } from "next/server";
import { plikPoTokenie } from "../../../usecases/obrazy/biblioteka";

/**
 * Publiczna trasa obrazów z biblioteki: /o/{token}.{ext}.
 *
 * Maila otwiera odbiorca bez sesji, więc trasa nie pyta o nic poza nieodgadywalnym
 * tokenem (32 losowe bajty). Tenant i ścieżka pliku wynikają z odnalezionego wiersza,
 * nigdy z adresu — z adresu nie da się złożyć ścieżki na dysku ani przejść do obrazu
 * innego sklepu.
 *
 * Nagłówki:
 *  - Content-Type z METADANYCH (ustalonych z magicznych bajtów przy wgraniu), nie z adresu,
 *  - X-Content-Type-Options: nosniff — przeglądarka nie zgaduje typu z treści,
 *  - CSP `default-src 'none'; sandbox` — gdyby ktoś otworzył plik jako dokument, nic w nim
 *    nie wykona się w kontekście naszej domeny,
 *  - cache na rok, immutable: treść pod tokenem nigdy się nie zmienia (nowy plik = nowy
 *    token), a skrzynki i proxy obrazów (Gmail) mają ją trzymać, żeby otwarcie maila
 *    za pół roku dalej pokazało grafikę.
 */

export const dynamic = "force-dynamic";

const PLIK = /^([A-Za-z0-9_-]{43})\.(png|jpg|gif|webp)$/;

function brak(): Response {
  return new Response("Nie znaleziono obrazu.", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(_zadanie: NextRequest, ctx: { params: Promise<{ plik: string }> }) {
  const { plik } = await ctx.params;
  const dopasowanie = PLIK.exec(plik);
  if (!dopasowanie) return brak();
  const obraz = await plikPoTokenie(dopasowanie[1], dopasowanie[2]);
  if (!obraz) return brak();
  return new Response(new Uint8Array(obraz.bajty), {
    status: 200,
    headers: {
      "content-type": obraz.mime,
      "content-length": String(obraz.bajty.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${dopasowanie[1]}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": `inline; filename="obraz.${dopasowanie[2]}"`,
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
    },
  });
}
