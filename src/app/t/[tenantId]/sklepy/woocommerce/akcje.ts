"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { wymaganyTenant } from "../../../../autoryzacja";
import { BladKlauzuli, BladParowania, startWcAuth, utworzKodParowania, zapiszKlauzuleCheckoutu } from "../../../../../usecases/integracja/woo-wtyczka";
import { stanImportuSklepu, stanPolaczeniaWoo, zlecImportSklepu, type StanImportu, type StanPolaczeniaSklepu } from "../../../../../usecases/sklep/kreator-sklepu";
import { zaplanujImport } from "../../../../../usecases/importuj-historie";

// Server actions kreatora „Połącz WooCommerce”: cienkie opakowania use-case (AD-17), każda
// zaczyna od wymaganyTenant (AD-21). Kod parowania wraca przez stan akcji, NIE przez URL.

const SCIEZKA = (t: string) => `/t/${t}/sklepy/woocommerce`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wroc(tenantId: string, q: { ok?: string; blad?: string }, kotwica = ""): never {
  const p = new URLSearchParams();
  if (q.ok) p.set("ok", q.ok);
  if (q.blad) p.set("blad", q.blad);
  redirect(`${SCIEZKA(tenantId)}?${p.toString()}${kotwica}`);
}

export interface StanKodu {
  kod?: string;
  link?: string | null;
  wygasa?: string;
  blad?: string;
  adres?: string;
}

export async function generujKodAkcja(_p: StanKodu | undefined, f: FormData): Promise<StanKodu> {
  const { tenantId, sesja } = await wymaganyTenant(f.get("tenantId"));
  const adres = String(f.get("adres") ?? "").trim();
  try {
    const k = await utworzKodParowania(tenantId, { adresSklepu: adres || null, userId: sesja.userId });
    return { kod: k.kod, link: k.link, wygasa: k.wygasa.toISOString(), adres };
  } catch (b) {
    if (b instanceof BladParowania) return { blad: b.message, adres };
    throw b;
  }
}

export async function wcAuthAkcja(f: FormData) {
  const { tenantId, sesja } = await wymaganyTenant(f.get("tenantId"));
  let url: string;
  try {
    url = (await startWcAuth(tenantId, String(f.get("adres") ?? ""), sesja.userId)).url;
  } catch (b) {
    if (b instanceof BladParowania) wroc(tenantId, { blad: b.message }, "#bez-wtyczki");
    throw b;
  }
  redirect(url);
}

export async function zapiszKlauzuleAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const storeId = String(f.get("storeId") ?? "");
  if (!UUID.test(storeId)) wroc(tenantId, { blad: "Nieznany sklep." });
  try {
    const k = await zapiszKlauzuleCheckoutu(tenantId, storeId, { tresc: String(f.get("tresc") ?? ""), polityka: String(f.get("polityka") ?? "") });
    revalidatePath(SCIEZKA(tenantId));
    wroc(tenantId, { ok: `Zapisane jako wersja ${k.wersja}. Sklep pokaże nową treść najpóźniej po godzinie (albo od razu po „Sprawdź połączenie” we wtyczce).` }, "#zgoda");
  } catch (b) {
    if (b instanceof BladKlauzuli) wroc(tenantId, { blad: b.message }, "#zgoda");
    throw b;
  }
}

/** Odpytywane co 3 s przez „Sprawdź połączenie”. Tylko odczyt, tylko własny tenant. */
export async function stanPolaczeniaAkcja(tenantId: string): Promise<StanPolaczeniaSklepu> {
  const { tenantId: t } = await wymaganyTenant(tenantId);
  return stanPolaczeniaWoo(t);
}

export interface PlanImportuWidok {
  zamowienia?: number;
  klienci?: number;
  noweProfile?: number;
  najstarsze?: string | null;
  blad?: string;
}

/** Plan importu (liczby ze sklepu i skutki uboczne) PRZED startem (lista kontrolna pkt 6). */
export async function planImportuAkcja(_p: PlanImportuWidok | undefined, f: FormData): Promise<PlanImportuWidok> {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const storeId = String(f.get("storeId") ?? "");
  if (!UUID.test(storeId)) return { blad: "Nieznany sklep." };
  try {
    const p = await zaplanujImport(tenantId, storeId);
    return { zamowienia: p.zamowienia, klienci: p.klienci, noweProfile: p.noweProfile, najstarsze: p.zakresOd ? p.zakresOd.toISOString() : null };
  } catch (b) {
    return { blad: `Sklep nie oddał danych do planu: ${b instanceof Error ? b.message.replace(/(ck|cs)_[a-z0-9]+/gi, "$1_…").slice(0, 200) : "błąd"}` };
  }
}

export async function startImportuAkcja(tenantId: string, storeId: string): Promise<{ ok: boolean; blad?: string }> {
  const { tenantId: t } = await wymaganyTenant(tenantId);
  if (!UUID.test(storeId)) return { ok: false, blad: "Nieznany sklep." };
  const w = await zlecImportSklepu(t, storeId);
  return w.ok ? { ok: true } : { ok: false, blad: w.blad };
}

export async function stanImportuAkcja(tenantId: string, storeId: string): Promise<StanImportu> {
  const { tenantId: t } = await wymaganyTenant(tenantId);
  if (!UUID.test(storeId)) return { stan: "brak", plan: null, postep: null, wynik: null, blad: null, start: null, koniec: null };
  return stanImportuSklepu(t, storeId);
}
