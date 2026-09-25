"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { odswiezWebhokiSklepu, opisBraku } from "../../../../usecases/podlacz-sklep";
import { wszystkieAktywne } from "../../../../adapters/store/webhooki";
import { wymaganyTenant } from "../../../autoryzacja";

// Server actions są cienkim opakowaniem use-case (AD-17). Lokalne dla /sklepy, żeby
// nie dotykać wspólnego akcje.ts podczas równoległej pracy nad epikami.
// tenantId z hidden inputa przechodzi przez wymaganyTenant (AD-21).

/**
 * Ponowne założenie i sprawdzenie webhooków w sklepie. Jedna akcja na trzy sytuacje:
 * webhooki nigdy nie powstały (sklep podłączony przed B3), sklep je wyłączył, albo
 * operator chce po prostu potwierdzić, że sklep dalej dosyła dane. Idempotentna -
 * istniejące webhooki są aktualizowane, nie dublowane.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** storeId z hidden inputa: śmieć = 404, nie błąd rzutowania Postgresa (audyt #17). */
function wymaganySklep(surowy: FormDataEntryValue | null): string {
  const id = String(surowy ?? "");
  if (!UUID.test(id)) notFound();
  return id;
}

export async function odswiezWebhokiAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const storeId = wymaganySklep(formularz.get("storeId"));
  const wynik = await odswiezWebhokiSklepu(tenantId, storeId);
  revalidatePath(`/t/${tenantId}/sklepy`);

  if (!wynik.ok) {
    redirect(`/t/${tenantId}/sklepy?blad=${encodeURIComponent(wynik.blad)}`);
  }
  // komunikat mówi PRAWDĘ o wyniku odczytu zwrotnego, nie o tym, że żądanie poszło
  if (!wszystkieAktywne(wynik.stan)) {
    redirect(`/t/${tenantId}/sklepy?blad=${encodeURIComponent(opisBraku(wynik.stan))}`);
  }
  const usuniete = wynik.stan.usunieteDuplikaty ?? 0;
  redirect(
    `/t/${tenantId}/sklepy?ok=${encodeURIComponent(
      `Sklep potwierdził ${wynik.stan.wpisy.length} aktywnych webhooków` +
        (usuniete ? `, usunięto ${usuniete} zdublowanych` : ""),
    )}`,
  );
}
