import { redirect } from "next/navigation";
import { wymaganyTenant } from "../../../autoryzacja";

/** /ustawienia nie ma własnej treści: jedynym ustawieniem w tym katalogu jest wysyłka. */
export default async function Ustawienia({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  await wymaganyTenant(tenantId);
  redirect(`/t/${tenantId}/ustawienia/wysylka`);
}
