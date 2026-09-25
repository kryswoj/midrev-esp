import { notFound, redirect } from "next/navigation";
import { formatujDateICzas } from "../../../../../domain/daty";
import type { PlanImportu } from "../../../../../usecases/import-klaviyo/podglad";
import type { LicznikiImportu } from "../../../../../usecases/import-klaviyo/wykonaj";
import { bledyPrzebiegu, przebieg } from "../../../../../usecases/import-klaviyo/zadania";
import { wymaganyTenant } from "../../../../autoryzacja";
import { Alert, Badge, Button, Card, CardBody, CardFooter, CardHeader, EmptyState, Stat, Table, TBody, Td, Th, THead } from "../../../../ui";
import { Komunikat, Naglowek } from "../../naglowek";
import { Kroki } from "../kroki";
import { STATUS_PRZEBIEGU } from "../statusy";
import { Odswiezanie } from "./odswiezanie";
import { odmien } from "../../../../../domain/liczebniki";

export const dynamic = "force-dynamic";

export const metadata = { title: "Import: przebieg" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (x: number | null | undefined) => (x === null || x === undefined ? "—" : x.toLocaleString("pl-PL"));

export default async function Przebieg({
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
  if (job.status === "suppressions") redirect(`/t/${tenantId}/import/${job.id}/podglad`);
  const { ok, blad } = await searchParams;
  const bledy = await bledyPrzebiegu(tenantId, job.id, 50);
  const plan = job.planned as unknown as Partial<PlanImportu>;
  const l = job.counters as unknown as Partial<LicznikiImportu>;
  const trwa = job.status === "planned" || job.status === "running";
  const s = STATUS_PRZEBIEGU[job.status];
  const postep = job.row_count ? Math.min(100, Math.round(((l.przetworzone ?? 0) / job.row_count) * 100)) : 0;

  const wiersze: { etykieta: string; plan: number | undefined; wynik: number | undefined; odczyt?: number | null; opis?: string }[] = [
    { etykieta: "Unikalnych adresów", plan: plan.unikalne, wynik: (l.profileNowe ?? 0) + (l.profileZaktualizowane ?? 0), odczyt: l.odczyt?.profileWBazie, opis: "odczyt: ile z tych adresów jest teraz w bazie" },
    { etykieta: "Nowe profile", plan: plan.nowe, wynik: l.profileNowe },
    { etykieta: "Uzupełnione istniejące", plan: plan.istniejace, wynik: l.profileZaktualizowane },
    { etykieta: "Zgody nadane", plan: plan.zeZgoda, wynik: l.zgodyNadane, odczyt: l.odczyt?.zgodyZTegoPrzebiegu, opis: l.zgodyJuzByly ? `${n(l.zgodyJuzByly)} zgód już było z wcześniejszego importu (bez duplikatu)` : "odczyt: wpisy w rejestrze zgód z tego przebiegu" },
    { etykieta: "Zablokowane listą globalną", plan: plan.naSupresjiGlobalnej, wynik: l.pominieteGlobalnie },
    { etykieta: "Zablokowane wykluczeniem sklepu", plan: (plan.wykluczeniWSklepie ?? 0) + (plan.wPlikuSupresji ?? 0), wynik: (l.pominieteWSklepie ?? 0) + (l.pominietePlikSupresji ?? 0) },
    { etykieta: "Wypisy z pliku profili", plan: plan.doWypisow, wynik: l.wypisyZapisane, opis: "UNSUBSCRIBED albo supresja w Klaviyo; identyczny wpis z pliku wykluczeń nie dubluje się" },
    { etykieta: "Wykluczenia sklepu z tego importu", plan: undefined, wynik: undefined, odczyt: l.odczyt?.wypisyZTegoPrzebiegu, opis: "odczyt: wszystkie wpisy w wykluczeniach sklepu z tego przebiegu (plik profili + plik wykluczeń)" },
    { etykieta: "Dodane do listy", plan: plan.doListy, wynik: l.doListyDodane, odczyt: l.odczyt?.naLiscieZTegoPrzebiegu, opis: l.odczyt?.naLiscieRazem != null ? `lista ma teraz ${n(l.odczyt.naLiscieRazem)} osób` : undefined },
    { etykieta: "Wiersze z błędem", plan: plan.bledy, wynik: l.bledy, odczyt: l.odczyt?.bledowZapisanych, opis: "odczyt: zapisane w raporcie błędów (do 5 000)" },
  ];

  return (
    <>
      <Odswiezanie aktywne={trwa} />
      <Naglowek
        tytul={job.status === "done" ? "Import zakończony" : job.status === "failed" ? "Import przerwany" : "Import w toku"}
        podtytul={<>Plik <b>{job.file_name}</b> · wgrany {formatujDateICzas(job.created_at)}{job.created_by ? <> przez {job.created_by}</> : null}{job.finished_at ? <> · zakończony {formatujDateICzas(job.finished_at)}</> : null}</>}
        powrot={{ href: `/t/${tenantId}/import`, etykieta: "Import z Klaviyo" }}
        akcja={<Badge ton={s.ton}>{s.slowo}</Badge>}
      />
      <Komunikat ok={trwa ? ok : undefined} blad={blad} />

      <div className="mx-auto max-w-[1040px] space-y-4">
        <Kroki biezacy="podglad" tenantId={tenantId} jobId={job.id} zablokowane />

        {job.status === "failed" ? (
          <Alert tone="blad" title="Import zatrzymał się na błędzie">
            {job.last_error ?? "Bez opisu."} Proces w tle ponowi go automatycznie; zapisane do tej pory dane zostają, a ponowienie dopisze tylko brakujące.
          </Alert>
        ) : null}

        {trwa ? (
          <Card>
            <CardBody>
              <div className="mb-2 flex items-center justify-between text-[13px] text-[var(--color-tekst-2)]">
                <span>{job.status === "planned" ? "Czeka na proces w tle…" : `Przetworzono ${n(l.przetworzone ?? 0)} z ${n(job.row_count)} wierszy`}</span>
                <span className="liczba">{postep}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--color-powierzchnia-2)]" role="progressbar" aria-valuenow={postep} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-[var(--color-akcent)] transition-[width]" style={{ width: `${postep}%` }} />
              </div>
            </CardBody>
          </Card>
        ) : null}

        {job.status === "done" ? (
          <Card>
            <div className="grid grid-cols-2 divide-y divide-[var(--color-linia-0)] md:grid-cols-4 md:divide-x md:divide-y-0">
              <Stat label="Profile w bazie" value={n(l.odczyt?.profileWBazie)} description="adresy z pliku obecne teraz w bazie" />
              <Stat label="Zgody nadane" value={<span className="text-[var(--color-ok)]">{n(l.odczyt?.zgodyZTegoPrzebiegu)}</span>} description="odczyt zwrotny z rejestru zgód" />
              <Stat label="Wykluczenia zapisane" value={n((l.odczyt?.wypisyZTegoPrzebiegu ?? 0) + (l.supresje?.globalneZapisane ?? 0))} description={`${n(l.odczyt?.wypisyZTegoPrzebiegu)} w sklepie, ${n(l.supresje?.globalneZapisane ?? 0)} globalnie`} />
              <Stat label="Czas" value={l.trwaloSek != null ? `${l.trwaloSek.toLocaleString("pl-PL")} s` : "—"} description={`${n(l.wierszy)} wierszy`} />
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Plan a wynik" description="Plan to liczby z podglądu przed startem. Wynik to faktyczny efekt zapisów (ON CONFLICT liczy tylko to, co weszło). Odczyt to osobne zapytanie do bazy po zakończeniu." />
          <Table className="min-w-[640px]">
            <THead><tr><Th>Co</Th><Th num>Plan</Th><Th num>Wynik</Th><Th num>Odczyt z bazy</Th></tr></THead>
            <TBody>
              {wiersze.map((w) => (
                <tr key={w.etykieta}>
                  <Td>
                    <div className="font-medium">{w.etykieta}</div>
                    {w.opis ? <div className="tekst-pomocniczy mt-0.5 !text-[var(--color-tekst-3)]">{w.opis}</div> : null}
                  </Td>
                  <Td num>{n(w.plan)}</Td>
                  <Td num className={w.plan !== undefined && w.wynik !== undefined && job.status === "done" && w.plan !== w.wynik ? "text-[var(--color-uwaga)]" : ""}>{job.status === "planned" ? "—" : n(w.wynik)}</Td>
                  <Td num>{w.odczyt === undefined ? "" : n(w.odczyt)}</Td>
                </tr>
              ))}
            </TBody>
          </Table>
          {l.supresje ? (
            <CardBody className="border-t border-[var(--color-linia-0)] text-[14px] text-[var(--color-tekst-2)]">
              Plik wykluczeń <b>{job.suppression_file_name}</b>: {n(l.supresje.wierszy)} wierszy, zapisano {n(l.supresje.lokalneZapisane)} wykluczeń sklepu ({n(l.supresje.lokalneJuzByly)} już było) i {n(l.supresje.globalneZapisane)} globalnych ({n(l.supresje.globalneJuzByly)} już było), {n(l.supresje.bledy)} wierszy z błędem.
            </CardBody>
          ) : job.options.supresjePominiete ? (
            <CardBody className="border-t border-[var(--color-linia-0)]"><Alert tone="uwaga">Krok wypisów i skarg został świadomie pominięty.</Alert></CardBody>
          ) : null}
        </Card>

        <Card>
          <CardHeader
            title="Wiersze z błędem"
            description={job.error_count ? `${odmien(job.error_count, "wiersz pominięty", "wiersze pominięte", "wierszy pominiętych")}. Numer linii odpowiada linii w Twoim pliku.` : "Każdy wiersz pliku został przyjęty."}
            action={
              job.error_count ? (
                <form method="post" action={`/t/${tenantId}/import/${job.id}/bledy`}>
                  <button type="submit" className="przycisk przycisk-wtorny przycisk-maly">Pobierz listę błędów (CSV)</button>
                </form>
              ) : null
            }
          />
          {bledy.length === 0 ? (
            <EmptyState inTable icon="gotowe" title={trwa ? "Na razie bez błędów" : "Bez błędów"} description={trwa ? "Lista uzupełnia się w trakcie importu." : "Wszystkie wiersze przeszły walidację."} />
          ) : (
            <Table className="min-w-[560px]">
              <THead><tr><Th>Plik</Th><Th num>Linia</Th><Th>Adres</Th><Th>Powód</Th></tr></THead>
              <TBody>
                {bledy.map((b, i) => (
                  <tr key={i}>
                    <Td className="text-[var(--color-tekst-2)]">{b.file === "profiles" ? "profile" : "wykluczenia"}</Td>
                    <Td num>{b.line_no}</Td>
                    <Td className="font-medium">{b.email ?? "—"}</Td>
                    <Td className="text-[var(--color-tekst-2)]">{b.reason}</Td>
                  </tr>
                ))}
              </TBody>
            </Table>
          )}
          {job.error_count > bledy.length ? (
            <CardFooter className="tekst-pomocniczy">Pokazujemy pierwsze {bledy.length}. Pełna lista w pliku CSV.</CardFooter>
          ) : null}
        </Card>

        <div className="flex flex-wrap gap-2">
          {job.options.listId ? <Button href={`/t/${tenantId}/listy/${job.options.listId}`} variant="secondary">Otwórz listę</Button> : null}
          <Button href={`/t/${tenantId}/profile`} variant="secondary">Zobacz profile</Button>
          <Button href={`/t/${tenantId}/import`} variant="secondary">Nowy import</Button>
        </div>
      </div>
    </>
  );
}
