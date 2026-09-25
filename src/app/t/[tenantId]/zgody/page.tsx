import {
  statystykiZgod,
  wykluczeniaGlobalne,
  wykluczeniaTenanta,
  zgodyTenanta,
} from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import { formatujDate } from "../../../../domain/daty";
import { zrodloZgody } from "../../../../domain/statusy";
import { Badge, Card, CardHeader, EmptyState, Icon, MobileList, MobileListItem, Stat, Table, TBody, Td, Th, THead } from "../../../ui";
import { Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export const metadata = { title: "Zgody i wykluczenia" };

function StanZgody({ stan, wykluczony }: { stan: string; wykluczony: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {stan === "granted" ? (
        <Badge ton="ok">zgoda</Badge>
      ) : (
        <Badge ton="blad" className="border-[var(--color-blad-ramka)] bg-[var(--color-blad-tlo)] font-semibold">wycofana</Badge>
      )}
      {stan === "granted" && wykluczony ? (
        <Badge ton="uwaga">wykluczony</Badge>
      ) : null}
    </div>
  );
}

export default async function Zgody({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const [statystyki, zgody, wykluczenia, globalne] = await Promise.all([
    statystykiZgod(tenantId),
    zgodyTenanta(tenantId),
    wykluczeniaTenanta(tenantId),
    wykluczeniaGlobalne(tenantId),
  ]);

  return (
    <>
      <Naglowek
        tytul="Zgody i wykluczenia"
        opis="Zgoda nie jest polem w profilu, tylko wpisem w rejestrze: data, źródło i treść klauzuli, na którą osoba się zgodziła. Aktualny stan to ostatni wpis, więc wycofanie zgody nie kasuje historii. Wykluczenia działają na dwóch poziomach: lokalne to wypisania z tego sklepu, globalne chronią reputację całej platformy."
      />

      <div className="tresc-strony">
        <Card>
          <div className="grid divide-y divide-[var(--color-linia-0)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Stat icon={<Icon name="wiadomosc" size={16} />} label="Zgody na e-mail" value={String(statystyki.zgody_email)} description={`na ${statystyki.profile} profili`} />
            <Stat icon={<Icon name="alert" size={16} />} label="Wycofane" value={String(statystyki.wycofane_email)} description="ostatni wpis" />
            <Stat icon={<Icon name="zgodnosc" size={16} />} label="Wykluczenia" value={String(wykluczenia.filter((w: any) => w.action === "suppressed").length)} description="w tym sklepie" />
          </div>
        </Card>

        <Card>
          <CardHeader title="Rejestr zgód" description="Aktualny stan każdej osoby i kanału wraz ze źródłem oraz datą." />
            {zgody.length === 0 ? (
              <EmptyState icon="zgodnosc" title="Rejestr zgód jest pusty" description="Pierwsze wpisy powstaną przy zapisie z formularza, w checkoucie sklepu albo przy imporcie bazy." />
            ) : (
              <>
              <div className="hidden md:block">
              <Table>
                  <THead>
                    <tr>
                      <Th>Osoba</Th>
                      <Th>Stan</Th>
                      <Th>Źródło</Th>
                      <Th num>Data</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {zgody.map((z: any) => {
                      // Zgoda i wykluczenie to dwa rejestry, ale operator patrzy na jeden ekran:
                      // adres ze zgodą obecny w wykluczeniach musi być oznaczony, inaczej "zgoda"
                      // obok wpisu o wypisaniu wygląda jak sprzeczność.
                      const wykluczony = Boolean(z.wykluczony);
                      return (
                        <tr key={`${z.profile_id}-${z.channel}`}>
                          <Td>
                            <div>{[z.first_name, z.last_name].filter(Boolean).join(" ") || "—"}</div>
                            <div className="tekst-meta mt-0.5">{z.email}</div>
                          </Td>
                          <Td><StanZgody stan={z.state} wykluczony={wykluczony} /></Td>
                          <Td className="text-[var(--color-tekst-2)]">{zrodloZgody(z.source)}</Td>
                          <Td num className="text-[var(--color-tekst-2)]">{formatujDate(z.occurred_at)}</Td>
                        </tr>
                      );
                    })}
                  </TBody>
              </Table>
              </div>
              <MobileList>
                {zgody.map((z: any) => {
                  const wykluczony = Boolean(z.wykluczony);
                  return (
                    <MobileListItem key={`${z.profile_id}-${z.channel}-mobile`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-[var(--color-tekst)]">{[z.first_name, z.last_name].filter(Boolean).join(" ") || "—"}</div>
                          <div className="tekst-pomocniczy mt-0.5 truncate !text-[var(--color-tekst-3)]">{z.email}</div>
                        </div>
                        <StanZgody stan={z.state} wykluczony={wykluczony} />
                      </div>
                      <div className="tekst-pomocniczy mt-3 flex items-center justify-between gap-3">
                        <span className="truncate">{zrodloZgody(z.source)}</span>
                        <span className="liczba shrink-0">{formatujDate(z.occurred_at)}</span>
                      </div>
                    </MobileListItem>
                  );
                })}
              </MobileList>
              </>
            )}
        </Card>

        <div className="grid gap-6 xl:grid-cols-2 xl:items-start">
          <Card>
            <CardHeader
              title="Wykluczenia tego sklepu"
              description="Adresy wypisane lokalnie, według ostatniego wpisu."
              action={wykluczenia.length > 0 ? <Badge ton="uwaga">{wykluczenia.length}</Badge> : undefined}
            />
              {wykluczenia.length === 0 ? (
                <EmptyState inTable icon="odbiorcy" title="Nie ma lokalnych wykluczeń" description="Wypisania z tego sklepu będą tu dopisywane razem z powodem i datą." />
              ) : (
                <>
                <div className="hidden md:block"><Table>
                    <THead>
                      <tr>
                        <Th>Adres</Th>
                        <Th>Powód</Th>
                        <Th num>Data</Th>
                      </tr>
                    </THead>
                    <TBody>
                      {wykluczenia.map((w: any) => (
                        <tr key={w.email}>
                          <Td>{w.email}</Td>
                          <Td className="text-[var(--color-tekst-2)]">
                            {w.action === "released" ? `zdjęte — ${w.reason}` : w.reason}
                          </Td>
                          <Td num className="text-[var(--color-tekst-2)]">{formatujDate(w.occurred_at)}</Td>
                        </tr>
                      ))}
                    </TBody>
                </Table></div>
                <MobileList>
                  {wykluczenia.map((w: any) => (
                    <MobileListItem key={`${w.email}-mobile`}>
                      <div className="break-all font-medium text-[var(--color-tekst)]">{w.email}</div>
                      <div className="tekst-pomocniczy mt-2 flex items-start justify-between gap-4">
                        <span>{w.action === "released" ? `zdjęte — ${w.reason}` : w.reason}</span>
                        <span className="liczba shrink-0">{formatujDate(w.occurred_at)}</span>
                      </div>
                    </MobileListItem>
                  ))}
                </MobileList>
                </>
              )}
          </Card>

          <Card>
            <CardHeader
              title="Wykluczenia globalne"
              description="Chronią wszystkich klientów agencji przed ponowną wysyłką na adres po skardze lub odbiciu."
              action={globalne.length > 0 ? <Badge ton="blad">{globalne.length}</Badge> : undefined}
            />
              {globalne.length === 0 ? (
                <EmptyState inTable icon="zgodnosc" title="Nie ma globalnych wykluczeń" description="Lista zapełni się automatycznie z odbić i skarg, gdy ruszy wysyłka." />
              ) : (
                <>
                <div className="hidden md:block"><Table>
                    <THead>
                      <tr>
                        <Th>Adres</Th>
                        <Th>Powód</Th>
                      </tr>
                    </THead>
                    <TBody>
                      {globalne.map((g: any) => (
                        <tr key={g.email}>
                          <Td>{g.email}</Td>
                          <Td className="text-[var(--color-tekst-2)]">{g.reason}</Td>
                        </tr>
                      ))}
                    </TBody>
                </Table></div>
                <MobileList>
                  {globalne.map((g: any) => (
                    <MobileListItem key={`${g.email}-mobile`}>
                      <div className="break-all font-medium text-[var(--color-tekst)]">{g.email}</div>
                      <div className="tekst-pomocniczy mt-1">{g.reason}</div>
                    </MobileListItem>
                  ))}
                </MobileList>
                </>
              )}
          </Card>
        </div>
      </div>
    </>
  );
}
