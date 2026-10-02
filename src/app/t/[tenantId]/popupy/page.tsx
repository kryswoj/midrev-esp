import { adresSledzenia } from "../../../../config";
import { wymaganyTenant } from "../../../autoryzacja";
import { listyTenanta } from "../../../../adapters/db/repozytoria";
import { formatujDate } from "../../../../domain/daty";
import { domyslnaKlauzula, nazwaFirmyTenanta, popupyTenanta, wersjeKlauzuli } from "../../../../usecases/popupy/zarzadzaj";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Icon, MobileList, MobileListItem, PrzyciskFormularza, Table, TBody, Td, Th, THead } from "../../../ui";
import { Komunikat, Naglowek } from "../naglowek";
import { przelaczPopupAkcja } from "./akcje";
import { FormularzKlauzuli, FormularzPopupu } from "./formularz-popupu";

export const dynamic = "force-dynamic";

// Nazwa ekranu poszła za nawigacją: „Formularze zapisu". „Popup" zostaje wyłącznie
// tam, gdzie mówimy o tym, jak to wygląda na stronie sklepu.
export const metadata = { title: "Formularze zapisu" };

export default async function Popupy({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string; zgoda?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const { ok, blad, zgoda } = await searchParams;
  const [popupy, listyWszystkie, firma] = await Promise.all([popupyTenanta(tenantId), listyTenanta(tenantId), nazwaFirmyTenanta(tenantId)]);
  const listy = listyWszystkie.map((l: { id: string; name: string }) => ({ id: l.id, name: l.name }));
  // edycja klauzuli: popup wybrany z listy (tylko popup TEGO tenanta - szukamy w jego liscie)
  const edytowany = zgoda ? popupy.find((p) => p.id === zgoda) ?? null : null;
  const wersje = edytowany ? await wersjeKlauzuli(tenantId, edytowany.id) : [];
  // snippet z adresu SLEDZENIA (TRACKING_URL albo APP_URL): ten sam host, na ktory skrypt wysle zgloszenia;
  // recznie wpisany host rozjechalby sie przy zmianie srodowiska
  const snippet = `<script src="${adresSledzenia()}/s/${tenantId}"></script>`;

  return (
    <>
      <Naglowek
        tytul="Formularze zapisu"
        opis="Formularz zapisu zbiera adresy e-mail bezpośrednio na stronie sklepu: sklep wkleja jeden tag script, a każdy zapis tworzy profil, zgodę z tekstem klauzuli, którą osoba zaznaczyła, wpis na liście i zdarzenie. Na stronie pokazywany jest najnowszy włączony formularz."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        <Card>
          <CardHeader
            title="Formularze"
            description="Formularze opublikowane i przygotowywane do uruchomienia w sklepie."
            action={popupy.length > 0 ? <Button href="#nowy-formularz" size="sm" className="max-sm:hidden"><Icon name="dodaj" size={16} />Nowy formularz</Button> : undefined}
          />
          {popupy.length === 0 ? (
            <EmptyState
              icon="formularz"
              title="Nie ma jeszcze formularza zapisu"
              description="Utwórz pierwszy formularz. Powstanie wyłączony, więc nic nie pojawi się w sklepie bez Twojej decyzji."
              action={<Button href="#nowy-formularz">Utwórz formularz</Button>}
            />
          ) : (
            <>
            <div className="hidden md:block"><Table>
              <THead>
                <tr>
                  <Th>Formularz</Th>
                  <Th>Reguła wyświetlania</Th>
                  <Th>Zgoda i lista</Th>
                  <Th num>Zapisy</Th>
                  <Th>Status</Th>
                  <Th aria-label="Akcja" />
                </tr>
              </THead>
              <TBody>
                {popupy.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      <div className="font-semibold">{p.name}</div>
                      <div className="tekst-meta mt-0.5">{p.headline}</div>
                    </Td>
                    <Td className="text-[var(--color-tekst-2)]">
                      Po {p.rules?.delay_seconds ?? 0} s
                      {p.discount_code ? (
                        <span className="tekst-meta mt-0.5 block">
                          Kod <code className="font-mono">{p.discount_code}</code>
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {p.consent_version ? (
                        <span className="text-[13px] text-[var(--color-tekst-2)]">Klauzula, wersja {p.consent_version}</span>
                      ) : (
                        <Badge ton="uwaga">brak klauzuli</Badge>
                      )}
                      <span className="tekst-meta mt-0.5 block">{p.lista ? <>Lista „{p.lista}”</> : "Bez listy"}</span>
                      <a href={`/t/${tenantId}/popupy?zgoda=${p.id}#zgoda`} className="mt-0.5 inline-block text-[13px] font-medium text-[var(--color-akcent)] hover:underline">Zmień zgodę i listę</a>
                    </Td>
                    <Td num className="font-semibold">{p.zgloszen}</Td>
                    <Td>
                      {/* kształt plus słowo (NFR33): pełny kwadrat = zbiera zapisy,
                          pusty = nie wisi na stronie */}
                      {p.active ? (
                        <Badge ton="ok">włączony</Badge>
                      ) : (
                        <Badge ton="szkic">wyłączony</Badge>
                      )}
                    </Td>
                    <Td className="text-right">
                      <form action={przelaczPopupAkcja}>
                        <input type="hidden" name="tenantId" value={tenantId} />
                        <input type="hidden" name="popupId" value={p.id} />
                        <input type="hidden" name="wlacz" value={p.active ? "0" : "1"} />
                        <PrzyciskFormularza variant="secondary" size="sm" trwa={p.active ? "Wyłączam…" : "Włączam…"}>{p.active ? "Wyłącz" : "Włącz"}</PrzyciskFormularza>
                      </form>
                    </Td>
                  </tr>
                ))}
              </TBody>
            </Table></div>
            <MobileList>
              {popupy.map((p) => (
                <MobileListItem key={`${p.id}-mobile`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{p.name}</div>
                      <div className="mt-0.5 line-clamp-2 text-[13px] text-[var(--color-tekst-3)]">{p.headline}</div>
                    </div>
                    <Badge ton={p.active ? "ok" : "szkic"}>{p.active ? "włączony" : "wyłączony"}</Badge>
                  </div>
                  <div className="mt-3 flex items-end justify-between gap-4">
                    <div className="tekst-pomocniczy">
                      <span>Po {p.rules?.delay_seconds ?? 0} s</span>
                      <span className="mx-1.5 text-[var(--color-linia-mocna)]">·</span>
                      <span className="liczba font-semibold text-[var(--color-tekst)]">{p.zgloszen}</span> zapisów
                      {p.discount_code ? <span className="mt-0.5 block">Kod <code className="font-mono">{p.discount_code}</code></span> : null}
                      <span className="mt-0.5 block">{p.consent_version ? `Klauzula, wersja ${p.consent_version}` : "Brak klauzuli"} · {p.lista ? `lista „${p.lista}”` : "bez listy"}</span>
                      <a href={`/t/${tenantId}/popupy?zgoda=${p.id}#zgoda`} className="mt-1 inline-flex min-h-[44px] items-center font-medium text-[var(--color-akcent)]">Zmień zgodę i listę</a>
                    </div>
                    <form action={przelaczPopupAkcja}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="popupId" value={p.id} />
                      <input type="hidden" name="wlacz" value={p.active ? "0" : "1"} />
                      <PrzyciskFormularza variant="secondary" size="sm" trwa={p.active ? "Wyłączam…" : "Włączam…"}>{p.active ? "Wyłącz" : "Włącz"}</PrzyciskFormularza>
                    </form>
                  </div>
                </MobileListItem>
              ))}
            </MobileList>
            </>
          )}
          {popupy.length > 0 ? (
            <div className="border-t border-[var(--color-linia-0)] px-4 py-3 sm:hidden [&>span]:w-full [&_a]:w-full">
              <Button href="#nowy-formularz" className="w-full"><Icon name="dodaj" size={16} />Nowy formularz</Button>
            </div>
          ) : null}
        </Card>

        {edytowany ? (
          <Card id="zgoda">
            <CardHeader
              title={`Zgoda i lista: ${edytowany.name}`}
              description="Zmiana tekstu albo adresu polityki tworzy nową wersję klauzuli. Zgody zapisane wcześniej wskazują wersję, którą te osoby widziały."
              action={<Button href={`/t/${tenantId}/popupy`} variant="secondary" size="sm">Zamknij</Button>}
            />
            <CardBody>
              <div className="grid gap-8 xl:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
                <FormularzKlauzuli
                  tenantId={tenantId}
                  popupId={edytowany.id}
                  listy={listy}
                  biezace={{
                    consentWording: edytowany.consent_wording ?? domyslnaKlauzula(firma),
                    privacyUrl: edytowany.consent_privacy_url ?? "",
                    listId: edytowany.list_id ?? "",
                  }}
                />
                <div>
                  <h3 className="mb-2 text-[13px] font-semibold">Historia wersji klauzuli</h3>
                  {wersje.length ? (
                    <ol className="space-y-3">
                      {wersje.map((v) => (
                        <li key={v.id} className="rounded-[10px] border border-[var(--color-linia)] px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-tekst-3)]">
                            <span className="font-semibold text-[var(--color-tekst)]">Wersja {v.version}</span>
                            {v.superseded_at ? <span>od {formatujDate(v.created_at)} do {formatujDate(v.superseded_at)}</span> : <Badge ton="ok">obowiązuje od {formatujDate(v.created_at)}</Badge>}
                          </div>
                          <p className="mt-1.5 whitespace-pre-line text-[13px] leading-5 text-[var(--color-tekst-2)]">{v.wording}</p>
                          {v.privacy_url ? <p className="mt-1 break-all text-[12px] text-[var(--color-tekst-3)]">Polityka prywatności: {v.privacy_url}</p> : null}
                        </li>
                      ))}
                    </ol>
                  ) : <p className="tekst-pomocniczy">Ten formularz nie ma jeszcze klauzuli, więc nie wyświetla się w sklepie. Zapisz ją obok.</p>}
                </div>
              </div>
            </CardBody>
          </Card>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)] xl:items-start">
          <Card>
            <CardHeader title="Instalacja w sklepie" description="Tag wkleja się raz, przed zamknięciem elementu body." />
            <CardBody>
              <p className="tekst-pomocniczy mb-4">Skrypt sam pobiera najnowszy włączony formularz. Późniejsze przełączanie nie wymaga zmian na stronie sklepu.</p>
              <code className="karta-plaska block overflow-x-auto whitespace-nowrap px-4 py-3 font-mono text-[12px]">{snippet}</code>
            </CardBody>
          </Card>

          <Card id="nowy-formularz">
            <CardHeader title="Nowy formularz zapisu" description="Nowy formularz powstaje jako wyłączony. Włączysz go po sprawdzeniu treści." />
            <CardBody className="p-0 max-md:p-0"><FormularzPopupu tenantId={tenantId} listy={listy} domyslnaKlauzula={domyslnaKlauzula(firma)} /></CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
