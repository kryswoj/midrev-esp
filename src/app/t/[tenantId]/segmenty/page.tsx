import { segmentyTenanta } from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import { policzSegment } from "../../../../adapters/db/segmenty";
import { odmien } from "../../../../domain/liczebniki";
import { opiszRegule as opiszReguleSurowo, type Regula } from "../../../../domain/segmenty";
import { Badge, Card, CardHeader, EmptyState, Icon, ResponsiveTable, Table, TBody, Td, Th, THead } from "../../../ui";
import { Komunikat, Naglowek } from "../naglowek";
import { FormularzSegmentu } from "./formularz-segmentu";

export const dynamic = "force-dynamic";

export const metadata = { title: "Segmenty" };

function opiszRegule(r: Regula): string {
  try { return opiszReguleSurowo(r); } catch { return "reguła nieznana"; }
}

export default async function Segmenty({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const { ok, blad } = await searchParams;
  const segmenty = await segmentyTenanta(tenantId);
  const zLiczba = await Promise.all(
    // Jeden uszkodzony segment (stara reguła o nieznanym typie) nie może wywrócić całej
    // listy: wtedy nie dałoby się go nawet zobaczyć, żeby go poprawić (review 24.09, S1).
    segmenty.map(async (s: any) => {
      try {
        return { ...s, ile: await policzSegment(tenantId, s.rules as Regula[]), uszkodzony: null as string | null };
      } catch (e) {
        return { ...s, ile: null, uszkodzony: e instanceof Error ? e.message : "nieznany błąd reguł" };
      }
    }),
  );

  return (
    <>
      <Naglowek
        tytul="Segmenty"
        opis="Segment to definicja reguł, nie zamrożona lista ludzi. Liczebność jest przeliczana przy każdym otwarciu, bo lista zapisana wczoraj kłamie już dzisiaj. W fazie 1 działa zamknięty zestaw reguł: otwarty builder wraca wtedy, gdy klient poprosi o coś, czego się z tego nie złoży."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        <Card>
          <CardHeader
            title="Listy dynamiczne"
            description="Członkostwo zmienia się automatycznie razem z danymi klientów."
            action={<span className="karta-naglowek-licznik">{odmien(zLiczba.length, "segment", "segmenty", "segmentów")}</span>}
          />
          {zLiczba.length === 0 ? (
            <EmptyState icon="segment" title="Nie ma jeszcze żadnego segmentu" description="Pierwszy złożysz w kreatorze poniżej. Panel policzy odbiorców przy każdym otwarciu tego ekranu." />
          ) : (
            <ResponsiveTable table={<Table className="min-w-[640px]">
              <THead><tr><Th>Nazwa</Th><Th>Typ</Th><Th>Warunki</Th><Th num>Profile</Th></tr></THead>
              <TBody>
                  {zLiczba.map((s: any) => (
                    <tr key={s.id}>
                      <Td><div className="flex items-center gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]"><Icon name="segment" size={14} /></span><span className="font-semibold">{s.name}</span></div></Td>
                      <Td><Badge>dynamiczny</Badge></Td>
                      <Td>
                        <span className="flex max-w-[460px] flex-wrap gap-1.5 py-1">
                          {(s.rules as Regula[]).map((r, i) => (
                            <span
                              key={i}
                              className="zeton-neutralny"
                            >
                              <Icon name="segment" size={12} className="shrink-0 text-[var(--color-tekst-3)]" />
                              {opiszRegule(r)}
                            </span>
                          ))}
                        </span>
                      </Td>
                      <Td num>{s.uszkodzony ? <span title={s.uszkodzony}><Badge ton="blad">segment uszkodzony</Badge></span> : s.ile}</Td>
                    </tr>
                  ))}
              </TBody>
            </Table>} mobile={<div>
              {zLiczba.map((s: any) => <div key={s.id} className="lista-mobilna-element">
                <div className="lista-mobilna-wiersz"><div className="lista-mobilna-tytul">{s.name}</div><div className="lista-mobilna-wartosc">{s.uszkodzony ? "segment uszkodzony" : odmien(s.ile, "profil", "profile", "profili")}</div></div>
                <div className="lista-mobilna-meta mt-2">{(s.rules as Regula[]).map(opiszRegule).join(" · ")}</div>
              </div>)}
            </div>} />
          )}
        </Card>

        <Card id="nowy-segment" className="h-fit">
          <CardHeader title="Nowy segment" description="Zdefiniuj, kto ma należeć do tej grupy. Wynik liczy się na żywo." />
          <div className="max-w-[880px] p-6 max-md:p-4"><FormularzSegmentu tenantId={tenantId} /></div>
          <p className="tekst-pomocniczy border-t border-[var(--color-linia-0)] px-6 py-4 !text-[var(--color-tekst-3)] max-md:px-4">
            Jeden segment może dziś zawierać jedną regułę; łączenie warunków przez „oraz” lub „lub” nie jest jeszcze dostępne.
          </p>
        </Card>
      </div>
    </>
  );
}
