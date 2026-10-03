"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { wymaganyTenant } from "../../../../autoryzacja";
import { BladUstawienStrony, wymienKluczStrony, zapewnijKluczStrony, zapiszUstawieniaStrony } from "../../../../../usecases/integracja/klucz-strony";
import { ostatnieZdarzeniaStrony, sygnalyStrony, type Sygnal } from "../../../../../usecases/integracja/podglad";
import { ustawRoleMetrykStrony } from "../../../../../usecases/integracja/role-metryk";
import { BladUstawienFeedu, importujFeed, zapiszFeed } from "../../../../../usecases/katalog/katalog";

// Server actions kreatora „Własna strona / inny sklep”: cienkie opakowania use-case (AD-17),
// KAŻDA zaczyna od wymaganyTenant (AD-21).

const SCIEZKA = (t: string) => `/t/${t}/sklepy/wlasna-strona`;

function wroc(tenantId: string, q: { ok?: string; blad?: string }, kotwica = ""): never {
  const p = new URLSearchParams();
  if (q.ok) p.set("ok", q.ok);
  if (q.blad) p.set("blad", q.blad);
  redirect(`${SCIEZKA(tenantId)}?${p.toString()}${kotwica}`);
}

export async function zapiszUstawieniaAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const tak = (n: string) => f.get(n) === "tak";
  try {
    await zapiszUstawieniaStrony(tenantId, {
      domeny: String(f.get("domeny") ?? "").split(/[\s,;]+/).filter(Boolean),
      ograniczOriginy: tak("ograniczOriginy"),
      wymagajZgodyCookies: tak("wymagajZgodyCookies"),
      identyfikacjaZLinkow: tak("identyfikacjaZLinkow"),
      ga4: tak("ga4"),
      zaladujFormularze: tak("zaladujFormularze"),
      tekstZgody: String(f.get("tekstZgody") ?? ""),
      politykaUrl: String(f.get("politykaUrl") ?? ""),
    });
    await ustawRoleMetrykStrony(tenantId);
  } catch (b) {
    if (b instanceof BladUstawienStrony) wroc(tenantId, { blad: b.message }, "#ustawienia");
    throw b;
  }
  revalidatePath(SCIEZKA(tenantId));
  wroc(tenantId, { ok: "Zapisane. Strona dostanie nowe ustawienia w ciągu 5 minut (tyle przeglądarki trzymają skrypt)." }, "#ustawienia");
}

export async function zapiszFeedAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  try {
    const feed = await zapiszFeed(tenantId, String(f.get("url") ?? ""));
    if (feed && f.get("teraz") === "tak") {
      const w = await importujFeed(tenantId);
      revalidatePath(SCIEZKA(tenantId));
      if (w?.status === "blad") wroc(tenantId, { blad: `Feed zapisany, ale pobranie się nie udało: ${w.blad}` }, "#katalog");
      wroc(tenantId, { ok: w?.status === "bez_zmian" ? "Feed bez zmian od ostatniego pobrania." : `Wczytane produkty: ${w?.produkty ?? 0} (warianty: ${w?.warianty ?? 0}).` }, "#katalog");
    }
    revalidatePath(SCIEZKA(tenantId));
    wroc(tenantId, { ok: feed ? "Adres feedu zapisany. Pobierzemy go w ciągu 15 minut, potem co 6 godzin." : "Feed usunięty. Katalog zostaje, ale nie będzie odświeżany." }, "#katalog");
  } catch (b) {
    if (b instanceof BladUstawienFeedu) wroc(tenantId, { blad: b.message }, "#katalog");
    throw b;
  }
}

export async function wymienKluczAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  if (f.get("potwierdzam") !== "tak") wroc(tenantId, { blad: "Zaznacz, że rozumiesz: stary kod na stronie przestanie działać." }, "#programista");
  const k = await wymienKluczStrony(tenantId);
  revalidatePath(SCIEZKA(tenantId));
  wroc(tenantId, { ok: `Nowy klucz strony: ${k.id}. Wklej nowy kod na stronę.` }, "#kod");
}

export interface StanPodgladu {
  teraz: number;
  sygnaly: Sygnal[];
  zdarzenia: { id: string; metryka: string; kiedy: number; sciezka: string | null; profileId: string | null; osoba: string | null }[];
}

/** Odpytywane co 3 s przez „Sprawdź połączenie”. Tylko odczyt, tylko własny tenant. */
export async function podgladAkcja(tenantId: string): Promise<StanPodgladu> {
  const { tenantId: t } = await wymaganyTenant(tenantId);
  const klucz = await zapewnijKluczStrony(t);
  const zdarzenia = await ostatnieZdarzeniaStrony(t, 15);
  return {
    teraz: Date.now(),
    sygnaly: sygnalyStrony(klucz.id),
    zdarzenia: zdarzenia.map((z) => ({ ...z, kiedy: z.kiedy.getTime() })),
  };
}
