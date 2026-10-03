import type { NextRequest } from "next/server";
import { przyjmijSubskrypcjeKlienta } from "../../../usecases/integracja/klient-api";
import { zanotujSygnal } from "../../../usecases/integracja/podglad";
import { bladKlienta, bramkaKlienta, obsluzBladWewnetrzny, preflight, przyjeto202 } from "../wspolne";

/**
 * `POST /client/subscriptions?company_id=` zgodne z Klaviyo, z wymogiem dowodu zgody
 * (`data.attributes.consent_text` = klauzula ustawiona w panelu). Synchronicznie, jak popup.
 */

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

export async function POST(zadanie: NextRequest) {
  try {
    const b = await bramkaKlienta(zadanie, { trasa: "subscriptions", maksBajtow: 16 * 1024 });
    if ("odpowiedz" in b) return b.odpowiedz;
    if (b.bot) return przyjeto202(b.cors);
    const w = await przyjmijSubskrypcjeKlienta(b.klucz, b.cialo, { origin: b.origin });
    if (w.status === "odrzucone") {
      zanotujSygnal(b.klucz.id, { rodzaj: "odrzucone", metryka: "zapis na newsletter", sciezka: null, origin: b.origin, powod: w.bledy[0]?.opis });
      return bladKlienta(400, w.bledy, b.cors);
    }
    zanotujSygnal(b.klucz.id, { rodzaj: "subskrypcja", metryka: "zapis na newsletter", sciezka: null, origin: b.origin });
    return przyjeto202(b.cors);
  } catch (blad) {
    return obsluzBladWewnetrzny("subscriptions", blad);
  }
}
