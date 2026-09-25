import { zamowieniaTenanta } from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import { formatujDate } from "../../../../domain/daty";
import { zGroszy } from "../../../../domain/kwoty";
import { odmien } from "../../../../domain/liczebniki";
import { nazwaStatusu, wagaStatusu } from "../../../../domain/statusy";
import { Badge, Card, CardHeader, EmptyState, MobileList, MobileListItem, Table, TBody, Td, Th, THead } from "../../../ui";
import { Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export const metadata = { title: "Zamówienia" };

export default async function Zamowienia({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const zamowienia = await zamowieniaTenanta(tenantId, 200);

  return (
    <>
      <Naglowek
        tytul="Zamówienia"
        opis="Zamówienia pobrane z połączonego sklepu, od najnowszych."
      />
      <div className="tresc-strony">
        <Card>
          <CardHeader
            title="Ostatnie zamówienia"
            description={`Najnowsze u góry.${zamowienia.length === 200 ? " Pokazujemy pierwsze 200." : ""}`}
            action={<span className="karta-naglowek-licznik">{odmien(zamowienia.length, "zamówienie", "zamówienia", "zamówień")}</span>}
          />
          {zamowienia.length === 0 ? (
            <EmptyState icon="zamowienie" title="Nie ma jeszcze zamówień" description="Pojawią się po imporcie historii podłączonego sklepu, a kolejne będą dochodzić przez webhooki." />
          ) : (
            <>
            <div className="hidden md:block"><Table>
                <THead>
                  <tr>
                    <Th>Numer</Th>
                    <Th>Klient</Th>
                    <Th>Status</Th>
                    <Th num>Kwota</Th>
                    <Th num>Data zamówienia</Th>
                  </tr>
                </THead>
                <TBody>
                  {zamowienia.map((z) => (
                    <tr key={z.id}>
                      <Td className="text-[var(--color-tekst-3)]">#{z.number ?? z.external_id}</Td>
                      <Td>
                        <div>{[z.first_name, z.last_name].filter(Boolean).join(" ") || "—"}</div>
                        <div className="tekst-meta mt-0.5">{z.email ?? "brak adresu"}</div>
                      </Td>
                      <Td><Badge ton={wagaStatusu(z.status)}>{nazwaStatusu(z.status)}</Badge></Td>
                      <Td num className="font-semibold">{zGroszy(Number(z.total_minor), z.currency)}</Td>
                      <Td num className="text-[var(--color-tekst-2)]">{formatujDate(z.occurred_at)}</Td>
                    </tr>
                  ))}
                </TBody>
            </Table></div>
            <MobileList>
              {zamowienia.map((z) => (
                <MobileListItem key={`${z.id}-mobile`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-[var(--color-tekst)]">{[z.first_name, z.last_name].filter(Boolean).join(" ") || "Brak danych klienta"}</div>
                      <div className="tekst-pomocniczy mt-0.5 truncate !text-[var(--color-tekst-3)]">{z.email ?? "brak adresu"}</div>
                      <div className="tekst-pomocniczy mt-0.5 !text-[var(--color-tekst-3)]">Zamówienie #{z.number ?? z.external_id}</div>
                    </div>
                    <div className="liczba shrink-0 text-right font-semibold">{zGroszy(Number(z.total_minor), z.currency)}</div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <Badge ton={wagaStatusu(z.status)}>{nazwaStatusu(z.status)}</Badge>
                    <span className="tekst-licznik">{formatujDate(z.occurred_at)}</span>
                  </div>
                </MobileListItem>
              ))}
            </MobileList>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
