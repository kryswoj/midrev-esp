"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { aktualnaSesja } from "../../../../adapters/auth-sesja";
import {
  SZABLONY,
  przelaczJourney,
  utworzJourney,
} from "../../../../usecases/automatyzacje/journeye";

// Server actions sa cienkim opakowaniem use-case (AD-17). Zero logiki biznesowej tutaj.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * tenantId przychodzi z hidden inputa, czyli od klienta: bez sprawdzenia wobec
 * sesji (AD-21) spreparowany formularz moglby wlaczac automatyzacje CUDZEGO
 * tenanta (znalezisko z review). Walidacja UUID przy okazji zamienia smieciowy
 * identyfikator w kontrolowana odmowe zamiast bledu Postgresa.
 */
async function wymaganyTenant(surowy: FormDataEntryValue | null): Promise<string> {
  const tenantId = String(surowy ?? "");
  if (!UUID.test(tenantId)) redirect("/");
  const sesja = await aktualnaSesja();
  if (!sesja || !sesja.tenantIds.includes(tenantId)) redirect("/logowanie");
  return tenantId;
}

function wroc(tenantId: string, wynik: { ok?: string; blad?: string }): never {
  revalidatePath(`/t/${tenantId}/automatyzacje`);
  const parametr = wynik.blad
    ? `blad=${encodeURIComponent(wynik.blad)}`
    : `ok=${encodeURIComponent(wynik.ok ?? "")}`;
  redirect(`/t/${tenantId}/automatyzacje?${parametr}`);
}

export async function utworzAutomatyzacjeAkcja(formularz: FormData) {
  const tenantId = await wymaganyTenant(formularz.get("tenantId"));
  const wynik = await utworzJourney(tenantId, {
    name: String(formularz.get("nazwa") ?? ""),
    triggerEvent: String(formularz.get("trigger") ?? ""),
    delayMinutes: Number(formularz.get("opoznienie") ?? 0),
    subject: String(formularz.get("temat") ?? ""),
    html: String(formularz.get("html") ?? ""),
  });
  wroc(tenantId, wynik.ok ? { ok: "Automatyzacja utworzona. Włącz ją, gdy treść będzie gotowa." } : { blad: wynik.blad });
}

export async function utworzZSzablonuAkcja(formularz: FormData) {
  const tenantId = await wymaganyTenant(formularz.get("tenantId"));
  const szablon = SZABLONY[String(formularz.get("szablon"))];
  if (!szablon) wroc(tenantId, { blad: "Nieznany szablon" });
  const wynik = await utworzJourney(tenantId, szablon);
  wroc(
    tenantId,
    wynik.ok
      ? { ok: `Utworzono „${szablon.name}". Podmień link do sklepu i włącz automatyzację.` }
      : { blad: wynik.blad },
  );
}

export async function przelaczAutomatyzacjeAkcja(formularz: FormData) {
  const tenantId = await wymaganyTenant(formularz.get("tenantId"));
  const journeyId = String(formularz.get("journeyId"));
  if (!UUID.test(journeyId)) wroc(tenantId, { blad: "Automatyzacja nie istnieje" });
  // formularz niesie STAN DOCELOWY, nie komende "przelacz": ponowiony submit
  // ustawia to samo drugi raz zamiast odwracac decyzje operatora
  const docelowa = String(formularz.get("docelowa")) === "1";
  const aktywna = await przelaczJourney(tenantId, journeyId, docelowa);
  if (aktywna === null) wroc(tenantId, { blad: "Automatyzacja nie istnieje" });
  wroc(tenantId, {
    ok: aktywna
      ? "Automatyzacja włączona. Reaguje na zdarzenia od tej chwili, nie wstecz."
      : "Automatyzacja wyłączona.",
  });
}
