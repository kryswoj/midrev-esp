"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  SZABLONY,
  przelaczJourney,
  utworzJourney,
} from "../../../../usecases/automatyzacje/journeye";
import { sklepyTenanta } from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import type { StanFormularza } from "../../../formularze";

// Server actions sa cienkim opakowaniem use-case (AD-17). Zero logiki biznesowej tutaj.
// tenantId z hidden inputa przechodzi przez wspolna bramke wymaganyTenant (AD-21) -
// pierwotny wzorzec z tego pliku zostal wyniesiony do src/app/autoryzacja.ts.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wroc(tenantId: string, wynik: { ok?: string; blad?: string }): never {
  revalidatePath(`/t/${tenantId}/automatyzacje`);
  const parametr = wynik.blad
    ? `blad=${encodeURIComponent(wynik.blad)}`
    : `ok=${encodeURIComponent(wynik.ok ?? "")}`;
  redirect(`/t/${tenantId}/automatyzacje?${parametr}`);
}

// useActionState (audyt B4): blad z use-case'u wraca do formularza razem
// z recznie pisanym HTML-em maila, zamiast redirectem kasowac cala tresc.
export async function utworzAutomatyzacjeAkcja(
  _poprzedni: StanFormularza | undefined,
  formularz: FormData,
): Promise<StanFormularza> {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const wartosci = {
    nazwa: String(formularz.get("nazwa") ?? ""),
    trigger: String(formularz.get("trigger") ?? ""),
    opoznienie: String(formularz.get("opoznienie") ?? ""),
    temat: String(formularz.get("temat") ?? ""),
    html: String(formularz.get("html") ?? ""),
  };
  const wynik = await utworzJourney(tenantId, {
    name: wartosci.nazwa,
    triggerEvent: wartosci.trigger,
    delayMinutes: Number(wartosci.opoznienie || 0),
    subject: wartosci.temat,
    html: wartosci.html,
  });
  if (!wynik.ok) return { blad: wynik.blad, wartosci };
  revalidatePath(`/t/${tenantId}/automatyzacje`);
  redirect(
    `/t/${tenantId}/automatyzacje?ok=${encodeURIComponent("Automatyzacja utworzona. Włącz ją, gdy treść będzie gotowa.")}`,
  );
}

export async function utworzZSzablonuAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const szablon = SZABLONY[String(formularz.get("szablon"))];
  if (!szablon) wroc(tenantId, { blad: "Nieznany szablon" });
  // Szablon nie zostawia placeholdera do recznej podmiany - edycji automatyzacji
  // jeszcze nie ma, wiec obietnica "podmien link" bylaby poleceniem bez narzedzia
  // (audyt P14). Link do sklepu wstawiamy z podlaczonego sklepu; bez sklepu
  // odmawiamy z powodem, zamiast tworzyc automatyzacje z linkiem-atrapa.
  const sklep = (await sklepyTenanta(tenantId)).find((s) => s.status === "connected");
  if (!sklep) {
    wroc(tenantId, {
      blad: "Szablon wstawia w treść link do Twojego sklepu - najpierw podłącz sklep w zakładce Sklepy.",
    });
  }
  const wynik = await utworzJourney(tenantId, {
    ...szablon,
    html: szablon.html.replaceAll("https://TWOJ-SKLEP.example.pl", sklep.base_url),
  });
  wroc(
    tenantId,
    wynik.ok
      ? {
          ok: `Utworzono „${szablon.name}". Link w treści prowadzi do ${sklep.base_url.replace(/^https?:\/\//, "")}. Włącz automatyzację, gdy będziesz gotowy.`,
        }
      : { blad: wynik.blad },
  );
}

export async function przelaczAutomatyzacjeAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
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
