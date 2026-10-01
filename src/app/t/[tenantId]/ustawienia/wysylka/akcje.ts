"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { wymaganyTenant } from "../../../../autoryzacja";
import type { StanFormularza } from "../../../../formularze";
import {
  dodajDomene,
  sprawdzDomene,
  usunDomene,
  zmienUstawieniaDomeny,
} from "../../../../../usecases/wysylka-konfiguracja/domeny";
import {
  testujSerwer,
  wyslijWiadomoscTestowa,
  zapiszSerwer,
} from "../../../../../usecases/wysylka-konfiguracja/serwer";
import { zapiszLimit } from "../../../../../usecases/wysylka-konfiguracja/limity";
import { zapiszDaneNadawcy } from "../../../../../usecases/wysylka-konfiguracja/dane-nadawcy";
import {
  testujSkrzynke,
  usunSkrzynke,
  zapiszSkrzynke,
} from "../../../../../usecases/wysylka-konfiguracja/skrzynka-zwrotna";

// Server actions ekranu „Wysyłka i domeny" — cienkie opakowania use-case (AD-17), lokalne
// dla tego katalogu, żeby nie dotykać wspólnego akcje.ts. KAŻDA akcja zaczyna od
// wymaganyTenant (AD-21): tenantId z hidden inputa to deklaracja, nie dostęp. Identyfikator
// domeny jest dodatkowo zawężany predykatem tenant_id w każdym zapytaniu use-case.
//
// Hasło SMTP: nie wraca w stanie akcji (byłoby w odpowiedzi RSC), nie trafia do URL-a
// ani do logów. Echo formularza po błędzie pomija je celowo.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sciezka(tenantId: string) {
  return `/t/${tenantId}/ustawienia/wysylka`;
}

function wroc(tenantId: string, pola: { ok?: string; blad?: string }): never {
  const q = pola.blad ? `blad=${encodeURIComponent(pola.blad)}` : `ok=${encodeURIComponent(pola.ok ?? "")}`;
  redirect(`${sciezka(tenantId)}?${q}`);
}

function tekst(f: FormData, pole: string): string {
  return String(f.get(pole) ?? "");
}

function idDomeny(f: FormData, tenantId: string): string {
  const id = tekst(f, "domainId");
  if (!UUID.test(id)) wroc(tenantId, { blad: "Nieznana domena." });
  return id;
}

const NAZWY_STATUSU: Record<string, string> = {
  verified: "zweryfikowana",
  partial: "zweryfikowana częściowo",
  failed: "niezweryfikowana",
  pending: "niesprawdzona",
};

export async function dodajDomeneAkcja(_poprzedni: StanFormularza | undefined, f: FormData): Promise<StanFormularza> {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const dane = { domena: tekst(f, "domena"), selektorDkim: tekst(f, "selektorDkim"), mechanizmSpf: tekst(f, "mechanizmSpf") };
  const wynik = await dodajDomene(tenantId, dane);
  if (!wynik.ok) return { blad: wynik.blad, wartosci: dane };
  // od razu pierwsze sprawdzenie: klient ma zobaczyć, czego brakuje, bez drugiego kliknięcia
  const spr = await sprawdzDomene(tenantId, wynik.id);
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, spr.ok
    ? spr.domena.status === "verified"
      ? { ok: "Domena dodana i zweryfikowana: SPF, DKIM i DMARC są poprawne." }
      : { ok: `Domena dodana. Pierwsze sprawdzenie: ${NAZWY_STATUSU[spr.domena.status] ?? spr.domena.status}. Ustaw brakujące rekordy u rejestratora i kliknij „Sprawdź teraz”.` }
    : { ok: `Domena dodana, ale sprawdzenie DNS się nie udało: ${spr.blad}` });
}

export async function sprawdzDomeneAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const wynik = await sprawdzDomene(tenantId, idDomeny(f, tenantId));
  revalidatePath(sciezka(tenantId));
  if (!wynik.ok) wroc(tenantId, { blad: wynik.blad });
  if (wynik.wynik.awariaDns) {
    wroc(tenantId, { blad: `DNS nie dał pełnej odpowiedzi — pokazujemy wynik poprzedniego sprawdzenia. ${wynik.domena.bladSprawdzenia ?? ""}` });
  }
  wroc(tenantId, { ok: `${wynik.domena.domena}: ${NAZWY_STATUSU[wynik.domena.status] ?? wynik.domena.status}.` });
}

export async function zmienDomeneAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const domainId = idDomeny(f, tenantId);
  const wynik = await zmienUstawieniaDomeny(tenantId, domainId, {
    selektorDkim: tekst(f, "selektorDkim"),
    mechanizmSpf: tekst(f, "mechanizmSpf"),
  });
  if (!wynik.ok) wroc(tenantId, { blad: wynik.blad });
  const spr = await sprawdzDomene(tenantId, domainId);
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, spr.ok
    ? { ok: `Ustawienia zapisane. Domena: ${NAZWY_STATUSU[spr.domena.status] ?? spr.domena.status}.` }
    : { blad: `Ustawienia zapisane, ale sprawdzenie się nie udało: ${spr.blad}` });
}

export async function usunDomeneAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const wynik = await usunDomene(tenantId, idDomeny(f, tenantId));
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, wynik.ok ? { ok: "Domena usunięta." } : { blad: wynik.blad });
}

export async function zapiszSerwerAkcja(_poprzedni: StanFormularza | undefined, f: FormData): Promise<StanFormularza> {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const dane = {
    host: tekst(f, "host"),
    port: tekst(f, "port"),
    bezpieczenstwo: tekst(f, "bezpieczenstwo"),
    uzytkownik: tekst(f, "uzytkownik"),
    noweHaslo: tekst(f, "haslo"),
    usunHaslo: f.get("usunHaslo") === "tak",
    nazwaNadawcy: tekst(f, "nazwaNadawcy"),
    adresNadawcy: tekst(f, "adresNadawcy"),
    odpowiedzDo: tekst(f, "odpowiedzDo"),
    rodzaj: tekst(f, "rodzaj") || "wlasny_serwer",
    domenaKoperty: tekst(f, "domenaKoperty"),
  };
  const wynik = await zapiszSerwer(tenantId, dane);
  if (!wynik.ok) {
    // echo BEZ hasła: sekret nie może wrócić w odpowiedzi RSC ani w DOM
    const { noweHaslo: _pominiete, usunHaslo: _u, ...wartosci } = dane;
    return { blad: wynik.blad, wartosci };
  }
  // zapis zeruje „sprawdzony" przy zmianie połączenia, więc test idzie od razu
  const test = await testujSerwer(tenantId);
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, test.ok
    ? { ok: "Serwer zapisany, test połączenia przeszedł." }
    : { blad: `Serwer zapisany, ale test połączenia nie przeszedł: ${test.komunikat}` });
}

export async function testujSerwerAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const test = await testujSerwer(tenantId);
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, test.ok ? { ok: "Test połączenia przeszedł." } : { blad: test.komunikat });
}

export async function wyslijTestowaAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const wynik = await wyslijWiadomoscTestowa(tenantId, tekst(f, "adres"));
  wroc(tenantId, wynik.ok
    ? { ok: `Serwer przyjął wiadomość testową od ${wynik.od}. Sprawdź skrzynkę odbiorcy (także spam).` }
    : { blad: wynik.blad });
}

// ── Dane nadawcy w stopce ────────────────────────────────────────────────────────

export async function zapiszDaneNadawcyAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const wynik = await zapiszDaneNadawcy(tenantId, { firma: tekst(f, "firma"), adres: tekst(f, "adres"), nip: tekst(f, "nip") });
  revalidatePath(sciezka(tenantId));
  // z onboardingu (ekran Przegląd) wracamy tam, skąd przyszedł formularz; wartość z listy, nie z URL
  if (tekst(f, "powrot") === "przeglad") {
    revalidatePath(`/t/${tenantId}`);
    const q = wynik.ok ? `ok=${encodeURIComponent("Dane firmy zapisane.")}` : `blad=${encodeURIComponent(wynik.blad)}`;
    redirect(`/t/${tenantId}?${q}`);
  }
  wroc(tenantId, wynik.ok ? { ok: "Dane firmy zapisane. Pojawią się w stopce każdej nowej wiadomości." } : { blad: wynik.blad });
}

// ── Limit dobowy ────────────────────────────────────────────────────────────────

export async function zapiszLimitAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const wynik = await zapiszLimit(tenantId, tekst(f, "limit"));
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, wynik.ok
    ? { ok: `Limit dobowy ustawiony na ${wynik.limit.toLocaleString("pl-PL")} wiadomości. Obowiązuje od następnej partii.` }
    : { blad: wynik.blad });
}

// ── Skrzynka zwrotna (odbicia) ──────────────────────────────────────────────────

export async function zapiszSkrzynkeAkcja(_poprzedni: StanFormularza | undefined, f: FormData): Promise<StanFormularza> {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const dane = {
    host: tekst(f, "host"),
    port: tekst(f, "port"),
    bezpieczenstwo: tekst(f, "bezpieczenstwo"),
    uzytkownik: tekst(f, "uzytkownik"),
    noweHaslo: tekst(f, "haslo"),
    skrzynka: tekst(f, "skrzynka"),
  };
  const wynik = await zapiszSkrzynke(tenantId, dane);
  if (!wynik.ok) {
    // echo BEZ hasła: sekret nie może wrócić w odpowiedzi RSC ani w DOM
    const { noweHaslo: _pominiete, ...wartosci } = dane;
    return { blad: wynik.blad, wartosci };
  }
  const test = await testujSkrzynke(tenantId);
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, test.ok
    ? { ok: `Skrzynka zapisana, połączenie działa. W folderze: ${test.wiadomosci} wiadomości, ${test.nieprzeczytane} nieprzeczytanych. Odbicia będą czytane co 5 minut.` }
    : { blad: `Skrzynka zapisana, ale test nie przeszedł: ${test.komunikat}` });
}

export async function testujSkrzynkeAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const test = await testujSkrzynke(tenantId);
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, test.ok
    ? { ok: `Skrzynka odpowiada. W folderze: ${test.wiadomosci} wiadomości, ${test.nieprzeczytane} nieprzeczytanych.` }
    : { blad: test.komunikat });
}

export async function usunSkrzynkeAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  await usunSkrzynke(tenantId);
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, { ok: "Skrzynka zwrotna usunięta. Odbicia nie będą już czytane — do czasu ponownego ustawienia dostarczalność jest ślepa." });
}

// ── Wysyłka platformowa (0040): kreator „Podłącz domenę" ─────────────────────────
// Klient nie widzi słów SES/SMTP: komunikaty use-case są już po ludzku. Domenę,
// strefę i układ liczy ZAWSZE serwer z samego wpisu klienta (formularz niesie tylko wpis,
// prefiks, część przed @, nazwę i adres odpowiedzi).

export async function podlaczDomeneAkcja(_poprzedni: StanFormularza | undefined, f: FormData): Promise<StanFormularza> {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const dane = {
    wpis: tekst(f, "wpis"),
    prefiks: tekst(f, "prefiks"),
    lokalna: tekst(f, "lokalna"),
    nazwaNadawcy: tekst(f, "nazwaNadawcy"),
    odpowiedzDo: tekst(f, "odpowiedzDo"),
  };
  const { podlaczDomene, sprawdzDomenePlatformowa } = await import("../../../../../usecases/wysylka-konfiguracja/domena-platformowa");
  const wynik = await podlaczDomene(tenantId, dane);
  if (!wynik.ok) return { blad: wynik.blad, wartosci: dane };
  // pierwsze sprawdzenie od razu: klient widzi stan rekordów bez czekania na workera
  await sprawdzDomenePlatformowa(tenantId, wynik.domainId).catch(() => null);
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, { ok: "Domena podłączona. Teraz dodaj rekordy z tabeli poniżej — resztę sprawdzimy sami." });
}

export async function sprawdzPlatformoweAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const { domenaPlatformowa, sprawdzDomenePlatformowa } = await import("../../../../../usecases/wysylka-konfiguracja/domena-platformowa");
  const d = await domenaPlatformowa(tenantId);
  if (!d) wroc(tenantId, { blad: "Najpierw podłącz domenę." });
  const w = await sprawdzDomenePlatformowa(tenantId, d!.id);
  revalidatePath(sciezka(tenantId));
  if (!w.ok) wroc(tenantId, { blad: w.blad });
  const brakuje = w.domena.rekordy.filter((r) => w.domena.raport?.rekordy[r.klucz]?.stan !== "ok").length;
  wroc(tenantId, w.domena.gotowa
    ? { ok: "Wszystko na miejscu. Domena jest gotowa do wysyłki." }
    : { ok: brakuje ? `Sprawdzone. Do dokończenia: ${brakuje} z ${w.domena.rekordy.length} rekordów.` : "Sprawdzone. Rekordy są na miejscu, czekamy na ostatnie potwierdzenie." });
}

export async function linkInstrukcjiAkcja(
  _poprzedni: { url?: string; wygasa?: string; blad?: string } | undefined,
  f: FormData,
): Promise<{ url?: string; wygasa?: string; blad?: string }> {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const { domenaPlatformowa } = await import("../../../../../usecases/wysylka-konfiguracja/domena-platformowa");
  const { utworzLinkInstrukcji } = await import("../../../../../usecases/wysylka-konfiguracja/instrukcja-dns");
  const d = await domenaPlatformowa(tenantId);
  if (!d) return { blad: "Najpierw podłącz domenę." };
  const w = await utworzLinkInstrukcji(tenantId, d.id);
  if (!w.ok) return { blad: w.blad };
  return { url: w.url, wygasa: w.wygasa.toISOString() };
}

export async function zapiszNadawcePlatformyAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const { zapiszNadawcePlatformy } = await import("../../../../../usecases/wysylka-konfiguracja/domena-platformowa");
  const w = await zapiszNadawcePlatformy(tenantId, {
    nazwaNadawcy: tekst(f, "nazwaNadawcy"),
    lokalna: tekst(f, "lokalna"),
    odpowiedzDo: tekst(f, "odpowiedzDo"),
  });
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, w.ok ? { ok: "Nadawca zapisany. Nowe maile wyjdą już z tymi danymi." } : { blad: w.blad });
}

export async function odlaczDomeneAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  if (tekst(f, "potwierdzenie").trim().toLowerCase() !== "odłącz") {
    wroc(tenantId, { blad: "Żeby odłączyć domenę, wpisz słowo „odłącz”." });
  }
  const { odlaczDomenePlatformowa } = await import("../../../../../usecases/wysylka-konfiguracja/domena-platformowa");
  const w = await odlaczDomenePlatformowa(tenantId);
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, w.ok ? { ok: "Domena odłączona. Wysyłka jest wstrzymana, dopóki nie podłączysz domeny ponownie." } : { blad: w.blad });
}

export async function wyslijTestPlatformyAkcja(f: FormData) {
  const { tenantId } = await wymaganyTenant(f.get("tenantId"));
  const { wyslijTestPlatformy } = await import("../../../../../usecases/wysylka-konfiguracja/wysylka-platformowa");
  const w = await wyslijTestPlatformy(tenantId, tekst(f, "adres"));
  revalidatePath(sciezka(tenantId));
  wroc(tenantId, w.ok ? { ok: `Test wysłany z ${w.od}. Sprawdź skrzynkę (także folder Oferty i Spam).` } : { blad: w.blad });
}
