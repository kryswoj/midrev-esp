import { adresSledzenia, config } from "../../../../../config";
import { formatujDateICzas } from "../../../../../domain/daty";
import { formaOdmiany } from "../../../../../domain/liczebniki";
import { zapewnijKluczStrony } from "../../../../../usecases/integracja/klucz-strony";
import { feedTenanta, statystykiKatalogu } from "../../../../../usecases/katalog/katalog";
import { wymaganyTenant } from "../../../../autoryzacja";
import { Kopiuj } from "../../../../_dns/kopiuj";
import { Alert, Badge, Card, CardHeader, Field, Input, PrzyciskFormularza, Textarea } from "../../../../ui";
import { Komunikat, Naglowek } from "../../naglowek";
import { wymienKluczAkcja, zapiszFeedAkcja, zapiszUstawieniaAkcja } from "./akcje";
import { PodgladNaZywo } from "./podglad-na-zywo";

export const dynamic = "force-dynamic";

export const metadata = { title: "Własna strona / inny sklep" };

const DOMYSLNA_ZGODA =
  "Zapisuję się na newsletter i zgadzam się na otrzymywanie wiadomości e-mail z ofertami i nowościami. Zgodę mogę wycofać w każdej chwili, klikając link w stopce wiadomości.";

function Krok({ numer, tytul, opis, id, children }: { numer: number; tytul: string; opis: string; id: string; children: React.ReactNode }) {
  return (
    <section id={id} className="formularz-sekcja scroll-mt-24">
      <div className="formularz-sekcja-opis">
        <div className="flex items-center gap-2.5">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--color-akcent-tlo)] text-[12px] font-semibold text-[var(--color-akcent)]">{numer}</span>
          <h3>{tytul}</h3>
        </div>
        <p>{opis}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Przelacznik({ nazwa, wlaczony, tytul, opis }: { nazwa: string; wlaczony: boolean; tytul: string; opis: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-[var(--color-powierzchnia-2)]">
      <input type="checkbox" name={nazwa} value="tak" defaultChecked={wlaczony} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-akcent)]" />
      <span className="min-w-0">
        <span className="block text-[14px] font-medium leading-5 text-[var(--color-tekst)]">{tytul}</span>
        <span className="block text-[13px] leading-[19px] text-[var(--color-tekst-2)]">{opis}</span>
      </span>
    </label>
  );
}

function Kod({ tekst, etykieta }: { tekst: string; etykieta: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-linia)] bg-[var(--color-powierzchnia-2)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-linia-0)] px-3 py-1.5">
        <span className="text-[12px] font-medium text-[var(--color-tekst-2)]">{etykieta}</span>
        <Kopiuj wartosc={tekst} etykieta={etykieta} />
      </div>
      <pre className="overflow-x-auto px-3 py-3 text-[12px] leading-[18px] text-[var(--color-tekst)]"><code>{tekst}</code></pre>
    </div>
  );
}

export default async function WlasnaStrona({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21)
  await wymaganyTenant(tenantId);
  const { ok, blad } = await searchParams;
  const [klucz, feed, katalog] = await Promise.all([zapewnijKluczStrony(tenantId), feedTenanta(tenantId), statystykiKatalogu(tenantId)]);
  const adres = adresSledzenia();
  const srcSkryptu = `${adres}/js/v1/${klucz.id}.js`;
  const snippet = `<!-- MidRev -->\n<script async src="${srcSkryptu}"></script>\n<script>window.midrev=window.midrev||[];window._learnq=window._learnq||[];</script>`;
  const stronaTestowa = klucz.domeny[0] ? `https://${klucz.domeny[0]}/?mrv_debug=1` : null;

  const przykladIdentify = `// po zalogowaniu albo zapisie (tak samo jak w Klaviyo: _learnq / klaviyo)
midrev.identify({ email: "jan@example.com", first_name: "Jan" });

// zdarzenie własne
midrev.track("Zapisał się na webinar", { webinar: "Longevity 101" });

// karta produktu (gdy nie masz GA4 ecommerce)
midrev.track("Viewed Product", {
  ProductID: "123", ProductName: "Krem", Price: 89.9,
  URL: location.href, ImageURL: "https://…/krem.jpg", Categories: ["Pielęgnacja"]
});

// zgoda na cookies, gdy baner nie jest wykrywany automatycznie
midrev.consent.grant();   // albo midrev.consent.revoke()

// zapis na newsletter z formularza na stronie (treść zgody = klauzula z panelu)
midrev.subscribe({ email: "jan@example.com", consentText: "${(klucz.tekstZgody ?? DOMYSLNA_ZGODA).replace(/"/g, '\\"').slice(0, 80)}…", listId: "<id listy>" });`;
  const przykladSerwer = `curl -X POST ${config().APP_URL}/api/events/ \\
  -H "Authorization: Klaviyo-API-Key <klucz prywatny z Ustawienia > Klucze API>" \\
  -H "revision: 2025-01-15" -H "Content-Type: application/json" \\
  -d '{"data":{"type":"event","attributes":{
        "metric":{"data":{"type":"metric","attributes":{"name":"Placed Order"}}},
        "profile":{"data":{"type":"profile","attributes":{"email":"jan@example.com"}}},
        "properties":{"OrderId":"1001","ItemNames":["Krem"]},
        "value":89.9,"value_currency":"PLN","unique_id":"1001"}}}'`;

  return (
    <>
      <Naglowek
        tytul="Własna strona / inny sklep"
        powrot={{ href: `/t/${tenantId}/sklepy`, etykieta: "Sklep i integracje" }}
        opis="Dla sklepów bez gotowej integracji: własny sklep, Magento, PrestaShop, IdoSell, strony i landingi. Jeden kod na stronie daje rozpoznawanie osób, oglądane produkty, koszyk i formularze, tak jak skrypt Klaviyo."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        <div className="flex w-full max-w-[960px] flex-col gap-6">
          <Card>
            <CardHeader
              title="Podłącz stronę"
              description="Pięć kroków. Wystarczą pierwsze dwa, resztę możesz zrobić później."
              action={<Badge ton="neutral">klucz strony: {klucz.id}</Badge>}
            />

            <Krok numer={1} id="kod" tytul="Wklej kod na stronę" opis="Wklej przed zamknięciem </head> na każdej podstronie. Jeśli masz już kod Klaviyo, zamień go na ten.">
              <div className="space-y-3">
                <Kod tekst={snippet} etykieta="Kod strony" />
                <details className="group rounded-lg border border-[var(--color-linia)] px-3 py-2">
                  <summary className="cursor-pointer text-[14px] font-medium">Używasz Google Tag Manager?</summary>
                  <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
                    <li>W GTM: Tagi → Nowy → Konfiguracja tagu → <b>Niestandardowy kod HTML</b>.</li>
                    <li>Wklej kod z ramki powyżej.</li>
                    <li>Reguła: <b>Wszystkie strony</b> (All Pages). Zapisz i opublikuj kontener.</li>
                    <li>
                      Zamiast kodu możesz zaimportować gotowy szablon:{" "}
                      <a className="text-[var(--color-akcent)] underline" href="/integracja/midrev-gtm.tpl" download>
                        midrev-gtm.tpl
                      </a>{" "}
                      (Szablony → Nowy → menu ⋮ → Importuj), a w tagu wpisz klucz strony <code>{klucz.id}</code>.
                    </li>
                  </ol>
                </details>
              </div>
            </Krok>

            <Krok numer={2} id="ustawienia" tytul="Co ma się dziać" opis="Bez zgody na cookies skrypt niczego nie zapisuje i nikogo nie śledzi. Formularze działają zawsze.">
              <form action={zapiszUstawieniaAkcja} className="space-y-4">
                <input type="hidden" name="tenantId" value={tenantId} />
                <Field label="Adres Twojej strony" htmlFor="domeny" hint="Np. mojsklep.pl. Kilka adresów oddziel przecinkiem. Subdomeny (www, sklep.) są wliczone.">
                  <Input id="domeny" name="domeny" defaultValue={klucz.domeny.join(", ")} placeholder="mojsklep.pl" autoComplete="off" />
                </Field>
                <div className="-mx-3 space-y-0.5">
                  <Przelacznik nazwa="ga4" wlaczony={klucz.ga4} tytul="Odczytuj zdarzenia z Google Analytics 4" opis="Jeśli sklep ma GA4 z e-commerce, oglądane produkty, koszyk i rozpoczęte zamówienia złapiemy bez dodatkowego kodu." />
                  <Przelacznik nazwa="identyfikacjaZLinkow" wlaczony={klucz.identyfikacjaZLinkow} tytul="Rozpoznawaj osoby, które klikną w maila" opis="Link do Twojej strony dostaje jednorazowy kod ważny 90 dni (bez adresu e-mail). Dopisz to do polityki prywatności." />
                  <Przelacznik nazwa="zaladujFormularze" wlaczony={klucz.zaladujFormularze} tytul="Pokazuj formularze i popupy" opis="Aktywne formularze z zakładki Formularze pojawią się na stronie bez osobnego kodu." />
                  <Przelacznik nazwa="wymagajZgodyCookies" wlaczony={klucz.wymagajZgodyCookies} tytul="Czekaj na zgodę na cookies" opis="Zalecane. Rozpoznajemy Google Consent Mode, Cookiebot, CookieYes, OneTrust, Complianz i WP Consent API. Wyłącz tylko, gdy zgodę zbierasz inaczej i wywołujesz midrev.consent.grant()." />
                  <Przelacznik nazwa="ograniczOriginy" wlaczony={klucz.ograniczOriginy} tytul="Przyjmuj dane tylko z mojej strony" opis="Zdarzenia z innych adresów będą odrzucane. Wyłącz na czas testów na stronie testowej." />
                </div>
                <details className="rounded-lg border border-[var(--color-linia)] px-3 py-2">
                  <summary className="cursor-pointer text-[14px] font-medium">Zapis na newsletter z własnych formularzy</summary>
                  <div className="mt-3 space-y-3">
                    <p className="text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
                      Formularz na Twojej stronie może zapisywać osoby przez <code>midrev.subscribe</code>. Przyjmiemy zapis tylko z dokładnie tą treścią zgody, a w rejestrze zgód zapiszemy ją jako dowód. Puste pole = zapis z formularzy strony wyłączony.
                    </p>
                    <Field label="Treść zgody przy polu wyboru" htmlFor="tekstZgody">
                      <Textarea id="tekstZgody" name="tekstZgody" defaultValue={klucz.tekstZgody ?? ""} placeholder={DOMYSLNA_ZGODA} rows={3} />
                    </Field>
                    <Field label="Adres polityki prywatności" htmlFor="politykaUrl">
                      <Input id="politykaUrl" name="politykaUrl" defaultValue={klucz.politykaUrl ?? ""} placeholder="https://mojsklep.pl/polityka-prywatnosci" />
                    </Field>
                  </div>
                </details>
                <PrzyciskFormularza trwa="Zapisuję…">Zapisz ustawienia</PrzyciskFormularza>
              </form>
            </Krok>

            <Krok numer={3} id="katalog" tytul="Katalog produktów" opis="Adres feedu produktów, tego samego co do Google Shopping albo Ceneo (XML albo CSV). Produkty trafią do bloków w mailach.">
              <form action={zapiszFeedAkcja} className="space-y-3">
                <input type="hidden" name="tenantId" value={tenantId} />
                <Field label="Adres feedu" htmlFor="url" hint="Odświeżamy co 6 godzin. Bez feedu katalog uzupełnia się z oglądanych produktów.">
                  <Input id="url" name="url" defaultValue={feed?.url ?? ""} placeholder="https://mojsklep.pl/feed/google.xml" inputMode="url" />
                </Field>
                <div className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="teraz" value="tak" />
                  <PrzyciskFormularza variant="secondary" trwa="Pobieram feed…">Zapisz i pobierz teraz</PrzyciskFormularza>
                  <span className="text-[13px] text-[var(--color-tekst-2)]">
                    W katalogu: <span className="liczba">{katalog.zFeedu}</span> {formaOdmiany(katalog.zFeedu, "produkt", "produkty", "produktów")} z feedu
                    {katalog.zPrzegladarki ? <>, <span className="liczba">{katalog.zPrzegladarki}</span> ze strony</> : null}
                  </span>
                </div>
                {feed?.status === "blad" ? (
                  <Alert tone="blad" title="Ostatnie pobranie się nie udało">{feed.blad}</Alert>
                ) : feed?.ostatnio ? (
                  <p className="text-[12px] text-[var(--color-tekst-3)]">Ostatnio pobrany {formatujDateICzas(feed.ostatnio)} · następne {formatujDateICzas(feed.nastepne)}</p>
                ) : null}
              </form>
            </Krok>

            <Krok numer={4} id="sprawdz" tytul="Sprawdź połączenie" opis="Otwórz swoją stronę w drugiej karcie, zaakceptuj cookies i wejdź na produkt. Wpisy pojawią się tu same.">
              <PodgladNaZywo tenantId={tenantId} stronaTestowa={stronaTestowa} />
            </Krok>

            <Krok numer={5} id="programista" tytul="Dla programisty" opis="Kod zgodny z Klaviyo: _learnq.push i klaviyo.identify działają bez zmian. Zamówienia wysyłaj z serwera.">
              <div className="space-y-3">
                <details className="rounded-lg border border-[var(--color-linia)] px-3 py-2" open>
                  <summary className="cursor-pointer text-[14px] font-medium">Przeglądarka: identify, track, zgoda</summary>
                  <div className="mt-3"><Kod tekst={przykladIdentify} etykieta="JavaScript" /></div>
                </details>
                <details className="rounded-lg border border-[var(--color-linia)] px-3 py-2">
                  <summary className="cursor-pointer text-[14px] font-medium">Serwer: zamówienia (Placed Order) przez API</summary>
                  <div className="mt-3 space-y-2">
                    <p className="text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
                      Zamówienia wysyłaj z serwera (adblock nie zgubi zamówienia, a <code>unique_id</code> = numer zamówienia chroni przed duplikatami). Ten sam format co Klaviyo <code>POST /api/events</code>; klucz prywatny utworzysz w{" "}
                      <a className="text-[var(--color-akcent)] underline" href={`/t/${tenantId}/ustawienia/klucze-api`}>Ustawienia → Klucze API</a>.
                      W n8n i Make wystarczy w istniejącym węźle Klaviyo zmienić adres i klucz.
                    </p>
                    <Kod tekst={przykladSerwer} etykieta="curl" />
                  </div>
                </details>
                <details className="rounded-lg border border-[var(--color-linia)] px-3 py-2">
                  <summary className="cursor-pointer text-[14px] font-medium">Nowy klucz strony</summary>
                  <form action={wymienKluczAkcja} className="mt-3 space-y-3">
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <p className="text-[13px] leading-[19px] text-[var(--color-tekst-2)]">Klucz strony jest jawny (stoi w kodzie strony) i pozwala tylko wysyłać dane, nie czytać. Wymień go, gdy ktoś nadużywa go na obcej stronie. Stary kod przestanie działać w ciągu minuty.</p>
                    <label className="flex items-start gap-2 text-[13px]">
                      <input type="checkbox" name="potwierdzam" value="tak" className="mt-0.5 h-4 w-4 accent-[var(--color-akcent)]" />
                      Rozumiem, że trzeba będzie wkleić nowy kod na stronę.
                    </label>
                    <PrzyciskFormularza variant="danger" size="sm" trwa="Wymieniam…">Wymień klucz strony</PrzyciskFormularza>
                  </form>
                </details>
              </div>
            </Krok>
          </Card>
        </div>
      </div>
    </>
  );
}
