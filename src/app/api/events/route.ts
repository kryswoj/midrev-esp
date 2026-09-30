import type { NextRequest } from "next/server";
import { przyjmijZdarzenieApi } from "../../../usecases/api/przyjmij-zdarzenie";
import { LIMIT_ZDARZEN, zaliczDoSufitu } from "../../../usecases/api/limity";
import { blad, bramkaApi, cialoJson, odpowiedzBledu, przyjeto } from "../zgodnosc-klaviyo";

/**
 * `POST /api/events` zgodne z Klaviyo (E2 / 2.3). Ta sama trasa odpowiada na `/api/events/`
 * (z ukośnikiem, jak wołają ją workflowy n8n): middleware przepisuje ścieżkę bez 308.
 *
 * Odpowiedź 202 pada dopiero PO zapisie surowego żądania i joba w jednej transakcji
 * (usecases/api/przyjmij-zdarzenie.ts), więc 202 nie gubi zdarzenia.
 */

export const dynamic = "force-dynamic";

const MAKS_CIALA_B = 5 * 1024 * 1024;

export async function POST(zadanie: NextRequest) {
  try {
    return await obsluz(zadanie);
  } catch (b) {
    // bez ciała i nagłówków w logu (klucz, dane osobowe): sama klasa i komunikat błędu
    console.error(`[api/events] błąd: ${b instanceof Error ? `${b.name}: ${b.message}` : "nieznany"}`);
    return blad(500, "error", "A server error occurred. Retry the request.");
  }
}

async function obsluz(zadanie: NextRequest) {
  const bramka = await bramkaApi(zadanie, {
    zakres: "events:write",
    trasa: "events",
    limit: LIMIT_ZDARZEN,
    zCialem: true,
    sufitDobowy: true,
  });
  if ("odpowiedz" in bramka) return bramka.odpowiedz;
  const odczyt = await cialoJson(zadanie, MAKS_CIALA_B);
  if ("odpowiedz" in odczyt) return odczyt.odpowiedz;

  const wynik = await przyjmijZdarzenieApi(
    bramka.kontekst.tenantId,
    { kluczId: bramka.kontekst.kluczId, revision: bramka.kontekst.revision },
    odczyt.surowe,
    odczyt.cialo,
  );
  if (!wynik.ok) {
    return odpowiedzBledu(
      wynik.bledy.map((b) => ({ status: 400, code: "invalid", title: "Invalid input.", detail: b.opis, source: { pointer: b.wskaznik } })),
    );
  }
  if (wynik.nowe) zaliczDoSufitu(bramka.kontekst.tenantId);
  return przyjeto();
}

function nieobslugiwana() {
  return blad(405, "method_not_allowed", "Method not allowed on /api/events. Use POST.", undefined, { Allow: "POST" });
}

export const GET = nieobslugiwana;
export const PUT = nieobslugiwana;
export const PATCH = nieobslugiwana;
export const DELETE = nieobslugiwana;
