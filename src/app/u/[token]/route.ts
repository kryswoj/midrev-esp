import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "../../../adapters/db/pool";

/**
 * Wypisanie z wysyłek sklepu (FR50, FR51, RFC 8058).
 *
 * Trzy wejścia, jedna zasada — wypisuje WYŁĄCZNIE POST:
 *   1. POST z nagłówka `List-Unsubscribe-Post` (Gmail, Yahoo, Apple Mail): klient pocztowy
 *      wysyła body `List-Unsubscribe=One-Click` bez człowieka na stronie. Odpowiedź
 *      to gołe 200 bez HTML (RFC 8058 §3.2), natychmiast, bez ankiety.
 *   2. GET z linku w stopce: pokazuje stronę z nazwą sklepu i JEDNYM przyciskiem
 *      „Wypisz mnie". Sam GET nie zmienia niczego — skanery antyspamowe (Microsoft
 *      Safe Links, Barracuda, Proofpoint) otwierają każdy link z maila zanim zrobi to
 *      człowiek, więc wypis na GET wypisywał ludzi bez ich wiedzy (audyt 24.09, #8).
 *   3. POST z tego przycisku (pole `potwierdzam=tak`): wypisuje i pokazuje potwierdzenie.
 *
 * Skutek wypisu: wpis 'suppressed' w logu wykluczeń sklepu. Wpis, nie DELETE i nie
 * kolumna, bo historia wypisań musi zostać (AD-16). Powtórny POST tym samym tokenem
 * jest bezpieczny: bramka `canSendTo` czyta OSTATNI wpis, drugi identyczny nic nie zmienia.
 */

interface Odbiorca {
  tenantId: string;
  email: string;
  nazwaSklepu: string;
}

async function znajdzOdbiorce(token: string): Promise<Odbiorca | null> {
  // Token to 18 losowych bajtów w base64url (24 znaki); śmieć nie idzie do bazy.
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const { rows } = await getPool().query(
    `select m.tenant_id, m.email, t.name as nazwa_sklepu
       from messages m join tenants t on t.id = m.tenant_id
      where m.unsubscribe_token = $1`,
    [token],
  );
  const w = rows[0];
  if (!w) return null;
  return { tenantId: w.tenant_id, email: w.email, nazwaSklepu: String(w.nazwa_sklepu ?? "").trim() || "tego sklepu" };
}

async function wypisz(o: Odbiorca, zrodlo: "one-click" | "strona"): Promise<void> {
  await getPool().query(
    `insert into tenant_suppressions (tenant_id, email, action, reason, actor)
     values ($1, $2, 'suppressed', $3, 'odbiorca')`,
    [o.tenantId, o.email, zrodlo === "one-click" ? "wypisanie jednym kliknięciem (List-Unsubscribe)" : "wypisanie ze strony wypisu"],
  );
}

/** Adres i nazwa sklepu pochodzą z danych, więc do HTML wchodzą wyłącznie po escapowaniu. */
function bezpieczny(tekst: string): string {
  return tekst.replace(/[&<>"']/g, (z) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[z]!);
}

/** Adres w formie „a•••@domena": strona jest publiczna, a link może obejrzeć skaner albo osoba trzecia. */
function zamaskuj(email: string): string {
  const [lokalna, domena] = email.split("@");
  if (!domena) return "•••";
  const poczatek = lokalna.slice(0, lokalna.length > 3 ? 2 : 1);
  return `${poczatek}•••@${domena}`;
}

/**
 * Strona publiczna, poza panelem, więc bez globals.css (ten arkusz wymaga fontu i tokenów
 * z layoutu aplikacji). Kolory i rytm są tokenami kanonu „Dzień" z DESIGN.md: płótno
 * #F6F7F9, powierzchnia biała, linia #E3E6EA, tekst #16181D / #5B616B, akcent #814AC8,
 * promień 12 px, cień karty. Jedna karta, jeden tytuł, jedna akcja.
 */
function strona(opcje: { tytul: string; tresc: string; status?: number }) {
  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${bezpieczny(opcje.tytul)}</title>
<style>
  :root{--plotno:#f6f7f9;--powierzchnia:#fff;--linia:#e3e6ea;--tekst:#16181d;--tekst-2:#5b616b;--tekst-3:#868d97;--akcent:#814ac8;--akcent-mocny:#6d38ad;--ok:#14795d;--ok-tlo:#eaf7f2;--blad:#b52a24;--blad-tlo:#fff0ef}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:var(--plotno);color:var(--tekst);font:15px/1.6 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  main{display:grid;place-items:center;min-height:100vh;padding:24px 16px}
  .karta{width:100%;max-width:440px;background:var(--powierzchnia);border:1px solid var(--linia);border-radius:12px;padding:36px 32px;box-shadow:0 1px 2px rgba(18,24,40,.035),0 3px 10px rgba(18,24,40,.025);text-align:center}
  .znak{width:48px;height:48px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;font-size:22px;font-weight:600}
  .znak-ok{background:var(--ok-tlo);color:var(--ok)}
  .znak-blad{background:var(--blad-tlo);color:var(--blad)}
  .znak-neutralny{background:#f4eefb;color:var(--akcent)}
  h1{margin:0 0 8px;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-.01em}
  p{margin:0;color:var(--tekst-2)}
  strong{color:var(--tekst);font-weight:600}
  .sklep{display:block;margin-bottom:14px;font-size:12px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;color:var(--tekst-3);font-weight:600}
  form{margin:24px 0 0}
  button{appearance:none;width:100%;border:0;border-radius:8px;background:var(--akcent);color:#fff;font:inherit;font-weight:600;padding:11px 16px;cursor:pointer}
  button:hover{background:var(--akcent-mocny)}
  button:focus-visible{outline:2px solid var(--akcent);outline-offset:2px}
  .meta{margin-top:14px;font-size:12px;line-height:17px;color:var(--tekst-3)}
</style></head>
<body><main><section class="karta" aria-live="polite">${opcje.tresc}</section></main></body></html>`;
  return new NextResponse(html, {
    status: opcje.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function stronaBrakLinku() {
  return strona({
    tytul: "Ten link wygasł",
    status: 404,
    tresc: `<div class="znak znak-blad" aria-hidden="true">×</div><h1>Ten link wygasł</h1><p>Nie znaleźliśmy wiadomości powiązanej z tym linkiem. Otwórz link z nowszego maila albo odpisz na wiadomość, żeby zostać wypisanym.</p>`,
  });
}

function stronaPotwierdzenia(o: Odbiorca) {
  return strona({
    tytul: "Wypisano z wiadomości",
    tresc: `<div class="znak znak-ok" aria-hidden="true">✓</div><span class="sklep">${bezpieczny(o.nazwaSklepu)}</span><h1>Wypisano</h1><p>Adres <strong>${bezpieczny(zamaskuj(o.email))}</strong> nie będzie już dostawać wiadomości od ${bezpieczny(o.nazwaSklepu)}. Zadziałało od razu.</p><p class="meta">Zmieniłaś/eś zdanie? Zgodę można wyrazić ponownie w sklepie.</p>`,
  });
}

/**
 * Klient pocztowy z RFC 8058 wysyła body `List-Unsubscribe=One-Click` jako
 * application/x-www-form-urlencoded. Gmail koduje znak równości, więc porównujemy po
 * rozkodowaniu przez URLSearchParams (klucz „List-Unsubscribe", wartość „One-Click").
 */
function czyOneClick(typTresci: string, cialo: string): boolean {
  // RFC 8058 wymaga form-urlencoded; przyjmujemy też brak typu i text/plain z tym samym
  // body (łagodniej niż norma, bezpiecznie: treść i tak musi być dokładnie tą parą)
  if (typTresci && !/application\/x-www-form-urlencoded|text\/plain/i.test(typTresci)) return false;
  try {
    return new URLSearchParams(cialo).get("List-Unsubscribe") === "One-Click";
  } catch {
    return false;
  }
}

export async function GET(_z: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const o = await znajdzOdbiorce(token);
  if (!o) return stronaBrakLinku();
  // Strona z jednym przyciskiem. Sam GET NICZEGO nie zapisuje.
  return strona({
    tytul: "Wypisz się z wiadomości",
    tresc: `<div class="znak znak-neutralny" aria-hidden="true">✉</div><span class="sklep">${bezpieczny(o.nazwaSklepu)}</span><h1>Wypisać Cię z wiadomości?</h1><p>Adres <strong>${bezpieczny(zamaskuj(o.email))}</strong> przestanie dostawać wiadomości od ${bezpieczny(o.nazwaSklepu)}. Zadziała od razu, bez logowania.</p>
<form method="post" action=""><input type="hidden" name="potwierdzam" value="tak"><button type="submit">Wypisz mnie</button></form>
<p class="meta">Jeśli nie chcesz się wypisywać, po prostu zamknij tę stronę.</p>`,
  });
}

export async function POST(z: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const o = await znajdzOdbiorce(token);
  const surowe = (await z.text()).slice(0, 2000);
  const oneClick = czyOneClick(z.headers.get("content-type") ?? "", surowe);
  if (!o) {
    return oneClick ? new NextResponse("NOT FOUND", { status: 404 }) : stronaBrakLinku();
  }
  if (oneClick) {
    // RFC 8058 §3.2: odpowiedź bez treści do przeczytania, bez przekierowania, bez strony.
    await wypisz(o, "one-click");
    return new NextResponse("OK", { status: 200, headers: { "cache-control": "no-store" } });
  }
  // Przycisk ze strony. Wymagamy pola potwierdzenia: POST bez niego (np. skaner, który
  // próbuje POST-a na każdy formularz) nie wypisuje, tylko pokazuje stronę z przyciskiem.
  const parametry = new URLSearchParams(surowe);
  if (parametry.get("potwierdzam") !== "tak") {
    return GET(z, ctx);
  }
  await wypisz(o, "strona");
  return stronaPotwierdzenia(o);
}
