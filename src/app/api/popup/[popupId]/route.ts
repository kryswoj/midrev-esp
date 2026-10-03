import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { KlauzulaNieaktualna, przyjmijZgloszenie, schematZgloszenia } from "../../../../usecases/popupy/zglos-popup";
import { popupPubliczny } from "../../../../usecases/popupy/zarzadzaj";
import { CORS, ipZadania, stworzLimit } from "../limit";
import { przeczytajOgraniczone } from "../../przeczytaj-ograniczone";

/**
 * Publiczny endpoint popupu (Epik F): GET oddaje konfiguracje, POST przyjmuje
 * zgloszenie. Zero auth, bo formularz stoi na domenie sklepu, nie naszej -
 * dlatego CORS jest otwarty, a ochrona to walidacja, limity dlugosci i rate limit.
 */

// Limit zgłoszeń: 5 na minutę z jednego IP, 120 na minutę na cały proces (patrz limit.ts).
const przekroczonyLimit = stworzLimit(5, 120);

// zgloszenie to email, imie, telefon i odpowiedzi na pytania; wiekszy payload nie ma prawa
// istniec, a czytanie go w calosci przed walidacja byloby zaproszeniem do zapychania pamieci
const MAKS_CIALO_B = 8192;


// id waliduje zod, a nie bezposrednio SQL: zly format uuid w zapytaniu pg konczy sie
// bledem skladni i piecsetka, a dla klienta to zwykle "nie ma takiego popupu"
const schematId = z.string().uuid();

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(_zadanie: NextRequest, ctx: { params: Promise<{ popupId: string }> }) {
  const { popupId } = await ctx.params;
  if (!schematId.safeParse(popupId).success) {
    return NextResponse.json({ ok: false, blad: "nie_znaleziono" }, { status: 404, headers: CORS });
  }
  const popup = await popupPubliczny(popupId);
  if (!popup) {
    return NextResponse.json({ ok: false, blad: "nie_znaleziono" }, { status: 404, headers: CORS });
  }
  // tylko pola potrzebne do wyswietlenia; bez tenant_id i bez kodu rabatowego,
  // bo kod jest nagroda ZA zapis, a nie publiczna trescia
  return NextResponse.json(
    {
      ok: true,
      popup: {
        id: popup.id,
        headline: popup.headline,
        bodyText: popup.body_text,
        buttonText: popup.button_text,
        delaySeconds: popup.rules?.delay_seconds ?? 0,
        // klauzula zgody (0041): tekst pokazywany przy polu wyboru i numer wersji do odeslania
        consentText: popup.consent_wording,
        consentVersion: popup.consent_version,
        privacyUrl: popup.consent_privacy_url,
      },
    },
    { headers: CORS },
  );
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
  if (surowe === null) {
    return NextResponse.json({ ok: false, blad: "za_duze_cialo" }, { status: 413, headers: CORS });
  }

  let cialo: unknown;
  try {
    cialo = JSON.parse(surowe);
  } catch {
    return NextResponse.json({ ok: false, blad: "niepoprawny_json" }, { status: 400, headers: CORS });
  }
  const dane = schematZgloszenia.safeParse(cialo);
  if (!dane.success) {
    // brak zaznaczonej zgody (albo stary skrypt bez pola wyboru) to osobny, jawny powod
    const bezZgody = dane.error.issues.some((i) => i.path[0] === "zgoda" || i.path[0] === "wersjaKlauzuli");
    return NextResponse.json(
      { ok: false, blad: bezZgody ? "brak_zgody" : "niepoprawne_dane" },
      { status: 400, headers: CORS },
    );
  }

  let wynik;
  try {
    wynik = await przyjmijZgloszenie(popupId, dane.data);
  } catch (blad) {
    // klauzula zmieniona dawno po wyswietleniu: osoba ma odswiezyc strone i zobaczyc nowy tekst
    if (blad instanceof KlauzulaNieaktualna) {
      return NextResponse.json({ ok: false, blad: "formularz_zmieniony" }, { status: 409, headers: CORS });
    }
    throw blad;
  }
  if (!wynik) {
    return NextResponse.json({ ok: false, blad: "nie_znaleziono" }, { status: 404, headers: CORS });
  }
  // discountCode dla skryptu 1.1 (stary popup); kody i token dla skryptu 2.x
  return NextResponse.json(
    { ok: true, ...(wynik.discountCode ? { discountCode: wynik.discountCode } : {}), kody: wynik.kody, token: wynik.token },
    { headers: CORS },
  );
}
