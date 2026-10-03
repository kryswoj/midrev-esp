import type { NextRequest } from "next/server";
import { przyjmijZadanieKlienta } from "../../../usecases/integracja/klient-api";
import { zanotujSygnal } from "../../../usecases/integracja/podglad";
import { bladKlienta, bramkaKlienta, obsluzBladWewnetrzny, preflight, przyjeto202 } from "../wspolne";

/**
 * `POST /client/profiles?company_id=` (identify) zgodne z Klaviyo. Przeglądarka nie nadpisuje
 * danych istniejącego profilu i nie zmienia jego identyfikatorów (klient-api.ts).
 */

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

export async function POST(zadanie: NextRequest) {
  try {
    const b = await bramkaKlienta(zadanie, { trasa: "profiles", maksBajtow: 32 * 1024 });
    if ("odpowiedz" in b) return b.odpowiedz;
    if (b.bot) return przyjeto202(b.cors);
    const w = await przyjmijZadanieKlienta(b.klucz, "profile", b.cialo);
    if (w.status === "limit") {
      return bladKlienta(429, [{ kod: "throttled", opis: "Daily limit for this site reached." }], b.cors, { "Retry-After": String(w.poSekundach) });
    }
    if (w.status === "odrzucone") {
      zanotujSygnal(b.klucz.id, { rodzaj: "odrzucone", metryka: "identify", sciezka: null, origin: b.origin, powod: w.bledy[0]?.opis });
      return bladKlienta(400, w.bledy, b.cors);
    }
    zanotujSygnal(b.klucz.id, { rodzaj: w.status === "anonimowe" ? "anonimowe" : "przyjete", metryka: "identify", sciezka: null, origin: b.origin });
    return przyjeto202(b.cors);
  } catch (blad) {
    return obsluzBladWewnetrzny("profiles", blad);
  }
}
