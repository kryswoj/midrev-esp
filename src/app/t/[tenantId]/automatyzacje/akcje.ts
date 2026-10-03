"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  BIBLIOTEKA,
  statystykiAutomatyzacji,
  utworzAutomatyzacje,
  utworzWiadomosc,
  utworzZBiblioteki,
  zapiszSzkic,
  zapiszWiadomosc,
  zmienNazwe,
  zmienStatus,
  opublikuj,
  type DocelowyStatus,
  type WynikSzkicu,
  type WersjeWidziane,
  type StatystykiAutomatyzacji,
} from "../../../../usecases/automatyzacje/journeye";
import type { BladGrafu } from "../../../../domain/automatyzacje/graf";
import { katalogWlasciwosci, type KatalogWlasciwosci } from "../../../../usecases/automatyzacje/katalog-wlasciwosci";
import { podgladWyzwalacza, type WynikPodgladu } from "../../../../usecases/automatyzacje/podglad-wyzwalacza";
import { sklepyTenanta } from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import type { StanFormularza } from "../../../formularze";

// Server actions sa cienkim opakowaniem use-case (AD-17). Zero logiki biznesowej tutaj.
// tenantId z formularza/argumentu przechodzi przez wspolna bramke wymaganyTenant (AD-21):
// kazda akcja sprawdza SAMA, bo jest osobno osiagalna z sieci.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wroc(tenantId: string, wynik: { ok?: string; blad?: string }): never {
  revalidatePath(`/t/${tenantId}/automatyzacje`);
  const parametr = wynik.blad ? `blad=${encodeURIComponent(wynik.blad)}` : `ok=${encodeURIComponent(wynik.ok ?? "")}`;
  redirect(`/t/${tenantId}/automatyzacje?${parametr}`);
}

/** Wersje widziane przez operatora (z sieci, wiec walidowane): graf + kazda wiadomosc. */
function wersjeWidziane(surowe: unknown): WersjeWidziane | undefined {
  if (!surowe || typeof surowe !== "object") return undefined;
  const w = surowe as { draft?: unknown; emaile?: unknown };
  if (!Number.isInteger(w.draft)) return undefined;
  const emaile: Record<string, number> = {};
  if (w.emaile && typeof w.emaile === "object") {
    for (const [id, v] of Object.entries(w.emaile as Record<string, unknown>)) {
      if (UUID.test(id) && Number.isInteger(v)) emaile[id] = v as number;
    }
  }
  return { draft: w.draft as number, emaile };
}

function wersja(surowa: unknown): number | undefined {
  return Number.isInteger(surowa) ? (surowa as number) : undefined;
}

function wymaganeId(surowe: unknown): string {
  const id = String(surowe ?? "");
  if (!UUID.test(id)) throw new Error("Nieprawidłowy identyfikator");
  return id;
}

// ── Lista ───────────────────────────────────────────────────────────────────

export async function utworzAutomatyzacjeAkcja(_poprzedni: StanFormularza | undefined, formularz: FormData): Promise<StanFormularza> {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const wartosci = {
    nazwa: String(formularz.get("nazwa") ?? ""),
    zdarzenie: String(formularz.get("zdarzenie") ?? ""),
    listId: String(formularz.get("listId") ?? ""),
  };
  // "m:integracja|nazwa" = metryka z katalogu tenanta; inaczej zdarzenie v1 / lista
  const wynik = await utworzAutomatyzacje(
    tenantId,
    wartosci.zdarzenie.startsWith("m:")
      ? { name: wartosci.nazwa, metryka: wartosci.zdarzenie.slice(2) }
      : { name: wartosci.nazwa, zdarzenie: wartosci.zdarzenie, listId: wartosci.listId || null },
  );
  if (!wynik.ok) return { blad: wynik.blad, wartosci };
  revalidatePath(`/t/${tenantId}/automatyzacje`);
  redirect(`/t/${tenantId}/automatyzacje/${wynik.id}/edytor`);
}

export async function utworzZBibliotekiAkcja(formularz: FormData) {
  const { tenantId } = await wymaganyTenant(formularz.get("tenantId"));
  const klucz = String(formularz.get("szablon") ?? "");
  if (!BIBLIOTEKA.some((s) => s.klucz === klucz)) wroc(tenantId, { blad: "Nieznany szablon" });
  // Szablony maja w tresci link do sklepu: bez podlaczonego sklepu odmawiamy z powodem,
  // zamiast tworzyc automatyzacje z linkiem-atrapa (audyt P14).
  const sklep = (await sklepyTenanta(tenantId)).find((s) => s.status === "connected");
  if (!sklep) wroc(tenantId, { blad: "Szablon wstawia w treść link do Twojego sklepu - najpierw podłącz sklep w zakładce Sklep i integracje." });
  const wynik = await utworzZBiblioteki(tenantId, klucz, { sklepUrl: sklep.base_url });
  if (!wynik.ok) wroc(tenantId, { blad: wynik.blad });
  revalidatePath(`/t/${tenantId}/automatyzacje`);
  redirect(`/t/${tenantId}/automatyzacje/${wynik.id}/edytor?ok=${encodeURIComponent("Automatyzacja z biblioteki gotowa jako szkic. Sprawdź treści maili i włącz.")}`);
}

// ── Edytor (wolane z komponentow klienta) ───────────────────────────────────

export async function zapiszSzkicAkcja(
  tenantIdSurowy: string,
  flowIdSurowy: string,
  grafJson: string,
  oczekiwanaWersja: number,
): Promise<WynikSzkicu> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  const flowId = wymaganeId(flowIdSurowy);
  if (typeof grafJson !== "string") return { ok: false, blad: "Definicja przyszła uszkodzona. Odśwież stronę." };
  const wynik = await zapiszSzkic(tenantId, flowId, { graf: grafJson, oczekiwanaWersja: Number(oczekiwanaWersja) });
  if (wynik.ok) revalidatePath(`/t/${tenantId}/automatyzacje`);
  return wynik;
}

export async function zmienNazweAkcja(tenantIdSurowy: string, flowIdSurowy: string, nazwa: unknown) {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  const flowId = wymaganeId(flowIdSurowy);
  // typ sprawdza use-case (review #15): server action dostaje dowolny JSON z sieci
  const wynik = await zmienNazwe(tenantId, flowId, nazwa);
  if (wynik.ok) revalidatePath(`/t/${tenantId}/automatyzacje`);
  return wynik;
}

export async function zmienStatusAkcja(
  tenantIdSurowy: string,
  flowIdSurowy: string,
  docelowy: DocelowyStatus,
  widziane?: unknown,
): Promise<{ ok: true; status: string; wersja: number | null; komunikat: string } | { ok: false; blad: string; bledy?: BladGrafu[] }> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  const flowId = wymaganeId(flowIdSurowy);
  if (!["wlaczony", "wstrzymany", "szkic"].includes(docelowy)) return { ok: false, blad: "Nieznany stan docelowy." };
  const wynik = await zmienStatus(tenantId, flowId, docelowy, wersjeWidziane(widziane));
  revalidatePath(`/t/${tenantId}/automatyzacje`, "layout");
  return wynik;
}

export async function opublikujAkcja(tenantIdSurowy: string, flowIdSurowy: string, widziane: unknown) {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  const flowId = wymaganeId(flowIdSurowy);
  const w = wersjeWidziane(widziane);
  // publikacja bez wersji z ekranu = odmowa: operator ma publikowac to, co widzi (review #6)
  if (!w) return { ok: false as const, blad: "Brak wersji szkicu z ekranu. Odśwież stronę." };
  const wynik = await opublikuj(tenantId, flowId, w);
  revalidatePath(`/t/${tenantId}/automatyzacje`, "layout");
  return wynik;
}

export async function utworzWiadomoscAkcja(tenantIdSurowy: string, flowIdSurowy: string, nazwa: string) {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  return utworzWiadomosc(tenantId, wymaganeId(flowIdSurowy), String(nazwa ?? ""));
}

export async function zapiszNaglowekWiadomosciAkcja(
  tenantIdSurowy: string,
  flowIdSurowy: string,
  emailIdSurowy: string,
  zmiany: { nazwa?: string; temat?: string },
  oczekiwanaWersja?: unknown,
) {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  return zapiszWiadomosc(tenantId, wymaganeId(flowIdSurowy), wymaganeId(emailIdSurowy), {
    nazwa: typeof zmiany?.nazwa === "string" ? zmiany.nazwa : undefined,
    temat: typeof zmiany?.temat === "string" ? zmiany.temat : undefined,
    oczekiwanaWersja: wersja(oczekiwanaWersja),
  });
}

export async function statystykiAkcja(tenantIdSurowy: string, flowIdSurowy: string): Promise<StatystykiAutomatyzacji | null> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  return statystykiAutomatyzacji(tenantId, wymaganeId(flowIdSurowy), { przychod: false });
}

// ── Edytor blokow wiadomosci (ten sam edytor co w kampaniach) ────────────────

export async function zapiszWiadomoscFlowAkcja(
  tenantIdSurowy: string,
  flowIdSurowy: string,
  emailIdSurowy: string,
  dokumentJson: string,
  oczekiwanaWersja?: unknown,
) {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  const flowId = wymaganeId(flowIdSurowy);
  const emailId = wymaganeId(emailIdSurowy);
  const wynik = await zapiszWiadomosc(tenantId, flowId, emailId, { dokumentJson, oczekiwanaWersja: wersja(oczekiwanaWersja) });
  if (wynik.ok) revalidatePath(`/t/${tenantId}/automatyzacje/${flowId}`, "layout");
  return wynik;
}

/** Podglad "tak dostanie odbiorca": bloki -> HTML -> prawdziwe zlozWiadomosc. Nic nie zapisuje. */
export async function podgladWiadomosciFlowAkcja(
  tenantIdSurowy: string,
  flowIdSurowy: string,
  dokumentJson: string,
): Promise<{ ok: true; html: string; uwagi: string[] } | { ok: false; blad: string }> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  wymaganeId(flowIdSurowy);
  const { przygotujDokument } = await import("../../../../usecases/tresc/zapisz-tresc");
  const { renderujDokument } = await import("../../../../usecases/tresc/render-blokow");
  const { zlozWiadomosc } = await import("../../../../usecases/wysylka/renderuj");
  const { getPool } = await import("../../../../adapters/db/pool");
  const przygotowany = przygotujDokument(dokumentJson);
  if (!przygotowany.ok) return przygotowany;
  const { rows } = await getPool().query(
    "select name, sender_company_name, sender_postal_address, sender_tax_id from tenants where id = $1",
    [tenantId],
  );
  const render = renderujDokument(przygotowany.dokument);
  const { html } = zlozWiadomosc({
    trescHtml: render.html,
    clickToken: "podglad",
    unsubscribeToken: "podglad",
    nazwaSklepu: String(rows[0]?.name ?? ""),
    nadawca: { firma: rows[0]?.sender_company_name ?? null, adres: rows[0]?.sender_postal_address ?? null, nip: rows[0]?.sender_tax_id ?? null },
    sledzKlikniecia: false,
    sledzOtwarcia: false,
  });
  // zmienne {{ event.X }} / {{ person.X }}: w podgladzie zostaja jako znaczniki (nie ma
  // konkretnej osoby ani zdarzenia), ale blad skladni widac od razu, nie dopiero przy publikacji
  const { maZmienne, sprawdzSzablon } = await import("../../../../domain/email/szablon");
  const uwagi = [...render.uwagi];
  if (maZmienne(render.html)) {
    const blad = sprawdzSzablon("", render.html);
    uwagi.push(blad ? `Błąd w zmiennych: ${blad}` : "Zmienne ({{ … }}) podstawią się przy wysyłce danymi osoby i zdarzenia.");
  }
  return { ok: true, html, uwagi };
}

// ── E4b: katalog wlasciwosci (EdytorFiltra) i podglad wyzwalacza ──────────────

export async function katalogWlasciwosciAkcja(tenantIdSurowy: string, metryka: unknown): Promise<KatalogWlasciwosci> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  const m = metryka && typeof metryka === "object" ? (metryka as { integracja?: unknown; nazwa?: unknown }) : null;
  const ref = m && typeof m.nazwa === "string" && m.nazwa.length <= 127
    ? { nazwa: m.nazwa, ...(typeof m.integracja === "string" && /^[a-z0-9_.-]{1,64}$/.test(m.integracja) ? { integracja: m.integracja } : {}) }
    : null;
  return katalogWlasciwosci(tenantId, ref);
}

export async function podgladWyzwalaczaAkcja(tenantIdSurowy: string, flowId: unknown, grafJson: unknown): Promise<WynikPodgladu> {
  const { tenantId } = await wymaganyTenant(tenantIdSurowy);
  if (typeof grafJson !== "string") return { ok: false, blad: "Brak szkicu." };
  return podgladWyzwalacza(tenantId, String(flowId ?? ""), grafJson);
}
