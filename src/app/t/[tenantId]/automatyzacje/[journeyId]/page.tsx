import { redirect } from "next/navigation";
import { wymaganyTenant } from "../../../../autoryzacja";

/** Adres automatyzacji prowadzi na kanwe; osobnego ekranu "szczegoly" nie ma. */
export default async function Automatyzacja({ params }: { params: Promise<{ tenantId: string; journeyId: string }> }) {
  const { tenantId: zadany, journeyId } = await params;
  const { tenantId } = await wymaganyTenant(zadany);
  redirect(`/t/${tenantId}/automatyzacje/${journeyId}/edytor`);
}
