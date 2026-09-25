"use client";

import { useActionState, useState } from "react";
import { BladFormularza } from "../../../../blad-formularza";
import { zapiszSerwerAkcja } from "./akcje";

/** To, co formularz wie o zapisanej konfiguracji. Bez hasła i bez szyfrogramu — tylko fakt, że jest. */
export interface SerwerDoFormularza {
  host: string;
  port: number;
  bezpieczenstwo: string;
  uzytkownik: string | null;
  hasloUstawione: boolean;
  nazwaNadawcy: string;
  adresNadawcy: string;
  odpowiedzDo: string | null;
}

const PORT_DLA_TRYBU: Record<string, string> = { starttls: "587", tls: "465", none: "25" };

/**
 * Formularz własnego serwera SMTP. Hasło:
 *  - nigdy nie przychodzi z serwera (nie ma go w propsach, więc nie ma go w HTML ani w RSC),
 *  - puste pole = zostaw zapisane; „Usuń hasło" = logowanie bez hasła,
 *  - po błędzie zapisu pole jest puste i komunikat o tym mówi.
 */
export function FormularzSerwera({
  tenantId,
  serwer,
  domeny,
  nazwaKonta,
}: {
  tenantId: string;
  serwer: SerwerDoFormularza | null;
  domeny: string[];
  nazwaKonta: string;
}) {
  const [stan, akcja, trwa] = useActionState(zapiszSerwerAkcja, undefined);
  const w = stan?.wartosci;
  const [tryb, ustawTryb] = useState(w?.bezpieczenstwo ?? serwer?.bezpieczenstwo ?? "starttls");
  const [port, ustawPort] = useState(w?.port ?? String(serwer?.port ?? 587));
  const [zmienHaslo, ustawZmienHaslo] = useState(!serwer?.hasloUstawione);

  return (
    <form action={akcja} className="space-y-5">
      <input type="hidden" name="tenantId" value={tenantId} />
      <BladFormularza blad={stan?.blad} />

      <fieldset className="space-y-4">
        <legend className="mb-2 text-[14px] font-semibold">Połączenie</legend>
        <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
          <label className="block">
            <span className="etykieta mb-1.5 block">Serwer SMTP</span>
            <input name="host" required placeholder="smtp.twojadomena.pl" defaultValue={w?.host ?? serwer?.host ?? ""} className="pole" autoComplete="off" spellCheck={false} />
          </label>
          <label className="block">
            <span className="etykieta mb-1.5 block">Port</span>
            <input name="port" required inputMode="numeric" value={port} onChange={(e) => ustawPort(e.target.value)} className="pole liczba" />
          </label>
        </div>
        <label className="block">
          <span className="etykieta mb-1.5 block">Szyfrowanie</span>
          <select
            name="bezpieczenstwo"
            value={tryb}
            onChange={(e) => {
              ustawTryb(e.target.value);
              // podpowiedź portu tylko wtedy, gdy port jest jednym ze standardowych
              if (["25", "465", "587"].includes(port)) ustawPort(PORT_DLA_TRYBU[e.target.value]);
            }}
            className="pole"
          >
            <option value="starttls">STARTTLS (zwykle port 587)</option>
            <option value="tls">TLS od początku połączenia (zwykle port 465)</option>
            <option value="none">Brak szyfrowania (tylko bez logowania)</option>
          </select>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="etykieta mb-1.5 block">Użytkownik</span>
            <input name="uzytkownik" placeholder="zwykle pełny adres e-mail" defaultValue={w?.uzytkownik ?? serwer?.uzytkownik ?? ""} className="pole" autoComplete="off" spellCheck={false} />
          </label>
          <div className="block">
            <span className="etykieta mb-1.5 block">Hasło</span>
            {zmienHaslo ? (
              <>
                <input
                  name="haslo"
                  type="password"
                  placeholder={serwer?.hasloUstawione ? "nowe hasło" : "hasło do skrzynki albo hasło aplikacji"}
                  className="pole"
                  autoComplete="new-password"
                />
                {serwer?.hasloUstawione ? (
                  <span className="mt-1 block text-[12px] text-[var(--color-tekst-3)]">
                    Puste pole zostawia zapisane hasło.{" "}
                    <button type="button" className="underline" onClick={() => ustawZmienHaslo(false)}>
                      Anuluj zmianę
                    </button>
                  </span>
                ) : null}
              </>
            ) : (
              <div className="flex h-9 items-center gap-3">
                <span className="plakietka plakietka-ok">hasło ustawione</span>
                <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => ustawZmienHaslo(true)}>
                  Zmień hasło
                </button>
                <label className="flex items-center gap-1.5 text-[13px] text-[var(--color-tekst-2)]">
                  <input type="checkbox" name="usunHaslo" value="tak" /> usuń
                </label>
              </div>
            )}
            {stan?.blad ? (
              <span className="mt-1 block text-[12px] text-[var(--color-tekst-3)]">
                Ze względów bezpieczeństwa hasło nie wraca po błędzie — wpisz je ponownie, jeśli było zmieniane.
              </span>
            ) : null}
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-4 border-t border-[var(--color-linia-0)] pt-5">
        <legend className="mb-2 text-[14px] font-semibold">Nadawca</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="etykieta mb-1.5 block">Nazwa nadawcy</span>
            <input name="nazwaNadawcy" required placeholder={nazwaKonta} defaultValue={w?.nazwaNadawcy ?? serwer?.nazwaNadawcy ?? nazwaKonta} className="pole" />
          </label>
          <label className="block">
            <span className="etykieta mb-1.5 block">Adres nadawcy</span>
            <input
              name="adresNadawcy"
              required
              type="email"
              placeholder={domeny[0] ? `sklep@${domeny[0]}` : "sklep@twojadomena.pl"}
              defaultValue={w?.adresNadawcy ?? serwer?.adresNadawcy ?? ""}
              className="pole"
              spellCheck={false}
            />
            <span className="mt-1 block text-[12px] text-[var(--color-tekst-3)]">
              {domeny.length
                ? `Musi być w domenie dodanej wyżej: ${domeny.join(", ")}.`
                : "Najpierw dodaj domenę wysyłkową — adres nadawcy musi być w niej."}
            </span>
          </label>
        </div>
        <label className="block sm:max-w-[50%]">
          <span className="etykieta mb-1.5 block">Odpowiedzi na adres (opcjonalnie)</span>
          <input name="odpowiedzDo" type="email" placeholder="kontakt@twojadomena.pl" defaultValue={w?.odpowiedzDo ?? serwer?.odpowiedzDo ?? ""} className="pole" spellCheck={false} />
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button className="przycisk" type="submit" disabled={trwa}>
          {trwa ? "Zapisuję i łączę się z serwerem…" : serwer ? "Zapisz i przetestuj" : "Zapisz i przetestuj połączenie"}
        </button>
        <span className="text-[13px] text-[var(--color-tekst-3)]">
          Hasło szyfrujemy przed zapisem i nigdy nie pokazujemy go ponownie.
        </span>
      </div>
    </form>
  );
}
