import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { listaTenantow, podsumowanieTenanta } from "../adapters/db/repozytoria";
import { utworzTenantaAkcja } from "./akcje";
import { wymaganaSesja } from "./autoryzacja";
import { zGroszy } from "../domain/kwoty";
import { odmien } from "../domain/liczebniki";
import { Alert, Button, Card, CardBody, CardHeader, EmptyState, Field, Icon, Input, PrzyciskFormularza } from "./ui";
import { wylogujAkcja } from "./logowanie/akcje";
import { StraznikWersji } from "./ui/straznik-wersji";

export const dynamic = "force-dynamic";

export default async function Strona({
  searchParams,
}: {
  searchParams: Promise<{ blad?: string }>;
}) {
  // Lista tenantow tylko dla zalogowanych i tylko te z sesji (AD-21):
  // client widzi wylacznie swoje membershipy, nie caly portfel agencji.
  const sesja = await wymaganaSesja();
  const { blad } = await searchParams;
  const tenanci = (await listaTenantow()).filter((t) => sesja.tenantIds.includes(t.id));
  const podsumowania = await Promise.all(
    tenanci.map(async (t) => ({ tenant: t, dane: await podsumowanieTenanta(t.id) })),
  );

  return (
    <main className="min-h-screen bg-[var(--color-plotno)]">
      <header className="border-b border-[var(--color-linia)] bg-white">
        <div className="mx-auto flex h-[72px] max-w-[1040px] items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--color-akcent)] text-[15px] font-bold text-white shadow-sm">m</span>
            <span className="text-[17px] font-semibold tracking-[-0.022em]">midrev esp</span>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <span className="tekst-pomocniczy hidden max-w-[240px] truncate sm:block">{sesja.email}</span>
            <form action={wylogujAkcja}>
              <PrzyciskFormularza variant="ghost" size="sm" trwa="Wylogowuję…"><Icon name="wyloguj" size={15} />Wyloguj</PrzyciskFormularza>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1040px] px-4 py-7 sm:px-6 lg:py-8">
        <div className="mb-6">
          <h1>Wybierz sklep</h1>
          <p className="mt-2 max-w-[62ch] text-[14px] leading-5 text-[var(--color-tekst-2)]">
            Każdy sklep ma osobny obszar roboczy z własnymi danymi, wysyłkami i listą wykluczeń.
          </p>
        </div>

        {blad ? (
          <Alert tone="blad" title="Nie udało się utworzyć konta" className="mb-6">{blad}</Alert>
        ) : null}

        <div className="space-y-6">
          <Card className="h-fit">
            <CardHeader
              title="Sklepy klientów"
              description={podsumowania.length > 0 ? "Otwórz konto, na którym chcesz teraz pracować." : undefined}
            />
            {podsumowania.length === 0 ? (
              <EmptyState
                icon="sklep"
                title="Nie ma jeszcze żadnego sklepu"
                description={sesja.role === "client" ? "Twoje konto nie ma jeszcze przypisanego sklepu." : "Dodaj pierwszego klienta, korzystając z formularza na tej stronie."}
                action={sesja.role === "client" ? undefined : <Button href="#nowy-klient" variant="secondary">Dodaj konto klienta</Button>}
              />
            ) : (
              <div>
                <div className="hidden grid-cols-[minmax(280px,1fr)_100px_120px_170px_24px] items-center gap-4 border-b border-[var(--color-linia)] bg-[var(--color-powierzchnia-3)] px-6 py-2.5 text-[12px] font-semibold text-[var(--color-tekst-2)] md:grid">
                  <span>Konto</span>
                  <span className="text-right">Profile</span>
                  <span className="text-right">Zamówienia</span>
                  <span className="text-right">Przychód</span>
                  <span aria-hidden="true" />
                </div>
                <div className="divide-y divide-[var(--color-linia-0)]">
                {podsumowania.map(({ tenant, dane }) => (
                  <Link
                    key={tenant.id}
                    href={`/t/${tenant.id}`}
                    className="group grid min-h-[82px] cursor-pointer grid-cols-[minmax(0,1fr)_24px] items-center gap-4 px-4 py-4 transition-colors hover:bg-[var(--color-powierzchnia-2)] focus-visible:bg-[var(--color-powierzchnia-2)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-akcent)] sm:px-6 md:grid-cols-[minmax(280px,1fr)_100px_120px_170px_24px]"
                  >
                    <div className="flex min-w-0 items-center gap-4">
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]">
                        <Icon name="sklep" size={21} />
                      </span>
                      <div className="min-w-0">
                        <h2 className="truncate transition-colors group-hover:text-[var(--color-akcent-mocny)]">{tenant.name}</h2>
                        <span className="tekst-pomocniczy mt-0.5 block !text-[var(--color-tekst-3)]">{odmien(Number(dane.sklepy), "sklep", "sklepy", "sklepów")}</span>
                        <div className="tekst-pomocniczy mt-2 flex flex-wrap gap-x-4 gap-y-1 md:hidden">
                          <span><strong className="liczba font-semibold text-[var(--color-tekst)]">{dane.profile}</strong> profili</span>
                          <span><strong className="liczba font-semibold text-[var(--color-tekst)]">{dane.zamowienia}</strong> zamówień</span>
                          <span><strong className="liczba font-semibold text-[var(--color-tekst)]">{zGroszy(Number(dane.przychod_minor))}</strong> przychodu</span>
                        </div>
                      </div>
                    </div>
                    <span className="liczba hidden text-right font-semibold text-[var(--color-tekst)] md:block">{dane.profile}</span>
                    <span className="liczba hidden text-right font-semibold text-[var(--color-tekst)] md:block">{dane.zamowienia}</span>
                    <span className="liczba hidden text-right font-semibold text-[var(--color-tekst)] md:block">{zGroszy(Number(dane.przychod_minor))}</span>
                    <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--color-tekst-3)] transition-[color,transform] group-hover:translate-x-0.5 group-hover:text-[var(--color-tekst)] group-focus-visible:translate-x-0.5 group-focus-visible:text-[var(--color-tekst)]" />
                  </Link>
                ))}
                </div>
              </div>
            )}
          </Card>

          {/* workspace'y zakłada MidRev: formularz tylko dla admin/operator,
              akcja i tak weryfikuje rolę sama (formularz to nie autoryzacja) */}
          {sesja.role !== "client" && (
            <Card id="nowy-klient">
              <CardHeader title="Dodaj konto klienta" description="Utwórz osobny obszar roboczy dla kolejnego sklepu." />
              <CardBody className="grid gap-6 py-6 md:grid-cols-[260px_minmax(0,1fr)] md:gap-8">
                <div className="flex items-start gap-3 md:border-r md:border-[var(--color-linia-0)] md:pr-8">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]"><Icon name="dodaj" size={18} /></span>
                  <p className="tekst-pomocniczy pt-0.5">Nowe konto zakłada operator MidRev. Dane każdego klienta pozostają oddzielone.</p>
                </div>
                <form action={utworzTenantaAkcja} className="grid max-w-[620px] gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <Field label="Nazwa sklepu" htmlFor="nazwa" className="min-w-0">
                    <Input id="nazwa" name="nazwa" required placeholder="np. Sklep Zielony Dom" />
                  </Field>
                  <PrzyciskFormularza trwa="Dodaję…"><Icon name="dodaj" size={16} />Dodaj klienta</PrzyciskFormularza>
                </form>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
      <StraznikWersji />
    </main>
  );
}
