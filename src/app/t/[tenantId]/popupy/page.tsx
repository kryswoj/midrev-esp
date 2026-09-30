import { adresSledzenia } from "../../../../config";
import { wymaganyTenant } from "../../../autoryzacja";
import { popupyTenanta } from "../../../../usecases/popupy/zarzadzaj";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Icon, MobileList, MobileListItem, Table, TBody, Td, Th, THead } from "../../../ui";
import { Komunikat, Naglowek } from "../naglowek";
import { przelaczPopupAkcja } from "./akcje";
import { FormularzPopupu } from "./formularz-popupu";

export const dynamic = "force-dynamic";

// Nazwa ekranu poszła za nawigacją: „Formularze zapisu". „Popup" zostaje wyłącznie
// tam, gdzie mówimy o tym, jak to wygląda na stronie sklepu.
export const metadata = { title: "Formularze zapisu" };

export default async function Popupy({
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
  const popupy = await popupyTenanta(tenantId);
  // snippet z adresu SLEDZENIA (TRACKING_URL albo APP_URL): ten sam host, na ktory skrypt wysle zgloszenia;
  // recznie wpisany host rozjechalby sie przy zmianie srodowiska
  const snippet = `<script src="${adresSledzenia()}/s/${tenantId}"></script>`;

  return (
    <>
      <Naglowek
        tytul="Formularze zapisu"
        opis="Formularz zapisu zbiera adresy e-mail bezpośrednio na stronie sklepu: sklep wkleja jeden tag script, a każdy zapis tworzy profil, zgodę ze źródłem popup i zdarzenie. Na stronie pokazywany jest najnowszy włączony formularz, więc zmiana treści to nowy formularz i przełączenie, a nie edycja tego, który już wisi."
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
                        <Button variant="secondary" size="sm" type="submit">{p.active ? "Wyłącz" : "Włącz"}</Button>
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
                    </div>
                    <form action={przelaczPopupAkcja}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="popupId" value={p.id} />
                      <input type="hidden" name="wlacz" value={p.active ? "0" : "1"} />
                      <Button variant="secondary" size="sm" type="submit">{p.active ? "Wyłącz" : "Włącz"}</Button>
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
            <CardBody className="p-0 max-md:p-0"><FormularzPopupu tenantId={tenantId} /></CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
