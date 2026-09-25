import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "../../../../adapters/db/pool";
import { zapiszZaangazowanie } from "../../../../usecases/wysylka/zaangazowanie";
import { adresIp, agentUzytkownika, zapiszNieblokujaco } from "../../zaangazowanie-web";

/**
 * Pixel otwarć (Blok A, A1 + A5). Przezroczysty obrazek 1x1, który klient pocztowy
 * pobiera przy wyświetleniu wiadomości.
 *
 * Trzy rzeczy, o których ta trasa musi pamiętać, bo wszystkie trzy da się zrobić źle:
 *
 * 1. **Odpowiedź zawsze jest obrazkiem, zawsze 200.** Nieznany token, brak zgody,
 *    padnięta baza — odbiorca i tak dostaje ten sam 1x1. Odpowiedź, która mówi
 *    „nie znam tego tokena", zamienia pixel w wyrocznię: da się nią sprawdzać, które
 *    tokeny istnieją. Dodatkowo klient pocztowy pokazałby w treści maila ikonę zepsutego
 *    obrazka, czyli nasza diagnostyka wyciekłaby odbiorcy na ekran.
 *
 * 2. **Zero cache'owania.** Drugie otwarcie tej samej wiadomości ma być drugim
 *    zdarzeniem. Obrazek zapamiętany w przeglądarce, w proxy albo w CDN sprawia, że
 *    kolejne otwarcia w ogóle do nas nie dochodzą — a dokładnie te kolejne otwarcia
 *    odróżniają maila przeczytanego raz od maila, do którego ktoś wrócił.
 *
 * 3. **Otwarcie maszynowe zapisujemy, nie odrzucamy.** Apple MPP i proxy obrazków
 *    pobierają pixel za użytkownika, zanim ten cokolwiek zobaczy. Wyrzucenie takich
 *    zdarzeń byłoby wygodne, ale skłamałoby w drugą stronę: nie wiedzielibyśmy, jak
 *    dużej części skrzynek w ogóle nie widzimy. Zapisujemy je z werdyktem `automat`
 *    i pokazujemy OSOBNO w raporcie.
 *
 * Izolacja tenantów: adres niesie wyłącznie token otwarcia (0016 — sha256 z click_token,
 * więc z adresu pixela nie da się złożyć adresu redirectu i wstrzyknąć kliknięcia do
 * atrybucji). Tenant pochodzi z odnalezionego wiersza, nie z adresu. Bramkę zgody na
 * śledzenie otwarć trzyma `zapiszZaangazowanie`, czytając MIGAWKĘ `open_tracking_allowed`
 * z wiadomości — pixel wysłany, gdy było wolno, nie przestaje działać przez zmianę
 * ustawienia jutro, a pixel wklejony tam, gdzie nie było wolno, nie zapisze niczego.
 */

// Najmniejszy poprawny przezroczysty GIF 1x1 (42 bajty). Trzymany jako base64 w kodzie,
// a nie jako plik w `public/`: to jest część kontraktu tej trasy, nie zasób do podmiany.
const PIXEL = Uint8Array.from(
  Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
);

function obrazek(): NextResponse {
  return new NextResponse(PIXEL, {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "content-length": String(PIXEL.byteLength),
      // komplet trzech nagłówków, bo starsze proxy i część klientów pocztowych ignorują
      // sam `cache-control`
      "cache-control": "no-store, no-cache, must-revalidate, private, max-age=0",
      pragma: "no-cache",
      expires: "0",
      // pixel nie ma być osadzany przez nikogo poza mailem i nie ma nic do pokazania
      // w przeglądarce
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function GET(zadanie: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  // Data otwarcia ustalona tu i podana jawnie (AD-10), tak samo jak przy kliknięciu.
  const kiedy = new Date();
  const { token: surowy } = await ctx.params;
  // Adres kończy się na `.gif`, bo część filtrów pocztowych traktuje obrazek bez
  // rozszerzenia podejrzliwie. Rozszerzenie jest ozdobą adresu, nie częścią tokena.
  const token = surowy.endsWith(".gif") ? surowy.slice(0, -4) : surowy;

  const { rows } = await getPool().query(
    "select tenant_id, id from messages where open_token = $1",
    [token],
  );
  const wiersz = rows[0];
  if (!wiersz) return obrazek();

  await zapiszNieblokujaco(
    zapiszZaangazowanie(wiersz.tenant_id, wiersz.id, {
      rodzaj: "open",
      kiedy,
      zrodlo: "wlasne",
      ip: adresIp(zadanie.headers),
      userAgent: agentUzytkownika(zadanie.headers),
    }),
    `otwarcie wiadomości ${wiersz.id}`,
  );

  return obrazek();
}
