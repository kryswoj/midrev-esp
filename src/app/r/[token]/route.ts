import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "../../../adapters/db/pool";
import { config } from "../../../config";
/**
 * Redirect kliknięcia (FR54, FR55). Token jest per odbiorca i wiadomość (AD-33), więc klik
 * mówi KTO kliknął, a nie tylko że ktoś kliknął. Na tym stoi cała atrybucja przychodu.
 *
 * Cele linków czytane są WYŁĄCZNIE ze snapshotu zapisanego na wiadomości przy budowie:
 * edycja kampanii po wysyłce nie może zmienić celu kliknięcia w mailach, które już wyszły
 * (znalezisko z review). Otwarty redirect ograniczają dwa fakty: cel pochodzi z treści,
 * którą zaakceptował klient sklepu, i nie da się go podmienić po wysyłce.
 */
export async function GET(zadanie: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const indeks = Number(zadanie.nextUrl.searchParams.get("l") ?? "0");
  const pool = getPool();

  const { rows } = await pool.query(
    `select tenant_id, id, profile_id, links from messages
      where click_token = $1 and source_type in ('campaign', 'journey')`,
    [token],
  );
  const wiersz = rows[0];
  if (!wiersz) return NextResponse.redirect(config().APP_URL);

  const linki: string[] = Array.isArray(wiersz.links) ? wiersz.links : [];
  const cel = linki[indeks];
  // Pusty snapshot albo zły indeks: przekierowanie bez zapisu kliku. Klik z celem
  // zastępczym wszedłby do atrybucji jako prawdziwe zaangażowanie, a nim nie jest.
  if (!cel) return NextResponse.redirect(config().APP_URL);

  await pool.query(
    `insert into clicks (tenant_id, message_id, profile_id, url, user_agent)
     values ($1, $2, $3, $4, left($5, 300))`,
    [wiersz.tenant_id, wiersz.id, wiersz.profile_id, cel, zadanie.headers.get("user-agent") ?? ""],
  );

  return NextResponse.redirect(cel, { status: 302 });
}
