import { notFound } from "next/navigation";
import { getPool } from "../../../../../../../../adapters/db/pool";
import { dokumentWiadomosci, wiadomoscFlow } from "../../../../../../../../usecases/automatyzacje/journeye";
import { wymaganyTenant } from "../../../../../../../autoryzacja";
import { TrybPelnyEkran } from "../../../../../../../ui/tryb-pelny-ekran";
import { EdytorWiadomosci } from "./edytor-wiadomosci";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automatyzacja · treść maila" };

/**
 * Tresc wiadomosci kroku e-mail: TEN SAM edytor blokow co w kampaniach (biblioteka, plotno,
 * panel wlasciwosci i render sa importowane z kreatora kampanii), tylko zapis idzie do
 * wiadomosci automatyzacji. Serwer wczytuje dokument i oddaje go komponentowi klienta.
 */
export default async function TrescWiadomosci({ params }: { params: Promise<{ tenantId: string; journeyId: string; emailId: string }> }) {
  const { tenantId: zadany, journeyId, emailId } = await params;
  const { tenantId } = await wymaganyTenant(zadany);
  const w = await wiadomoscFlow(tenantId, journeyId, emailId);
  if (!w) notFound();
  const { dokument, zrodlo } = dokumentWiadomosci(w.content);
  const { rows } = await getPool().query("select name from tenants where id = $1", [tenantId]);
  // Pełny ekran jak edytor kampanii i kanwa (kontrakt ramy, fala 1): rama zwija pasek
  // i zdejmuje padding, więc bez ujemnych marginesów; wysokość ze zmiennej, nie h-screen
  // (na telefonie 100vh jest wyższe o dwa paski u góry).
  return (
    <>
      <TrybPelnyEkran />
      <div className="flex h-[var(--wysokosc-pelnego-ekranu)] flex-col bg-[var(--color-app)]">
        <EdytorWiadomosci
          tenantId={tenantId}
          flowId={journeyId}
          emailId={emailId}
          flowName={w.flowName}
          nazwaStartowa={w.nazwa}
          tematStartowy={w.temat}
          dokumentStartowy={dokument}
          zrodlo={zrodlo}
          nazwaSklepu={String(rows[0]?.name ?? "")}
          flowStatus={w.flowStatus}
          wersjaStartowa={w.wersja}
        />
      </div>
    </>
  );
}
