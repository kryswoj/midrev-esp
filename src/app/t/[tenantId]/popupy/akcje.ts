"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { TypFormularza } from "../../../../domain/formularze/model";
import type { IdSzablonu } from "../../../../domain/formularze/szablony";
import {
  archiwizujFormularz,
  BladFormularza,
  duplikujFormularz,
  opublikujFormularz,
  utworzFormularz,
  zapiszSzkic,
  type WynikPublikacji,
  type WynikZapisuSzkicu,
} from "../../../../usecases/popupy/formularze";
import { wynikiFormularza, type WynikiFormularza } from "../../../../usecases/popupy/wyswietlenia";
import { ustawAktywnosc } from "../../../../usecases/popupy/zarzadzaj";
import { wymaganyTenant } from "../../../autoryzacja";

// Server actions są cienkim opakowaniem use-case (AD-17). tenantId z klienta zawsze
// przechodzi przez wymaganyTenant (AD-21): sesja rozstrzyga dostęp, nie parametr.

const ID = /^[0-9a-f-]{36}$/i;

export async function utworzFormularzAkcja(formularz: FormData): Promise<void> {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const szablon = String(formularz.get("szablon") ?? "pusty") as IdSzablonu;
  const typ = String(formularz.get("typ") ?? "") as TypFormularza;
  const nazwa = String(formularz.get("nazwa") ?? "").trim().slice(0, 120);
  let id: string;
  try {
    id = await utworzFormularz(tenantId, { nazwa, szablon, typ: ["popup", "flyout", "embed"].includes(typ) ? typ : undefined });
  } catch (b) {
    if (b instanceof BladFormularza) redirect(`/t/${tenantId}/popupy/nowy?blad=${encodeURIComponent(b.message)}`);
    throw b;
  }
  revalidatePath(`/t/${tenantId}/popupy`);
  redirect(`/t/${tenantId}/popupy/${id}`);
}

export async function zapiszSzkicAkcja(tenantIdSurowy: string, id: string, revision: number, definicja: unknown, nazwa?: string): Promise<WynikZapisuSzkicu> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  if (!ID.test(id) || !Number.isInteger(revision)) return { ok: false, blad: "Nie znaleziono takiego formularza." };
  return zapiszSzkic(tenantId, id, revision, definicja, nazwa);
}

export async function opublikujAkcja(tenantIdSurowy: string, id: string, revision: number): Promise<WynikPublikacji> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  if (!ID.test(id) || !Number.isInteger(revision)) return { ok: false, blad: "Nie znaleziono takiego formularza." };
  const w = await opublikujFormularz(tenantId, id, revision);
  if (w.ok) revalidatePath(`/t/${tenantId}/popupy`);
  return w;
}

export async function wstrzymajAkcja(tenantIdSurowy: string, id: string, wlacz: boolean): Promise<{ ok: boolean }> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  if (!ID.test(id)) return { ok: false };
  const ok = await ustawAktywnosc(tenantId, id, wlacz);
  revalidatePath(`/t/${tenantId}/popupy`);
  return { ok };
}

export async function wynikiAkcja(tenantIdSurowy: string, id: string, dni: number): Promise<WynikiFormularza | null> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  if (!ID.test(id)) return null;
  return wynikiFormularza(tenantId, id, dni);
}

/** Akcje z listy formularzy (formularz HTML): duplikat, archiwum, włącz/wstrzymaj. */
export async function akcjaListyFormularzy(formularz: FormData): Promise<void> {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const id = String(formularz.get("popupId") ?? "");
  const co = String(formularz.get("akcja") ?? "");
  const baza = `/t/${tenantId}/popupy`;
  if (!ID.test(id)) redirect(`${baza}?blad=${encodeURIComponent("Nie znaleziono takiego formularza")}`);
  let komunikat: string;
  if (co === "duplikuj") {
    const nowy = await duplikujFormularz(tenantId, id);
    if (!nowy) redirect(`${baza}?blad=${encodeURIComponent("Nie znaleziono takiego formularza")}`);
    revalidatePath(baza);
    redirect(`${baza}/${nowy}`);
  } else if (co === "archiwizuj") {
    komunikat = (await archiwizujFormularz(tenantId, id)) ? "Formularz przeniesiony do archiwum. Zniknął ze strony sklepu, a zapisane zgody zostały." : "";
  } else if (co === "wlacz" || co === "wstrzymaj") {
    const ok = await ustawAktywnosc(tenantId, id, co === "wlacz");
    komunikat = ok ? (co === "wlacz" ? "Formularz włączony" : "Formularz wstrzymany. Zniknął ze strony sklepu.") : co === "wlacz" ? "Ten formularz trzeba najpierw opublikować w builderze." : "";
    if (!ok && co === "wlacz") redirect(`${baza}?blad=${encodeURIComponent(komunikat)}`);
  } else {
    komunikat = "";
  }
  revalidatePath(baza);
  if (!komunikat) redirect(`${baza}?blad=${encodeURIComponent("Nie znaleziono takiego formularza")}`);
  redirect(`${baza}?ok=${encodeURIComponent(komunikat)}`);
}
