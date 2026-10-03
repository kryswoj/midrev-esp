import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { zapiszWyswietlenie } from "../../../../../usecases/popupy/wyswietlenia";
import { przeczytajOgraniczone } from "../../../przeczytaj-ograniczone";
import { CORS, ipZadania, stworzLimit } from "../../limit";

/**
 * Lekkie zdarzenie wyświetlenia kroku formularza (0043): „Viewed Form” / „Viewed Form Step”
 * w strumieniu metric_events, bez profilu. Skrypt wysyła je jako text/plain (bez preflightu
 * CORS) z keepalive. Odpowiedź zawsze 204: nic nie zdradza i nic nie blokuje strony sklepu.
 */

const przekroczonyLimit = stworzLimit(60, 3000);
const schematId = z.string().uuid();
const schematCiala = z.object({ krok: z.number().int().min(0).max(20), gosc: z.string().max(40) });

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(zadanie: NextRequest, ctx: { params: Promise<{ popupId: string }> }) {
  const { popupId } = await ctx.params;
  const pusta = () => new NextResponse(null, { status: 204, headers: CORS });
  if (!schematId.safeParse(popupId).success || przekroczonyLimit(ipZadania(zadanie))) return pusta();
  const surowe = await przeczytajOgraniczone(zadanie, 512);
  if (!surowe) return pusta();
  let cialo: unknown;
  try {
    cialo = JSON.parse(surowe);
  } catch {
    return pusta();
  }
  const dane = schematCiala.safeParse(cialo);
  if (!dane.success) return pusta();
  await zapiszWyswietlenie(popupId, dane.data);
  return pusta();
}
