"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { wymaganyTenant } from "../../../../autoryzacja";
import { BladDostepuShopify, BladShopify } from "../../../../../adapters/store/shopify/graphql";
import { rozpocznijImportShopify, zaplanujImportShopify, type PlanImportuShopify } from "../../../../../usecases/shopify/import";
import { poInstalacji } from "../../../../../usecases/shopify/instalacja";
import { BladSklepuShopify, sklepShopify, zapiszAplikacjeShopify } from "../../../../../usecases/shopify/sklep";
import { stanShopify, type StanShopify } from "../../../../../usecases/shopify/stan";

// Server actions kreatora „Połącz Shopify”: cienkie opakowania use-case (AD-17), KAŻDA zaczyna
// od wymaganyTenant (AD-21), a sklep czyta zawsze w parze (tenant, id) - cudzy id = brak.

const SCIEZKA = (t: string) => `/t/${t}/sklepy/shopify`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wroc(tenantId: string, q: { ok?: string; blad?: string; sklep?: string }, kotwica = ""): never {
  const p = new URLSearchParams();
  if (q.sklep) p.set("sklep", q.sklep);
  if (q.ok) p.set("ok", q.ok);
  if (q.blad) p.set("blad", q.blad);
  redirect(`${SCIEZKA(tenantId)}?${p.toString()}${kotwica}`);
}

export async function zapiszAplikacjeAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  let id: string;
  try {
    const s = await zapiszAplikacjeShopify(tenantId, {
      adres: String(f.get("adres") ?? ""),
      clientId: String(f.get("clientId") ?? ""),
      clientSecret: String(f.get("clientSecret") ?? ""),
    });
    id = s.id;
  } catch (b) {
    if (b instanceof BladSklepuShopify) wroc(tenantId, { blad: b.message }, "#aplikacja");
    throw b;
  }
  revalidatePath(SCIEZKA(tenantId));
  wroc(tenantId, { sklep: id, ok: "Aplikacja zapisana. Teraz zainstaluj ją w sklepie linkiem z Dev Dashboard." }, "#instalacja");
}

export async function sprawdzPonownieAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const storeId = String(f.get("storeId") ?? "");
  if (!UUID.test(storeId) || !(await sklepShopify(tenantId, storeId))) wroc(tenantId, { blad: "Nie znaleziono sklepu." });
  try {
    const w = await poInstalacji(tenantId, storeId);
    revalidatePath(SCIEZKA(tenantId));
    if (w.ostrzezenia.length) wroc(tenantId, { sklep: storeId, blad: w.ostrzezenia.join(" ") }, "#sprawdz");
  } catch (b) {
    if (b instanceof BladDostepuShopify) wroc(tenantId, { sklep: storeId, blad: "Shopify odmówił dostępu. Aplikacja mogła zostać odinstalowana: zainstaluj ją ponownie." }, "#instalacja");
    if (b instanceof BladShopify || b instanceof BladSklepuShopify) wroc(tenantId, { sklep: storeId, blad: b.message }, "#sprawdz");
    throw b;
  }
  wroc(tenantId, { sklep: storeId, ok: "Powiadomienia, piksel i ustawienia motywu potwierdzone w Shopify." }, "#sprawdz");
}

/** Plan importu (liczności ze sklepu). Tylko odczyt Shopify, nic nie zapisuje. */
export async function planImportuAkcja(tenantId: string, storeId: string): Promise<PlanImportuShopify | { blad: string }> {
  const { tenantId: t } = await wymaganyTenant(tenantId);
  if (!UUID.test(storeId) || !(await sklepShopify(t, storeId))) return { blad: "Nie znaleziono sklepu." };
  try {
    return await zaplanujImportShopify(t, storeId);
  } catch (b) {
    return { blad: b instanceof BladShopify ? b.message : "Nie udało się policzyć danych w sklepie." };
  }
}

export async function rozpocznijImportAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const storeId = String(f.get("storeId") ?? "");
  if (!UUID.test(storeId) || !(await sklepShopify(tenantId, storeId))) wroc(tenantId, { blad: "Nie znaleziono sklepu." });
  if (f.get("potwierdzam") !== "tak") wroc(tenantId, { sklep: storeId, blad: "Zaznacz, że znasz skutki importu." }, "#import");
  try {
    const plan = await zaplanujImportShopify(tenantId, storeId);
    await rozpocznijImportShopify(tenantId, storeId, plan);
  } catch (b) {
    if (b instanceof BladShopify) wroc(tenantId, { sklep: storeId, blad: b.message }, "#import");
    throw b;
  }
  revalidatePath(SCIEZKA(tenantId));
  wroc(tenantId, { sklep: storeId, ok: "Import ruszył. Pasek postępu odświeża się sam." }, "#import");
}

/** Odpytywane co 3 s przez „Sprawdź połączenie” i pasek importu. Tylko odczyt, tylko własny tenant. */
export async function stanAkcja(tenantId: string, storeId: string): Promise<StanShopify | null> {
  const { tenantId: t } = await wymaganyTenant(tenantId);
  if (!UUID.test(storeId)) return null;
  return stanShopify(t, storeId);
}
