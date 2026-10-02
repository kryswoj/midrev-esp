"use client";

/**
 * Przycisk wysyłający formularz z widocznym stanem „trwa” (audyt UX 02.10, P0-1).
 *
 * Bez tego wolny albo zepsuty submit (np. stara karta po wdrożeniu) wygląda jak martwy
 * przycisk: operator klika drugi raz albo uznaje, że „nic się nie dzieje”. Stan bierze
 * z `useFormStatus`, więc działa w każdym `<form action={…}>` bez przekazywania propsów;
 * musi być renderowany WEWNĄTRZ formularza, którego stan ma pokazywać.
 *
 * W trakcie: tekst `trwa` (np. „Dodaję…”), blokada ponownego kliknięcia, `aria-busy`.
 * Zewnętrzny stan (np. `pending` z `useActionState`) można dołożyć propsem `trwaZewnetrznie`.
 */
import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./button";

export interface PrzyciskFormularzaProps extends Omit<ButtonProps, "href" | "type"> {
  /** Tekst w trakcie wysyłki, np. „Dodaję…”. */
  trwa: string;
  /** Dodatkowy sygnał „trwa” spoza formularza (np. pending z useActionState). */
  trwaZewnetrznie?: boolean;
}

export function PrzyciskFormularza({ children, trwa, trwaZewnetrznie = false, disabled, ...props }: PrzyciskFormularzaProps) {
  const { pending } = useFormStatus();
  const wTrakcie = pending || trwaZewnetrznie;
  return (
    <Button {...props} type="submit" disabled={disabled || wTrakcie} aria-busy={wTrakcie || undefined}>
      {wTrakcie ? (
        <>
          <span aria-hidden="true" className="przycisk-wskaznik" />
          <span>{trwa}</span>
        </>
      ) : children}
    </Button>
  );
}
