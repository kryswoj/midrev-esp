"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { BladPopupu, MAX_KLAUZULA, MIN_KLAUZULA, ustawAktywnosc, utworzPopup, zmienKlauzule } from "../../../../usecases/popupy/zarzadzaj";
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
    consentWording: String(formularz.get("consentWording") ?? "").trim(),
    privacyUrl: String(formularz.get("privacyUrl") ?? "").trim(),
    listId: String(formularz.get("listId") ?? ""),
  };
  if (!wartosci.name || !wartosci.headline || !wartosci.bodyText || !wartosci.buttonText) {
    return { blad: "Nazwa, nagłówek, treść i tekst przycisku są wymagane", wartosci };
  }
  if (wartosci.consentWording.length < MIN_KLAUZULA || wartosci.consentWording.length > MAX_KLAUZULA) {
    return { blad: `Klauzula zgody jest wymagana: od ${MIN_KLAUZULA} do ${MAX_KLAUZULA} znaków. To ją zobaczy osoba przy polu wyboru.`, wartosci };
  }
  if (wartosci.privacyUrl && !/^https?:\/\/[^\s<>"]+$/.test(wartosci.privacyUrl)) {
    return { blad: "Adres polityki prywatności musi zaczynać się od https:// albo http:// (albo zostaw puste pole).", wartosci };
  }

  try {
    await utworzPopup(tenantId, {
      name: wartosci.name,
      headline: wartosci.headline,
      bodyText: wartosci.bodyText,
      buttonText: wartosci.buttonText,
      discountCode: wartosci.discountCode || null,
      delaySeconds: Number(wartosci.delaySeconds) || 0,
      consentWording: wartosci.consentWording,
      privacyUrl: wartosci.privacyUrl,
      listId: wartosci.listId || null,
    });
  } catch (blad: unknown) {
    if (blad instanceof BladPopupu) return { blad: blad.message, wartosci };
    // unikalnosc (tenant_id, name) z migracji 0009: druga proba pod ta sama nazwa
    // ma dac czytelny komunikat, a nie piecsetke
    const kod = (blad as { code?: string })?.code;
    if (kod === "23505") {
      return { blad: "Popup o tej nazwie już istnieje", wartosci };
    }
    // limity dlugosci z use-case'u: za dluga tresc to komunikat w panelu, nie piecsetka
    if (blad instanceof ZodError) {
      return {
        blad: "Sprawdź długości: nagłówek do 200, treść do 1000, przycisk do 80, kod do 60, klauzula do 2000 znaków; adres polityki zaczyna się od https://",
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

/**
 * Zmiana klauzuli zgody i listy docelowej. Nowy tekst = nowa wersja klauzuli: zgody zapisane
 * wczesniej dalej wskazuja wersje, ktora te osoby widzialy.
 */
export async function zmienKlauzuleAkcja(
  _poprzedni: StanFormularza | undefined,
  formularz: FormData,
): Promise<StanFormularza> {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const popupId = String(formularz.get("popupId") ?? "");
  const wartosci = {
    consentWording: String(formularz.get("consentWording") ?? "").trim(),
    privacyUrl: String(formularz.get("privacyUrl") ?? "").trim(),
    listId: String(formularz.get("listId") ?? ""),
  };
  if (!/^[0-9a-f-]{36}$/i.test(popupId)) return { blad: "Nie znaleziono takiego formularza.", wartosci };
  const w = await zmienKlauzule(tenantId, popupId, { consentWording: wartosci.consentWording, privacyUrl: wartosci.privacyUrl, listId: wartosci.listId || null });
  if (!w.ok) return { blad: w.blad, wartosci };
  revalidatePath(`/t/${tenantId}/popupy`);
  redirect(`/t/${tenantId}/popupy?ok=${encodeURIComponent(w.nowaWersja ? `Zapisano wersję ${w.wersja} klauzuli. Nowe zapisy dostaną ten tekst.` : "Zapisano. Tekst klauzuli bez zmian, wersja ta sama.")}`);
}
