"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { anonimizujProfil, sprawdzPowodRodo } from "../../../../../usecases/profil-rodo";
import { zGroszy } from "../../../../../domain/kwoty";
import { odmien } from "../../../../../domain/liczebniki";
import { wymaganyTenant } from "../../../../autoryzacja";
import type { StanFormularza } from "../../../../formularze";
import { FRAZA_POTWIERDZENIA } from "./stale";

// Server action jako cienkie opakowanie use-case (AD-17), lokalne dla ekranu
// profilu. tenantId przychodzi z hidden inputa, czyli od klienta, więc przechodzi
// przez wymaganyTenant (AD-21) - profil odbiorcy to dane osobowe i tu wyciek
// cross-tenant byłby najdroższy z możliwych.

export async function usunDaneAkcja(
  _poprzedni: StanFormularza | undefined,
  formularz: FormData,
): Promise<StanFormularza> {
  const { tenantId, sesja } = await wymaganyTenant(formularz.get("tenantId"));
  const profileId = String(formularz.get("profileId") ?? "");
  const wartosci = {
    potwierdzenie: String(formularz.get("potwierdzenie") ?? ""),
    powod: String(formularz.get("powod") ?? "").trim(),
  };

  // Walidacja frazy jest po stronie serwera, nie tylko w przeglądarce: blokada
  // przycisku to wygoda operatora, a nie zabezpieczenie.
  if (wartosci.potwierdzenie.trim().toUpperCase() !== FRAZA_POTWIERDZENIA) {
    return {
      blad: `Wpisz ${FRAZA_POTWIERDZENIA} w polu potwierdzenia, żeby wykonać tę operację. Jest nieodwracalna.`,
      wartosci,
    };
  }

  // Powód zostaje w logu RODO PO usunięciu danych osoby, więc nie może jej zawierać
  // (review 24.09, R7). Błąd pokazujemy jako błąd formularza, nie jako 500.
  const bladPowodu = sprawdzPowodRodo(wartosci.powod || null);
  if (bladPowodu) return { blad: bladPowodu, wartosci };

  const wynik = await anonimizujProfil(tenantId, profileId, {
    aktor: sesja.email,
    powod: wartosci.powod || null,
  });
  if (!wynik) {
    return { blad: "Nie znaleziono tego profilu w tym sklepie", wartosci };
  }

  revalidatePath(`/t/${tenantId}/profile`);
  revalidatePath(`/t/${tenantId}/profile/${profileId}`);
  // Komunikat mówi FAKTYCZNY wynik odczytany z bazy: co zniknęło i co zostało,
  // żeby operator nie musiał wierzyć na słowo, że raport przychodu ocalał.
  const podsumowanie =
    `Dane osobowe usunięte. Zostaje ${odmien(wynik.zamowien, "zamówienie", "zamówienia", "zamówień")} ` +
    `na ${zGroszy(Number(wynik.przychodMinor))} w raportach i ${odmien(wynik.wiadomosci, "wysłana wiadomość", "wysłane wiadomości", "wysłanych wiadomości")} w historii. ` +
    `Wycofane zgody: ${wynik.zgodyWycofane}. Usunięto z list: ${wynik.usunieteZList}.`;
  redirect(`/t/${tenantId}/profile/${profileId}?ok=${encodeURIComponent(podsumowanie)}`);
}
