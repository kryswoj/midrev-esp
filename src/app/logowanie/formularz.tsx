"use client";

import { useActionState } from "react";
import { zalogujAkcja } from "./akcje";

// Formularz logowania jako komponent klientowy z useActionState: po błędnym
// haśle e-mail zostaje w polu (audyt B4). Akcja zwraca FLAGĘ błędu, nie treść -
// mapowanie flaga -> komunikat siedzi tutaj, więc stan nie jest kanałem do
// wstrzyknięcia tekstu, a formularz nie zdradza, które adresy mają konta.
const KOMUNIKATY: Record<string, string> = {
  limit: "Za dużo nieudanych prób logowania. Spróbuj ponownie za kwadrans.",
  dane: "Nieprawidłowy adres albo hasło",
};

export function FormularzLogowania({ dalej }: { dalej?: string }) {
  const [stan, akcja] = useActionState(zalogujAkcja, undefined);

  return (
    <form action={akcja} className="karta w-full max-w-[340px] p-6">
      <p className="etykieta mb-1">MidRev</p>
      <h1 className="mb-1">Panel operatora</h1>
      <p className="mb-5 text-[var(--color-tekst-3)]">
        Zaloguj się, żeby pracować na sklepach klientów.
      </p>

      {stan?.blad ? (
        <p className="plakietka plakietka-blad mb-4" role="alert">
          {KOMUNIKATY[stan.blad] ?? KOMUNIKATY.dane}
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
          defaultValue={stan?.wartosci?.email ?? ""}
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
  );
}
