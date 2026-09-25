import { NextResponse, type NextRequest } from "next/server";
import { przeanalizujPlik } from "../../../../../../usecases/import-klaviyo/analiza";
import { rozpoznajKolumnySupresji } from "../../../../../../usecases/import-klaviyo/mapowanie";
import { MAKS_ROZMIAR_PLIKU, odkazNazwePliku, sciezkaPliku, usunPlik, zapiszStrumien } from "../../../../../../usecases/import-klaviyo/pliki";
import { przebieg, zapiszPlikSupresji } from "../../../../../../usecases/import-klaviyo/zadania";
import { wymaganyTenant } from "../../../../../autoryzacja";

/**
 * Upload pliku supresji (krok 3 kreatora) do istniejacego przebiegu. Te same zasady co
 * upload profili: surowe cialo, limit 50 MB, wymagany wlasny naglowek (CSRF), tenant
 * z sesji. Przebieg musi nalezec do tenanta i byc przed startem - po starcie plik
 * supresji jest zamrozony, bo raport ma odpowiadac temu, co faktycznie przetworzono.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function odpowiedzBledu(status: number, blad: string) {
  return NextResponse.json({ ok: false, blad }, { status });
}

export async function POST(zadanie: NextRequest, ctx: { params: Promise<{ tenantId: string; jobId: string }> }) {
  const { tenantId: zadany, jobId } = await ctx.params;
  const { tenantId } = await wymaganyTenant(zadany);
  if (!UUID.test(jobId)) return odpowiedzBledu(404, "Nie ma takiego importu.");
  const job = await przebieg(tenantId, jobId);
  if (!job) return odpowiedzBledu(404, "Nie ma takiego importu.");
  if (job.status !== "mapped" && job.status !== "suppressions") return odpowiedzBledu(409, "Ten import jest już uruchomiony albo nie ma jeszcze mapowania.");

  const nazwaSurowa = zadanie.headers.get("x-nazwa-pliku");
  if (nazwaSurowa === null) return odpowiedzBledu(400, "Brak nazwy pliku.");
  let nazwa = "supresje.csv";
  try {
    nazwa = odkazNazwePliku(decodeURIComponent(nazwaSurowa));
  } catch {
    return odpowiedzBledu(400, "Nieczytelna nazwa pliku.");
  }
  const dlugosc = Number(zadanie.headers.get("content-length") ?? "0");
  if (dlugosc > MAKS_ROZMIAR_PLIKU) return odpowiedzBledu(413, "Plik jest większy niż 50 MB.");
  if (!zadanie.body) return odpowiedzBledu(400, "Brak pliku w żądaniu.");

  const sciezka = sciezkaPliku(tenantId, jobId, "suppressions");
  const zapis = await zapiszStrumien(zadanie.body, sciezka);
  if (!zapis.ok) {
    return odpowiedzBledu(zapis.powod === "za_duzy" ? 413 : 400, zapis.powod === "za_duzy" ? "Plik jest większy niż 50 MB." : "Plik jest pusty.");
  }
  const analiza = await przeanalizujPlik(sciezka);
  if ("blad" in analiza) {
    await usunPlik(sciezka);
    return odpowiedzBledu(400, analiza.blad);
  }
  const zapisano = await zapiszPlikSupresji(tenantId, jobId, {
    fileName: nazwa,
    fileSize: zapis.rozmiar,
    rowCount: analiza.wierszy,
    headers: analiza.naglowki,
    sample: analiza.probka,
    mapping: rozpoznajKolumnySupresji(analiza.naglowki),
  });
  if (!zapisano) {
    await usunPlik(sciezka);
    return odpowiedzBledu(409, "Import zmienił stan w trakcie wgrywania. Odśwież stronę.");
  }
  return NextResponse.json({ ok: true, jobId, wierszy: analiza.wierszy, kolumn: analiza.naglowki.length });
}
