"use client";

/**
 * Wspólna treść ekranów błędu (src/app/error.tsx, src/app/global-error.tsx,
 * src/app/t/[tenantId]/error.tsx). Błąd „stara karta po wdrożeniu” dostaje własny
 * komunikat i przycisk pełnego przeładowania; każdy inny zostaje ogólnym błędem
 * z „Spróbuj ponownie”. Szczegół błędu zostaje w logu serwera, nie na ekranie.
 */
import { czyBladWersji } from "./blad-wersji";

export function EkranBledu({ error, reset, powrot }: {
  error: Error & { digest?: string };
  reset: () => void;
  powrot?: { href: string; etykieta: string };
}) {
  const wersja = czyBladWersji(error);
  return (
    <div className="karta max-w-md p-6" role="alert">
      <p className="etykieta mb-2">{wersja ? "Nowa wersja panelu" : "Błąd"}</p>
      <h1>{wersja ? "Panel został zaktualizowany" : "Coś poszło nie tak"}</h1>
      <p className="mt-2 text-[13px] text-[var(--color-tekst-2)]">
        {wersja
          ? "Ta karta ma jeszcze poprzednią wersję panelu, dlatego ostatnia akcja się nie wykonała i jej zmiany nie zostały zapisane. Odśwież stronę i powtórz ją."
          : "Panel nie zdołał wyrenderować tej strony. Spróbuj ponownie, a jeśli błąd wraca, zgłoś go z adresem strony, na której wystąpił."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {wersja ? (
          <button className="przycisk" type="button" onClick={() => window.location.reload()}>
            Odśwież stronę
          </button>
        ) : (
          <button className="przycisk" type="button" onClick={reset}>
            Spróbuj ponownie
          </button>
        )}
        {powrot ? (
          // zwykły <a>, nie <Link>: po błędzie wersji miękka nawigacja i tak by nie zadziałała
          <a href={powrot.href} className="przycisk przycisk-wtorny">{powrot.etykieta}</a>
        ) : null}
      </div>
    </div>
  );
}
