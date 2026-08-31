import { NextResponse, type NextRequest } from "next/server";

// Pierwsza linia obrony (Story 1.4). Edge runtime nie ma dostepu do bazy, wiec
// middleware sprawdza wylacznie OBECNOSC ciasteczka sesji i odsyla anonimowych
// na /logowanie. Sfalszowane ciasteczko przechodzi tedy celowo - twarda
// weryfikacja tokenu w bazie to aktualnaSesja() z src/adapters/auth-sesja.ts,
// wolana w server components. Tu odpada tylko halas: boty i wygasniete karty.

// Musi byc rowne CIASTECZKO_SESJI z src/adapters/auth-sesja.ts; import niemozliwy,
// bo tamten modul ciagnie next/headers i baze, ktorych edge nie udzwignie.
const CIASTECZKO_SESJI = "midrev_sesja";

// Sciezki publiczne: logowanie, zasoby Nexta, webhooki sklepow (autoryzacja
// podpisem HMAC, nie sesja) oraz wszystko, co klika odbiorca maila lub klient
// bez konta: przekierowania /r/, wypisania /u/, akceptacja kampanii, warianty.
const PUBLICZNE = [
  "/logowanie",
  "/_next",
  "/api/webhooks",
  "/r",
  "/u",
  "/akceptacja",
  "/warianty",
  "/favicon.ico", "/s", "/api/popup",
];

function publiczna(sciezka: string): boolean {
  // dopasowanie po calych segmentach: "/r/abc" tak, ale "/raporty" juz nie
  return PUBLICZNE.some((p) => sciezka === p || sciezka.startsWith(p + "/"));
}

export function middleware(zadanie: NextRequest) {
  const { pathname, search } = zadanie.nextUrl;
  if (publiczna(pathname)) return NextResponse.next();
  if (zadanie.cookies.get(CIASTECZKO_SESJI)?.value) return NextResponse.next();

  const cel = new URL("/logowanie", zadanie.url);
  // powrot tam, dokad uzytkownik szedl; wartosc jest odkazana przy uzyciu
  // (bezpiecznaSciezka w akcji logowania), nie przy zapisie
  cel.searchParams.set("dalej", pathname + search);
  return NextResponse.redirect(cel);
}
