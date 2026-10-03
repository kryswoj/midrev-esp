import { adresSledzenia } from "../../../../config";
import { NAZWY_TYPOW } from "../../../../domain/formularze/model";
import { formatujDate } from "../../../../domain/daty";
import { listaFormularzy, type PozycjaListy } from "../../../../usecases/popupy/formularze";
import { wynikiFormularzyTenanta } from "../../../../usecases/popupy/wyswietlenia";
import { Kopiuj } from "../../../_dns/kopiuj";
import { wymaganyTenant } from "../../../autoryzacja";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Icon, MobileList, MobileListItem, Table, TBody, Td, Th, THead } from "../../../ui";
import { Komunikat, Naglowek } from "../naglowek";
import { akcjaListyFormularzy } from "./akcje";
import { PodgladFormularza, StylePodgladu } from "./podglad";

export const dynamic = "force-dynamic";

// Nazwa ekranu poszła za nawigacją: „Formularze zapisu”. „Popup” to jeden z typów.
export const metadata = { title: "Formularze zapisu" };

function Status({ f }: { f: PozycjaListy }) {
  return (
    <span className="flex flex-col items-start gap-1">
      {f.status === "na_zywo" ? <Badge ton="ok">na stronie</Badge> : f.status === "wstrzymany" ? <Badge ton="nieaktywna">wstrzymany</Badge> : <Badge ton="szkic">szkic</Badge>}
      {f.niepublikowaneZmiany ? <span className="text-[12px] text-[var(--color-czeka)]">niepublikowane zmiany</span> : null}
    </span>
  );
}

function Miniatura({ f }: { f: PozycjaListy }) {
  return (
    <span className="relative block h-[60px] w-[84px] shrink-0 overflow-hidden rounded-md border border-[var(--color-linia)] bg-[#eef0f3]" aria-hidden="true">
      {f.podglad ? (
        <span className="pointer-events-none absolute left-1/2 top-1.5 block w-[440px] origin-top -translate-x-1/2" style={{ zoom: 0.17 }}>
          <PodgladFormularza def={f.podglad} krok={f.podglad.kroki[0]} statyczny bezNakladki />
        </span>
      ) : null}
    </span>
  );
}

function Menu({ tenantId, f }: { tenantId: string; f: PozycjaListy }) {
  const pozycja = "flex w-full items-center rounded-md px-3 py-2 text-left text-[13px] hover:bg-[var(--color-powierzchnia-2)]";
  return (
    <details className="group relative">
      <summary className="grid h-8 w-8 cursor-pointer list-none place-items-center rounded-lg text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] max-md:h-11 max-md:w-11" aria-label={`Więcej działań: ${f.nazwa}`}>
        <span aria-hidden="true" className="text-[18px] leading-none">⋯</span>
      </summary>
      <div className="absolute right-0 top-9 z-20 w-56 rounded-[10px] border border-[var(--color-linia)] bg-white p-1 shadow-[var(--cien-uniesiony)]">
        <form action={akcjaListyFormularzy}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="popupId" value={f.id} />
          <button name="akcja" value="duplikuj" className={pozycja}>Duplikuj</button>
          {f.status === "na_zywo" ? <button name="akcja" value="wstrzymaj" className={pozycja}>Wstrzymaj (zdejmij ze strony)</button> : null}
          {f.status === "wstrzymany" ? <button name="akcja" value="wlacz" className={pozycja}>Włącz ponownie</button> : null}
          <button name="akcja" value="archiwizuj" className={`${pozycja} text-[var(--color-blad)]`}>Przenieś do archiwum</button>
        </form>
      </div>
    </details>
  );
}

export default async function Formularze({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granicą auth
  await wymaganyTenant(tenantId);
  const { ok, blad } = await searchParams;
  const [formularze, wyniki] = await Promise.all([listaFormularzy(tenantId), wynikiFormularzyTenanta(tenantId, 30)]);
  const snippet = `<script src="${adresSledzenia()}/s/${tenantId}" async></script>`;
  const procent = (w: { wyswietlenia: number; zapisy: number } | undefined) => (w && w.wyswietlenia > 0 ? `${(Math.round((w.zapisy / w.wyswietlenia) * 1000) / 10).toLocaleString("pl-PL")}%` : "–");

  return (
    <>
      <StylePodgladu />
      <Naglowek
        tytul="Formularze zapisu"
        opis="Popupy, karty wysuwane w rogu i formularze osadzone na stronie sklepu. Każdy zapis tworzy profil, zgodę z tekstem, który osoba zaznaczyła, i wpis na wybranej liście."
        akcja={<Button href={`/t/${tenantId}/popupy/nowy`}><Icon name="dodaj" size={16} />Utwórz formularz</Button>}
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        <Card>
          <CardHeader title="Twoje formularze" description="Wyświetlenia, zapisy i konwersja z ostatnich 30 dni." />
          {formularze.length === 0 ? (
            <EmptyState
              icon="formularz"
              title="Nie ma jeszcze formularza zapisu"
              description="Wybierz szablon, dopasuj wygląd i opublikuj. Formularz pojawi się w sklepie dopiero po publikacji."
              action={<Button href={`/t/${tenantId}/popupy/nowy`}>Utwórz pierwszy formularz</Button>}
            />
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <THead>
                    <tr>
                      <Th>Formularz</Th>
                      <Th>Status</Th>
                      <Th num>Wyświetlenia</Th>
                      <Th num>Zapisy</Th>
                      <Th num>Konwersja</Th>
                      <Th aria-label="Działania" />
                    </tr>
                  </THead>
                  <TBody>
                    {formularze.map((f) => {
                      const w = wyniki.get(f.id);
                      return (
                        <tr key={f.id}>
                          <Td>
                            <a href={`/t/${tenantId}/popupy/${f.id}`} className="flex items-center gap-3 hover:[&_.nazwa]:text-[var(--color-akcent)]">
                              <Miniatura f={f} />
                              <span className="min-w-0">
                                <span className="nazwa block truncate font-semibold">{f.nazwa}</span>
                                <span className="tekst-meta mt-0.5 block">
                                  {NAZWY_TYPOW[f.typ].nazwa} · {f.lista ? `lista „${f.lista}”` : "bez listy"}
                                  {f.zmieniono ? ` · zmieniony ${formatujDate(f.zmieniono)}` : ""}
                                </span>
                              </span>
                            </a>
                          </Td>
                          <Td><Status f={f} /></Td>
                          <Td num>{(w?.wyswietlenia ?? 0).toLocaleString("pl-PL")}</Td>
                          <Td num className="font-semibold">{(w?.zapisy ?? 0).toLocaleString("pl-PL")}</Td>
                          <Td num>{procent(w)}</Td>
                          <Td className="text-right">
                            <span className="inline-flex items-center gap-1">
                              <Button href={`/t/${tenantId}/popupy/${f.id}`} variant="secondary" size="sm">Edytuj</Button>
                              <Menu tenantId={tenantId} f={f} />
                            </span>
                          </Td>
                        </tr>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
              <MobileList>
                {formularze.map((f) => {
                  const w = wyniki.get(f.id);
                  return (
                    <MobileListItem key={`${f.id}-m`}>
                      <div className="flex items-start gap-3">
                        <a href={`/t/${tenantId}/popupy/${f.id}`} className="flex min-w-0 flex-1 items-start gap-3">
                          <Miniatura f={f} />
                          <span className="min-w-0">
                            <span className="block truncate font-semibold">{f.nazwa}</span>
                            <span className="tekst-meta mt-0.5 block">{NAZWY_TYPOW[f.typ].nazwa}</span>
                            <span className="mt-1.5 block"><Status f={f} /></span>
                          </span>
                        </a>
                        <Menu tenantId={tenantId} f={f} />
                      </div>
                      <div className="tekst-pomocniczy mt-2">
                        {(w?.wyswietlenia ?? 0).toLocaleString("pl-PL")} wyświetleń · <b className="text-[var(--color-tekst)]">{(w?.zapisy ?? 0).toLocaleString("pl-PL")}</b> zapisów · {procent(w)}
                      </div>
                    </MobileListItem>
                  );
                })}
              </MobileList>
            </>
          )}
        </Card>

        <Card>
          <CardHeader title="Instalacja w sklepie" description="Jeden tag na całym sklepie. Pokazuje wszystkie opublikowane formularze według ich reguł." />
          <CardBody className="space-y-3">
            <div className="flex items-center gap-2 max-md:flex-col max-md:items-stretch">
              <code className="karta-plaska block min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-4 py-3 font-mono text-[12px]">{snippet}</code>
              <Kopiuj wartosc={snippet} etykieta="tag skryptu" />
            </div>
            <p className="tekst-pomocniczy">
              WooCommerce: wklej tag przed <code className="font-mono">&lt;/body&gt;</code> (np. wtyczką do wstawiania kodu w stopce). Shopify: w pliku <code className="font-mono">theme.liquid</code> przed <code className="font-mono">&lt;/body&gt;</code>. Formularz osadzony dodatkowo potrzebuje znacznika w miejscu, gdzie ma stać (znajdziesz go w builderze, zakładka „Wyświetlanie”).
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
