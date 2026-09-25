import { getPool } from "../../../../../adapters/db/pool";
import { formatujDateICzas } from "../../../../../domain/daty";
import { listaDomen, type DomenaWysylkowa } from "../../../../../usecases/wysylka-konfiguracja/domeny";
import { odczytajSerwer, type WidokSerwera } from "../../../../../usecases/wysylka-konfiguracja/serwer";
import { odczytajLimit, RAMPA, type WidokLimitu } from "../../../../../usecases/wysylka-konfiguracja/limity";
import {
  odczytajSkrzynke,
  ostatnieRaporty,
  statystykaRaportow,
  type RaportWPanelu,
  type WidokSkrzynki,
} from "../../../../../usecases/wysylka-konfiguracja/skrzynka-zwrotna";
import type { StatusRekordu, WynikRekordu } from "../../../../../usecases/wysylka-konfiguracja/weryfikacja-dns";
import { wymaganyTenant } from "../../../../autoryzacja";
import { Komunikat, Naglowek } from "../../naglowek";
import {
  sprawdzDomeneAkcja,
  testujSerwerAkcja,
  testujSkrzynkeAkcja,
  usunDomeneAkcja,
  usunSkrzynkeAkcja,
  wyslijTestowaAkcja,
  zapiszLimitAkcja,
  zmienDomeneAkcja,
} from "./akcje";
import { FormularzDomeny } from "./formularz-domeny";
import { FormularzSerwera } from "./formularz-serwera";
import { FormularzSkrzynki } from "./formularz-skrzynki";
import { Kopiuj } from "./kopiuj";
import { PrzyciskAkcji } from "./przycisk";

export const dynamic = "force-dynamic";

export const metadata = { title: "Wysyłka i domeny" };

// Plakietka niesie KSZTAŁT i SŁOWO (NFR33): kwadrat dobry, trójkąt uwaga, okrąg problem,
// pusty kwadrat = jeszcze nie wiadomo. Słowa po polsku, nigdy surowe enumy.
const PLAKIETKA_REKORDU: Record<StatusRekordu, { klasa: string; slowo: string }> = {
  ok: { klasa: "plakietka-ok", slowo: "poprawny" },
  brak: { klasa: "plakietka-blad", slowo: "brak" },
  bledny: { klasa: "plakietka-blad", slowo: "błędny" },
  niesprawdzony: { klasa: "plakietka-uwaga", slowo: "nie sprawdzono" },
};

const PLAKIETKA_DOMENY: Record<string, { klasa: string; slowo: string }> = {
  verified: { klasa: "plakietka-ok", slowo: "zweryfikowana" },
  partial: { klasa: "plakietka-uwaga", slowo: "częściowo" },
  failed: { klasa: "plakietka-blad", slowo: "niezweryfikowana" },
  pending: { klasa: "plakietka-szkic", slowo: "nie sprawdzona" },
};

const NAZWY_REKORDOW = { spf: "SPF", dkim: "DKIM", dmarc: "DMARC" } as const;

/**
 * Werdykt „czy to konto może dziś wysyłać" — ta sama logika co wybierzWysylke() przed
 * partią (FR45), policzona z zapisanego stanu, bez sieci. Stoi na górze ekranu, bo to
 * jest jedyne pytanie, z którym ktoś tu przychodzi.
 */
function werdykt(serwer: WidokSerwera | null, domeny: DomenaWysylkowa[]): { klasa: string; slowo: string; opis: string } {
  if (!serwer) {
    return {
      klasa: "plakietka-uwaga",
      slowo: "adres techniczny",
      opis: domeny.length
        ? "Serwer wysyłkowy nie jest ustawiony, więc kampanie wychodzą z adresu technicznego panelu, a nie z Twojej domeny. Ustaw serwer niżej."
        : "Dodaj domenę i ustaw serwer wysyłkowy. Do tego czasu kampanie wychodzą z adresu technicznego panelu, a nie z Twojej domeny.",
    };
  }
  if (!serwer.polaczenieSprawdzoneAt) {
    return { klasa: "plakietka-blad", slowo: "wysyłka wstrzymana", opis: `Serwer ${serwer.host} nie przeszedł testu połączenia po ostatniej zmianie. Kliknij „Testuj połączenie”.` };
  }
  if (serwer.deweloperski) {
    return {
      klasa: "plakietka-uwaga",
      slowo: "tryb deweloperski",
      opis: `Serwer ${serwer.host}:${serwer.port} jest na liście SMTP_HOSTY_DEWELOPERSKIE: poczta zostaje w lokalnej skrzynce testowej i nie wychodzi do internetu. Blokada niezweryfikowanej domeny go nie dotyczy.`,
    };
  }
  if (serwer.statusDomeny !== "verified") {
    return {
      klasa: "plakietka-blad",
      slowo: "wysyłka zablokowana",
      opis: `Domena ${serwer.domenaNadawcy} nie jest zweryfikowana. Dopóki SPF, DKIM i DMARC nie są poprawne, nie wysyłamy z niej ani jednego maila — z niepodpisanej domeny poczta ląduje w spamie i psuje reputację na miesiące.`,
    };
  }
  return { klasa: "plakietka-ok", slowo: "gotowe do wysyłki", opis: `Kampanie wychodzą jako ${serwer.nazwaNadawcy} <${serwer.adresNadawcy}> przez ${serwer.host}.` };
}

export default async function WysylkaIDomeny({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21) — layout nie jest granicą autoryzacji
  await wymaganyTenant(tenantId);
  const { ok, blad } = await searchParams;
  const [domeny, serwer, konto, limit, skrzynka, raporty, statystyka] = await Promise.all([
    listaDomen(tenantId),
    odczytajSerwer(tenantId),
    getPool().query("select name from tenants where id = $1", [tenantId]),
    odczytajLimit(tenantId),
    odczytajSkrzynke(tenantId),
    ostatnieRaporty(tenantId, 15),
    statystykaRaportow(tenantId, 7),
  ]);
  const nazwaKonta = String(konto.rows[0]?.name ?? "");
  const stan = werdykt(serwer, domeny);

  return (
    <>
      <Naglowek
        tytul="Wysyłka i domeny"
        opis="Tu ustawiasz, z jakiej domeny i przez jaki serwer wychodzą Twoje kampanie. Domena musi mieć trzy rekordy DNS: SPF (kto może wysyłać), DKIM (podpis maila) i DMARC (co robić z podróbkami). Sprawdzamy je prawdziwymi zapytaniami DNS. Dopóki którykolwiek jest niepoprawny, wysyłka przez Twój serwer jest zablokowana — Gmail i Yahoo od 2024 roku odrzucają albo wrzucają do spamu pocztę masową bez nich."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="mx-auto max-w-[880px] space-y-4 p-4">
        {/* Werdykt na górze: jedno pytanie, jedna odpowiedź */}
        <section className="karta flex flex-wrap items-start gap-3 px-4 py-3.5" aria-label="Stan wysyłki">
          <span className={`plakietka ${stan.klasa}`}>{stan.slowo}</span>
          <p className="min-w-0 flex-1 text-[13px] leading-[20px] text-[var(--color-tekst-2)]">{stan.opis}</p>
        </section>

        {/* Krok 1: domena */}
        <section className="karta overflow-hidden">
          <div className="karta-naglowek">
            <div className="min-w-0">
              <h2>1. Domena wysyłkowa</h2>
              <p className="karta-opis mt-0.5">Rekordy ustawiasz u rejestratora domeny (home.pl, OVH, Cloudflare…). Propagacja trwa od kilku minut do 72 godzin.</p>
            </div>
          </div>
          {domeny.length === 0 ? (
            <div className="p-4">
              <p className="mb-4 max-w-[70ch] text-[14px] text-[var(--color-tekst-2)]">
                Żadna domena nie jest dodana. Dodaj tę, z której mają wychodzić kampanie — pokażemy, jakie rekordy ustawić, i sprawdzimy je w DNS.
              </p>
              <FormularzDomeny tenantId={tenantId} />
            </div>
          ) : (
            <>
              <ul className="divide-y divide-[var(--color-linia)]">
                {domeny.map((d) => (
                  <li key={d.id}>
                    <Domena tenantId={tenantId} d={d} uzywana={serwer?.domenaId === d.id} />
                  </li>
                ))}
              </ul>
              <details className="border-t border-[var(--color-linia)] px-4 py-3">
                <summary className="cursor-pointer text-[13px] font-medium text-[var(--color-tekst-2)]">Dodaj kolejną domenę</summary>
                <div className="pt-4">
                  <FormularzDomeny tenantId={tenantId} />
                </div>
              </details>
            </>
          )}
        </section>

        {/* Krok 2: serwer */}
        <section className="karta overflow-hidden">
          <div className="karta-naglowek">
            <div className="min-w-0">
              <h2>2. Serwer wysyłkowy</h2>
              <p className="karta-opis mt-0.5">Przez co fizycznie wychodzą maile.</p>
            </div>
          </div>

          {/* Zwykły opis, nie kontrolka: wyboru dziś nie ma, więc nie udajemy przełącznika (DESIGN.md: zero atrap) */}
          <p className="px-4 pt-4 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
            Kampanie wychodzą przez Twój własny serwer SMTP: skrzynkę firmową, Google Workspace, Microsoft 365 albo serwer hostingu.
            Infrastruktura MidRev (Amazon SES) jest w przygotowaniu; gdy będzie dostępna, pojawi się tu wybór.
          </p>

          {serwer ? <StanSerwera tenantId={tenantId} serwer={serwer} /> : null}

          <div className="mt-4 border-t border-[var(--color-linia)] p-4">
            <FormularzSerwera
              tenantId={tenantId}
              nazwaKonta={nazwaKonta}
              domeny={domeny.map((d) => d.domena)}
              // jawnie wybrane pola: hasło ani szyfrogram nie mają jak trafić do propsów klienta
              serwer={
                serwer
                  ? {
                      host: serwer.host,
                      port: serwer.port,
                      bezpieczenstwo: serwer.bezpieczenstwo,
                      uzytkownik: serwer.uzytkownik,
                      hasloUstawione: serwer.hasloUstawione,
                      nazwaNadawcy: serwer.nazwaNadawcy,
                      adresNadawcy: serwer.adresNadawcy,
                      odpowiedzDo: serwer.odpowiedzDo,
                    }
                  : null
              }
            />
          </div>
        </section>

        {/* Krok 3: limit dobowy */}
        <SekcjaLimitu tenantId={tenantId} limit={limit} />

        {/* Krok 4: skrzynka zwrotna */}
        <SekcjaSkrzynki tenantId={tenantId} serwer={serwer} skrzynka={skrzynka} raporty={raporty} statystyka={statystyka} />
      </div>
    </>
  );
}

function SekcjaLimitu({ tenantId, limit }: { tenantId: string; limit: WidokLimitu }) {
  const dniKolejki = limit.wKolejce > 0 ? Math.ceil(limit.wKolejce / limit.limit) : 0;
  const naRampie = RAMPA.find((r) => r.limit === limit.limit);
  return (
    <section className="karta overflow-hidden">
      <div className="karta-naglowek">
        <div className="min-w-0">
          <h2>3. Limit dobowy</h2>
          <p className="karta-opis mt-0.5">Ile wiadomości dziennie wolno wysłać z tego konta. Reszta kolejki czeka na następną dobę.</p>
        </div>
      </div>
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-[var(--color-tekst-3)]">Limit</dt>
            <dd>
              <span className="liczba font-medium">{limit.limit.toLocaleString("pl-PL")}</span> / dobę
              {limit.domyslny ? <span className="plakietka plakietka-szkic ml-2">domyślny</span> : null}
            </dd>
            <dt className="text-[var(--color-tekst-3)]">Dziś zarezerwowane</dt>
            <dd>
              <span className="liczba">{limit.zuzyteDzis.toLocaleString("pl-PL")}</span>, wolne <span className="liczba">{limit.wolneDzis.toLocaleString("pl-PL")}</span>
            </dd>
            <dt className="text-[var(--color-tekst-3)]">W kolejce</dt>
            <dd>
              <span className="liczba">{limit.wKolejce.toLocaleString("pl-PL")}</span>
              {dniKolejki > 1 ? <span className="text-[var(--color-tekst-2)]"> — przy tym limicie wyjdzie w {dniKolejki} dni</span> : null}
            </dd>
          </dl>
          <form action={zapiszLimitAkcja} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tenantId" value={tenantId} />
            <label className="block">
              <span className="etykieta mb-1.5 block">Nowy limit dobowy</span>
              <input name="limit" inputMode="numeric" required defaultValue={String(limit.limit)} className="pole liczba w-[160px]" />
            </label>
            <PrzyciskAkcji trwa="Zapisuję…" maly={false}>
              Zapisz limit
            </PrzyciskAkcji>
          </form>
          <p className="text-[12px] leading-[17px] text-[var(--color-tekst-3)]">
            Limit obowiązuje od następnej partii. Doba liczona jest według zegara bazy (UTC), kampania zatrzymana limitem wznawia się sama o północy.
          </p>
        </div>
        <div className="karta-plaska p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold">Rampowanie nowej domeny</span>
            {naRampie ? <span className="plakietka plakietka-nieaktywna">dzień {naRampie.dzien} rampy</span> : null}
          </div>
          <p className="mt-1.5 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
            Gmail i Microsoft oceniają nadawcę po pierwszych dniach wolumenu. Skok z zera do dziesięciu tysięcy kończy się w spamie na tygodnie.
            Podnoś limit co dwa–trzy dni, o ile odbicia i skargi trzymają się poniżej progów.
          </p>
          <table className="tabela mt-3">
            <thead>
              <tr>
                <th>Dzień</th>
                <th className="text-right">Limit / dobę</th>
              </tr>
            </thead>
            <tbody>
              {RAMPA.map((r) => (
                <tr key={r.dzien} className={r.limit === limit.limit ? "bg-[var(--color-akcent-tlo)]" : ""}>
                  <td>{r.dzien}</td>
                  <td className="liczba text-right">{r.limit.toLocaleString("pl-PL")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

const NAZWY_RODZAJU: Record<string, string> = { dsn: "raport DSN", arf: "skarga", heurystyka: "odbicie bez DSN", nie_odbicie: "nie odbicie" };
const NAZWY_ZDARZENIA: Record<string, { slowo: string; klasa: string }> = {
  bounced: { slowo: "odbicie", klasa: "plakietka-blad" },
  complained: { slowo: "skarga", klasa: "plakietka-blad" },
  delivered: { slowo: "dostarczono", klasa: "plakietka-ok" },
  dropped: { slowo: "odrzucono", klasa: "plakietka-uwaga" },
};
const NAZWY_WYNIKU: Record<string, string> = {
  zapisane: "zapisane",
  brak_wiadomosci: "nie dopasowano do wiadomości",
  pominiete: "pominięte",
  brak_daty: "bez daty",
  nie_jest_skarga: "nie jest skargą",
  opoznienie: "opóźnienie (serwer ponawia)",
  blad: "błąd odczytu",
};
const NAZWY_KLASY: Record<string, string> = { hard: "twarde", soft: "miękkie", undetermined: "nieustalone" };

function SekcjaSkrzynki({
  tenantId,
  serwer,
  skrzynka,
  raporty,
  statystyka,
}: {
  tenantId: string;
  serwer: WidokSerwera | null;
  skrzynka: WidokSkrzynki | null;
  raporty: RaportWPanelu[];
  statystyka: { odbicia: number; skargi: number; niedopasowane: number };
}) {
  const sprawdzona = skrzynka?.polaczenieSprawdzoneAt != null;
  return (
    <section className="karta overflow-hidden">
      <div className="karta-naglowek">
        <div className="min-w-0">
          <h2>4. Skrzynka zwrotna (odbicia)</h2>
          <p className="karta-opis mt-0.5">
            Serwery odbiorców odsyłają raporty o odbiciach na adres nadawcy. Czytamy tę skrzynkę przez IMAP co 5 minut: martwe adresy trafiają na wykluczenia, skargi wstrzymują wysyłkę, a wskaźniki reputacji mają z czego liczyć.
          </p>
        </div>
      </div>

      {!serwer ? (
        <p className="p-4 text-[14px] text-[var(--color-tekst-2)]">Najpierw ustaw serwer wysyłkowy (sekcja 2). Skrzynka zwrotna to zwykle ta sama skrzynka, z której wychodzą kampanie.</p>
      ) : null}

      {!skrzynka && serwer ? (
        <p role="status" className="mx-4 mt-4 rounded-md border border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-3 py-2 text-[13px] text-[var(--color-czeka)]">
          Skrzynka zwrotna nie jest ustawiona. Bez niej dostarczalność jest ślepa: twarde odbicia nie trafiają na wykluczenia, skargi nie wstrzymują wysyłki, a progi reputacji nie mają czego liczyć.
        </p>
      ) : null}

      {skrzynka ? (
        <div className="space-y-3 border-b border-[var(--color-linia)] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold">
              {skrzynka.host}:<span className="liczba">{skrzynka.port}</span>
            </span>
            {sprawdzona && !skrzynka.ostatniBladTestu ? (
              <span className="plakietka plakietka-ok">połączenie działa</span>
            ) : (
              <span className="plakietka plakietka-blad">{skrzynka.ostatniBladTestu ? "ostatni test nieudany" : "niesprawdzona"}</span>
            )}
            {skrzynka.deweloperski ? <span className="plakietka plakietka-uwaga">serwer deweloperski</span> : null}
          </div>
          <p className="text-[13px] text-[var(--color-tekst-2)]">
            Użytkownik {skrzynka.uzytkownik} · folder {skrzynka.skrzynka}
            {skrzynka.ostatniOdczytAt ? (
              <>
                {" "}· ostatni odczyt <span className="liczba">{formatujDateICzas(skrzynka.ostatniOdczytAt)}</span>
              </>
            ) : (
              <> · jeszcze nie czytana</>
            )}
          </p>
          {skrzynka.ostatniBladTestu || skrzynka.ostatniBladOdczytu ? (
            <p role="status" className="rounded-md border border-[var(--color-blad)] bg-[var(--color-blad-tlo)] px-3 py-2 text-[13px] text-[var(--color-blad)]">
              {skrzynka.ostatniBladTestu ?? skrzynka.ostatniBladOdczytu}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <form action={testujSkrzynkeAkcja}>
              <input type="hidden" name="tenantId" value={tenantId} />
              <PrzyciskAkcji trwa="Łączę się…" maly={false}>
                Testuj skrzynkę
              </PrzyciskAkcji>
            </form>
            <form action={usunSkrzynkeAkcja}>
              <input type="hidden" name="tenantId" value={tenantId} />
              <PrzyciskAkcji trwa="Usuwam…" wariant="przycisk-niebezpieczny">
                Usuń skrzynkę
              </PrzyciskAkcji>
            </form>
          </div>
        </div>
      ) : null}

      {serwer ? (
        <div className="p-4">
          <FormularzSkrzynki
            tenantId={tenantId}
            podpowiedzUzytkownika={serwer.uzytkownik ?? serwer.adresNadawcy}
            skrzynka={
              skrzynka
                ? {
                    host: skrzynka.host,
                    port: skrzynka.port,
                    bezpieczenstwo: skrzynka.bezpieczenstwo,
                    uzytkownik: skrzynka.uzytkownik,
                    hasloUstawione: skrzynka.hasloUstawione,
                    skrzynka: skrzynka.skrzynka,
                  }
                : null
            }
          />
        </div>
      ) : null}

      {skrzynka ? (
        <div className="border-t border-[var(--color-linia)]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[13px] text-[var(--color-tekst-2)]">
            <span className="font-medium text-[var(--color-tekst)]">Ostatnie 7 dni:</span>
            <span>
              odbicia <span className="liczba">{statystyka.odbicia}</span>
            </span>
            <span>
              skargi <span className="liczba">{statystyka.skargi}</span>
            </span>
            <span>
              niedopasowane <span className="liczba">{statystyka.niedopasowane}</span>
            </span>
          </div>
          {raporty.length === 0 ? (
            <p className="pusty-stan-w-tabeli px-4 pb-4 text-[13px] text-[var(--color-tekst-3)]">Jeszcze żadnego raportu. Pojawią się tu po pierwszych odbiciach z kampanii.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Kiedy</th>
                    <th>Adres</th>
                    <th>Rodzaj</th>
                    <th>Zdarzenie</th>
                    <th>Kod</th>
                    <th>Wynik</th>
                  </tr>
                </thead>
                <tbody>
                  {raporty.map((r) => {
                    const z = r.typZdarzenia ? NAZWY_ZDARZENIA[r.typZdarzenia] : null;
                    return (
                      <tr key={r.id}>
                        <td className="liczba whitespace-nowrap">{formatujDateICzas(r.kiedy)}</td>
                        <td className="break-all">{r.adres ?? "—"}</td>
                        <td>{NAZWY_RODZAJU[r.rodzaj] ?? r.rodzaj}</td>
                        <td>
                          {z ? (
                            <span className={`plakietka ${z.klasa}`}>
                              {z.slowo}
                              {r.klasa ? ` ${NAZWY_KLASY[r.klasa] ?? ""}` : ""}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="font-mono text-[12px]">{r.kodSmtp ?? "—"}</td>
                        <td className="text-[var(--color-tekst-2)]">{NAZWY_WYNIKU[r.wynik] ?? r.wynik}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function Domena({ tenantId, d, uzywana }: { tenantId: string; d: DomenaWysylkowa; uzywana: boolean }) {
  const plakietka = PLAKIETKA_DOMENY[d.status] ?? PLAKIETKA_DOMENY.pending;
  const raport = d.raport;
  const wyniki: Record<"spf" | "dkim" | "dmarc", WynikRekordu | null> = {
    spf: raport?.spf ?? null,
    dkim: raport?.dkim ?? null,
    dmarc: raport?.dmarc ?? null,
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold">{d.domena}</span>
            <span className={`plakietka ${plakietka.klasa}`}>{plakietka.slowo}</span>
            {uzywana ? <span className="plakietka plakietka-nieaktywna">adres nadawcy</span> : null}
          </div>
          <div className="mt-1 text-[13px] text-[var(--color-tekst-3)]">
            {d.sprawdzonoAt ? (
              <>
                sprawdzono <span className="liczba">{formatujDateICzas(d.sprawdzonoAt)}</span>
              </>
            ) : (
              "jeszcze nie sprawdzono"
            )}
          </div>
        </div>
        <form action={sprawdzDomeneAkcja}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="domainId" value={d.id} />
          <PrzyciskAkcji trwa="Pytam DNS…" wariant="" maly={false}>
            Sprawdź teraz
          </PrzyciskAkcji>
        </form>
      </div>

      {d.bladSprawdzenia ? (
        <p role="status" className="rounded-md border border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-3 py-2 text-[13px] text-[var(--color-czeka)]">
          Ostatnie sprawdzenie nie dało odpowiedzi: {d.bladSprawdzenia} Poniżej wynik z poprzedniego udanego sprawdzenia.
        </p>
      ) : null}

      {/* Tabela Host / Typ / Wartość — wzorzec Klaviyo Settings → Domains */}
      <div className="overflow-x-auto rounded-[10px] border border-[var(--color-linia)]">
        <table className="tabela">
          <thead>
            <tr>
              <th>Rekord</th>
              <th>Host</th>
              <th>Typ</th>
              <th>Wartość</th>
              <th>Stan</th>
            </tr>
          </thead>
          <tbody>
            {d.rekordy.map((r) => {
              const w = wyniki[r.rodzaj];
              const p = w ? PLAKIETKA_REKORDU[w.status] : null;
              return (
                <tr key={r.rodzaj}>
                  <td className="font-medium">{NAZWY_REKORDOW[r.rodzaj]}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-[12px] break-all" title={r.pelnaNazwa}>{r.host}</code>
                      <Kopiuj wartosc={r.host} etykieta={`host ${NAZWY_REKORDOW[r.rodzaj]}`} />
                    </div>
                  </td>
                  <td>{r.typ}</td>
                  <td className="max-w-[300px]">
                    <div className="flex items-center gap-2">
                      {w?.status === "ok" ? (
                        // rekord już jest: propozycja do wklejenia tylko by myliła (np. p=none przy p=quarantine)
                        <span className="text-[13px] text-[var(--color-tekst-2)]">ustawiony w DNS — szczegóły niżej</span>
                      ) : r.doSkopiowania ? (
                        <>
                          <code className="font-mono text-[12px] break-all">{r.wartosc}</code>
                          <Kopiuj wartosc={r.wartosc} etykieta={`wartość ${NAZWY_REKORDOW[r.rodzaj]}`} />
                        </>
                      ) : (
                        <span className="text-[13px] text-[var(--color-tekst-2)]">{r.wartosc}</span>
                      )}
                    </div>
                  </td>
                  <td>{p ? <span className={`plakietka ${p.klasa}`}>{p.slowo}</span> : <span className="plakietka plakietka-szkic">nie sprawdzono</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] leading-[17px] text-[var(--color-tekst-3)]">
        Host podajemy bez domeny — większość rejestratorów dopisuje ją sama. Jeśli Twój tego nie robi, wpisz pełną nazwę (najedź na host).
        Jeśli domena ma już rekord SPF, nie zakładaj drugiego: dopisz brakujący mechanizm do istniejącego.
      </p>

      {/* Co dokładnie poprawić — per rekord, tylko gdy jest raport */}
      {raport ? (
        <div className="space-y-2">
          {(["spf", "dkim", "dmarc"] as const).map((rodzaj) => {
            const w = wyniki[rodzaj];
            if (!w) return null;
            const p = PLAKIETKA_REKORDU[w.status];
            return (
              <div key={rodzaj} className="karta-plaska p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold">{NAZWY_REKORDOW[rodzaj]}</span>
                  <span className={`plakietka ${p.klasa}`}>{p.slowo}</span>
                  {rodzaj === "dmarc" && raport.dmarc.polityka ? (
                    <span className="text-[13px] text-[var(--color-tekst-2)]">polityka p={raport.dmarc.polityka}</span>
                  ) : null}
                </div>
                {w.problem ? <p className="mt-1.5 text-[13px] leading-[19px] text-[var(--color-tekst)]">{w.problem}</p> : null}
                {w.poprawka ? (
                  <p className="mt-1 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
                    <span className="font-medium">Co zrobić:</span> {w.poprawka}
                  </p>
                ) : null}
                {w.znaleziono ? (
                  <p className="mt-1.5 text-[12px] text-[var(--color-tekst-3)]">
                    W DNS: <code className="font-mono break-all" title={w.znaleziono}>{w.znaleziono.length > 160 ? `${w.znaleziono.slice(0, 160)}…` : w.znaleziono}</code>
                  </p>
                ) : null}
                {w.uwagi.length ? (
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[12px] leading-[17px] text-[var(--color-tekst-2)]">
                    {w.uwagi.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
          <p className="text-[12px] text-[var(--color-tekst-3)]">
            MX: {raport.mx.rekordy.length ? <span className="font-mono">{raport.mx.rekordy.join(", ")}</span> : null}
            {raport.mx.uwaga ? <span> {raport.mx.uwaga}</span> : null}
          </p>
        </div>
      ) : null}

      <details className="rounded-[8px] border border-[var(--color-linia-0)] px-3 py-2">
        <summary className="cursor-pointer text-[13px] text-[var(--color-tekst-2)]">Selektor DKIM i SPF dostawcy</summary>
        <form action={zmienDomeneAkcja} className="mt-3 space-y-3">
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="domainId" value={d.id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="etykieta mb-1.5 block">Selektor DKIM</span>
              <input name="selektorDkim" defaultValue={d.selektorDkim ?? ""} placeholder="np. google" className="pole font-mono text-[13px]" autoComplete="off" />
            </label>
            <label className="block">
              <span className="etykieta mb-1.5 block">SPF dostawcy</span>
              <input name="mechanizmSpf" defaultValue={d.mechanizmSpf ?? ""} placeholder="include:_spf.google.com" className="pole font-mono text-[13px]" autoComplete="off" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <PrzyciskAkcji trwa="Zapisuję i sprawdzam…">Zapisz i sprawdź</PrzyciskAkcji>
            <span className="text-[12px] text-[var(--color-tekst-3)]">Zmiana wymaga ponownej weryfikacji — do tego czasu wysyłka z domeny jest wstrzymana.</span>
          </div>
        </form>
        {!uzywana ? (
          <form action={usunDomeneAkcja} className="mt-3 border-t border-[var(--color-linia-0)] pt-3">
            <input type="hidden" name="tenantId" value={tenantId} />
            <input type="hidden" name="domainId" value={d.id} />
            <PrzyciskAkcji trwa="Usuwam…" wariant="przycisk-niebezpieczny">
              Usuń domenę
            </PrzyciskAkcji>
          </form>
        ) : null}
      </details>
    </div>
  );
}

function StanSerwera({ tenantId, serwer }: { tenantId: string; serwer: WidokSerwera }) {
  const sprawdzony = serwer.polaczenieSprawdzoneAt !== null;
  const bladOstatni = serwer.ostatniBladTestu;
  return (
    <div className="space-y-3 border-t border-[var(--color-linia)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-semibold">
          {serwer.host}:<span className="liczba">{serwer.port}</span>
        </span>
        {sprawdzony && !bladOstatni ? (
          <span className="plakietka plakietka-ok">połączenie działa</span>
        ) : sprawdzony && bladOstatni ? (
          <span className="plakietka plakietka-uwaga">ostatni test nieudany</span>
        ) : (
          <span className="plakietka plakietka-blad">niesprawdzony</span>
        )}
        {serwer.deweloperski ? <span className="plakietka plakietka-uwaga">serwer deweloperski</span> : null}
      </div>
      <p className="text-[13px] text-[var(--color-tekst-2)]">
        Nadawca: {serwer.nazwaNadawcy} &lt;{serwer.adresNadawcy}&gt;
        {serwer.odpowiedzDo ? <> · odpowiedzi na {serwer.odpowiedzDo}</> : null}
        {serwer.ostatniTestAt ? (
          <>
            {" "}· ostatni test <span className="liczba">{formatujDateICzas(serwer.ostatniTestAt)}</span>
          </>
        ) : null}
      </p>
      {bladOstatni ? (
        <p role="status" className="rounded-md border border-[var(--color-blad)] bg-[var(--color-blad-tlo)] px-3 py-2 text-[13px] text-[var(--color-blad)]">
          {bladOstatni}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <form action={testujSerwerAkcja}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <PrzyciskAkcji trwa="Łączę się…" maly={false}>
            Testuj połączenie
          </PrzyciskAkcji>
        </form>
        <form action={wyslijTestowaAkcja} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tenantId" value={tenantId} />
          <label className="block">
            <span className="etykieta mb-1.5 block">Wiadomość testowa na adres</span>
            <input name="adres" type="email" required placeholder="ty@firma.pl" className="pole w-[240px]" />
          </label>
          <PrzyciskAkcji trwa="Wysyłam…" maly={false}>
            Wyślij test
          </PrzyciskAkcji>
        </form>
      </div>
    </div>
  );
}
