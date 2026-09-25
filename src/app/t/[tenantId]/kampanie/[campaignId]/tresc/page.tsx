import { wymaganyTenant } from "../../../../../autoryzacja";
import { getPool } from "../../../../../../adapters/db/pool";
import { wczytajDokument } from "../../../../../../domain/email/bloki";
import { Komunikat, kampaniaKreatora, RamaKreatora } from "../kreator";
import { Edytor } from "./edytor/edytor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Kampania · treść" };

/**
 * Krok 2: edytor bloków. Serwer wczytuje dokument (także z kampanii sprzed edytora —
 * wtedy jako jeden blok „Własny HTML") i oddaje go komponentowi klienta. Zapis wraca
 * przez `zapiszBlokiAkcja`, która sama sprawdza tenanta, waliduje i renderuje HTML.
 */
export default async function KrokTresc({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; campaignId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId: surowy, campaignId } = await params;
  const { tenantId } = await wymaganyTenant(surowy);
  const { ok, blad } = await searchParams;
  const kampania = await kampaniaKreatora(tenantId, campaignId);
  const { dokument, zrodlo } = wczytajDokument(kampania.content);
  const { rows } = await getPool().query("select name from tenants where id = $1", [tenantId]);

  return (
    <div className="flex h-screen flex-col">
      <RamaKreatora tenantId={tenantId} kampania={kampania} aktywny="tresc" />
      <Komunikat ok={ok} blad={blad} />
      <Edytor
        tenantId={tenantId}
        campaignId={campaignId}
        dokumentStartowy={dokument}
        zrodlo={zrodlo}
        nazwaSklepu={String(rows[0]?.name ?? "")}
        tylkoDoOdczytu={kampania.poWysylce}
        status={kampania.status}
        temat={kampania.subject ?? ""}
      />
    </div>
  );
}
