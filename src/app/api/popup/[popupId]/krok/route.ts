import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { przyjmijKrok, schematKroku } from "../../../../../usecases/popupy/zglos-popup";
import { przeczytajOgraniczone } from "../../../przeczytaj-ograniczone";
import { CORS, ipZadania, stworzLimit } from "../../limit";

/**
 * Kolejny krok formularza PO kroku z e-mailem (zapis cząstkowy, 0043). Uzupełnia profil
 * wskazany podpisanym tokenem z odpowiedzi na krok z e-mailem: imię i telefon tylko tam,
 * gdzie ich nie ma, właściwości z pytań przewidzianych w opublikowanym formularzu.
 * Nie tworzy profilu ani zgody. Bez ważnego tokenu: 403, profil bez zmian.
 */

// kroki po e-mailu to zwykle 1-2 żądania na osobę; limit luźniejszy niż samego zapisu
const przekroczonyLimit = stworzLimit(10, 240);
const MAKS_CIALO_B = 8192;
const schematId = z.string().uuid();

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(zadanie: NextRequest, ctx: { params: Promise<{ popupId: string }> }) {
  const { popupId } = await ctx.params;
  if (!schematId.safeParse(popupId).success) {
    return NextResponse.json({ ok: false, blad: "nie_znaleziono" }, { status: 404, headers: CORS });
  }
  if (przekroczonyLimit(ipZadania(zadanie))) {
    return NextResponse.json({ ok: false, blad: "za_duzo_zadan" }, { status: 429, headers: CORS });
  }
  const surowe = await przeczytajOgraniczone(zadanie, MAKS_CIALO_B);
  if (surowe === null) return NextResponse.json({ ok: false, blad: "za_duze_cialo" }, { status: 413, headers: CORS });
  let cialo: unknown;
  try {
    cialo = JSON.parse(surowe);
  } catch {
    return NextResponse.json({ ok: false, blad: "niepoprawny_json" }, { status: 400, headers: CORS });
  }
  const dane = schematKroku.safeParse(cialo);
  if (!dane.success) return NextResponse.json({ ok: false, blad: "niepoprawne_dane" }, { status: 400, headers: CORS });
  const w = await przyjmijKrok(popupId, dane.data);
  if (w.ok) return NextResponse.json({ ok: true }, { headers: CORS });
  const status = w.powod === "nie_znaleziono" ? 404 : w.powod === "token" ? 403 : 400;
  return NextResponse.json({ ok: false, blad: w.powod }, { status, headers: CORS });
}
