import type { NextRequest } from "next/server";
import { adresKlienta } from "../../../adapters/ip-klienta";

/**
 * Prosty rate limit w pamięci procesu dla publicznych tras formularzy: per IP i globalny.
 * Świadomy kompromis fazy 1: nie przeżyje restartu i nie działa między replikami, ale
 * zatrzymuje najgorsze (pętle floodujące bazę z jednego źródła). X-Forwarded-For podaje
 * klient, więc per-IP to tylko pierwsza linia; sufit globalny trzyma resztę, a request
 * odbity limitem IP nie zjada puli globalnej (review: jeden adres nie wyłącza popupów innym).
 */
export function stworzLimit(limitIp: number, limitGlobalny: number, oknoMs = 60_000): (ip: string) => boolean {
  const liczniki = new Map<string, { ile: number; resetPo: number }>();
  let globalny = { ile: 0, resetPo: 0 };
  return function przekroczony(ip: string): boolean {
    const teraz = Date.now();
    if (liczniki.size > 10_000) {
      for (const [klucz, wpis] of liczniki) if (wpis.resetPo <= teraz) liczniki.delete(klucz);
      if (liczniki.size > 10_000) liczniki.clear();
    }
    const wpis = liczniki.get(ip);
    if (!wpis || wpis.resetPo <= teraz) {
      liczniki.set(ip, { ile: 1, resetPo: teraz + oknoMs });
    } else {
      wpis.ile += 1;
      if (wpis.ile > limitIp) return true;
    }
    if (globalny.resetPo <= teraz) globalny = { ile: 0, resetPo: teraz + oknoMs };
    globalny.ile += 1;
    return globalny.ile > limitGlobalny;
  };
}

/** Adres z nagłówka ZAUFANEGO proxy (TRUSTED_PROXY), nie pierwszy wpis XFF od klienta. */
export function ipZadania(zadanie: NextRequest): string {
  return adresKlienta(zadanie.headers) ?? "nieznane";
}

// Skrypt na stronie siedzi na dowolnej domenie sklepu, więc origin jest z definicji obcy.
// `*` jest tu poprawne: trasy nie czytają ciasteczek ani sesji (skrypt wysyła z
// credentials: "omit"), więc cudzym originem nie ma czego ukraść; dane idą tylko DO serwera.
export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
