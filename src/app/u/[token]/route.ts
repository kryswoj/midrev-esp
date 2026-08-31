import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "../../../adapters/db/pool";

/**
 * Wypisanie jednym kliknięciem (FR50, FR51, RFC 8058).
 *
 * POST obsługuje nagłówek List-Unsubscribe-Post z klienta pocztowego. GET obsługuje link
 * ze stopki. Oba wypisują NATYCHMIAST: bez logowania, bez ankiety, bez "do 48 godzin".
 * Skutek: wpis 'suppressed' w logu wykluczeń sklepu. Wpis, nie DELETE i nie kolumna,
 * bo historia wypisań musi zostać (AD-16).
 *
 * Do rewizji przy prawdziwym ruchu: skanery antyspamowe potrafią prefetchować GET-y
 * z maili, co wypisuje ludzi bez ich wiedzy. Wtedy GET przechodzi na stronę z jednym
 * przyciskiem, a POST zostaje natychmiastowy.
 */
async function wypisz(token: string): Promise<{ ok: boolean; email?: string }> {
  const pool = getPool();
  const { rows } = await pool.query(
    "select tenant_id, email from messages where unsubscribe_token = $1",
    [token],
  );
  const wiersz = rows[0];
  if (!wiersz) return { ok: false };
  await pool.query(
    `insert into tenant_suppressions (tenant_id, email, action, reason, actor)
     values ($1, $2, 'suppressed', 'wypisanie jednym kliknięciem', 'odbiorca')`,
    [wiersz.tenant_id, wiersz.email],
  );
  return { ok: true, email: wiersz.email };
}

/** Adres pochodzi z danych profilu, więc do HTML wchodzi wyłącznie po escapowaniu. */
function bezpieczny(tekst: string): string {
  return tekst.replace(/[&<>"']/g, (z) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[z]!);
}

function strona(tresc: string) {
  return new NextResponse(
    `<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f5f5;font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#1c1c1e">
     <div style="background:#fff;border-radius:10px;padding:32px 36px;max-width:26rem;text-align:center">${tresc}</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function POST(_z: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const wynik = await wypisz(token);
  return new NextResponse(wynik.ok ? "OK" : "NOT FOUND", { status: wynik.ok ? 200 : 404 });
}

export async function GET(_z: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const wynik = await wypisz(token);
  if (!wynik.ok) return strona("<h2>Ten link wygasł</h2><p>Nie znaleźliśmy wiadomości powiązanej z tym linkiem.</p>");
  return strona(
    `<h2 style="margin:0 0 8px">Wypisano</h2>
     <p style="margin:0;color:#6b7280">Adres <strong>${bezpieczny(wynik.email ?? "")}</strong> nie będzie już otrzymywać wiadomości od tego sklepu. Zadziałało od razu.</p>`,
  );
}
