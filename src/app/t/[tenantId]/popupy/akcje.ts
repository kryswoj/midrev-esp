"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { ustawAktywnosc, utworzPopup } from "../../../../usecases/popupy/zarzadzaj";

// Server actions sa cienkim opakowaniem use-case (AD-17). Lokalne dla /popupy,
// zeby nie dotykac wspolnego akcje.ts podczas rownoleglej pracy nad epikami.

export async function utworzPopupAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
  const name = String(formularz.get("name") ?? "").trim();
  const headline = String(formularz.get("headline") ?? "").trim();
  const bodyText = String(formularz.get("bodyText") ?? "").trim();
  const buttonText = String(formularz.get("buttonText") ?? "").trim();
  if (!name || !headline || !bodyText || !buttonText) {
    redirect(
      `/t/${tenantId}/popupy?blad=${encodeURIComponent("Nazwa, nagłówek, treść i tekst przycisku są wymagane")}`,
    );
  }

  try {
    await utworzPopup(tenantId, {
      name,
      headline,
      bodyText,
      buttonText,
      discountCode: String(formularz.get("discountCode") ?? "").trim() || null,
      delaySeconds: Number(formularz.get("delaySeconds") ?? 0) || 0,
    });
  } catch (blad: unknown) {
    // unikalnosc (tenant_id, name) z migracji 0009: druga proba pod ta sama nazwa
    // ma dac czytelny komunikat, a nie piecsetke
    const kod = (blad as { code?: string })?.code;
    if (kod === "23505") {
      redirect(
        `/t/${tenantId}/popupy?blad=${encodeURIComponent("Popup o tej nazwie już istnieje")}`,
      );
    }
    // limity dlugosci z use-case'u: za dluga tresc to komunikat w panelu, nie piecsetka
    if (blad instanceof ZodError) {
      redirect(
        `/t/${tenantId}/popupy?blad=${encodeURIComponent("Treść jest za długa: nagłówek do 200, treść do 1000, przycisk do 80, kod do 60 znaków")}`,
      );
    }
    throw blad;
  }
  revalidatePath(`/t/${tenantId}/popupy`);
  redirect(`/t/${tenantId}/popupy?ok=${encodeURIComponent("Popup zapisany. Włącz go, gdy treść jest gotowa.")}`);
}

export async function przelaczPopupAkcja(formularz: FormData) {
  const tenantId = String(formularz.get("tenantId"));
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
