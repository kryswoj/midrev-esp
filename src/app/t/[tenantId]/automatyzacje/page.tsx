import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getPool } from "../../../../adapters/db/pool";
import { odmien } from "../../../../domain/liczebniki";
import { zGroszy } from "../../../../domain/kwoty";
import { BIBLIOTEKA, STATUSY, TRIGGERY, automatyzacjeTenanta, etykietaWyzwalacza, metrykiDoWyzwalacza } from "../../../../usecases/automatyzacje/journeye";
import { przychodPrzegladu } from "../../../../usecases/raport-przegladu";
import { wymaganyTenant } from "../../../autoryzacja";
import { Badge, Button, Card, CardHeader, EmptyState, Icon, ResponsiveTable, Table, TBody, Td, Th, THead, type NazwaIkony } from "../../../ui";
import { Komunikat, Naglowek } from "../naglowek";
import { utworzZBibliotekiAkcja } from "./akcje";
import { NowaAutomatyzacja } from "./nowa-automatyzacja";

export const dynamic = "force-dynamic";

export const metadata = { title: "Automatyzacje" };

const IKONY_SZABLONOW: Record<string, NazwaIkony> = { powitanie: "wiadomosc", po_zakupie: "zamowienie", win_back: "odbiorcy" };

export default async function Automatyzacje({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId: zadany } = await params;
  const { ok, blad } = await searchParams;
  // tenantId pochodzi z URL, czyli od klienta: bez sprawdzenia wobec sesji (AD-21)
  // sam adres ujawnialby automatyzacje cudzego tenanta.
  const { tenantId } = await wymaganyTenant(zadany);
  const [{ lista, przebiegAt }, przeglad, listy, metryki] = await Promise.all([
    automatyzacjeTenanta(tenantId),
    przychodPrzegladu(tenantId),
    getPool().query("select id, name from lists where tenant_id = $1 order by name", [tenantId]).then((r) => r.rows as { id: string; name: string }[]),
    metrykiDoWyzwalacza(tenantId),
  ]);
  // wybor wyzwalacza: metryki tenanta (klucz "m:integracja|nazwa") + dolaczenie do listy
  const triggery: Record<string, string> = {
    ...Object.fromEntries(metryki.filter((m) => m.canTrigger).map((m) => [`m:${m.klucz}`, m.etykieta])),
    "list.joined": TRIGGERY["list.joined"],
  };
  const wToku = lista.reduce((s, f) => s + f.wToku, 0);

  return (
    <>
      <Naglowek
        tytul="Automatyzacje"
        opis="Automatyzacja to graf: wyzwalacz, opóźnienia, warunki i maile na kanwie. Osoba wchodzi raz, idzie krok po kroku i wychodzi, gdy kupi albo wypisze się ze zgód. Każdy mail przechodzi przez te same bramki zgód i wykluczeń co kampanie. Włączenie działa od tej chwili w przód. Wysłane liczymy z faktycznych wysyłek, przychód z ostatniego przebiegu atrybucji."
        akcja={<Button href="#nowa-automatyzacja"><Icon name="dodaj" size={16} />Nowa automatyzacja</Button>}
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        <Card>
          <CardHeader
            title="Wszystkie automatyzacje"
            description={przebiegAt ? "Przychód z ostatniego zakończonego przeliczenia atrybucji." : "Przychód pojawi się po pierwszym przeliczeniu atrybucji."}
            action={<span className="text-[13px] text-[var(--color-tekst-3)]">{lista.length} łącznie · {odmien(wToku, "osoba", "osoby", "osób")} w toku</span>}
          />
          {lista.length === 0 ? (
            <EmptyState
              icon="automatyzacja"
              title="Nie ma jeszcze żadnej automatyzacji"
              description="Zacznij od gotowca z biblioteki poniżej albo zbuduj własną od zera. Powstanie jako szkic, więc nic nie wyjdzie przed sprawdzeniem treści."
            />
          ) : (
            <ResponsiveTable
              table={
                <Table className="min-w-[920px]">
                  <THead>
                    <tr>
                      <Th>Automatyzacja</Th>
                      <Th>Status</Th>
                      <Th>Wyzwalacz</Th>
                      <Th num>W toku</Th>
                      <Th num>Wysłane</Th>
                      <Th num>Przychód</Th>
                      <Th aria-label="Akcja" />
                    </tr>
                  </THead>
                  <TBody>
                    {lista.map((f) => {
                      const stan = STATUSY[f.status];
                      return (
                        <tr key={f.id} className="wiersz-link">
                          <Td>
                            <Link href={`/t/${tenantId}/automatyzacje/${f.id}/edytor`} className="wiersz-link-cel">{f.name}</Link>
                            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-[var(--color-tekst-3)]">
                              <Icon name="wiadomosc" size={13} />
                              {odmien(f.emaili, "wiadomość", "wiadomości", "wiadomości")}
                              {f.status !== "szkic" && f.niepublikowane ? <span className="text-[var(--color-czeka)]">· szkic różni się od wersji włączonej</span> : null}
                            </div>
                          </Td>
                          <Td><Badge ton={stan.ton}>{stan.etykieta}</Badge></Td>
                          <Td className="text-[var(--color-tekst-2)]">{etykietaWyzwalacza(f.zdarzenie)}</Td>
                          <Td num className="font-medium">{f.wToku}</Td>
                          <Td num className="font-medium">{f.wyslane}</Td>
                          <Td num className="font-medium">
                            {f.przychod ? zGroszy(f.przychod.przychodMinor, przeglad.waluta) : "—"}
                            {f.przychod && f.przychod.zamowien ? <span className="mt-0.5 block text-[12px] font-normal text-[var(--color-tekst-3)]">{odmien(f.przychod.zamowien, "zamówienie", "zamówienia", "zamówień")}</span> : null}
                          </Td>
                          <Td className="text-right">
                            <ChevronRight size={16} className="inline text-[var(--color-tekst-3)]" aria-hidden="true" />
                          </Td>
                        </tr>
                      );
                    })}
                  </TBody>
                </Table>
              }
              mobile={
                <div>
                  {lista.map((f) => {
                    const stan = STATUSY[f.status];
                    return (
                      <Link key={f.id} href={`/t/${tenantId}/automatyzacje/${f.id}/edytor`} className="lista-mobilna-element">
                        <div className="lista-mobilna-wiersz">
                          <div className="min-w-0">
                            <div className="lista-mobilna-tytul">{f.name}</div>
                            <div className="lista-mobilna-meta">{etykietaWyzwalacza(f.zdarzenie)} · {f.wToku} w toku · {f.wyslane} wysłane</div>
                          </div>
                          <div className="lista-mobilna-wartosc">{f.przychod ? zGroszy(f.przychod.przychodMinor, przeglad.waluta) : "—"}</div>
                        </div>
                        <div className="mt-3"><Badge ton={stan.ton}>{stan.etykieta}</Badge></div>
                      </Link>
                    );
                  })}
                </div>
              }
            />
          )}
        </Card>

        <Card>
          <CardHeader title="Biblioteka gotowych automatyzacji" description="Gotowe grafy z treściami po polsku. Linki w mailach prowadzą do podłączonego sklepu. Powstają jako szkic do przejrzenia na kanwie." />
          <div className="grid gap-4 p-6 max-md:p-4 md:grid-cols-3">
            {BIBLIOTEKA.map((s) => (
              <form key={s.klucz} action={utworzZBibliotekiAkcja} className="karta-plaska flex flex-col items-start p-5 transition-colors hover:border-[var(--color-akcent-ramka)]">
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="szablon" value={s.klucz} />
                <span className="mb-4 grid h-9 w-9 place-items-center rounded-full border border-[var(--color-akcent-ramka)] bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]">
                  <Icon name={IKONY_SZABLONOW[s.klucz] ?? "automatyzacja"} size={18} />
                </span>
                <h3 className="text-[15px] font-semibold">{s.name}</h3>
                <p className="mt-1 text-[13px] leading-5 text-[var(--color-tekst-2)]">{s.opis}</p>
                <ol className="mt-4 flex flex-wrap items-center gap-1 text-[12px] text-[var(--color-tekst-2)]">
                  {s.kroki.map((k, i) => (
                    <li key={k} className="flex items-center gap-1">
                      <span className="rounded-md border border-[var(--color-linia)] bg-white px-1.5 py-0.5">{k}</span>
                      {i < s.kroki.length - 1 ? <span aria-hidden="true" className="text-[var(--color-tekst-3)]">→</span> : null}
                    </li>
                  ))}
                </ol>
                <div className="mt-auto flex items-center gap-2 pt-5 text-[13px] text-[var(--color-tekst-3)]"><Icon name="automatyzacja" size={14} />Wyzwalacz: {TRIGGERY[s.zdarzenie]}</div>
                <button className="przycisk przycisk-wtorny przycisk-maly mt-4" type="submit">Użyj szablonu</button>
              </form>
            ))}
          </div>
          <div className="karta-stopka">Porzuconego koszyka tu nie ma: sklep nie wysyła jeszcze zdarzenia „koszyk porzucony”, a automatyzacja bez zdarzenia byłaby atrapą.</div>
        </Card>

        <Card id="nowa-automatyzacja" className="scroll-mt-4">
          <CardHeader title="Nowa automatyzacja" description="Nazwa i wyzwalacz. Kroki, maile i warunki dodasz na kanwie." />
          <div className="max-w-[808px] p-6 max-md:p-4"><NowaAutomatyzacja tenantId={tenantId} triggery={triggery} listy={listy} /></div>
        </Card>
      </div>
    </>
  );
}
