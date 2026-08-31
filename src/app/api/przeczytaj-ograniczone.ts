import type { NextRequest } from "next/server";

/**
 * Czyta cialo strumieniowo z twardym limitem bajtow. Sam naglowek Content-Length
 * to deklaracja klienta: request chunked albo z falszywym naglowkiem i tak
 * dostarczylby dowolnie duze cialo do `zadanie.json()` (znalezisko review).
 * Zwraca null, gdy cialo przekracza limit. Wspolne dla wszystkich tras publicznych.
 */
export async function przeczytajOgraniczone(
  zadanie: NextRequest,
  maksBajtow: number,
): Promise<string | null> {
  const strumien = zadanie.body;
  if (!strumien) return "";
  const czytnik = strumien.getReader();
  const kawalki: Uint8Array[] = [];
  let bajtow = 0;
  try {
    for (;;) {
      const { done, value } = await czytnik.read();
      if (done) break;
      bajtow += value.byteLength;
      if (bajtow > maksBajtow) {
        await czytnik.cancel();
        return null;
      }
      kawalki.push(value);
    }
  } finally {
    czytnik.releaseLock();
  }
  return Buffer.concat(kawalki).toString("utf-8");
}
