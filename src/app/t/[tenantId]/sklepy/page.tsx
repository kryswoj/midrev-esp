import { wymaganyTenant } from "../../../autoryzacja";
import { formatujDate, formatujDateICzas } from "../../../../domain/daty";
import { nazwaMozliwosci } from "../../../../domain/statusy";
import { sklepyZeStanemWebhookow } from "../../../../adapters/store/stan-webhookow";
import type { StanWebhookow, WpisWebhooka } from "../../../../adapters/store/webhooki";
import { ocenSklep, PROG_CISZY_GODZIN, type OcenaSklepu } from "../../../../usecases/cisza-sklepow";
import { kluczStronyTenanta } from "../../../../usecases/integracja/klucz-strony";
import { importujAkcja } from "../../../akcje";
import { Alert, Badge, Button, Card, PrzyciskFormularza, CardBody, CardHeader, EmptyState, Icon, MobileList, MobileListItem, Table, TBody, Td, Th, THead } from "../../../ui";
import { Komunikat, Naglowek } from "../naglowek";
import { odswiezWebhokiAkcja } from "./akcje";
import { FormularzPodlaczenia } from "./formularz-podlaczenia";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sklep i integracje" };

/**
 * Tematy webhookow po polsku. DESIGN.md: zadnych surowych enumow platformy sklepowej
 * w interfejsie - operator ma wiedziec, CO nie dochodzi, a nie jak Woo to nazywa.
 */
const NAZWY_TEMATOW: Record<string, string> = {
  "order.created": "nowe zamówienie",
  "order.updated": "zmiana zamówienia",
  "customer.created": "nowy klient",
  "customer.updated": "zmiana danych klienta",
};

const NAZWY_STANOW: Record<string, string> = {
  aktywny: "aktywny",
  wstrzymany: "wstrzymany w sklepie",
  wylaczony: "wyłączony w sklepie",
  brak: "nie założony",
  blad: "błąd",
};

// plakietka niesie KSZTALT, nie tylko kolor (DESIGN: kwadrat dobry, trojkat uwaga,
// okrag problem) - informacja zostaje przy daltonizmie i na wydruku
function klasaStanu(stan: WpisWebhooka["stan"]): string {
  if (stan === "aktywny") return "plakietka-ok";
  if (stan === "wstrzymany") return "plakietka-uwaga";
  return "plakietka-blad";
}

export default async function Sklepy({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const { ok, blad } = await searchParams;
  const [sklepy, kluczStrony] = await Promise.all([sklepyZeStanemWebhookow(tenantId), kluczStronyTenanta(tenantId)]);

  return (
    <>
      <Naglowek
        tytul="Sklep i integracje"
        opis="To jest ustawienie konta, nie codzienne narzędzie: sklep podłącza się raz i potem sprawdza tylko wtedy, gdy dane przestały dochodzić. Klucze REST generuje merchant po swojej stronie. Sprawdzamy każde uprawnienie osobno, zanim cokolwiek zapiszemy, bo klucze bez dostępu do zamówień przechodzą zwykły test połączenia, a import kończy się pustym wynikiem wyglądającym jak sklep bez historii. Po podłączeniu zakładamy w sklepie webhooki i potwierdzamy ich stan odczytem zwrotnym: sklep, który przestał dosyłać dane, wygląda tak samo jak sklep bez sprzedaży."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        <div className="flex w-full max-w-[900px] flex-col gap-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <a href="#woocommerce" className="karta flex items-start gap-3 p-4 transition-colors hover:border-[var(--color-akcent)]">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]"><Icon name="sklep" size={18} /></span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-[var(--color-tekst)]">WooCommerce</span>
                <span className="block text-[13px] leading-[19px] text-[var(--color-tekst-2)]">Zamówienia, klienci i webhooki przez klucze REST.</span>
              </span>
            </a>
            <a href={`/t/${tenantId}/sklepy/wlasna-strona`} className="karta flex items-start gap-3 p-4 transition-colors hover:border-[var(--color-akcent)]">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]"><Icon name="formularz" size={18} /></span>
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-[14px] font-semibold text-[var(--color-tekst)]">
                  Własna strona / inny sklep
                  {kluczStrony?.domeny.length ? <Badge ton="ok">podłączona</Badge> : null}
                </span>
                <span className="block text-[13px] leading-[19px] text-[var(--color-tekst-2)]">Jeden kod jak w Klaviyo: Magento, PrestaShop, IdoSell, własny sklep, landing.</span>
              </span>
            </a>
          </div>
          {sklepy.length === 0 ? (
            <Card>
              <CardHeader title="Podłączony sklep" description="Źródło zamówień, profili i zdarzeń dla tego konta." />
              <EmptyState icon="sklep" title="Sklep nie jest jeszcze podłączony" description="Panel nie ma jeszcze skąd pobierać zamówień ani profili. Użyj formularza poniżej, aby połączyć WooCommerce." />
            </Card>
          ) : (
            <div className="space-y-6">
              {sklepy.map((s) => {
                const ocena = s.status === "connected" ? ocenSklep(s) : null;
                return (
                  <Card key={s.id}>
                    <CardHeader
                      title={<span className="flex min-w-0 items-center gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]"><Icon name="sklep" size={18} /></span><span className="truncate">{s.base_url.replace(/^https?:\/\//, "")}</span></span>}
                      description={<>WooCommerce · dodany <span className="liczba">{formatujDate(s.created_at)}</span></>}
                      action={
                        <div className="flex flex-col items-start gap-1.5 sm:items-end">
                          <Badge ton={s.status === "connected" ? "ok" : "blad"}>{s.status === "connected" ? "połączony" : "błąd połączenia"}</Badge>
                          <span className="tekst-meta">
                            {ocena?.ostatnieZdarzenieAt ? <>Ostatnie zdarzenie <span className="liczba">{formatujDateICzas(ocena.ostatnieZdarzenieAt)}</span></> : "Brak odebranych zdarzeń"}
                          </span>
                        </div>
                      }
                    />

                    <section className="formularz-sekcja">
                      <div className="formularz-sekcja-opis">
                        <h3>Uprawnienia</h3>
                        <p>Dostęp potwierdzony podczas połączenia ze sklepem.</p>
                      </div>
                      <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {/* stan webhookow lezy w tym samym jsonb co uprawnienia, ale jest obiektem,
                            nie flaga - plakietki uprawnien pokazuja wylacznie wartosci logiczne */}
                        {Object.entries(s.capabilities ?? {})
                          .filter(([, wartosc]) => typeof wartosc === "boolean")
                          .map(([nazwa, wartosc]) => (
                            <span key={nazwa} className={`grid min-w-0 grid-cols-[18px_minmax(0,1fr)] gap-x-2 rounded-lg px-3 py-2.5 ${wartosc ? "bg-[var(--color-powierzchnia-3)]" : "bg-[var(--color-czeka-tlo)]"}`}>
                              <Icon name={wartosc ? "check" : "uwaga"} size={16} className={`row-span-2 mt-0.5 ${wartosc ? "text-[var(--color-ok)]" : "text-[var(--color-czeka)]"}`} />
                              <span className="truncate text-[13px] leading-[18px] font-medium text-[var(--color-tekst)]">{nazwaMozliwosci(nazwa)}</span>
                              <span className={`text-[12px] leading-4 ${wartosc ? "text-[var(--color-ok)]" : "font-medium text-[var(--color-czeka)]"}`}>{wartosc ? "dostęp" : "brak dostępu"}</span>
                            </span>
                          ))}
                      </div>
                    </section>

                    <section className="formularz-sekcja">
                      <div className="formularz-sekcja-opis">
                        <h3>Webhooki</h3>
                        <p>Bieżące zamówienia i zmiany klientów powinny docierać bez ręcznego importu.</p>
                      </div>
                      <Dosylanie
                        stan={s.stan}
                        ocena={ocena}
                        akcja={
                          <form action={odswiezWebhokiAkcja}>
                            <input type="hidden" name="tenantId" value={tenantId} />
                            <input type="hidden" name="storeId" value={s.id} />
                            <PrzyciskFormularza variant="secondary" size="sm" trwa="Sprawdzam…">Sprawdź webhooki</PrzyciskFormularza>
                          </form>
                        }
                      />
                    </section>

                    <section className="formularz-sekcja items-center">
                      <div className="formularz-sekcja-opis">
                        <h3>Import historii</h3>
                        <p>Pobierz wcześniejsze zamówienia i profile ze sklepu.</p>
                      </div>
                      <form action={importujAkcja}>
                        <input type="hidden" name="tenantId" value={tenantId} />
                        <input type="hidden" name="storeId" value={s.id} />
                        <PrzyciskFormularza variant="secondary" trwa="Uruchamiam import…">Importuj historię</PrzyciskFormularza>
                      </form>
                    </section>
                  </Card>
                );
              })}
            </div>
          )}

          <Card id="woocommerce">
            <CardHeader title={sklepy.length === 0 ? "Podłącz sklep WooCommerce" : "Dodaj kolejny sklep WooCommerce"} description="Klucze są sprawdzane przed zapisaniem, a po połączeniu panel zakłada wymagane webhooki." />
            <CardBody className="p-0 max-md:p-0">
              <FormularzPodlaczenia tenantId={tenantId} />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * Sekcja "Dosylanie danych": czy sklep realnie przysyla zdarzenia, a nie czy kiedys
 * odpowiedzial na POST-a. Cisza ma tu wlasny wiersz, bo brak danych bez tego wyglada
 * dokladnie jak brak sprzedazy.
 */
function Dosylanie({ stan, ocena, akcja }: { stan: StanWebhookow | null; ocena: OcenaSklepu | null; akcja: React.ReactNode }) {
  // stan bez wpisow to rowniez "nie zalozone": pusty rekord potrafi powstac
  // od samego znacznika alertu o ciszy, a pusta tabela nic operatorowi nie mowi
  if (!stan || (stan.wpisy.length === 0 && !stan.blad)) {
    return (
      <div className="flex flex-col gap-4 rounded-lg border border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="uwaga" size={18} className="mt-0.5 shrink-0 text-[var(--color-czeka)]" />
          <div className="min-w-0">
            <p className="tekst-pomocniczy font-semibold !text-[var(--color-tekst)]">Webhooki wymagają konfiguracji</p>
            <p className="tekst-pomocniczy mt-0.5">Bez nich nowe zamówienia nie trafią do panelu.</p>
          </div>
        </div>
        <div className="shrink-0 pl-[30px] sm:pl-0">{akcja}</div>
      </div>
    );
  }

  const aktywnych = stan.wpisy.filter((w) => w.stan === "aktywny").length;
  const wszystkich = stan.wpisy.length;
  const dobrze = ocena ? !ocena.milczy : aktywnych === wszystkich && !stan.blad;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Badge ton={dobrze ? "ok" : ocena?.webhookiAktywne ? "uwaga" : "blad"}>
            {dobrze
              ? "dosyła dane"
              : ocena?.webhookiAktywne
                ? `milczy od ${Math.floor(ocena.godzinBezZdarzen)} h`
                : "nie dosyła danych"}
          </Badge>
          <span className="tekst-pomocniczy">
            webhooki: <span className="liczba">{aktywnych}</span> z{" "}
            <span className="liczba">{wszystkich}</span> aktywne · sprawdzone{" "}
            <span className="liczba">{formatujDateICzas(stan.sprawdzonyAt)}</span>
          </span>
        </div>
        {akcja}
      </div>

      {stan.blad && (
        <Alert tone="blad" title="Sklep odrzucił konfigurację webhooków">{stan.blad}</Alert>
      )}

      {ocena?.milczy && ocena.webhookiAktywne && (
        <Alert tone="uwaga" title="Sklep przestał dosyłać dane">
          Webhooki są aktywne, ale przez ponad <span className="liczba">{PROG_CISZY_GODZIN}</span> h
          nie przyszło żadne zdarzenie. Najczęstsza przyczyna: sklep nie odpala wp-crona
          (WooCommerce dosyła webhooki właśnie z niego) albo WordPress blokuje dostawę na nasz
          adres.
        </Alert>
      )}

      <div className="hidden overflow-hidden rounded-lg border border-[var(--color-linia)] bg-[var(--color-powierzchnia)] md:block">
        <Table>
          <THead>
            <tr>
              <Th>Zdarzenie</Th>
              <Th>Stan</Th>
              <Th num>Potwierdzone w sklepie</Th>
            </tr>
          </THead>
          <TBody>
            {stan.wpisy.map((w) => (
              <tr key={w.temat}>
                <Td>{NAZWY_TEMATOW[w.temat] ?? w.temat}</Td>
                <Td>
                  <span className={`plakietka ${klasaStanu(w.stan)}`}>
                    {NAZWY_STANOW[w.stan] ?? w.stan}
                  </span>
                  {w.blad && (
                    <span className="tekst-pomocniczy ml-2 !text-[var(--color-tekst-3)]">{w.blad}</span>
                  )}
                </Td>
                <Td num className="text-[var(--color-tekst-2)]">{w.potwierdzonyAt ? formatujDateICzas(w.potwierdzonyAt) : "—"}</Td>
              </tr>
            ))}
          </TBody>
        </Table>
      </div>

      <MobileList className="rounded-lg border border-[var(--color-linia)]">
        {stan.wpisy.map((w) => (
          <MobileListItem key={`${w.temat}-mobile`}>
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium">{NAZWY_TEMATOW[w.temat] ?? w.temat}</span>
              <span className={`plakietka ${klasaStanu(w.stan)}`}>{NAZWY_STANOW[w.stan] ?? w.stan}</span>
            </div>
            <div className="tekst-pomocniczy mt-2 !text-[var(--color-tekst-3)]">
              {w.blad ?? (w.potwierdzonyAt ? `Potwierdzone ${formatujDateICzas(w.potwierdzonyAt)}` : "Brak potwierdzenia")}
            </div>
          </MobileListItem>
        ))}
      </MobileList>

      <p className="tekst-pomocniczy mt-3 !text-[var(--color-tekst-3)]">
        Ostatnie zdarzenie ze sklepu:{" "}
        <span className="liczba">
          {ocena?.ostatnieZdarzenieAt ? formatujDateICzas(ocena.ostatnieZdarzenieAt) : "—"}
        </span>
        {ocena && (
          <>
            {" "}
            · w ostatniej dobie <span className="liczba">{ocena.zdarzen24h}</span>
          </>
        )}
      </p>
    </div>
  );
}
