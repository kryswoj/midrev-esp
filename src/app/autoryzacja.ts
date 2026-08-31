import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { aktualnaSesja, type SesjaAktora } from "../adapters/auth-sesja";

// Wspolna bramka autoryzacji strefy chronionej (AD-21). Warstwa app, nie
// adapters: dotyka cookies() (przez aktualnaSesja) oraz redirect()/notFound(),
// czyli mechanizmow Nexta, ktorych use-case'y i adaptery nie znaja.
//
// Trzy punkty wejscia - kazdy weryfikuje SAM, bo kazdy jest osobno osiagalny
// z sieci (layout nie jest granica auth: nawigacja RSC potrafi wyrenderowac
// sam segment strony bez ponownego uruchomienia layoutu, a server action
// w ogole nie renderuje niczego):
// - layout /t/[tenantId] - chroni to, co sam pobiera (przelacznik, liczniki),
// - KAZDA strona strefy /t/ - na poczatku, przed pierwszym zapytaniem o dane,
// - kazda server action, ktora dostaje tenantId z formularza.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// layout i strona wolaja bramke niezaleznie w tym samym renderze RSC; cache()
// deduplikuje odczyt sesji W OBREBIE JEDNEGO renderu, wiec podwojna weryfikacja
// nie znaczy podwojnych zapytan do bazy. Server action to osobne zadanie POST
// z wlasnym memo - jej weryfikacja NIE wspoldzieli wyniku z renderem i tak ma
// byc: akcja zawsze sprawdza sama.
const sesjaZadania = cache(aktualnaSesja);

/**
 * Sesja albo /logowanie. Middleware sprawdza tylko OBECNOSC ciasteczka (edge
 * nie ma bazy), wiec dopiero tutaj jest twarda weryfikacja tokenu w bazie.
 */
export async function wymaganaSesja(): Promise<SesjaAktora> {
  const sesja = await sesjaZadania();
  if (!sesja) redirect("/logowanie");
  return sesja;
}

/**
 * tenantId przychodzi od klienta (hidden input formularza albo segment URL),
 * wiec bez porownania z sesja spreparowane zadanie operowaloby na CUDZYM
 * tenancie. Zwraca tenantId dopiero po sprawdzeniu, ze zalogowany uzytkownik
 * ma go w sesji (admin/operator: wszystkie; client: wylacznie membershipy).
 *
 * Brak sesji -> /logowanie. Brak dostepu albo smieciowy identyfikator ->
 * notFound(): dla wolajacego tenant, ktorego nie wolno mu widziec, nie istnieje,
 * a walidacja UUID przy okazji zamienia smiec w kontrolowana odmowe zamiast
 * bledu Postgresa.
 */
export async function wymaganyTenant(
  surowy: FormDataEntryValue | string | null,
): Promise<{ tenantId: string; sesja: SesjaAktora }> {
  const sesja = await wymaganaSesja();
  const tenantId = String(surowy ?? "");
  if (!UUID.test(tenantId) || !sesja.tenantIds.includes(tenantId)) notFound();
  return { tenantId, sesja };
}
