import { readFileSync } from "node:fs";
import type { NextConfig } from "next";
import { wersjaZRevision } from "./src/wersja-wydania";

// Wersja wydania (audyt UX 02.10, „stara karta po wdrożeniu”). deploy/deploy.sh zapisuje
// REVISION w katalogu wydania PRZED `next build`: „<sha> <ref>” albo
// „archiwum <plik> sha256:<hash>”. Z niej bierzemy krótki identyfikator, który:
// - idzie do `deploymentId`: Next dokleja go do zasobów i przy niezgodności wersji karty
//   z serwerem robi pełne przeładowanie zamiast miękkiej nawigacji,
// - jest wkompilowany jako process.env.ESP_WERSJA (serwer i klient): /api/wersja
//   i strażnik wersji w panelu porównują go, żeby pokazać pasek „Jest nowa wersja”.
// Bez pliku REVISION (dev, testy, ręczny build) wersji nie ma i obie rzeczy są wyłączone.
// Zależy WYŁĄCZNIE od pliku, nie od NODE_ENV.
function wersjaWydania(): string {
  try {
    return wersjaZRevision(readFileSync("REVISION", "utf8"));
  } catch {
    return "";
  }
}
const wersja = wersjaWydania();

const produkcja = process.env.NODE_ENV === "production";
// HSTS tylko wtedy, gdy panel naprawdę stoi na https: przeglądarka i tak ignoruje HSTS
// po http, ale nagłówek na serwerze deweloperskim pod gołym IP byłby tylko mylący.
// UWAGA: headers() liczy się przy `next build` (trafia do routes-manifest), więc build
// produkcyjny uruchamiać z załadowanym plikiem środowiska (APP_URL=https://…). Reverse
// proxy (Caddy) i tak powinno dokładać HSTS samo — tu jest druga warstwa.
const https = /^https:\/\//i.test(process.env.APP_URL ?? "");

// Nagłówki dla KAŻDEJ odpowiedzi. X-Frame-Options: DENY jest bezpieczne wszędzie, bo nic
// z naszych tras nie jest osadzane w ramce: popupy na stronie sklepu to <script src="/s/…">
// (skrypt, nie ramka), podglądy maili w panelu to <iframe srcdoc> (bez odpowiedzi HTTP),
// obrazy i pixel ładują się jako <img>. Panel z danymi osobowymi nie może dać się osadzić
// w cudzej ramce (clickjacking na „Wyślij teraz").
const naglowkiWspolne = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // przekierowanie /r do sklepu nie zdradza adresu z tokenem, najwyżej sam host śledzenia
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Build produkcyjny ZAWSZE z HSTS (review Codeksa r1: build bez załadowanego env gubił
  // nagłówek, a runtime już go nie doda). Poza https przeglądarka i tak go ignoruje, a guard
  // startowy nie wpuści produkcji bez https.
  ...(https || produkcja ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  // Panel jest narzędziem pracy operatora, nie stroną publiczną: bez indeksowania,
  // bez optymalizacji obrazów pod CDN, za to z jawnymi błędami w konsoli.
  reactStrictMode: true,
  ...(wersja ? { deploymentId: wersja } : {}),
  env: { ESP_WERSJA: wersja },
  serverExternalPackages: ["pg"],
  // bez „X-Powered-By: Next.js": nie podpowiadamy skanerom wersji frameworka
  poweredByHeader: false,
  // API zgodne z Klaviyo przyjmuje `/api/events/` (z ukośnikiem, jak wołają je workflowy
  // n8n) BEZ 308: middleware przepisuje te ścieżki, a resztę przekierowuje jak dotąd
  // (src/trasy-publiczne.ts, TRASY_API_Z_UKOSNIKIEM).
  skipTrailingSlashRedirect: true,
  // Podgląd serwera deweloperskiego pod publicznym adresem VPS: bez tego Next 16 odmawia
  // przeglądarce plików JS (403) i panel renderuje się bez interakcji (edytor, kanwa).
  // WYŁĄCZNIE poza buildem produkcyjnym.
  ...(produkcja ? {} : { allowedDevOrigins: ["137.74.42.199"] }),
  async headers() {
    return [
      { source: "/:path*", headers: naglowkiWspolne },
      // CSP frame-ancestors dla stron panelu (HTML). Trasy z własnym CSP (obrazy /o:
      // `default-src 'none'; sandbox`) i API zostają przy swoich nagłówkach — drugi
      // nagłówek CSP zaostrzałby je w sposób, którego nie chcemy tu zgadywać.
      {
        source: "/((?!o/|api/|s/|_next/).*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
          // panel nie jest stroną do indeksowania (akceptacja i wypis też nie)
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
