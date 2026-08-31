"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { ustawAktywnosc, utworzPopup } from "../../../../usecases/popupy/zarzadzaj";
import { wymaganyTenant } from "../../../autoryzacja";
import type { StanFormularza } from "../../../formularze";

// Server actions sa cienkim opakowaniem use-case (AD-17). Lokalne dla /popupy,
// zeby nie dotykac wspolnego akcje.ts podczas rownoleglej pracy nad epikami.
// tenantId z hidden inputa przechodzi przez wymaganyTenant (AD-21) - patrz
// src/app/autoryzacja.ts.

// useActionState (audyt B4): blad walidacji wraca do formularza razem z wpisana
// trescia, zamiast redirectem czyscic naglowek, tresc, przycisk i kod naraz.
export async function utworzPopupAkcja(
  _poprzedni: StanFormularza | undefined,
  formularz: FormData,
): Promise<StanFormularza> {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const wartosci = {
    name: String(formularz.get("name") ?? "").trim(),
    headline: String(formularz.get("headline") ?? "").trim(),
    bodyText: String(formularz.get("bodyText") ?? "").trim(),
    buttonText: String(formularz.get("buttonText") ?? "").trim(),
    discountCode: String(formularz.get("discountCode") ?? "").trim(),
    delaySeconds: String(formularz.get("delaySeconds") ?? ""),
  };
  if (!wartosci.name || !wartosci.headline || !wartosci.bodyText || !wartosci.buttonText) {
    return { blad: "Nazwa, nagłówek, treść i tekst przycisku są wymagane", wartosci };
  }

  try {
    await utworzPopup(tenantId, {
      name: wartosci.name,
      headline: wartosci.headline,
      bodyText: wartosci.bodyText,
      buttonText: wartosci.buttonText,
      discountCode: wartosci.discountCode || null,
      delaySeconds: Number(wartosci.delaySeconds) || 0,
    });
  } catch (blad: unknown) {
    // unikalnosc (tenant_id, name) z migracji 0009: druga proba pod ta sama nazwa
    // ma dac czytelny komunikat, a nie piecsetke
    const kod = (blad as { code?: string })?.code;
    if (kod === "23505") {
      return { blad: "Popup o tej nazwie już istnieje", wartosci };
    }
    // limity dlugosci z use-case'u: za dluga tresc to komunikat w panelu, nie piecsetka
    if (blad instanceof ZodError) {
      return {
        blad: "Treść jest za długa: nagłówek do 200, treść do 1000, przycisk do 80, kod do 60 znaków",
        wartosci,
      };
    }
    throw blad;
  }
  revalidatePath(`/t/${tenantId}/popupy`);
  redirect(`/t/${tenantId}/popupy?ok=${encodeURIComponent("Popup zapisany. Włącz go, gdy treść jest gotowa.")}`);
}

export async function przelaczPopupAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const popupId = String(formularz.get("popupId"));
  const wlacz = String(formularz.get("wlacz")) === "1";
  const zmieniono = await ustawAktywnosc(tenantId, popupId, wlacz);
  revalidatePath(`/t/${tenantId}/popupy`);
  // komunikat sukcesu tylko po faktycznej zmianie; UPDATE bez trafienia to nie sukces
  if (!zmieniono) {
    redirect(`/t/${tenantId}/popupy?blad=${encodeURIComponent("Nie znaleziono takiego popupu")}`);
  }
  redirect(
    `/t/${tenantId}/popupy?ok=${encodeURIComponent(wlacz ? "Popup włączony" : "Popup wyłączony")}`,
  );
}
