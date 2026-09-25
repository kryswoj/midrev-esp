import { NextResponse, type NextRequest } from "next/server";
import { v7 as uuidv7 } from "uuid";
import { przeanalizujPlik } from "../../../../usecases/import-klaviyo/analiza";
import { rozpoznajKolumny } from "../../../../usecases/import-klaviyo/mapowanie";
import { MAKS_ROZMIAR_PLIKU, odkazNazwePliku, sciezkaPliku, usunPlik, zapiszStrumien } from "../../../../usecases/import-klaviyo/pliki";
import { utworzPrzebieg } from "../../../../usecases/import-klaviyo/zadania";
import { listaTenanta } from "../../../../usecases/listy/czlonkowie";
import { wymaganyTenant } from "../../../autoryzacja";

/**
 * Upload pliku profili (krok 1 kreatora). Cialo zadania to SUROWY plik, nie multipart:
 * przegladarka wysyla go strumieniem, a serwer zapisuje kawalek po kawalku z twardym
 * limitem 50 MB - nic nie laduje w pamieci w calosci.
 *
 * Handler weryfikuje SAM (AD-21): jest osiagalny z sieci bez layoutu. Tenant z URL-a to
 * deklaracja, dostep rozstrzyga sesja. Naglowek x-nazwa-pliku jest WYMAGANY: wlasny
 * naglowek wymusza preflight CORS, wiec formularz ani fetch z obcej strony nie przemyci
 * tu zadania z ciasteczkiem sesji (CSRF).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function odpowiedzBledu(status: number, blad: string) {
  return NextResponse.json({ ok: false, blad }, { status });
}

export async function POST(zadanie: NextRequest, ctx: { params: Promise<{ tenantId: string }> }) {
  const { tenantId: zadany } = await ctx.params;
  const { tenantId, sesja } = await wymaganyTenant(zadany);

  const nazwaSurowa = zadanie.headers.get("x-nazwa-pliku");
  if (nazwaSurowa === null) return odpowiedzBledu(400, "Brak nazwy pliku.");
  let nazwa = "plik.csv";
  try {
    nazwa = odkazNazwePliku(decodeURIComponent(nazwaSurowa));
  } catch {
    return odpowiedzBledu(400, "Nieczytelna nazwa pliku.");
  }

  const listaSurowa = zadanie.headers.get("x-lista-id");
  let listId: string | null = null;
  if (listaSurowa) {
    if (!UUID.test(listaSurowa) || !(await listaTenanta(tenantId, listaSurowa))) return odpowiedzBledu(400, "Wskazana lista nie istnieje.");
    listId = listaSurowa;
  }

  const dlugosc = Number(zadanie.headers.get("content-length") ?? "0");
  if (dlugosc > MAKS_ROZMIAR_PLIKU) return odpowiedzBledu(413, "Plik jest większy niż 50 MB. Podziel go na części w Klaviyo (eksport per lista).");
  if (!zadanie.body) return odpowiedzBledu(400, "Brak pliku w żądaniu.");

  const jobId = uuidv7();
  const sciezka = sciezkaPliku(tenantId, jobId, "profiles");
  const zapis = await zapiszStrumien(zadanie.body, sciezka);
  if (!zapis.ok) {
    return odpowiedzBledu(zapis.powod === "za_duzy" ? 413 : 400, zapis.powod === "za_duzy" ? "Plik jest większy niż 50 MB." : "Plik jest pusty.");
  }

  const analiza = await przeanalizujPlik(sciezka);
  if ("blad" in analiza) {
    await usunPlik(sciezka);
    return odpowiedzBledu(400, analiza.blad);
  }

  await utworzPrzebieg(tenantId, {
    id: jobId,
    fileName: nazwa,
    fileSize: zapis.rozmiar,
    rowCount: analiza.wierszy,
    headers: analiza.naglowki,
    sample: analiza.probka,
    mapping: rozpoznajKolumny(analiza.naglowki),
    createdBy: sesja.email,
    listId,
  });

  return NextResponse.json({ ok: true, jobId, wierszy: analiza.wierszy, kolumn: analiza.naglowki.length, uszkodzonych: analiza.uszkodzonych });
}
