import { notFound, redirect } from "next/navigation";
import { OPIS_POLA_SUPRESJI, POLA_SUPRESJI, sprawdzMapowanieSupresji, type PoleSupresji } from "../../../../../../usecases/import-klaviyo/mapowanie";
import { przebieg } from "../../../../../../usecases/import-klaviyo/zadania";
import { wymaganyTenant } from "../../../../../autoryzacja";
import { Alert, Card, CardBody, CardFooter, CardHeader, Select, Table, TBody, Td, Th, THead } from "../../../../../ui";
import { Komunikat, Naglowek } from "../../../naglowek";
import { pominSupresjeAkcja, zapiszSupresjeAkcja } from "../../akcje";
import { FormularzPliku } from "../../formularz-pliku";
import { Kroki } from "../../kroki";

export const dynamic = "force-dynamic";

export const metadata = { title: "Import: wypisy i skargi" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Supresje({
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
  if (!["mapped", "suppressions"].includes(job.status)) redirect(`/t/${tenantId}/import/${job.id}`);
  const { ok, blad } = await searchParams;
  const naglowki = job.suppression_headers;
  const mapowanie = (job.suppression_mapping ?? []) as PoleSupresji[];
  const walidacja = naglowki ? sprawdzMapowanieSupresji(mapowanie, naglowki) : null;
  const urlUploadu = `/api/import/${tenantId}/${job.id}/supresje`;
  const tutaj = `/t/${tenantId}/import/{jobId}/supresje`;

  const probki = (i: number) =>
    (job.suppression_sample ?? [])
      .map((w) => (w[i] ?? "").trim())
      .filter(Boolean)
      .slice(0, 3);

  return (
    <>
      <Naglowek
        tytul="Wypisy, skargi i odbicia"
        podtytul="Klaviyo trzyma je osobno od list. Bez tego pliku osoba, która się wypisała, wygląda w eksporcie listy jak zwykły subskrybent."
        powrot={{ href: `/t/${tenantId}/import/${job.id}/mapowanie`, etykieta: "Mapowanie kolumn" }}
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="mx-auto max-w-[1040px] space-y-4">
        <Kroki biezacy="supresje" tenantId={tenantId} jobId={job.id} />

        {naglowki ? (
          <form action={zapiszSupresjeAkcja}>
            <input type="hidden" name="tenantId" value={tenantId} />
            <input type="hidden" name="jobId" value={job.id} />
            <Card>
              <CardHeader
                title="3. Plik wykluczeń"
                description={<>Plik <b>{job.suppression_file_name}</b>: {(job.suppression_row_count ?? 0).toLocaleString("pl-PL")} wierszy. Wypisy i ręczne wykluczenia trafią do wykluczeń tego sklepu, skargi i odbicia do globalnej listy platformy.</>}
              />
              <Table className="min-w-[640px]">
                <THead><tr><Th>Kolumna w pliku</Th><Th>Przykładowe wartości</Th><Th className="w-[240px]">Trafi do</Th></tr></THead>
                <TBody>
                  {naglowki.map((n, i) => (
                    <tr key={i}>
                      <Td className="font-semibold">{n || <span className="text-[var(--color-tekst-3)]">(bez nagłówka)</span>}</Td>
                      <Td className="max-w-[360px] text-[var(--color-tekst-2)]"><div className="truncate">{probki(i).join(" · ") || <span className="text-[var(--color-tekst-3)]">puste</span>}</div></Td>
                      <Td>
                        <Select name={`skol-${i}`} defaultValue={mapowanie[i] ?? "pomin"} aria-label={`Przypisanie kolumny ${n || i + 1}`}>
                          {POLA_SUPRESJI.map((p) => <option key={p} value={p}>{OPIS_POLA_SUPRESJI[p].etykieta}</option>)}
                        </Select>
                      </Td>
                    </tr>
                  ))}
                </TBody>
              </Table>
              {walidacja && walidacja.ostrzezenia.length ? (
                <CardBody className="border-t border-[var(--color-linia-0)]">
                  <Alert tone="info">
                    <ul className="list-disc space-y-1 pl-4">{walidacja.ostrzezenia.map((o) => <li key={o}>{o}</li>)}</ul>
                  </Alert>
                </CardBody>
              ) : null}
              <CardFooter className="flex flex-wrap items-center justify-between gap-3">
                <details className="min-w-0">
                  <summary className="cursor-pointer text-[13px] font-medium text-[var(--color-tekst-2)]">Wgraj inny plik wykluczeń</summary>
                  <div className="pt-4 md:w-[520px]">
                    <FormularzPliku url={urlUploadu} dalej={tutaj} etykieta="Wybierz plik CSV z wykluczeniami" opis="Zastąpi obecny plik." />
                  </div>
                </details>
                <button type="submit" className="przycisk">Dalej: podgląd i start</button>
              </CardFooter>
            </Card>
          </form>
        ) : (
          <>
            <Card>
              <CardHeader title="3. Plik wykluczeń z Klaviyo" description="Audience › Profiles › View suppressed profiles › Export CSV. Wystarczy kolumna Email; kolumny powodu i daty rozpoznamy, jeśli są." />
              <CardBody>
                <FormularzPliku
                  url={urlUploadu}
                  dalej={tutaj}
                  etykieta="Przeciągnij plik CSV z wykluczeniami albo kliknij, żeby wybrać"
                  opis="Do 50 MB. Osoby z tego pliku nie dostaną zgody, nawet jeśli plik profili ją ma."
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Nie mam pliku wykluczeń" description="Ten krok da się pominąć tylko świadomie." />
              <form action={pominSupresjeAkcja}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="jobId" value={job.id} />
                <CardBody className="space-y-3">
                  <Alert tone="uwaga" title="Ryzyko: mail do osoby, która się wypisała">
                    Eksport listy z Klaviyo pokazuje status SUBSCRIBED także osobom, które później trafiły na supresję (Klaviyo dokumentuje to wprost). Bez pliku wykluczeń takie osoby dostaną tu zgodę i przy pierwszej kampanii dostaną maila, którego nie chciały. To skarga na Twoją domenę, a w UE także skarga do UODO.
                  </Alert>
                  <label className="flex items-start gap-2.5 text-[14px] leading-5">
                    <input type="checkbox" name="rozumiem" value="tak" className="mt-0.5 h-4 w-4 accent-[var(--color-akcent)]" required />
                    <span>Nie mam pliku supresji i rozumiem ryzyko. Kolumnę „Email Suppressions” z pliku profili (jeśli jest) i tak uwzględnimy.</span>
                  </label>
                </CardBody>
                <CardFooter className="flex justify-end">
                  <button type="submit" className="przycisk przycisk-wtorny">Pomiń ten krok</button>
                </CardFooter>
              </form>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
