"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { wymaganyTenant } from "../../../../autoryzacja";
import { BladKlucza, uniewaznijKlucz, utworzKlucz } from "../../../../../usecases/api/klucze";

// Server actions ekranu „Klucze API” (E2 / 2.1): cienkie opakowania use-case (AD-17).
// KAŻDA akcja zaczyna od wymaganyTenant (AD-21). Jawny klucz wraca WYŁĄCZNIE w stanie
// akcji tworzenia (jednorazowo na ekranie): nie trafia do URL-a, do logów ani do bazy.

export interface StanNowegoKlucza {
  blad?: string;
  nowy?: { jawny: string; prefiks: string; nazwa: string };
}

export async function utworzKluczAkcja(_p: StanNowegoKlucza | undefined, f: FormData): Promise<StanNowegoKlucza> {
  const { tenantId, sesja } = await wymaganyTenant(f.get("tenantId"));
  const nazwa = String(f.get("nazwa") ?? "");
  const zakresy = f.getAll("zakresy").map(String);
  try {
    const k = await utworzKlucz(tenantId, { nazwa, zakresy, aktorId: sesja.userId });
    revalidatePath(`/t/${tenantId}/ustawienia/klucze-api`);
    return { nowy: { jawny: k.jawny, prefiks: k.prefiks, nazwa: nazwa.trim() } };
  } catch (b) {
    if (b instanceof BladKlucza) return { blad: b.message };
    throw b;
  }
}

export async function uniewaznijKluczAkcja(f: FormData) {
  const { tenantId, sesja } = await wymaganyTenant(f.get("tenantId"));
  const ok = await uniewaznijKlucz(tenantId, String(f.get("kluczId") ?? ""), sesja.userId);
  revalidatePath(`/t/${tenantId}/ustawienia/klucze-api`);
  const q = ok ? "ok=" + encodeURIComponent("Klucz unieważniony. Żądania z nim dostają teraz 401.") : "blad=" + encodeURIComponent("Nie ma takiego aktywnego klucza.");
  redirect(`/t/${tenantId}/ustawienia/klucze-api?${q}`);
}
