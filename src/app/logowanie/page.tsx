import { redirect } from "next/navigation";
import { aktualnaSesja } from "../../adapters/auth-sesja";
import { zalogujAkcja } from "./akcje";

export const dynamic = "force-dynamic";

// Ekran logowania w kierunku "Noc": jedna karta na plotnie, istniejace klasy
// (.karta, .pole, .przycisk, .etykieta), zero nowych tokenow w globals.css.

export default async function StronaLogowania({
  searchParams,
}: {
  searchParams: Promise<{ dalej?: string; blad?: string }>;
}) {
  const { dalej, blad } = await searchParams;

  // zalogowany nie oglada formularza; cel z ?dalej dopiero po odkazeniu,
  // bo to parametr z URL-a, czyli wejscie atakujacego (open redirect)
  const sesja = await aktualnaSesja();
  if (sesja) {
    redirect(dalej && dalej.startsWith("/") && !dalej.startsWith("//") ? dalej : "/");
  }

  return (
    <main
      style={{ background: "var(--color-plotno)" }}
      className="flex min-h-screen items-center justify-center px-4"
    >
      <form action={zalogujAkcja} className="karta w-full max-w-[340px] p-6">
        <p className="etykieta mb-1">MidRev</p>
        <h1 className="mb-1">Panel operatora</h1>
        <p className="mb-5 text-[var(--color-tekst-3)]">
          Zaloguj się, żeby pracować na sklepach klientów.
        </p>

        {blad ? (
          <p className="plakietka plakietka-blad mb-4" role="alert">
            {/* jeden komunikat na zly adres i zle haslo - formularz nie moze
                byc wyrocznia, ktore adresy maja konta */}
            {blad === "limit"
              ? "Za dużo nieudanych prób logowania. Spróbuj ponownie za kwadrans."
              : "Nieprawidłowy adres albo hasło"}
          </p>
        ) : null}

        <input type="hidden" name="dalej" value={dalej ?? ""} />

        <div className="mb-4">
          <label className="etykieta mb-1 block" htmlFor="email">
            Adres e-mail
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            className="pole"
          />
        </div>

        <div className="mb-5">
          <label className="etykieta mb-1 block" htmlFor="haslo">
            Hasło
          </label>
          <input
            id="haslo"
            name="haslo"
            type="password"
            required
            autoComplete="current-password"
            className="pole"
          />
        </div>

        <button type="submit" className="przycisk w-full">
          Zaloguj się
        </button>
      </form>
    </main>
  );
}
