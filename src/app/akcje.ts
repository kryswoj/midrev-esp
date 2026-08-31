"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { utworzTenanta } from "../adapters/db/repozytoria";
import { podlaczSklepWoo } from "../usecases/podlacz-sklep";
import { wykonajImport } from "../usecases/importuj-historie";

// Server actions są cienkim opakowaniem use-case (AD-17). Zero logiki biznesowej tutaj.

export async function utworzTenantaAkcja(formularz: FormData) {
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  if (!nazwa) return;
  const tenant = await utworzTenanta(nazwa);
  redirect(`/t/${tenant.id}`);
}

export async function podlaczSklepAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const wynik = await podlaczSklepWoo(tenantId, {
    baseUrl: String(formularz.get("baseUrl") ?? "").trim(),
    consumerKey: String(formularz.get("consumerKey") ?? "").trim(),
    consumerSecret: String(formularz.get("consumerSecret") ?? "").trim(),
  });
  revalidatePath(`/t/${tenantId}`);
  if (!wynik.ok) {
    redirect(`/t/${tenantId}?blad=${encodeURIComponent(wynik.blad)}`);
  }
  redirect(`/t/${tenantId}?ok=${encodeURIComponent("Sklep podłączony")}`);
}

export async function importujAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const storeId = String(formularz.get("storeId"));
  const wynik = await wykonajImport(tenantId, storeId);
  revalidatePath(`/t/${tenantId}`);
  const komunikat = wynik.rozbieznosc
    ? `Import zakończony z rozbieżnością: ${wynik.rozbieznosc}`
    : `Zaimportowano ${wynik.utworzoneZamowienia} zamówień i ${wynik.utworzoneProfile} nowych profili`;
  redirect(`/t/${tenantId}?ok=${encodeURIComponent(komunikat)}`);
}

export async function utworzSegmentAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  const typ = String(formularz.get("typ"));
  const wartosc = Number(formularz.get("wartosc") ?? 0);
  if (!nazwa) return;

  const regula =
    typ === "wydal_powyzej"
      ? { typ, kwotaMinor: Math.round(wartosc * 100) }
      : typ === "liczba_zamowien_min"
        ? { typ, ile: wartosc }
        : typ === "ma_zgode"
          ? { typ, kanal: "email" }
          : { typ, dni: wartosc };

  const { utworzSegment } = await import("../adapters/db/repozytoria");
  await utworzSegment(tenantId, nazwa, [regula]);
  revalidatePath(`/t/${tenantId}/segmenty`);
  redirect(`/t/${tenantId}/segmenty?ok=${encodeURIComponent("Segment zapisany")}`);
}

export async function utworzListeAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  if (!nazwa) return;
  const { utworzListe } = await import("../adapters/db/repozytoria");
  await utworzListe(tenantId, nazwa, String(formularz.get("opis") ?? "") || null);
  revalidatePath(`/t/${tenantId}/listy`);
  redirect(`/t/${tenantId}/listy?ok=${encodeURIComponent("Lista utworzona")}`);
}

export async function utworzKampanieAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const nazwa = String(formularz.get("nazwa") ?? "").trim();
  if (!nazwa) return;
  const { utworzKampanie } = await import("../adapters/db/repozytoria");
  await utworzKampanie(tenantId, nazwa, String(formularz.get("temat") ?? "") || null);
  revalidatePath(`/t/${tenantId}/kampanie`);
  redirect(`/t/${tenantId}/kampanie?ok=${encodeURIComponent("Kampania utworzona w szkicu")}`);
}
