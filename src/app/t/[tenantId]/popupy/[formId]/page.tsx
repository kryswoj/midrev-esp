import { notFound } from "next/navigation";
import { adresSledzenia } from "../../../../../config";
import { listyTenanta } from "../../../../../adapters/db/repozytoria";
import { formularzDoEdycji } from "../../../../../usecases/popupy/formularze";
import { wynikiFormularza } from "../../../../../usecases/popupy/wyswietlenia";
import { nazwaFirmyTenanta } from "../../../../../usecases/popupy/zarzadzaj";
import { wymaganyTenant } from "../../../../autoryzacja";
import { TrybPelnyEkran } from "../../../../ui/tryb-pelny-ekran";
import { Builder } from "./builder";

export const dynamic = "force-dynamic";
export const metadata = { title: "Formularz · builder" };

/**
 * Builder formularza na pełnym ekranie (rama zwija boczną nawigację). Serwer wczytuje
 * szkic (albo stary popup jako formularz jednokrokowy), listy, nazwę firmy do domyślnej
 * zgody i wyniki z 30 dni. Zapis i publikacja wracają przez server actions z popupy/akcje.ts,
 * które same sprawdzają tenanta.
 */
export default async function StronaBuildera({ params }: { params: Promise<{ tenantId: string; formId: string }> }) {
  const { tenantId: surowy, formId } = await params;
  const { tenantId } = await wymaganyTenant(surowy);
  const f = await formularzDoEdycji(tenantId, formId);
  if (!f || f.zarchiwizowany) notFound();
  const [listy, firma, wyniki] = await Promise.all([listyTenanta(tenantId), nazwaFirmyTenanta(tenantId), wynikiFormularza(tenantId, formId, 30)]);
  return (
    <>
      <TrybPelnyEkran />
      <Builder
        tenantId={tenantId}
        formId={f.id}
        nazwa={f.nazwa}
        szkic={f.szkic}
        opublikowana={f.opublikowana}
        aktywny={f.aktywny}
        revision={f.revision}
        wersjaKlauzuli={f.wersjaKlauzuli}
        listy={listy.map((l: { id: string; name: string }) => ({ id: l.id, name: l.name }))}
        firma={firma}
        snippet={`<script src="${adresSledzenia()}/s/${tenantId}" async></script>`}
        wyniki={wyniki}
        staryFormat={f.staryFormat}
      />
    </>
  );
}
