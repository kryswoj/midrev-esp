import { NextResponse, type NextRequest } from "next/server";
import { czyTrasaPubliczna, TRASY_API_Z_UKOSNIKIEM } from "./src/trasy-publiczne";

// Pierwsza linia obrony (Story 1.4). Edge runtime nie ma dostepu do bazy, wiec
// middleware sprawdza wylacznie OBECNOSC ciasteczka sesji i odsyla anonimowych
// na /logowanie. Sfalszowane ciasteczko przechodzi tedy celowo - twarda
// weryfikacja tokenu w bazie to aktualnaSesja() z src/adapters/auth-sesja.ts,
// wolana w server components. Tu odpada tylko halas: boty i wygasniete karty.

// Musi byc rowne CIASTECZKO_SESJI z src/adapters/auth-sesja.ts; import niemozliwy,
// bo tamten modul ciagnie next/headers i baze, ktorych edge nie udzwignie.
const CIASTECZKO_SESJI = "midrev_sesja";

// Lista tras publicznych zyje w src/trasy-publiczne.ts (jedno zrodlo prawdy, pilnowane
// testem tests/trasy-publiczne.test.ts, ktory zderza ja z drzewem src/app).

export function middleware(zadanie: NextRequest) {
  const { pathname, search } = zadanie.nextUrl;
  // Ukośnik na końcu (next.config: skipTrailingSlashRedirect). API zgodne z Klaviyo:
  // rewrite bez 308 (POST z ciałem nie może odbić się przekierowaniem). Reszta: to samo
  // 308 co dotąd robił Next.
  if (pathname.length > 1 && pathname.endsWith("/")) {
    const bez = pathname.replace(/\/+$/, "") || "/";
    // zwykły URL, nie klon nextUrl: NextURL pamięta ukośnik z oryginału i dokleja go z powrotem
    // API zgodne z Klaviyo (POST z ciałem nie może dostać 308): przepuszczamy BEZ rewrite
    // w middleware, ścieżkę bez ukośnika daje rewrite z next.config.ts (beforeFiles).
    // Rewrite w middleware na absolutny URL z zadanie.url za proxy (X-Forwarded-Proto: https,
    // serwer na http) Next traktował jako zewnętrzny i proxował TLS-em na port http: EPROTO,
    // 500 na produkcji (03.10). Rewrite z konfiguracji jest zawsze wewnętrzny.
    if ((TRASY_API_Z_UKOSNIKIEM as readonly string[]).includes(bez)) return NextResponse.next();
    const cel = new URL(bez + search, zadanie.url);
    return NextResponse.redirect(cel, 308);
  }
  if (czyTrasaPubliczna(pathname)) return NextResponse.next();
  if (zadanie.cookies.get(CIASTECZKO_SESJI)?.value) return NextResponse.next();

  const cel = new URL("/logowanie", zadanie.url);
  // powrot tam, dokad uzytkownik szedl; wartosc jest odkazana przy uzyciu
  // (bezpiecznaSciezka w akcji logowania), nie przy zapisie
  cel.searchParams.set("dalej", pathname + search);
  return NextResponse.redirect(cel);
}
