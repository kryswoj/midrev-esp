"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { wymaganyTenant } from "../../../../autoryzacja";
import { dodajDoListyPoEmailu, dodajZSegmentu, usunZListy } from "../../../../../usecases/listy/czlonkowie";
import { odmien } from "../../../../../domain/liczebniki";

/**
 * Server actions ekranu listy. Kazda zaczyna od wymaganyTenant (AD-21); identyfikatory
 * listy, profilu i segmentu sa walidowane jako UUID przed pierwszym zapytaniem, a kazde
 * zapytanie use-case ma predykat tenant_id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wroc(tenantId: string, listId: string, pola: { ok?: string; blad?: string }): never {
  const q = pola.blad ? `blad=${encodeURIComponent(pola.blad)}` : `ok=${encodeURIComponent(pola.ok ?? "")}`;
  redirect(`/t/${tenantId}/listy/${listId}?${q}`);
}

async function kontekst(f: FormData) {
  const { tenantId, sesja } = await wymaganyTenant(f.get("tenantId"));
  const listId = String(f.get("listId") ?? "");
  if (!UUID.test(listId)) redirect(`/t/${tenantId}/listy?blad=${encodeURIComponent("Nie ma takiej listy.")}`);
  return { tenantId, listId, sesja };
}

export async function dodajPoEmailuAkcja(f: FormData) {
  const { tenantId, listId, sesja } = await kontekst(f);
  const wynik = await dodajDoListyPoEmailu(tenantId, listId, String(f.get("email") ?? ""), `reczny:${sesja.email}`);
  revalidatePath(`/t/${tenantId}/listy/${listId}`);
  if (!wynik.ok) wroc(tenantId, listId, { blad: wynik.blad });
  wroc(tenantId, listId, { ok: wynik.dodano ? "Osoba dodana do listy." : "Ta osoba już jest na liście." });
}

export async function usunZListyAkcja(f: FormData) {
  const { tenantId, listId } = await kontekst(f);
  const profileId = String(f.get("profileId") ?? "");
  if (!UUID.test(profileId)) wroc(tenantId, listId, { blad: "Nie ma takiego profilu." });
  const usunieto = await usunZListy(tenantId, listId, profileId);
  revalidatePath(`/t/${tenantId}/listy/${listId}`);
  wroc(tenantId, listId, usunieto ? { ok: "Osoba usunięta z listy. Profil i zgody zostają bez zmian." } : { blad: "Tej osoby nie było na liście." });
}

export async function dodajZSegmentuAkcja(f: FormData) {
  const { tenantId, listId } = await kontekst(f);
  const segmentId = String(f.get("segmentId") ?? "");
  if (!UUID.test(segmentId)) wroc(tenantId, listId, { blad: "Wybierz segment." });
  const wynik = await dodajZSegmentu(tenantId, listId, segmentId);
  revalidatePath(`/t/${tenantId}/listy/${listId}`);
  if (!wynik.ok) wroc(tenantId, listId, { blad: wynik.blad });
  wroc(tenantId, listId, {
    ok: `Z segmentu „${wynik.nazwaSegmentu}” dodano ${odmien(wynik.dodano, "osobę", "osoby", "osób")} (${wynik.kandydatow - wynik.dodano} już było na liście). To migawka: lista nie śledzi segmentu.`,
  });
}
