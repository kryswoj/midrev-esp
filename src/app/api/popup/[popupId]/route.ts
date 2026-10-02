import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { KlauzulaNieaktualna, przyjmijZgloszenie, schematZgloszenia } from "../../../../usecases/popupy/zglos-popup";
import { popupPubliczny } from "../../../../usecases/popupy/zarzadzaj";
import { adresKlienta } from "../../../../adapters/ip-klienta";
import { przeczytajOgraniczone } from "../../przeczytaj-ograniczone";

/**
 * Publiczny endpoint popupu (Epik F): GET oddaje konfiguracje, POST przyjmuje
 * zgloszenie. Zero auth, bo formularz stoi na domenie sklepu, nie naszej -
 * dlatego CORS jest otwarty, a ochrona to walidacja, limity dlugosci i rate limit.
 */

// Skrypt on-site siedzi na dowolnej domenie sklepu, wiec origin jest z definicji
// obcy. `*` jest tu poprawne: endpoint nie czyta ciasteczek ani sesji, wiec nie
// ma czego ukrasc cudzym originem; dane ida tylko W STRONE serwera.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// Prosty rate limit w pamieci procesu: 5 zgloszen na minute z jednego IP.
// Swiadomy kompromis fazy 1 - nie przezyje restartu i nie dziala miedzy replikami,
// ale zatrzymuje najgorsze: petle floodujace baze profilami z jednego zrodla.
//
// X-Forwarded-For jest naglowkiem od klienta, wiec per-IP jest tylko pierwsza
// linia (znalezisko review: falszywy XFF go omija). Dlatego obok dziala limit
// GLOBALNY na caly proces: nawet z tysiacem zmyslonych adresow flood zatrzymuje
// sie na twardym suficie, a mapa licznikow nie rosnie bez konca.
const LIMIT_IP = 5;
const LIMIT_GLOBALNY = 120;
const OKNO_MS = 60_000;
const liczniki = new Map<string, { ile: number; resetPo: number }>();
let globalny = { ile: 0, resetPo: 0 };

function przekroczonyLimit(ip: string): boolean {
  const teraz = Date.now();

  // najpierw per-IP: request odbity limitem IP nie moze zjadac puli globalnej,
  // inaczej jeden adres spamem odrzucanych POST-ow wylacza popupy wszystkim
  // (znalezisko drugiej rundy review)
  // sprzatanie przy okazji, zeby mapa nie rosla bez konca po tygodniu ruchu;
  // twardy sufit rozmiaru chroni pamiec przed zalewem zmyslonych adresow z XFF
  if (liczniki.size > 10_000) {
    for (const [klucz, wpis] of liczniki) if (wpis.resetPo <= teraz) liczniki.delete(klucz);
    if (liczniki.size > 10_000) liczniki.clear();
  }
  const wpis = liczniki.get(ip);
  if (!wpis || wpis.resetPo <= teraz) {
    liczniki.set(ip, { ile: 1, resetPo: teraz + OKNO_MS });
  } else {
    wpis.ile += 1;
    if (wpis.ile > LIMIT_IP) return true;
  }

  // pula globalna liczy tylko requesty, ktore przeszly limit per-IP
  if (globalny.resetPo <= teraz) globalny = { ile: 0, resetPo: teraz + OKNO_MS };
  globalny.ile += 1;
  return globalny.ile > LIMIT_GLOBALNY;
}

function ipZadania(zadanie: NextRequest): string {
  // adres z naglowka ustawionego przez ZAUFANE proxy (TRUSTED_PROXY): pierwszy wpis
  // X-Forwarded-For podaje klient i kazda proba dostawalaby nowy licznik
  return adresKlienta(zadanie.headers) ?? "nieznane";
}

// zgloszenie to email + imie; wiekszy payload nie ma prawa istniec, a czytanie
// go w calosci przed walidacja byloby zaproszeniem do zapychania pamieci
const MAKS_CIALO_B = 4096;


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
  return NextResponse.json(
    { ok: true, ...(wynik.discountCode ? { discountCode: wynik.discountCode } : {}) },
    { headers: CORS },
  );
}
