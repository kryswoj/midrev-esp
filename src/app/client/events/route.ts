import type { NextRequest } from "next/server";
import { przyjmijZadanieKlienta } from "../../../usecases/integracja/klient-api";
import { sciezkaBezDanych, zanotujSygnal } from "../../../usecases/integracja/podglad";
import { bladKlienta, bramkaKlienta, obsluzBladWewnetrzny, preflight, przyjeto202 } from "../wspolne";

/**
 * `POST /client/events?company_id=<klucz strony>` zgodne z Klaviyo (plan 2.1, 6). Ta sama
 * trasa odpowiada na `/client/events/` (middleware przepisuje bez 308). 202 po zapisie
 * surowego żądania (AD-4); przetwarzanie w workerze (job przetworz_zdarzenie_klienta).
 */

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

export async function POST(zadanie: NextRequest) {
  try {
    const b = await bramkaKlienta(zadanie, { trasa: "events", maksBajtow: 64 * 1024 });
    if ("odpowiedz" in b) return b.odpowiedz;
    const nazwa = (b.cialo as { data?: { attributes?: { metric?: { data?: { attributes?: { name?: unknown } } } } } })?.data?.attributes?.metric?.data?.attributes?.name;
    const props = (b.cialo as { data?: { attributes?: { properties?: Record<string, unknown> } } })?.data?.attributes?.properties ?? {};
    const sygnal = {
      metryka: typeof nazwa === "string" ? nazwa : null,
      sciezka: sciezkaBezDanych(props.URL ?? props.CheckoutURL ?? props.page ?? props.url),
      origin: b.origin,
    };
    if (b.bot) {
      zanotujSygnal(b.klucz.id, { ...sygnal, rodzaj: "odrzucone", powod: "ruch automatyczny (bot)" });
      return przyjeto202(b.cors);
    }
    const w = await przyjmijZadanieKlienta(b.klucz, "event", b.cialo);
    if (w.status === "limit") {
      return bladKlienta(429, [{ kod: "throttled", opis: "Daily limit for this site reached." }], b.cors, { "Retry-After": String(w.poSekundach) });
    }
    if (w.status === "odrzucone") {
      zanotujSygnal(b.klucz.id, { ...sygnal, rodzaj: "odrzucone", powod: w.bledy[0]?.opis });
      return bladKlienta(400, w.bledy, b.cors);
    }
    zanotujSygnal(b.klucz.id, { ...sygnal, rodzaj: w.status === "anonimowe" ? "anonimowe" : "przyjete" });
    return przyjeto202(b.cors);
  } catch (blad) {
    return obsluzBladWewnetrzny("events", blad);
  }
}
