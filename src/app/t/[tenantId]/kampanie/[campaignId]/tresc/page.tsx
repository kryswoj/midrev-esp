import { wymaganyTenant } from "../../../../../autoryzacja";
import { getPool } from "../../../../../../adapters/db/pool";
import { wczytajDokument } from "../../../../../../domain/email/bloki";
import { TrybPelnyEkran } from "../../../../../ui/tryb-pelny-ekran";
import { stanKampaniiNaEkran } from "../../stany";
import { kampaniaKreatora } from "../kreator";
import { Edytor } from "./edytor/edytor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Kampania · treść" };

/**
 * Krok 2: edytor bloków na pełnym ekranie (audyt UX 02.10, P0-1). Rama panelu zwija boczną
 * nawigację (`<TrybPelnyEkran />`), a nagłówek i pasek kroków kreatora zastępuje pasek
 * edytora z nazwą kampanii, krokami, zapisem, testem i „Dalej".
 *
 * Serwer wczytuje dokument (także z kampanii sprzed edytora — wtedy jako jeden blok
 * „Własny HTML") i dane konta do nagłówka i stopki. Zapis wraca przez `zapiszBlokiAkcja`,
 * która sama sprawdza tenanta, waliduje i renderuje HTML.
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
  const { rows } = await getPool().query(
    "select name, sender_company_name, sender_postal_address, sender_tax_id from tenants where id = $1",
    [tenantId],
  );
  const t = rows[0] ?? {};

  return (
    <>
      <TrybPelnyEkran />
      <Edytor
        tenantId={tenantId}
        campaignId={campaignId}
        nazwaKampanii={kampania.name}
        stan={stanKampaniiNaEkran(kampania.status)}
        dokumentStartowy={dokument}
        zrodlo={zrodlo}
        konto={{
          nazwaSklepu: String(t.name ?? ""),
          firma: t.sender_company_name ?? null,
          adres: t.sender_postal_address ?? null,
          nip: t.sender_tax_id ?? null,
        }}
        tylkoDoOdczytu={kampania.poWysylce}
        status={kampania.status}
        temat={kampania.subject ?? ""}
        komunikat={ok || blad ? { ok, blad } : undefined}
      />
    </>
  );
}
