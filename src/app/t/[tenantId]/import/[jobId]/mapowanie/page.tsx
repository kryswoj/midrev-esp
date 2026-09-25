import { notFound, redirect } from "next/navigation";
import { OPIS_POLA, POLA_PROFILU, sprawdzMapowanie, type PoleProfilu } from "../../../../../../usecases/import-klaviyo/mapowanie";
import { listyDoWyboru, przebieg } from "../../../../../../usecases/import-klaviyo/zadania";
import { wymaganyTenant } from "../../../../../autoryzacja";
import { Alert, Card, CardBody, CardFooter, CardHeader, Select, Table, TBody, Td, Th, THead } from "../../../../../ui";
import { Komunikat, Naglowek } from "../../../naglowek";
import { zapiszMapowanieAkcja } from "../../akcje";
import { Kroki } from "../../kroki";

export const dynamic = "force-dynamic";

export const metadata = { title: "Import: mapowanie kolumn" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Mapowanie({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; jobId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string; uwaga?: string }>;
}) {
  const { tenantId, jobId } = await params;
  await wymaganyTenant(tenantId);
  if (!UUID.test(jobId)) notFound();
  const job = await przebieg(tenantId, jobId);
  if (!job) notFound();
  if (!["uploaded", "mapped", "suppressions"].includes(job.status)) redirect(`/t/${tenantId}/import/${job.id}`);
  const { ok, blad, uwaga } = await searchParams;
  const listy = await listyDoWyboru(tenantId);
  const mapowanie = job.mapping as PoleProfilu[];
  const walidacja = sprawdzMapowanie(mapowanie, job.headers);
  const pokazOstrzezenia = uwaga === "1" && walidacja.ostrzezenia.length > 0;

  const probki = (i: number) =>
    job.sample
      .map((w) => (w[i] ?? "").trim())
      .filter(Boolean)
      .slice(0, 3);

  return (
    <>
      <Naglowek
        tytul="Mapowanie kolumn"
        podtytul={<>Plik <b>{job.file_name}</b>: {job.row_count.toLocaleString("pl-PL")} wierszy, {job.headers.length} kolumn. Sprawdź, dokąd trafi każda kolumna.</>}
        powrot={{ href: `/t/${tenantId}/import`, etykieta: "Import z Klaviyo" }}
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="mx-auto max-w-[1040px] space-y-4">
        <Kroki biezacy="mapowanie" tenantId={tenantId} jobId={job.id} />

        <form action={zapiszMapowanieAkcja}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="jobId" value={job.id} />

          <Card>
            <CardHeader title="2. Kolumny pliku" description="Kolumny Klaviyo rozpoznaliśmy automatycznie. Zgoda wymaga dwóch kolumn: statusu i daty." />
            <Table className="min-w-[720px]">
              <THead>
                <tr>
                  <Th>Kolumna w pliku</Th>
                  <Th>Przykładowe wartości</Th>
                  <Th className="w-[280px]">Trafi do</Th>
                </tr>
              </THead>
              <TBody>
                {job.headers.map((naglowek, i) => (
                  <tr key={i}>
                    <Td className="font-semibold">{naglowek || <span className="text-[var(--color-tekst-3)]">(bez nagłówka)</span>}</Td>
                    <Td className="max-w-[360px] text-[var(--color-tekst-2)]">
                      {probki(i).length ? (
                        <div className="truncate" title={probki(i).join(" · ")}>{probki(i).join(" · ")}</div>
                      ) : (
                        <span className="text-[var(--color-tekst-3)]">puste</span>
                      )}
                    </Td>
                    <Td>
                      <Select name={`kol-${i}`} defaultValue={mapowanie[i] ?? "pomin"} aria-label={`Przypisanie kolumny ${naglowek || i + 1}`}>
                        {POLA_PROFILU.map((p) => (
                          <option key={p} value={p}>
                            {p === "wlasciwosc" ? `Właściwość własna „${naglowek.trim() || `kolumna ${i + 1}`}”` : OPIS_POLA[p].etykieta}
                          </option>
                        ))}
                      </Select>
                    </Td>
                  </tr>
                ))}
              </TBody>
            </Table>
            <CardBody className="border-t border-[var(--color-linia-0)]">
              <div className="grid gap-4 md:grid-cols-[280px_1fr] md:gap-8">
                <div>
                  <h3 className="text-[15px] font-semibold">Lista docelowa</h3>
                  <p className="tekst-pomocniczy mt-1">Wszystkie poprawne adresy z pliku trafią na listę, także te bez zgody. Do wysyłki i tak przechodzą tylko osoby ze zgodą.</p>
                </div>
                <div className="max-w-[420px]">
                  <label className="etykieta mb-1.5 block" htmlFor="listId">Dodaj osoby do listy</label>
                  <Select id="listId" name="listId" defaultValue={job.options.listId ?? ""}>
                    <option value="">Bez listy (tylko profile i zgody)</option>
                    {listy.map((l) => (
                      <option key={l.id} value={l.id}>{l.name} ({l.czlonkow.toLocaleString("pl-PL")})</option>
                    ))}
                  </Select>
                  {listy.length === 0 ? <p className="tekst-meta mt-1.5">Nie ma jeszcze żadnej listy. Możesz ją utworzyć w zakładce Listy i wrócić tutaj.</p> : null}
                </div>
              </div>
            </CardBody>

            {pokazOstrzezenia ? (
              <CardBody className="border-t border-[var(--color-linia-0)] space-y-3">
                <Alert tone="uwaga" title="Zanim przejdziesz dalej">
                  <ul className="list-disc space-y-1 pl-4">
                    {walidacja.ostrzezenia.map((o) => <li key={o}>{o}</li>)}
                  </ul>
                </Alert>
                <label className="flex items-start gap-2.5 text-[14px] leading-5">
                  <input type="checkbox" name="potwierdzam" value="tak" className="mt-0.5 h-4 w-4 accent-[var(--color-akcent)]" required />
                  <span>Rozumiem. Chcę zaimportować te osoby tak, jak opisano wyżej.</span>
                </label>
              </CardBody>
            ) : null}

            <CardFooter className="flex flex-wrap items-center justify-between gap-3">
              <p className="tekst-pomocniczy max-w-[60ch]">Zmiany mapowania zapisują się przy przejściu dalej. Nic nie trafia jeszcze do bazy odbiorców.</p>
              <button type="submit" className="przycisk">{pokazOstrzezenia ? "Rozumiem, dalej: wypisy i skargi" : "Dalej: wypisy i skargi"}</button>
            </CardFooter>
          </Card>
        </form>
      </div>
    </>
  );
}
