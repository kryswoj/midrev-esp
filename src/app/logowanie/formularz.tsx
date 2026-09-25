"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Input } from "../ui";
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
    <form action={akcja} className="w-full">
      <h1>Zaloguj się</h1>
      <p className="mb-6 mt-2 text-[14px] leading-5 text-[var(--color-tekst-2)]">
        Przejdź do sklepów klientów i bieżącej pracy nad wysyłkami.
      </p>

      {stan?.blad ? (
        <Alert tone="blad" title="Nie udało się zalogować" className="mb-5">
          {KOMUNIKATY[stan.blad] ?? KOMUNIKATY.dane}
        </Alert>
      ) : null}

      <input type="hidden" name="dalej" value={dalej ?? ""} />

      <div className="space-y-5">
        <Field label="Adres e-mail" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            defaultValue={stan?.wartosci?.email ?? ""}
            className="focus-visible:border-[var(--color-akcent)] focus-visible:shadow-[0_0_0_3px_rgba(129,74,200,0.10)]"
          />
        </Field>

        <Field label="Hasło" htmlFor="haslo">
          <Input
            id="haslo"
            name="haslo"
            type="password"
            required
            autoComplete="current-password"
            className="focus-visible:border-[var(--color-akcent)] focus-visible:shadow-[0_0_0_3px_rgba(129,74,200,0.10)]"
          />
        </Field>
      </div>

      <div className="mt-7 [&>span]:w-full [&_button]:w-full">
        <Button type="submit" className="h-10 min-h-10 w-full hover:bg-[var(--color-akcent-mocny)] active:bg-[#5f2f99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-akcent)]">Zaloguj się</Button>
      </div>
    </form>
  );
}
