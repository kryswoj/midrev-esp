import { notFound, redirect } from "next/navigation";
import { formatujDateICzas } from "../../../../../../domain/daty";
import { policzPlan, type PlanImportu } from "../../../../../../usecases/import-klaviyo/podglad";
import { przebieg, zapiszPlan } from "../../../../../../usecases/import-klaviyo/zadania";
import { wymaganyTenant } from "../../../../../autoryzacja";
import { Alert, Badge, Button, Card, CardBody, CardFooter, CardHeader, Stat, Table, TBody, Td, Th, THead } from "../../../../../ui";
import { Komunikat, Naglowek } from "../../../naglowek";
import { uruchomImportAkcja } from "../../akcje";
import { Kroki } from "../../kroki";
import { odmien } from "../../../../../../domain/liczebniki";

export const dynamic = "force-dynamic";

export const metadata = { title: "Import: podgląd i start" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const n = (x: number) => x.toLocaleString("pl-PL");

function Liczby({ plan }: { plan: PlanImportu }) {
  const pozycje: { etykieta: string; wartosc: number; opis: string; ton?: "ok" | "uwaga" | "blad" }[] = [
    { etykieta: "Wierszy w pliku", wartosc: plan.wierszy, opis: `${n(plan.bledy)} z błędem, ${n(plan.duplikaty)} powtórzonych adresów` },
    { etykieta: "Unikalnych adresów", wartosc: plan.unikalne, opis: `${n(plan.nowe)} nowych profili, ${n(plan.istniejace)} już w bazie (uzupełnimy puste pola)` },
    { etykieta: "Dostanie zgodę", wartosc: plan.zeZgoda, opis: "status SUBSCRIBED z datą, poza wykluczeniami", ton: "ok" },
    { etykieta: "Bez zgody", wartosc: plan.bezZgody, opis: `w tym ${n(plan.zgodaBezDaty)} bez daty zgody, ${n(plan.wypisani)} UNSUBSCRIBED, ${n(plan.supresjaKlaviyo)} z supresją Klaviyo` },
    { etykieta: "Blokuje lista globalna", wartosc: plan.naSupresjiGlobalnej, opis: "skargi i odbicia (także z pliku wykluczeń); supresja wygrywa ze zgodą z pliku", ton: plan.naSupresjiGlobalnej ? "uwaga" : undefined },
    { etykieta: "Wypisani z tego sklepu", wartosc: plan.wykluczeniWSklepie + plan.wPlikuSupresji, opis: `${n(plan.wykluczeniWSklepie)} w rejestrze wykluczeń, ${n(plan.wPlikuSupresji)} w pliku wykluczeń`, ton: plan.wykluczeniWSklepie + plan.wPlikuSupresji ? "uwaga" : undefined },
  ];
  return (
    <div className="grid grid-cols-2 divide-y divide-[var(--color-linia-0)] md:grid-cols-3 md:divide-x">
      {pozycje.map((p) => (
        <Stat key={p.etykieta} label={p.etykieta} value={<span className={p.ton === "ok" ? "text-[var(--color-ok)]" : p.ton === "uwaga" ? "text-[var(--color-uwaga)]" : ""}>{n(p.wartosc)}</span>} description={p.opis} />
      ))}
    </div>
  );
}

export default async function Podglad({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; jobId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId, jobId } = await params;
  await wymaganyTenant(tenantId);
  if (!UUID.test(jobId)) notFound();
  const job = await przebieg(tenantId, jobId);
  if (!job) notFound();
  if (job.status === "uploaded") redirect(`/t/${tenantId}/import/${job.id}/mapowanie`);
  if (job.status === "mapped") redirect(`/t/${tenantId}/import/${job.id}/supresje`);
  if (job.status !== "suppressions") redirect(`/t/${tenantId}/import/${job.id}`);
  const { ok, blad } = await searchParams;

  let plan: PlanImportu | null = null;
  let bladPlanu: string | null = null;
  try {
    plan = await policzPlan(tenantId, job);
    await zapiszPlan(tenantId, job.id, plan as unknown as Record<string, unknown>);
  } catch (b) {
    bladPlanu = b instanceof Error ? b.message : String(b);
  }

  const powodBlokady = !plan
    ? "Podgląd nie został policzony."
    : plan.unikalne === 0
      ? "W pliku nie ma ani jednego poprawnego adresu."
      : undefined;

  return (
    <>
      <Naglowek
        tytul="Podgląd i start"
        podtytul="Tak będzie wyglądał wynik importu. Liczby policzone teraz, z pliku i z bazy. Do bazy nic jeszcze nie trafiło."
        powrot={{ href: `/t/${tenantId}/import/${job.id}/supresje`, etykieta: "Wypisy i skargi" }}
      />
      <Komunikat ok={ok} blad={blad ?? bladPlanu ?? undefined} />

      <div className="mx-auto max-w-[1040px] space-y-4">
        <Kroki biezacy="podglad" tenantId={tenantId} jobId={job.id} />

        {plan ? (
          <>
            {plan.supresjePominiete ? (
              <Alert tone="uwaga" title="Krok wypisów i skarg został pominięty">
                Osoby wypisane w Klaviyo, których nie ma w rejestrze wykluczeń tego sklepu ani na liście globalnej, dostaną zgodę zgodnie z plikiem profili. Jeśli masz plik wykluczeń, wróć do kroku 3.
              </Alert>
            ) : null}
            {plan.bledy > 0 ? (
              <Alert tone="info">{odmien(plan.bledy, "wiersz zostanie pominięty", "wiersze zostaną pominięte", "wierszy zostanie pominiętych")} z powodu błędów (pusty lub niepoprawny adres, nieczytelna data). Po imporcie pobierzesz ich listę z numerami linii.</Alert>
            ) : null}

            <Card>
              <CardHeader title="Profile i zgody" description={<>Plik <b>{job.file_name}</b>{plan.listaNazwa ? <> · lista docelowa <b>{plan.listaNazwa}</b> ({n(plan.doListy)} osób)</> : " · bez listy docelowej"}</>} />
              <Liczby plan={plan} />
            </Card>

            {plan.supresje ? (
              <Card>
                <CardHeader title="Wykluczenia z pliku" description={<>Plik <b>{job.suppression_file_name}</b>: {n(plan.supresje.wierszy)} wierszy, {n(plan.supresje.unikalne)} unikalnych adresów, {n(plan.supresje.bledy)} z błędem.</>} />
                <div className="grid grid-cols-2 divide-y divide-[var(--color-linia-0)] md:grid-cols-4 md:divide-x md:divide-y-0">
                  <Stat label="Wypisy (ten sklep)" value={n(plan.supresje.wgRodzaju.wypis + plan.supresje.wgRodzaju.reczne)} description="do wykluczeń sklepu" />
                  <Stat label="Skargi (globalnie)" value={n(plan.supresje.wgRodzaju.skarga)} description="do listy całej platformy" />
                  <Stat label="Odbicia, złe adresy (globalnie)" value={n(plan.supresje.wgRodzaju.odbicie + plan.supresje.wgRodzaju.nieprawidlowy)} description="do listy całej platformy" />
                  <Stat label="Już wykluczone" value={n(plan.supresje.juzWykluczone)} description={`bez zmian · ${n(plan.supresje.bezDaty)} bez daty dostanie datę importu`} />
                </div>
              </Card>
            ) : null}

            <Card>
              <CardHeader title="Pierwsze 20 wierszy po mapowaniu" description="Tak zostaną zapisane. Data zgody pochodzi z pliku, nigdy z chwili importu." />
              <Table className="min-w-[760px]">
                <THead><tr><Th num>Linia</Th><Th>E-mail</Th><Th>Imię i nazwisko</Th><Th>Zgoda</Th><Th>Data zgody</Th><Th>Uwagi</Th></tr></THead>
                <TBody>
                  {plan.probka.map((w) => (
                    <tr key={w.linia}>
                      <Td num className="text-[var(--color-tekst-3)]">{w.linia}</Td>
                      <Td className="font-medium">{w.email || "—"}</Td>
                      <Td className="text-[var(--color-tekst-2)]">{[w.imie, w.nazwisko].filter(Boolean).join(" ") || "—"}</Td>
                      <Td>
                        {w.blad ? <Badge ton="blad">pominięty</Badge> : w.zgoda === "granted" ? <Badge ton="ok">zgoda</Badge> : w.zgoda === "unsubscribed" ? <Badge ton="uwaga">wypisany</Badge> : <Badge ton="nieaktywna">bez zgody</Badge>}
                      </Td>
                      <Td className="liczba text-[var(--color-tekst-2)]">{w.zgodaData ? formatujDateICzas(w.zgodaData) : "—"}</Td>
                      <Td className="text-[var(--color-tekst-2)]">{w.blad ?? (w.uwagi.length ? w.uwagi.join("; ") : "")}</Td>
                    </tr>
                  ))}
                </TBody>
              </Table>
            </Card>

            <form action={uruchomImportAkcja}>
              <input type="hidden" name="tenantId" value={tenantId} />
              <input type="hidden" name="jobId" value={job.id} />
              <Card>
                <CardBody className="flex flex-wrap items-center justify-between gap-4">
                  <div className="max-w-[60ch]">
                    <h2 className="text-[17px] font-semibold">Uruchom import</h2>
                    <p className="tekst-pomocniczy mt-1">Wykona go proces w tle; przy dużym pliku to kilka minut. Po zakończeniu zobaczysz raport z liczbami odczytanymi z bazy, nie z licznika prób.</p>
                  </div>
                  <Button type="submit" powodBlokady={powodBlokady}>Importuj {n(plan.unikalne)} adresów</Button>
                </CardBody>
              </Card>
            </form>
          </>
        ) : (
          <Card>
            <CardBody>
              <Alert tone="blad" title="Nie udało się policzyć podglądu">{bladPlanu}</Alert>
            </CardBody>
            <CardFooter><Button href={`/t/${tenantId}/import`} variant="secondary">Zacznij od nowa</Button></CardFooter>
          </Card>
        )}
      </div>
    </>
  );
}
