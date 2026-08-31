"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { CIASTECZKO_SESJI } from "../../adapters/auth-sesja";
import { zaloguj } from "../../usecases/auth/zaloguj";
import { wyloguj } from "../../usecases/auth/wyloguj";

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

export async function zalogujAkcja(formularz: FormData) {
  const email = String(formularz.get("email") ?? "").trim();
  const haslo = String(formularz.get("haslo") ?? "");
  const dalej = String(formularz.get("dalej") ?? "");

  // adres klienta wylacznie do limitu prob logowania; pierwszy wpis
  // x-forwarded-for to oryginalny nadawca sprzed reverse proxy
  const naglowki = await headers();
  const klientIp =
    naglowki.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;

  const wynik = await zaloguj(email, haslo, klientIp);
  if (!wynik.ok) {
    // blad jako flaga w URL-u, nie tresc: komunikaty sa stale i renderuje je
    // strona, wiec URL nie stanie sie kanalem do wstrzykniecia tekstu
    const flaga = wynik.blad.startsWith("Za dużo") ? "limit" : "1";
    redirect(`/logowanie?blad=${flaga}${dalej ? `&dalej=${encodeURIComponent(dalej)}` : ""}`);
  }

  const sloik = await cookies();
  sloik.set(CIASTECZKO_SESJI, wynik.token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // NODE_ENV to jedyny swiadomy wyjatek od reguly "process.env tylko w config":
    // ustawia go Next, nie operator, i nie jest sekretem ani konfiguracja aplikacji.
    // W dev po http ciasteczko Secure by nie wrocilo i logowanie by nie dzialalo.
    secure: process.env.NODE_ENV === "production",
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
