import Link from "next/link";
import { notFound } from "next/navigation";
import { formatujDate } from "../../../../../domain/daty";
import { odmien } from "../../../../../domain/liczebniki";
import { czlonkowieListy, listaTenanta, segmentyDoWyboru, statystykiListy } from "../../../../../usecases/listy/czlonkowie";
import { wymaganyTenant } from "../../../../autoryzacja";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Icon, Input, ResponsiveTable, Select, Stat, Table, TBody, Td, Th, THead } from "../../../../ui";
import { Komunikat, Naglowek } from "../../naglowek";
import { dodajPoEmailuAkcja, dodajZSegmentuAkcja, usunZListyAkcja } from "./akcje";

export const dynamic = "force-dynamic";

export const metadata = { title: "Lista" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NA_STRONE = 100;
const n = (x: number) => x.toLocaleString("pl-PL");

function zrodlo(s: string): string {
  if (s.startsWith("import:")) return "import z pliku";
  if (s.startsWith("segment:")) return `segment ${s.slice(8)}`;
  if (s.startsWith("reczny")) return "ręcznie";
  if (s.startsWith("popup")) return "formularz zapisu";
  return s;
}

export default async function SzczegolyListy({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; listId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string; q?: string; strona?: string }>;
}) {
  const { tenantId, listId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granicą auth
  await wymaganyTenant(tenantId);
  if (!UUID.test(listId)) notFound();
  const lista = await listaTenanta(tenantId, listId);
  if (!lista) notFound();
  const { ok, blad, q = "", strona: stronaParam } = await searchParams;
  const strona = Math.max(1, Number.parseInt(stronaParam ?? "1", 10) || 1);
  const [stat, czlonkowie, segmenty] = await Promise.all([
    statystykiListy(tenantId, listId),
    czlonkowieListy(tenantId, listId, { q, limit: NA_STRONE, offset: (strona - 1) * NA_STRONE }),
    segmentyDoWyboru(tenantId),
  ]);
  const stron = Math.max(1, Math.ceil(czlonkowie.razem / NA_STRONE));
  const link = (s: number) => `/t/${tenantId}/listy/${listId}?${new URLSearchParams({ ...(q ? { q } : {}), strona: String(s) }).toString()}`;

  return (
    <>
      <Naglowek
        tytul={lista.name}
        podtytul={lista.description ?? "Lista statyczna. Osoby zostają na niej do czasu świadomego usunięcia."}
        powrot={{ href: `/t/${tenantId}/listy`, etykieta: "Listy" }}
        akcja={
          <>
            <form method="post" action={`/t/${tenantId}/listy/${listId}/eksport`}>
              <button type="submit" className="przycisk przycisk-wtorny" disabled={stat.czlonkow === 0}>Eksportuj CSV</button>
            </form>
            <Button href={`/t/${tenantId}/import?lista=${listId}`}>Importuj z pliku</Button>
          </>
        }
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        <div className="space-y-4">
          <Card>
            <div className="grid grid-cols-2 divide-y divide-[var(--color-linia-0)] md:grid-cols-4 md:divide-x md:divide-y-0">
              <Stat label="Na liście" value={n(stat.czlonkow)} description="wszystkie osoby" />
              <Stat label="Ze zgodą" value={<span className="text-[var(--color-ok)]">{n(stat.zeZgoda)}</span>} description="dostaną kampanię do tej listy" />
              <Stat label="Bez zgody" value={n(stat.bezZgody)} description="na liście, ale bramka wysyłki ich odrzuci" />
              <Stat label="Wykluczeni" value={n(stat.wykluczonych)} description="wypisani, skargi, odbicia" />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Osoby na liście"
              description={q ? `Wyniki dla „${q}”: ${odmien(czlonkowie.razem, "osoba", "osoby", "osób")}.` : "Najnowsze wpisy u góry."}
              action={
                <form method="get" className="flex items-center gap-2">
                  <Input type="search" name="q" defaultValue={q} placeholder="Szukaj po e-mailu albo nazwisku" aria-label="Szukaj na liście" className="w-[260px] max-md:w-full" />
                  <button type="submit" className="przycisk przycisk-wtorny przycisk-maly">Szukaj</button>
                </form>
              }
            />
            {czlonkowie.wiersze.length === 0 ? (
              q ? (
                <EmptyState inTable icon="profil" title="Nikogo nie znaleziono" description={<>Brak osób pasujących do „{q}”. <Link href={`/t/${tenantId}/listy/${listId}`} className="font-medium text-[var(--color-akcent)]">Pokaż całą listę</Link>.</>} />
              ) : (
                <EmptyState inTable icon="lista" title="Lista jest pusta" description="Zaimportuj plik z Klaviyo, dodaj osoby z segmentu albo pojedynczo po adresie." action={<Button href={`/t/${tenantId}/import?lista=${listId}`}>Importuj z pliku</Button>} />
              )
            ) : (
              <>
                <ResponsiveTable
                  table={
                    <Table className="min-w-[820px]">
                      <THead><tr><Th>Osoba</Th><Th>Zgoda</Th><Th>Na liście od</Th><Th>Skąd</Th><Th className="w-[1%]"></Th></tr></THead>
                      <TBody>
                        {czlonkowie.wiersze.map((c) => {
                          const nazwa = [c.first_name, c.last_name].filter(Boolean).join(" ") || "Bez nazwiska";
                          return (
                            <tr key={c.profile_id} className="wiersz-link">
                              <Td>
                                <Link href={`/t/${tenantId}/profile/${c.profile_id}`} className="wiersz-link-cel font-semibold" prefetch={false}>{nazwa}</Link>
                                <div className="tekst-pomocniczy mt-0.5 truncate !text-[var(--color-tekst-3)]">{c.email ?? "brak adresu"}</div>
                              </Td>
                              <Td>
                                {c.wykluczony ? <Badge ton="blad">wykluczony</Badge> : c.zgoda === "granted" ? <Badge ton="ok">zgoda{c.zgoda_at ? ` · ${formatujDate(c.zgoda_at)}` : ""}</Badge> : c.zgoda === "withdrawn" ? <Badge ton="uwaga">wycofana</Badge> : <Badge ton="nieaktywna">bez zgody</Badge>}
                              </Td>
                              <Td className="liczba text-[var(--color-tekst-2)]">{formatujDate(c.added_at)}</Td>
                              <Td className="text-[var(--color-tekst-2)]">{zrodlo(c.source)}</Td>
                              <Td>
                                <form action={usunZListyAkcja}>
                                  <input type="hidden" name="tenantId" value={tenantId} />
                                  <input type="hidden" name="listId" value={listId} />
                                  <input type="hidden" name="profileId" value={c.profile_id} />
                                  <button type="submit" className="przycisk przycisk-wtorny przycisk-maly relative z-10" aria-label={`Usuń ${c.email ?? nazwa} z listy`}>Usuń</button>
                                </form>
                              </Td>
                            </tr>
                          );
                        })}
                      </TBody>
                    </Table>
                  }
                  mobile={
                    <div>
                      {czlonkowie.wiersze.map((c) => {
                        const nazwa = [c.first_name, c.last_name].filter(Boolean).join(" ") || "Bez nazwiska";
                        return (
                          <div key={c.profile_id} className="lista-mobilna-element">
                            <div className="lista-mobilna-wiersz">
                              <div className="min-w-0">
                                <Link href={`/t/${tenantId}/profile/${c.profile_id}`} className="lista-mobilna-tytul block truncate" prefetch={false}>{nazwa}</Link>
                                <div className="lista-mobilna-meta truncate">{c.email ?? "brak adresu"}</div>
                                <div className="lista-mobilna-meta">od <span className="liczba">{formatujDate(c.added_at)}</span> · {zrodlo(c.source)}</div>
                              </div>
                              {c.wykluczony ? <Badge ton="blad">wykluczony</Badge> : c.zgoda === "granted" ? <Badge ton="ok">zgoda</Badge> : <Badge ton="nieaktywna">bez zgody</Badge>}
                            </div>
                            <form action={usunZListyAkcja} className="mt-2">
                              <input type="hidden" name="tenantId" value={tenantId} />
                              <input type="hidden" name="listId" value={listId} />
                              <input type="hidden" name="profileId" value={c.profile_id} />
                              <button type="submit" className="przycisk przycisk-wtorny przycisk-maly">Usuń z listy</button>
                            </form>
                          </div>
                        );
                      })}
                    </div>
                  }
                />
                {stron > 1 ? (
                  <div className="flex items-center justify-between gap-3 border-t border-[var(--color-linia-0)] px-6 py-3 max-md:px-4">
                    <span className="tekst-pomocniczy">Strona {strona} z {stron} · {odmien(czlonkowie.razem, "osoba", "osoby", "osób")}</span>
                    <div className="flex gap-2">
                      <Button href={link(strona - 1)} variant="secondary" size="sm" disabled={strona <= 1}>Poprzednia</Button>
                      <Button href={link(strona + 1)} variant="secondary" size="sm" disabled={strona >= stron}>Następna</Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Dodaj osobę" description="Istniejący profil po adresie e-mail. Nowe osoby wchodzą importem albo formularzem, żeby zgoda miała źródło." />
            <form action={dodajPoEmailuAkcja}>
              <input type="hidden" name="tenantId" value={tenantId} />
              <input type="hidden" name="listId" value={listId} />
              <CardBody className="space-y-3">
                <label className="block">
                  <span className="etykieta mb-1.5 block">Adres e-mail</span>
                  <Input name="email" type="email" required placeholder="anna@sklep.pl" autoComplete="off" />
                </label>
                <button type="submit" className="przycisk">Dodaj do listy</button>
              </CardBody>
            </form>
          </Card>

          <Card>
            <CardHeader title="Dodaj z segmentu" description="Jednorazowa migawka: osoby spełniające dziś warunek segmentu. Lista nie będzie śledzić segmentu później." />
            <form action={dodajZSegmentuAkcja}>
              <input type="hidden" name="tenantId" value={tenantId} />
              <input type="hidden" name="listId" value={listId} />
              <CardBody className="space-y-3">
                {segmenty.length === 0 ? (
                  <p className="tekst-pomocniczy">Nie ma jeszcze żadnego segmentu. <Link href={`/t/${tenantId}/segmenty`} className="font-medium text-[var(--color-akcent)]">Utwórz segment</Link>.</p>
                ) : (
                  <>
                    <label className="block">
                      <span className="etykieta mb-1.5 block">Segment</span>
                      <Select name="segmentId" required defaultValue="">
                        <option value="" disabled>Wybierz segment</option>
                        {segmenty.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                    </label>
                    <button type="submit" className="przycisk przycisk-wtorny">Dodaj osoby z segmentu</button>
                  </>
                )}
              </CardBody>
            </form>
          </Card>

          <Card>
            <CardHeader title="O tej liście" />
            <CardBody className="space-y-2 text-[14px] leading-5 text-[var(--color-tekst-2)]">
              <div className="flex items-center gap-2"><Icon name="kalendarz" size={16} className="text-[var(--color-tekst-3)]" /> utworzona <span className="liczba">{formatujDate(lista.created_at)}</span></div>
              <div className="flex items-center gap-2"><Icon name="zgodnosc" size={16} className="text-[var(--color-tekst-3)]" /> {n(stat.bezAdresu)} osób bez adresu e-mail</div>
              <p className="pt-1">Usunięcie z listy nie usuwa profilu ani zgody. Zgoda i wykluczenia żyją na profilu, lista tylko grupuje.</p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
