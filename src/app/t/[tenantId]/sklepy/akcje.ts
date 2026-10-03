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

// ── Kreator „Połącz sklep”: gotowe automatyzacje (wspólne dla Woo, Shopify i custom) ────────

function wrocDo(sciezka: string, q: { ok?: string; blad?: string }): never {
  const p = new URLSearchParams();
  if (q.ok) p.set("ok", q.ok);
  if (q.blad) p.set("blad", q.blad);
  redirect(`${sciezka}?${p.toString()}#automatyzacje`);
}

/** Bezpieczny powrót: tylko ścieżki kreatora tego tenanta. */
function sciezkaPowrotu(tenantId: string, surowa: FormDataEntryValue | null): string {
  const s = String(surowa ?? "");
  return /^\/t\/[0-9a-f-]{36}\/sklepy(\/[a-z-]+)?$/.test(s) && s.startsWith(`/t/${tenantId}/`) ? s : `/t/${tenantId}/sklepy`;
}

/** „Utwórz” na karcie szablonu: automatyzacja z mailami jako szkic (jedno kliknięcie). */
export async function utworzSzablonSklepuAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const powrot = sciezkaPowrotu(tenantId, formularz.get("powrot"));
  const klucz = String(formularz.get("szablon") ?? "");
  const { KLUCZE_SZABLONOW_KREATORA, utworzZBiblioteki } = await import("../../../../usecases/automatyzacje/journeye");
  if (!(KLUCZE_SZABLONOW_KREATORA as readonly string[]).includes(klucz)) wrocDo(powrot, { blad: "Nieznany szablon." });
  const { sklepyTenanta } = await import("../../../../adapters/db/repozytoria");
  const { kluczStronyTenanta } = await import("../../../../usecases/integracja/klucz-strony");
  // sklep platformy kreatora, z którego przyszła karta (review integracji: przy Woo + Shopify
  // w jednym tenancie pierwszy połączony sklep dawał maile z linkiem do innego sklepu)
  const platforma = powrot.endsWith("/sklepy/shopify") ? "shopify" : powrot.endsWith("/sklepy/woocommerce") ? "woocommerce" : null;
  const polaczone = (await sklepyTenanta(tenantId)).filter((s) => s.status === "connected");
  const sklep = platforma ? polaczone.find((s) => s.platform === platforma) : polaczone[0];
  const strona = await kluczStronyTenanta(tenantId);
  // Shopify: domena główna sklepu (primaryDomain z instalacji), nie *.myshopify.com
  const domenaShopify = sklep?.platform === "shopify" ? ((sklep.capabilities as { shopify?: { domenaPubliczna?: string | null } } | null)?.shopify?.domenaPubliczna ?? null) : null;
  const adres = domenaShopify ?? sklep?.base_url ?? (!platforma && strona?.domeny[0] ? `https://${strona.domeny[0]}` : null);
  if (!adres) wrocDo(powrot, { blad: platforma ? "Najpierw połącz ten sklep: maile mają link do niego." : "Najpierw połącz sklep albo stronę: maile mają link do Twojego sklepu." });
  const w = await utworzZBiblioteki(tenantId, klucz, { sklepUrl: adres });
  if (!w.ok) wrocDo(powrot, { blad: w.blad });
  revalidatePath(powrot);
  wrocDo(powrot, { ok: "Automatyzacja gotowa jako szkic. Przejrzyj maile i włącz ją jednym kliknięciem." });
}

/** „Włącz”: publikacja szkicu z bramką (ta sama co w edytorze), bez wchodzenia w kanwę. */
export async function wlaczSzablonSklepuAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const powrot = sciezkaPowrotu(tenantId, formularz.get("powrot"));
  const flowId = String(formularz.get("flowId") ?? "");
  if (!UUID.test(flowId)) notFound();
  const { zmienStatus } = await import("../../../../usecases/automatyzacje/journeye");
  const w = await zmienStatus(tenantId, flowId, "wlaczony");
  if (!w.ok) wrocDo(powrot, { blad: w.blad });
  revalidatePath(powrot);
  wrocDo(powrot, { ok: "Automatyzacja włączona. Wejdą do niej osoby od teraz (bez historii)." });
}
