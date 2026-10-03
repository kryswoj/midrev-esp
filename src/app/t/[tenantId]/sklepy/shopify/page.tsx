import { config } from "../../../../../config";
import { formatujDateICzas } from "../../../../../domain/daty";
import { sklepyShopifyTenanta } from "../../../../../usecases/shopify/sklep";
import { stanShopify } from "../../../../../usecases/shopify/stan";
import { wymaganyTenant } from "../../../../autoryzacja";
import { Kopiuj } from "../../../../_dns/kopiuj";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, PrzyciskFormularza } from "../../../../ui";
import { Komunikat, Naglowek } from "../../naglowek";
import { GotoweAutomatyzacje } from "../gotowe-automatyzacje";
import { sprawdzPonownieAkcja, zapiszAplikacjeAkcja } from "./akcje";
import { PasekImportu, SprawdzNaZywo } from "./na-zywo";
import { PlanImportu } from "./plan-importu";

export const dynamic = "force-dynamic";

export const metadata = { title: "Shopify" };

/**
 * Kreator „Połącz Shopify” (plan F.1): aplikacja → instalacja → włącz w motywie → sprawdź
 * połączenie → import historii → automatyzacje. Jeden ekran z krokami, każdy krok mówi, czy
 * jest zrobiony. Kafel na ekranie „Sklep i integracje” prowadzi tutaj.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Krok({ numer, tytul, opis, id, zrobiony, children }: { numer: number; tytul: string; opis: string; id: string; zrobiony?: boolean; children: React.ReactNode }) {
  return (
    <section id={id} className="formularz-sekcja scroll-mt-24">
      <div className="formularz-sekcja-opis">
        <div className="flex items-center gap-2.5">
          <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${zrobiony ? "bg-[var(--color-ok)] text-white" : "bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]"}`}>
            {zrobiony ? "✓" : numer}
          </span>
          <h3>{tytul}</h3>
        </div>
        <p>{opis}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export default async function Shopify({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string; sklep?: string; zainstalowano?: string }>;
}) {
  const { tenantId } = await params;
  await wymaganyTenant(tenantId);
  const q = await searchParams;
  const sklepy = await sklepyShopifyTenanta(tenantId);
  const sklep = (q.sklep && UUID.test(q.sklep) ? sklepy.find((s) => s.id === q.sklep) : null) ?? sklepy[0] ?? null;
  const stan = sklep ? await stanShopify(tenantId, sklep.id) : null;
  const polaczony = sklep?.status === "connected";
  const app = config().APP_URL;
  const pkt = (k: string) => stan?.punkty.find((p) => p.klucz === k)?.ok ?? false;

  const formularz = (
    <form action={zapiszAplikacjeAkcja} className="flex flex-col gap-3">
      <input type="hidden" name="tenantId" value={tenantId} />
      <Field label="Adres sklepu" htmlFor="adres" hint={"nazwa-sklepu.myshopify.com (Ustawienia > Domeny w\u00a0panelu Shopify)"}>
        <Input id="adres" name="adres" required defaultValue={sklep?.domena ?? ""} placeholder="twoj-sklep.myshopify.com" autoComplete="off" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Client ID" htmlFor="clientId">
          <Input id="clientId" name="clientId" required defaultValue={sklep?.poswiadczenia.clientId ?? ""} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Client secret" htmlFor="clientSecret" hint={sklep ? "Zapisany i zaszyfrowany. Zostaw puste, jeśli się nie zmienił." : "Trzymamy go zaszyfrowanego, nie pokażemy go ponownie."}>
          <Input id="clientSecret" name="clientSecret" type="password" required={!sklep} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <div>
        <PrzyciskFormularza trwa="Zapisuję…" variant={sklep ? "secondary" : "primary"}>{sklep ? "Zapisz zmiany" : "Zapisz aplikację"}</PrzyciskFormularza>
      </div>
    </form>
  );

  return (
    <>
      <Naglowek
        tytul="Shopify"
        powrot={{ href: `/t/${tenantId}/sklepy`, etykieta: "Sklep i integracje" }}
        opis="Aplikacja MidRev w sklepie Shopify: zamówienia, porzucone checkouty z linkiem powrotu, zgody, katalog i formularze. Bez wklejania kodu w motyw."
      />
      <Komunikat ok={q.ok} blad={q.blad} />
      {q.zainstalowano ? (
        <div className="pb-4">
          <Alert tone="ok" title="Aplikacja zainstalowana">{"Został jeden krok w\u00a0sklepie: włącz MidRev w\u00a0motywie (krok 3)."}</Alert>
        </div>
      ) : null}

      <div className="tresc-strony">
        <div className="flex w-full max-w-[960px] flex-col gap-6">
          <Card>
            <CardHeader
              title={sklep ? sklep.domena : "Połącz sklep Shopify"}
              description={
                sklep
                  ? polaczony
                    ? <>Połączony{sklep.zainstalowanyAt ? <> · zainstalowano <span className="liczba">{formatujDateICzas(sklep.zainstalowanyAt)}</span></> : null}</>
                    : sklep.status === "pending"
                      ? "Aplikacja zapisana, czeka na instalację w sklepie."
                      : (sklep.ostatniBlad ?? "Połączenie wymaga uwagi.")
                  : "Około 2 minut po stronie sklepu. Aplikację dla klienta przygotowuje MidRev (instrukcja w dokumentacji wdrożenia)."
              }
              action={sklep ? <Badge ton={polaczony ? "ok" : sklep.status === "pending" ? "uwaga" : "blad"}>{polaczony ? "połączony" : sklep.status === "pending" ? "czeka na instalację" : "wymaga uwagi"}</Badge> : null}
            />

            <Krok numer={1} id="aplikacja" tytul="Aplikacja klienta" zrobiony={Boolean(sklep)} opis={"Adres sklepu i\u00a0dane aplikacji z\u00a0Shopify Dev Dashboard. Każdy sklep ma własną aplikację MidRev."}>
              {sklep ? (
                <details className="group">
                  <summary className="cursor-pointer text-[14px] leading-5 text-[var(--color-tekst)] marker:text-[var(--color-tekst-3)]">
                    <span className="font-medium">{sklep.domena}</span> <span className="tekst-meta">· Client ID {sklep.poswiadczenia.clientId.slice(0, 8)}… · zmień dane aplikacji</span>
                  </summary>
                  <div className="pt-3">{formularz}</div>
                </details>
              ) : (
                formularz
              )}
            </Krok>

            {sklep ? (
              <>
                <Krok numer={2} id="instalacja" tytul="Instalacja w sklepie" zrobiony={polaczony} opis="Klient otwiera link instalacyjny z Dev Dashboard (Dystrybucja) i klika „Zainstaluj”. Wracamy tu sami.">
                  <div className="flex flex-col gap-3">
                    {polaczony ? (
                      <Alert tone="ok">Dostęp potwierdzony. Zakresy: {stan?.zakresy.join(", ") || "brak"}.</Alert>
                    ) : (
                      <Alert tone={sklep.status === "error" ? "blad" : "info"}>
                        {sklep.status === "error" && sklep.ostatniBlad ? `${sklep.ostatniBlad} ` : ""}Po kliknięciu „Zainstaluj” Shopify przekieruje na MidRev, a ta strona pokaże kolejny krok.
                      </Alert>
                    )}
                    {polaczony ? null : <div className="grid gap-2 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
                      <span>Adresy do ustawienia w aplikacji (Dev Dashboard &gt; Wersje):</span>
                      <span className="flex flex-wrap items-center gap-2"><code className="break-all">{app}/api/shopify/auth</code><Kopiuj wartosc={`${app}/api/shopify/auth`} etykieta="Adres aplikacji" /></span>
                      <span className="flex flex-wrap items-center gap-2"><code className="break-all">{app}/api/shopify/callback</code><Kopiuj wartosc={`${app}/api/shopify/callback`} etykieta="Adres powrotu" /></span>
                    </div>}
                  </div>
                </Krok>

                <Krok numer={3} id="motyw" tytul="Włącz w motywie" zrobiony={pkt("skrypt")} opis="Jedno kliknięcie w edytorze motywu: formularze i popupy MidRev bez wklejania kodu.">
                  <div className="flex flex-col items-start gap-2">
                    <Button href={stan?.linkMotywu} variant={pkt("skrypt") ? "secondary" : "primary"} powodBlokady={polaczony ? undefined : "Najpierw zainstaluj aplikację."}>
                      Otwórz edytor motywu
                    </Button>
                    <p className="tekst-meta">W edytorze kliknij „Zapisz” w prawym górnym rogu. Piksel zdarzeń włączyliśmy już sami.</p>
                  </div>
                </Krok>

                <Krok numer={4} id="sprawdz" tytul="Sprawdź połączenie" zrobiony={pkt("zamowienia") && pkt("piksel")} opis="Kropki zapalają się, gdy zobaczymy zdarzenie ze sklepu.">
                  <div className="flex flex-col gap-3">
                    <SprawdzNaZywo tenantId={tenantId} storeId={sklep.id} poczatkowy={stan} />
                    {polaczony ? (
                      <form action={sprawdzPonownieAkcja}>
                        <input type="hidden" name="tenantId" value={tenantId} />
                        <input type="hidden" name="storeId" value={sklep.id} />
                        <PrzyciskFormularza trwa="Sprawdzam w Shopify…" variant="secondary" size="sm">Napraw powiadomienia i piksel</PrzyciskFormularza>
                      </form>
                    ) : null}
                  </div>
                </Krok>

                <Krok numer={5} id="import" tytul="Import historii" zrobiony={stan?.import?.status === "done"} opis="Zamówienia z 24 miesięcy, klienci ze zgodą i katalog. Bez wysyłki maili.">
                  {stan?.import ? (
                    <PasekImportu tenantId={tenantId} storeId={sklep.id} poczatkowy={stan} />
                  ) : polaczony ? (
                    <PlanImportu tenantId={tenantId} storeId={sklep.id} />
                  ) : (
                    <p className="tekst-meta">Dostępny po instalacji aplikacji.</p>
                  )}
                </Krok>

                {/* id kroku inny niż karty: „Utwórz”/„Włącz” na wspólnej karcie wracają z kotwicą #automatyzacje */}
                <Krok numer={6} id="krok-automatyzacje" tytul="Automatyzacje" opis="Porzucony checkout, porzucony koszyk, oglądany produkt, powitanie, po zakupie.">
                  <div className="flex flex-col items-start gap-2">
                    <Alert tone="uwaga" title="Wyłącz przypomnienie Shopify">
                      Shopify ma własny mail o porzuconym checkoucie (Ustawienia &gt; Powiadomienia). Wyłącz go, zanim włączysz automatyzację w MidRev, inaczej klient dostanie dwa maile.
                    </Alert>
                    {polaczony ? (
                      <Button href="#automatyzacje" variant="secondary">Gotowe automatyzacje niżej</Button>
                    ) : (
                      <p className="tekst-meta">Dostępne po instalacji aplikacji.</p>
                    )}
                  </div>
                </Krok>
              </>
            ) : (
              <section className="formularz-sekcja">
                <div className="formularz-sekcja-opis">
                  <h3>Co dalej</h3>
                  <p>Po zapisaniu aplikacji kreator poprowadzi przez resztę.</p>
                </div>
                <ol className="grid gap-2">
                  {["Instalacja w\u00a0sklepie (klient klika „Zainstaluj”)", "Włącz w\u00a0motywie (jedno kliknięcie)", "Sprawdź połączenie na żywo", "Import historii z\u00a0paskiem postępu", "Automatyzacje e-commerce"].map((t, i) => (
                    <li key={t} className="flex items-center gap-2.5 text-[14px] leading-5 text-[var(--color-tekst-2)]">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--color-linia)] text-[12px] font-semibold text-[var(--color-tekst-3)]">{i + 2}</span>
                      {t}
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </Card>
          {/* wspólna karta szablonów sklepu (Woo, Shopify, własna strona): szablony stoją na rolach
              metryk, które instalacja Shopify ustawia (started_checkout = shopify/Started Checkout) */}
          {polaczony ? (
            <GotoweAutomatyzacje
              tenantId={tenantId}
              powrot={`/t/${tenantId}/sklepy/shopify`}
              uwaga="Najpierw wyłącz w Shopify mail o porzuconym checkoucie (krok 6), inaczej klient dostanie dwa maile."
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
