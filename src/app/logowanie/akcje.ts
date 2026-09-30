"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { CIASTECZKO_SESJI } from "../../adapters/auth-sesja";
import { adresKlienta } from "../../adapters/ip-klienta";
import { config } from "../../config";
import { zaloguj } from "../../usecases/auth/zaloguj";
import { wyloguj } from "../../usecases/auth/wyloguj";
import type { StanFormularza } from "../formularze";

// Server actions logowania: cienkie opakowanie use-case (AD-17) plus ciasteczko,
// ktore jako mechanizm HTTP nalezy do tej warstwy, nie do use-case'a.

/**
 * Parametr ?dalej pochodzi z URL-a, wiec jest wejsciem atakujacego. Przepuszczamy
 * wylacznie sciezke wewnetrzna: "http://..." i "//zloadomena.pl" to open redirect
 * z ekranu logowania prosto na strone lowiaca hasla.
 */
function bezpiecznaSciezka(dalej: string): string {
  return dalej.startsWith("/") && !dalej.startsWith("//") ? dalej : "/";
}

export async function zalogujAkcja(
  _poprzedni: StanFormularza | undefined,
  formularz: FormData,
): Promise<StanFormularza> {
  const email = String(formularz.get("email") ?? "").trim();
  const haslo = String(formularz.get("haslo") ?? "");
  const dalej = String(formularz.get("dalej") ?? "");

  // adres klienta wylacznie do limitu prob logowania, z naglowka ustawionego przez
  // ZAUFANE proxy (TRUSTED_PROXY, src/adapters/ip-klienta.ts). Pierwszy wpis XFF podaje
  // klient, wiec limit per IP bylby do obejscia jednym naglowkiem.
  const naglowki = await headers();
  const klientIp = adresKlienta(naglowki) ?? undefined;

  const wynik = await zaloguj(email, haslo, klientIp);
  if (!wynik.ok) {
    // blad jako FLAGA, nie tresc: komunikaty sa stale i mapuje je formularz,
    // wiec stan nie stanie sie kanalem do wstrzykniecia tekstu. E-mail wraca
    // w wartosciach, zeby bledne haslo nie kasowalo tez adresu (audyt B4).
    const flaga = wynik.blad.startsWith("Za dużo") ? "limit" : "dane";
    return { blad: flaga, wartosci: { email } };
  }

  const sloik = await cookies();
  sloik.set(CIASTECZKO_SESJI, wynik.token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Secure musi odpowiadac protokolowi, pod ktorym panel realnie stoi:
    // przy produkcyjnym buildzie serwowanym po zwyklym http przegladarka
    // odrzuca ciasteczko Secure i kazda nawigacja wraca na ekran logowania.
    secure: config().APP_URL.startsWith("https://"),
    expires: wynik.wygasa,
  });

  redirect(bezpiecznaSciezka(dalej));
}

export async function wylogujAkcja() {
  const sloik = await cookies();
  const token = sloik.get(CIASTECZKO_SESJI)?.value;
  // najpierw uniewaznienie w bazie, potem ciasteczko - w odwrotnej kolejnosci
  // blad bazy zostawilby zywa sesje bez sladu po stronie przegladarki
  if (token) await wyloguj(token);
  sloik.delete(CIASTECZKO_SESJI);
  redirect("/logowanie");
}
