import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "../../../adapters/db/pool";
import { config } from "../../../config";
import { zapiszZaangazowanie } from "../../../usecases/wysylka/zaangazowanie";
import {
  adresIp,
  agentUzytkownika,
  celBezpieczny,
  zapiszNieblokujaco,
} from "../../api/zaangazowanie-web";

/**
 * Redirect kliknięcia (FR54, FR55). Token jest per odbiorca i wiadomość (AD-33), więc klik
 * mówi KTO kliknął, a nie tylko że ktoś kliknął. Na tym stoi cała atrybucja przychodu.
 *
 * Cele linków czytane są WYŁĄCZNIE ze snapshotu zapisanego na wiadomości przy budowie:
 * edycja kampanii po wysyłce nie może zmienić celu kliknięcia w mailach, które już wyszły
 * (znalezisko z review). Otwarty redirect ograniczają dwa fakty: cel pochodzi z treści,
 * którą zaakceptował klient sklepu, i nie da się go podmienić po wysyłce.
 *
 * Zapis idzie przez `zapiszZaangazowanie` (Blok A), a NIE prosto do `clicks`. To jest
 * cała różnica między tą wersją a poprzednią: tamta wpisywała do `clicks` każde wejście,
 * łącznie ze skanerem bezpieczeństwa bramki pocztowej, który klika każdy link w mailu
 * ZANIM zobaczy go człowiek. Takie kliknięcie wchodziło do atrybucji last-click z 0007
 * i przypisywało kampanii przychód, którego nie wygenerowała. Od teraz:
 *   - każde kliknięcie ląduje w `message_engagement` z werdyktem, czy było maszynowe,
 *   - do `clicks`, czyli do pieniędzy, trafia wyłącznie ruch nieuznany za maszynę.
 *
 * Izolacja tenantów: w adresie NIE MA identyfikatora tenanta ani wiadomości — jest sam
 * token. Tenant bierze się z odnalezionego wiersza i dopiero z nim idzie do zapisu, który
 * zawęża po nim zapytanie ponownie. Nie ma więc czego zgadywać ani czym się podstawić.
 */
export async function GET(zadanie: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  // Data zdarzenia USTALONA TUTAJ i podana jawnie (AD-10). Źródłem jest to żądanie,
  // więc znamy ją co do milisekundy; `default now()` w bazie zapisałby moment zapisu,
  // czyli o tyle później, ile trwała kolejka i transakcja.
  const kiedy = new Date();
  const { token } = await ctx.params;
  const indeks = Number(zadanie.nextUrl.searchParams.get("l") ?? "0");
  const pool = getPool();

  const { rows } = await pool.query(
    `select tenant_id, id, links from messages
      where click_token = $1 and source_type in ('campaign', 'journey')`,
    [token],
  );
  const wiersz = rows[0];
  if (!wiersz) return NextResponse.redirect(config().APP_URL);

  const linki: string[] = Array.isArray(wiersz.links) ? wiersz.links : [];
  const cel = Number.isInteger(indeks) ? linki[indeks] : undefined;
  // Pusty snapshot, zły indeks albo cel, który nie jest adresem http(s): przekierowanie
  // na stronę główną BEZ zapisu kliku. Klik z celem zastępczym wszedłby do atrybucji
  // jako prawdziwe zaangażowanie, a nim nie jest.
  if (!cel || !celBezpieczny(cel)) return NextResponse.redirect(config().APP_URL);

  await zapiszNieblokujaco(
    zapiszZaangazowanie(wiersz.tenant_id, wiersz.id, {
      rodzaj: "click",
      kiedy,
      zrodlo: "wlasne",
      url: cel,
      ip: adresIp(zadanie.headers),
      userAgent: agentUzytkownika(zadanie.headers),
    }),
    `kliknięcie wiadomości ${wiersz.id}`,
  );

  return NextResponse.redirect(cel, { status: 302 });
}
