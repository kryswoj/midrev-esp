/** Ekran startowy: pieniądz, źródła przychodu, onboarding i ostatnia aktywność. */
import Link from "next/link";
import { wymaganyTenant } from "../../autoryzacja";
import { kampanieTenanta } from "../../../adapters/db/repozytoria";
import { STATUSY, automatyzacjeTenanta } from "../../../usecases/automatyzacje/journeye";
import { ZDARZENIA_WYZWALACZA } from "../../../domain/automatyzacje/graf";
import { stanOnboardingu } from "../../../usecases/onboarding";
import { ostatnieKampanie, przychodPrzegladu } from "../../../usecases/raport-przegladu";
import { przychodAutomatyzacji } from "../../../usecases/przelicz-atrybucje";
import { formatujDate } from "../../../domain/daty";
import { zGroszy } from "../../../domain/kwoty";
import { odmien } from "../../../domain/liczebniki";
import {
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  EmptyState,
  Icon,
  ResponsiveTable,
  Stat,
  StatGrid,
  Table,
  TBody,
  Td,
  Th,
  THead,
} from "../../ui";
import { Komunikat, Naglowek } from "./naglowek";
import { Onboarding } from "./onboarding";

export const dynamic = "force-dynamic";
export const metadata = { title: "Przegląd" };

export default async function Przeglad({ params, searchParams }: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  await wymaganyTenant(tenantId);
  const { ok, blad } = await searchParams;

  const [przychod, kampanie, automatyzacje, wszystkieKampanie, onboarding, atrybucjaAutomatyzacji] = await Promise.all([
    przychodPrzegladu(tenantId),
    ostatnieKampanie(tenantId, 6),
    automatyzacjeTenanta(tenantId),
    kampanieTenanta(tenantId),
    stanOnboardingu(tenantId),
    przychodAutomatyzacji(tenantId),
  ]);

  const doAkceptacji = wszystkieKampanie.filter((k: { status: string }) => k.status === "awaiting_approval").length;
  const udzial = przychod.przypisanyMinor !== null && przychod.sklepMinor > 0
    ? (przychod.przypisanyMinor / przychod.sklepMinor) * 100
    : null;
  // Przychód z ostatniego przebiegu atrybucji; brak przebiegu = brak liczby, nie zero.
  const przeliczoneAutomatyzacje = (automatyzacje.przebiegAt ?? atrybucjaAutomatyzacji.przebiegAt) !== null;
  // Przychód liczony per FLOW (suma jego maili), nie per pojedyncza wiadomość: od 0019
  // automatyzacja to graf z wieloma mailami, a lista zwraca już zsumowany przychód.
  const przychodJourneya = (id: string) => automatyzacje.lista.find((a) => a.id === id)?.przychod?.przychodMinor ?? 0;
  const najlepszeAutomatyzacje = [...automatyzacje.lista]
    .sort((a, b) => przychodJourneya(b.id) - przychodJourneya(a.id) || b.wyslane - a.wyslane)
    .slice(0, 6);
  const onboardingNaGorze = !onboarding.gotowe && kampanie.length === 0;
  const sekcjaOnboardingu = <Onboarding tenantId={tenantId} stan={onboarding} />;
  const zakres = przychod.odKiedy && przychod.doKiedy
    ? `${formatujDate(przychod.odKiedy)} – ${formatujDate(przychod.doKiedy)}`
    : "Brak zamówień w wybranym sklepie";

  return (
    <>
      <Naglowek
        tytul="Przegląd"
        podtytul={zakres}
        opis="Przychód sklepu to suma zamówień opłaconych i w realizacji, po dacie ze sklepu, nie po dacie importu — raport liczony po dacie importu kłamie po cichu i nikt tego nie zauważa. Przychód przypisany pochodzi z ostatniego zakończonego przebiegu atrybucji: zamówienie dostaje przychód od ostatniego kliknięcia tego profilu w oknie reguły. Otwarcia nie liczą się w tym modelu w ogóle, bo połowa z nich to skanery skrzynek."
        akcja={doAkceptacji > 0 ? (
          <Button href={`/t/${tenantId}/kampanie`} variant="secondary">
            <Badge ton="uwaga">{doAkceptacji}</Badge>
            czeka na akceptację
          </Button>
        ) : null}
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        {onboardingNaGorze ? sekcjaOnboardingu : null}

        <Card>
          <CardHeader title="Przychód" description="Wynik sklepu i część przypisana działaniom e-mailowym." />
          {przychod.zamowienSklep === 0 ? (
            <EmptyState
              icon="raport"
              title="Nie ma jeszcze z czego liczyć przychodu"
              description="W bazie nie ma ani jednego zamówienia. Zamówienia pojawią się tu po imporcie historii i z webhooków sklepu."
              action={<Button href={`/t/${tenantId}/sklepy`}>Przejdź do sklepu</Button>}
            />
          ) : (
            <>
              <StatGrid className="przychod-glowne">
                <Stat
                  label="Przychód sklepu"
                  value={zGroszy(przychod.sklepMinor, przychod.waluta)}
                  description={`${odmien(przychod.zamowienSklep, "zamówienie", "zamówienia", "zamówień")} opłacone i w realizacji`}
                />
                <Stat
                  label="Przychód przypisany e-mailowi"
                  value={przychod.przypisanyMinor === null ? "nie policzono" : zGroszy(przychod.przypisanyMinor, przychod.waluta)}
                  missing={przychod.przypisanyMinor === null}
                  description={przychod.przypisanyMinor === null
                    ? "Atrybucji nie przeliczono ani razu. Przeliczenie uruchamia się z karty kampanii."
                    : <>{odmien(przychod.przypisanychZamowien, "zamówienie", "zamówienia", "zamówień")}{udzial !== null ? <> · <span className="liczba">{udzial.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%</span> przychodu sklepu</> : null}</>}
                />
              </StatGrid>

              <div className="border-t border-[var(--color-linia-0)] px-6 pb-1 pt-5 max-md:px-4 max-md:pt-4">
                <h3>Przypisany przychód według źródła</h3>
              </div>
              <div className="grid px-6 pb-6 pt-3 md:grid-cols-2 md:divide-x md:divide-[var(--color-linia-0)] max-md:divide-y max-md:divide-[var(--color-linia-0)] max-md:px-4 max-md:pb-4">
                <div className="py-3 pr-6 max-md:pb-4 max-md:pr-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon name="kampania" size={18} className="text-[var(--color-tekst-3)]" />
                    <span className="font-semibold">Kampanie</span>
                    <Badge ton={przychod.kampanieMinor === null ? "uwaga" : "ok"}>{przychod.kampanieMinor === null ? "nie przeliczono" : "liczone"}</Badge>
                  </div>
                  <div className={`mt-3 ${przychod.kampanieMinor === null ? "wielkosc wielkosc-brak" : "wielkosc"}`}>
                    {przychod.kampanieMinor === null ? "brak liczby" : zGroszy(przychod.kampanieMinor, przychod.waluta)}
                  </div>
                  <p className="tekst-pomocniczy mt-2 max-w-[48ch]">
                    {przychod.kampanieMinor === null
                      ? "Atrybucji nie przeliczono jeszcze ani razu, więc nie ma przebiegu, z którego można wziąć kwotę."
                      : <>{odmien(przychod.kampanieZamowien, "zamówienie", "zamówienia", "zamówień")} z ostatniego przebiegu atrybucji.</>}
                  </p>
                </div>
                <div className="py-3 pl-6 max-md:pl-0 max-md:pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon name="automatyzacja" size={18} className="text-[var(--color-tekst-3)]" />
                    <span className="font-semibold">Automatyzacje</span>
                    <Badge ton={przychod.automatyzacjeMinor === null ? "uwaga" : "ok"}>{przychod.automatyzacjeMinor === null ? "nie przeliczono" : "liczone"}</Badge>
                  </div>
                  <div className={`mt-3 ${przychod.automatyzacjeMinor === null ? "wielkosc wielkosc-brak" : "wielkosc"}`}>
                    {przychod.automatyzacjeMinor === null ? "brak liczby" : zGroszy(przychod.automatyzacjeMinor, przychod.waluta)}
                  </div>
                  <p className="tekst-pomocniczy mt-2 max-w-[48ch]">
                    {przychod.automatyzacjeMinor === null
                      ? "Atrybucji nie przeliczono jeszcze ani razu, więc nie ma przebiegu, z którego można wziąć kwotę."
                      : <>{odmien(przychod.automatyzacjeZamowien, "zamówienie", "zamówienia", "zamówień")} z ostatniego przebiegu atrybucji.</>}
                  </p>
                </div>
              </div>
              <CardFooter className="border-t-0">
                <span>Zakres: wszystkie zamówienia w bazie, od <span className="liczba">{formatujDate(przychod.odKiedy)}</span> do <span className="liczba">{formatujDate(przychod.doKiedy)}</span></span>
                {przychod.przebiegAt ? <span>Atrybucja przeliczona <span className="liczba">{formatujDate(przychod.przebiegAt)}</span>{przychod.oknoGodzin ? `, okno ${przychod.oknoGodzin} godz.` : ""}</span> : null}
              </CardFooter>
            </>
          )}
        </Card>

        {onboardingNaGorze ? null : sekcjaOnboardingu}

        <Card className="shadow-none">
          <CardHeader
            title="Najlepsze automatyzacje"
            description={przeliczoneAutomatyzacje ? "Według przypisanego przychodu, potem liczby wysłanych wiadomości." : "Według liczby wysłanych wiadomości; przychód pojawi się po przeliczeniu atrybucji."}
            action={<Button href={`/t/${tenantId}/automatyzacje`} variant="secondary" size="sm">Wszystkie automatyzacje</Button>}
          />
          {najlepszeAutomatyzacje.length === 0 ? (
            <EmptyState
              icon="automatyzacja"
              title="Nie ma jeszcze automatyzacji"
              description="Automatyzacja reaguje na zdarzenie ze sklepu i wysyła wiadomość bez udziału operatora."
              action={<Button href={`/t/${tenantId}/automatyzacje`}>Zbuduj pierwszą</Button>}
            />
          ) : (
            <ResponsiveTable table={<Table>
              <THead><tr><Th>Automatyzacja</Th><Th>Status</Th><Th num>Wysłane</Th><Th num>Przychód</Th></tr></THead>
              <TBody>
                {najlepszeAutomatyzacje.map((j) => (
                  <tr key={j.id} className="wiersz-link">
                    <Td>
                      <Link href={`/t/${tenantId}/automatyzacje/${j.id}/edytor`} className="wiersz-link-cel">{j.name}</Link>
                      <div className="tekst-meta mt-0.5">{j.zdarzenie ? (ZDARZENIA_WYZWALACZA[j.zdarzenie as keyof typeof ZDARZENIA_WYZWALACZA] ?? j.zdarzenie) : "brak wyzwalacza"}</div>
                    </Td>
                    <Td><Badge ton={STATUSY[j.status].ton}>{STATUSY[j.status].etykieta}</Badge></Td>
                    <Td num>{j.wyslane}</Td>
                    <Td num>{przeliczoneAutomatyzacje ? zGroszy(przychodJourneya(j.id), przychod.waluta) : "—"}</Td>
                  </tr>
                ))}
              </TBody>
            </Table>} mobile={<div>
              {najlepszeAutomatyzacje.map((j) => (
                <Link key={j.id} href={`/t/${tenantId}/automatyzacje/${j.id}/edytor`} className="lista-mobilna-element">
                  <div className="lista-mobilna-wiersz">
                    <div className="lista-mobilna-tytul">{j.name}</div>
                    <div className="lista-mobilna-wartosc">{przeliczoneAutomatyzacje ? zGroszy(przychodJourneya(j.id), przychod.waluta) : "—"}</div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <Badge ton={STATUSY[j.status].ton}>{STATUSY[j.status].etykieta}</Badge>
                    <span className="tekst-licznik">Wysłane: {j.wyslane}</span>
                  </div>
                  <div className="lista-mobilna-meta">{j.zdarzenie ? (ZDARZENIA_WYZWALACZA[j.zdarzenie as keyof typeof ZDARZENIA_WYZWALACZA] ?? j.zdarzenie) : "brak wyzwalacza"}</div>
                </Link>
              ))}
            </div>} />
          )}
        </Card>

        <Card className="shadow-none">
          <CardHeader
            title="Ostatnie kampanie"
            description="Data wysyłki wiadomości do odbiorców."
            action={<Button href={`/t/${tenantId}/kampanie`} variant="secondary" size="sm">Wszystkie kampanie</Button>}
          />
          {kampanie.length === 0 ? (
            <EmptyState
              icon="kampania"
              title="Nie wysłano jeszcze kampanii"
              description="Pierwsza wysyłka przechodzi przez akceptację klienta i dopiero potem pojawi się w tym zestawieniu."
              action={<Button href={`/t/${tenantId}/kampanie`}>Przygotuj kampanię</Button>}
            />
          ) : (
            <ResponsiveTable table={<Table>
              <THead><tr><Th>Kampania</Th><Th num>Wysyłka</Th><Th num>Wysłane</Th><Th num>Kliknięcia</Th><Th num>Przychód</Th></tr></THead>
              <TBody>
                {kampanie.map((k) => (
                  <tr key={k.id} className="wiersz-link">
                    <Td><Link href={`/t/${tenantId}/kampanie/${k.id}`} className="wiersz-link-cel">{k.name}</Link></Td>
                    <Td num className="text-[var(--color-tekst-3)]">{formatujDate(k.wyslanaAt)}</Td>
                    <Td num>{k.wyslane}</Td>
                    <Td num>{k.klikniecia}</Td>
                    <Td num>{przychod.przypisanyMinor === null ? "—" : zGroszy(k.przychodMinor, przychod.waluta)}</Td>
                  </tr>
                ))}
              </TBody>
            </Table>} mobile={<div>
              {kampanie.map((k) => (
                <Link key={k.id} href={`/t/${tenantId}/kampanie/${k.id}`} className="lista-mobilna-element">
                  <div className="lista-mobilna-wiersz">
                    <div className="lista-mobilna-tytul">{k.name}</div>
                    <div className="lista-mobilna-wartosc">{przychod.przypisanyMinor === null ? "—" : zGroszy(k.przychodMinor, przychod.waluta)}</div>
                  </div>
                  <div className="lista-mobilna-meta flex justify-between gap-3"><span>{formatujDate(k.wyslanaAt)}</span><span className="liczba">{k.wyslane} wysłane · {k.klikniecia} klik.</span></div>
                </Link>
              ))}
            </div>} />
          )}
        </Card>
      </div>
    </>
  );
}
