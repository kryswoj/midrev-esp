import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wymaganyTenant } from "../../../../autoryzacja";
import { getPool } from "../../../../../adapters/db/pool";
import { klauzulaCheckoutu } from "../../../../../usecases/integracja/woo-wtyczka";
import { stanImportuSklepu } from "../../../../../usecases/sklep/kreator-sklepu";
import { Badge, Card, CardHeader, Field, Input, PrzyciskFormularza, Textarea } from "../../../../ui";
import { Komunikat, Naglowek } from "../../naglowek";
import { FormularzPodlaczenia } from "../formularz-podlaczenia";
import { GotoweAutomatyzacje } from "../gotowe-automatyzacje";
import { wcAuthAkcja, zapiszKlauzuleAkcja } from "./akcje";
import { ImportHistorii } from "./import-historii";
import { KodParowania } from "./kod-parowania";
import { SprawdzPolaczenie } from "./na-zywo";

export const dynamic = "force-dynamic";

export const metadata = { title: "Połącz WooCommerce" };

function wersjaPaczki(): string | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "public", "integracja", "midrev-esp-woocommerce.json"), "utf8")).wersja ?? null;
  } catch {
    return null;
  }
}

function Krok({ numer, tytul, opis, id, gotowy, children }: { numer: number; tytul: string; opis: string; id: string; gotowy?: boolean; children: React.ReactNode }) {
  return (
    <section id={id} className="formularz-sekcja scroll-mt-24">
      <div className="formularz-sekcja-opis">
        <div className="flex items-center gap-2.5">
          <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${gotowy ? "bg-[var(--color-ok)] text-white" : "bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]"}`}>{gotowy ? "✓" : numer}</span>
          <h3>{tytul}</h3>
        </div>
        <p>{opis}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export default async function PolaczWoo({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ ok?: string; blad?: string; wc_auth?: string }> }) {
  const { tenantId } = await params;
  await wymaganyTenant(tenantId);
  const { ok, blad, wc_auth } = await searchParams;
  const { rows } = await getPool().query<{ id: string; base_url: string; connection_method: string | null; status: string }>(
    `select id, base_url, connection_method, status from stores
      where tenant_id = $1 and platform = 'woocommerce' order by (status = 'connected') desc, created_at desc limit 1`,
    [tenantId],
  );
  const sklep = rows[0] ?? null;
  const polaczony = sklep?.status === "connected";
  const zWtyczka = polaczony && sklep?.connection_method === "wtyczka";
  const [klauzula, importu] = sklep ? await Promise.all([klauzulaCheckoutu(tenantId, sklep.id), stanImportuSklepu(tenantId, sklep.id)]) : [null, null];
  const wersja = wersjaPaczki();

  return (
    <>
      <Naglowek
        tytul="Połącz WooCommerce"
        powrot={{ href: `/t/${tenantId}/sklepy`, etykieta: "Sklep i integracje" }}
        opis="Wtyczka MidRev łączy sklep w 3 minuty: zamówienia, katalog, porzucony koszyk i zamówienie z linkiem odtwarzającym koszyk, zgoda na newsletter w kasie. Bez kopiowania kluczy."
      />
      <Komunikat ok={ok ?? (wc_auth === "powrot" ? "Wróciłeś ze sklepu. Jeśli zatwierdziłeś dostęp, połączenie pojawi się poniżej w ciągu kilku sekund." : undefined)} blad={blad} />
      <div className="tresc-strony">
        <div className="flex w-full max-w-[960px] flex-col gap-6">
          <Card>
            <CardHeader
              title="Połącz sklep wtyczką"
              description="Zalecane. Wszystko, co daje Klaviyo na WooCommerce."
              action={polaczony ? <Badge ton="ok">{zWtyczka ? "połączony wtyczką" : sklep?.connection_method === "wc_auth" ? "wersja podstawowa" : "połączony kluczami"}</Badge> : undefined}
            />
            {zWtyczka ? (
              <details className="border-b border-[var(--color-linia-0)] px-6 py-3 max-md:px-4">
                <summary className="cursor-pointer text-[14px] font-medium">
                  ✓ Wtyczka zainstalowana i połączona z {sklep!.base_url.replace(/^https?:\/\//, "")} <span className="font-normal text-[var(--color-tekst-2)]">· pobierz ponownie albo połącz inny sklep</span>
                </summary>
                <div className="-mx-6 max-md:-mx-4">
            <Krok numer={1} id="pobierz" gotowy={zWtyczka} tytul="Pobierz wtyczkę" opis="Plik zip, który wgrasz do WordPressa. Wymaga WooCommerce 8 lub nowszego.">
                <a className="przycisk" href="/integracja/midrev-esp-woocommerce.zip" download>
                  Pobierz wtyczkę{wersja ? ` (wersja ${wersja})` : ""}
                </a>
              </Krok>
              <Krok numer={2} id="zainstaluj" gotowy={zWtyczka} tytul="Zainstaluj w sklepie" opis="W panelu WordPressa sklepu.">
                <ol className="list-decimal space-y-1 pl-5 text-[14px] leading-[21px] text-[var(--color-tekst-2)]">
                  <li>Wtyczki → Dodaj nową → <b>Wyślij wtyczkę na serwer</b>.</li>
                  <li>Wybierz pobrany plik i kliknij <b>Zainstaluj</b>, potem <b>Włącz</b>.</li>
                  <li>W menu WooCommerce pojawi się pozycja <b>MidRev ESP</b>.</li>
                </ol>
              </Krok>
              <Krok numer={3} id="kod" gotowy={zWtyczka} tytul="Połącz kodem" opis="Wtyczka sama utworzy klucz REST i powiadomienia o zamówieniach.">
                <KodParowania tenantId={tenantId} adresDomyslny={sklep?.base_url ?? ""} />
              </Krok>
                  </div>
              </details>
            ) : (
              <>
            <Krok numer={1} id="pobierz" gotowy={zWtyczka} tytul="Pobierz wtyczkę" opis="Plik zip, który wgrasz do WordPressa. Wymaga WooCommerce 8 lub nowszego.">
              <a className="przycisk" href="/integracja/midrev-esp-woocommerce.zip" download>
                Pobierz wtyczkę{wersja ? ` (wersja ${wersja})` : ""}
              </a>
            </Krok>
            <Krok numer={2} id="zainstaluj" gotowy={zWtyczka} tytul="Zainstaluj w sklepie" opis="W panelu WordPressa sklepu.">
              <ol className="list-decimal space-y-1 pl-5 text-[14px] leading-[21px] text-[var(--color-tekst-2)]">
                <li>Wtyczki → Dodaj nową → <b>Wyślij wtyczkę na serwer</b>.</li>
                <li>Wybierz pobrany plik i kliknij <b>Zainstaluj</b>, potem <b>Włącz</b>.</li>
                <li>W menu WooCommerce pojawi się pozycja <b>MidRev ESP</b>.</li>
              </ol>
            </Krok>
            <Krok numer={3} id="kod" gotowy={zWtyczka} tytul="Połącz kodem" opis="Wtyczka sama utworzy klucz REST i powiadomienia o zamówieniach.">
              <KodParowania tenantId={tenantId} adresDomyslny={sklep?.base_url ?? ""} />
            </Krok>
              </>
            )}
            <Krok numer={4} id="sprawdz" tytul="Sprawdź połączenie" opis={"Otwórz sklep, zaakceptuj cookies, obejrzyj produkt i\u00a0dodaj go do koszyka. Kropki zapalą się same."}>
              <p className="mb-3 rounded-lg bg-[var(--color-powierzchnia-3)] px-3 py-2.5 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
                {"Porzucone koszyki i\u00a0zamówienia działają po zgodzie na cookies: bez niej wtyczka nie wysyła zdarzeń koszyka ani kasy. Jeśli sklep nie ma wtyczki cookies zgodnej z\u00a0WP Consent API, zainstaluj np. Complianz albo CookieYes."}
              </p>
              <SprawdzPolaczenie tenantId={tenantId} />
            </Krok>
            <Krok numer={5} id="import" gotowy={importu?.stan === "gotowe"} tytul="Import historii" opis="Zamówienia i klienci z przeszłości: do raportów, segmentów i winbacku. Nie wysyła maili.">
              {sklep && polaczony ? <ImportHistorii tenantId={tenantId} storeId={sklep.id} poczatkowy={importu!} /> : <p className="text-[13px] text-[var(--color-tekst-2)]">Dostępny po połączeniu sklepu.</p>}
            </Krok>
          </Card>

          {sklep && polaczony ? (
            <Card id="zgoda" className="scroll-mt-24">
              <CardHeader title="Zgoda na newsletter w kasie" description="Pole wyboru pod formularzem zamówienia, domyślnie niezaznaczone. Każda zmiana treści to nowa wersja: w rejestrze zgód zostaje dokładnie ten tekst, który widział kupujący." action={klauzula ? <Badge ton="neutral">wersja {klauzula.wersja}</Badge> : undefined} />
              <form action={zapiszKlauzuleAkcja} className="space-y-4 p-6 max-md:p-4">
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="storeId" value={sklep.id} />
                <Field label="Treść zgody" htmlFor="tresc" hint="Od 20 do 2000 znaków, bez HTML.">
                  <Textarea id="tresc" name="tresc" rows={3} defaultValue={klauzula?.tresc ?? ""} />
                </Field>
                <Field label="Polityka prywatności" htmlFor="polityka" hint="Link pokaże się obok pola wyboru.">
                  <Input id="polityka" name="polityka" defaultValue={klauzula?.polityka ?? ""} placeholder="https://mojsklep.pl/polityka-prywatnosci" />
                </Field>
                <PrzyciskFormularza variant="secondary" trwa="Zapisuję…">Zapisz nową wersję</PrzyciskFormularza>
              </form>
            </Card>
          ) : null}

          {polaczony ? <GotoweAutomatyzacje tenantId={tenantId} powrot={`/t/${tenantId}/sklepy/woocommerce`} uwaga={!zWtyczka ? "Bez wtyczki porzucony koszyk i zamówienie nie mają zdarzeń, więc te automatyzacje nie ruszą." : undefined} /> : null}

          <Card id="bez-wtyczki" className={`scroll-mt-24 ${zWtyczka ? "hidden" : ""}`}>
            <CardHeader title="Bez wtyczki: wersja podstawowa" description="Gdy nie możesz instalować wtyczek. Jedno kliknięcie „Zatwierdź” w sklepie daje zamówienia, klientów i katalog." />
            <div className="space-y-4 p-6 max-md:p-4">
              <ul className="grid gap-1 text-[13px] leading-5 text-[var(--color-tekst-2)] sm:grid-cols-2">
                <li>✓ zamówienia, klienci, katalog</li>
                <li>✓ po zakupie, winback, przychód z maili</li>
                <li>✗ porzucony koszyk i zamówienie</li>
                <li>✗ link odtwarzający koszyk</li>
                <li>✗ zgoda na newsletter w kasie</li>
                <li>✗ oglądane produkty bez wklejenia kodu strony</li>
              </ul>
              <form action={wcAuthAkcja} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="tenantId" value={tenantId} />
                <Field label="Adres sklepu (https)" htmlFor="adres-wc" className="min-w-[260px] flex-1">
                  <Input id="adres-wc" name="adres" defaultValue={sklep?.base_url ?? ""} placeholder="https://mojsklep.pl" />
                </Field>
                <PrzyciskFormularza variant="secondary" trwa="Przekierowuję…">Połącz bez wtyczki</PrzyciskFormularza>
              </form>
              <details className="rounded-lg border border-[var(--color-linia)] px-3 py-2">
                <summary className="cursor-pointer text-[14px] font-medium">Mam już klucze REST (dla programisty)</summary>
                <div className="mt-3"><FormularzPodlaczenia tenantId={tenantId} /></div>
              </details>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
