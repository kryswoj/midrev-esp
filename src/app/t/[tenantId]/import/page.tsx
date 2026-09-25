import Link from "next/link";
import { formatujDateICzas } from "../../../../domain/daty";
import { odmien } from "../../../../domain/liczebniki";
import { przebiegiTenanta, type PrzebiegImportu } from "../../../../usecases/import-klaviyo/zadania";
import { listaTenanta } from "../../../../usecases/listy/czlonkowie";
import { wymaganyTenant } from "../../../autoryzacja";
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, ResponsiveTable, Table, TBody, Td, Th, THead } from "../../../ui";
import { Komunikat, Naglowek } from "../naglowek";
import { FormularzPliku } from "./formularz-pliku";
import { Kroki } from "./kroki";
import { STATUS_PRZEBIEGU } from "./statusy";

export const dynamic = "force-dynamic";

export const metadata = { title: "Import z Klaviyo" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


function krokPrzebiegu(p: PrzebiegImportu): string {
  if (p.status === "uploaded") return "mapowanie";
  if (p.status === "mapped") return "supresje";
  if (p.status === "suppressions") return "podglad";
  return "";
}

export default async function ImportStart({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string; lista?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granicą auth
  await wymaganyTenant(tenantId);
  const { ok, blad, lista: listaParam } = await searchParams;
  const lista = listaParam && UUID.test(listaParam) ? await listaTenanta(tenantId, listaParam) : null;
  const przebiegi = await przebiegiTenanta(tenantId, 30);

  return (
    <>
      <Naglowek
        tytul="Import z Klaviyo"
        opis="Przenosisz bazę odbiorców z pliku CSV wyeksportowanego z Klaviyo: profile, zgody z datą i źródłem oraz osobno wypisy, skargi i odbicia. Zgoda powstaje tylko wtedy, gdy plik ma jej datę; adresy z globalnej listy wykluczeń zgody nie dostaną, nawet jeśli plik ją ma. Przed uruchomieniem zobaczysz dokładnie, co się stanie."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        <div className="space-y-4">
          <Kroki biezacy="plik" tenantId={tenantId} />

          <Card>
            <CardHeader title="1. Plik profili" description="Eksport listy albo segmentu z Klaviyo (Audience › Lists & segments › Manage list › Export list to CSV), z zaznaczonymi kolumnami zgody." />
            <CardBody className="space-y-4">
              {lista ? (
                <Alert tone="info" title={`Osoby z pliku trafią do listy „${lista.name}”`}>
                  Możesz to zmienić w kroku mapowania.
                </Alert>
              ) : null}
              <FormularzPliku
                url={`/api/import/${tenantId}`}
                dalej={`/t/${tenantId}/import/{jobId}/mapowanie`}
                listaId={lista?.id ?? null}
                etykieta="Przeciągnij plik CSV albo kliknij, żeby wybrać"
                opis="Do 50 MB. Pierwsza linia to nazwy kolumn. Kolumny Klaviyo rozpoznajemy same: Email, First Name, Last Name, Email Marketing Consent, Email Marketing Consent Timestamp."
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Jak przygotować pliki w Klaviyo" />
            <CardBody>
              <ol className="grid gap-3 text-[14px] leading-5 text-[var(--color-tekst-2)] md:grid-cols-3">
                <li className="rounded-[10px] border border-[var(--color-linia)] p-4">
                  <div className="mb-1 font-semibold text-[var(--color-tekst)]">Profile ze zgodą</div>
                  Lists &amp; segments › lista › Manage list › <b>Export list to CSV</b>. Zaznacz <b>Email Marketing Consent</b> i <b>Email Marketing Consent Timestamp</b>. Bez daty zgody nie nadamy.
                </li>
                <li className="rounded-[10px] border border-[var(--color-linia)] p-4">
                  <div className="mb-1 font-semibold text-[var(--color-tekst)]">Wypisy, skargi, odbicia</div>
                  Audience › Profiles › <b>View suppressed profiles</b> › <b>Export CSV</b>. To osobny plik; bez niego osoby wypisane w Klaviyo mogłyby znowu dostać maila.
                </li>
                <li className="rounded-[10px] border border-[var(--color-linia)] p-4">
                  <div className="mb-1 font-semibold text-[var(--color-tekst)]">Właściwości własne</div>
                  Kolumny takie jak City, Shopify Tags czy punkty lojalnościowe możesz zapisać na profilu jako właściwości. Zdecydujesz o tym przy mapowaniu.
                </li>
              </ol>
            </CardBody>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title="Poprzednie importy" action={<span className="karta-naglowek-licznik">{odmien(przebiegi.length, "import", "importy", "importów")}</span>} />
          {przebiegi.length === 0 ? (
            <EmptyState icon="dokument" title="Jeszcze nic nie importowano" description="Pierwszy import pojawi się tutaj razem z raportem: ile profili, ile zgód, ile wykluczeń." />
          ) : (
            <ResponsiveTable
              table={
                <Table className="min-w-[520px]">
                  <THead><tr><Th>Plik</Th><Th>Stan</Th><Th num>Wierszy</Th><Th num>Zgód</Th></tr></THead>
                  <TBody>
                    {przebiegi.map((p) => {
                      const s = STATUS_PRZEBIEGU[p.status];
                      const krok = krokPrzebiegu(p);
                      const href = `/t/${tenantId}/import/${p.id}${krok ? `/${krok}` : ""}`;
                      const zgody = (p.counters as { odczyt?: { zgodyZTegoPrzebiegu?: number } }).odczyt?.zgodyZTegoPrzebiegu;
                      return (
                        <tr key={p.id} className="wiersz-link">
                          <Td>
                            <Link href={href} className="wiersz-link-cel font-semibold">{p.file_name}</Link>
                            <div className="tekst-pomocniczy mt-0.5 !text-[var(--color-tekst-3)] liczba">{formatujDateICzas(p.created_at)}</div>
                          </Td>
                          <Td><Badge ton={s.ton}>{s.slowo}</Badge></Td>
                          <Td num>{p.row_count.toLocaleString("pl-PL")}</Td>
                          <Td num>{zgody === undefined ? "—" : zgody.toLocaleString("pl-PL")}</Td>
                        </tr>
                      );
                    })}
                  </TBody>
                </Table>
              }
              mobile={
                <div>
                  {przebiegi.map((p) => {
                    const s = STATUS_PRZEBIEGU[p.status];
                    const krok = krokPrzebiegu(p);
                    return (
                      <Link key={p.id} href={`/t/${tenantId}/import/${p.id}${krok ? `/${krok}` : ""}`} className="lista-mobilna-element">
                        <div className="lista-mobilna-wiersz">
                          <div className="min-w-0">
                            <div className="lista-mobilna-tytul truncate">{p.file_name}</div>
                            <div className="lista-mobilna-meta liczba">{formatujDateICzas(p.created_at)}</div>
                          </div>
                          <Badge ton={s.ton}>{s.slowo}</Badge>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              }
            />
          )}
        </Card>
      </div>
    </>
  );
}
