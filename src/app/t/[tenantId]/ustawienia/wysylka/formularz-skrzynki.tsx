"use client";

import { useActionState, useState } from "react";
import { BladFormularza } from "../../../../blad-formularza";
import { zapiszSkrzynkeAkcja } from "./akcje";

/** To, co formularz wie o zapisanej skrzynce. Bez hasła i bez szyfrogramu. */
export interface SkrzynkaDoFormularza {
  host: string;
  port: number;
  bezpieczenstwo: string;
  uzytkownik: string;
  hasloUstawione: boolean;
  skrzynka: string;
}

const PORT_DLA_TRYBU: Record<string, string> = { tls: "993", starttls: "143", none: "143" };

/**
 * Formularz skrzynki zwrotnej (IMAP). Hasło: nigdy nie przychodzi z serwera, puste pole
 * zostawia zapisane, po błędzie pole jest puste i komunikat o tym mówi (jak przy SMTP).
 */
export function FormularzSkrzynki({
  tenantId,
  skrzynka,
  podpowiedzUzytkownika,
}: {
  tenantId: string;
  skrzynka: SkrzynkaDoFormularza | null;
  podpowiedzUzytkownika: string;
}) {
  const [stan, akcja, trwa] = useActionState(zapiszSkrzynkeAkcja, undefined);
  const w = stan?.wartosci;
  const [tryb, ustawTryb] = useState(w?.bezpieczenstwo ?? skrzynka?.bezpieczenstwo ?? "tls");
  const [port, ustawPort] = useState(w?.port ?? String(skrzynka?.port ?? 993));
  const [zmienHaslo, ustawZmienHaslo] = useState(!skrzynka?.hasloUstawione);

  return (
    <form action={akcja} className="space-y-4">
      <input type="hidden" name="tenantId" value={tenantId} />
      <BladFormularza blad={stan?.blad} />
      <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
        <label className="block">
          <span className="etykieta mb-1.5 block">Serwer IMAP</span>
          <input name="host" required placeholder="imap.twojadomena.pl" defaultValue={w?.host ?? skrzynka?.host ?? ""} className="pole" autoComplete="off" spellCheck={false} />
        </label>
        <label className="block">
          <span className="etykieta mb-1.5 block">Port</span>
          <input name="port" required inputMode="numeric" value={port} onChange={(e) => ustawPort(e.target.value)} className="pole liczba" />
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="etykieta mb-1.5 block">Szyfrowanie</span>
          <select
            name="bezpieczenstwo"
            value={tryb}
            onChange={(e) => {
              ustawTryb(e.target.value);
              if (["143", "993"].includes(port)) ustawPort(PORT_DLA_TRYBU[e.target.value]);
            }}
            className="pole"
          >
            <option value="tls">TLS od początku połączenia (port 993)</option>
            <option value="starttls">STARTTLS (port 143)</option>
            <option value="none">Brak szyfrowania (tylko serwer testowy)</option>
          </select>
        </label>
        <label className="block">
          <span className="etykieta mb-1.5 block">Folder</span>
          <input name="skrzynka" placeholder="INBOX" defaultValue={w?.skrzynka ?? skrzynka?.skrzynka ?? "INBOX"} className="pole" autoComplete="off" spellCheck={false} />
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="etykieta mb-1.5 block">Użytkownik</span>
          <input name="uzytkownik" required placeholder={podpowiedzUzytkownika || "zwykle pełny adres e-mail"} defaultValue={w?.uzytkownik ?? skrzynka?.uzytkownik ?? ""} className="pole" autoComplete="off" spellCheck={false} />
        </label>
        <div className="block">
          <span className="etykieta mb-1.5 block">Hasło</span>
          {zmienHaslo ? (
            <>
              <input name="haslo" type="password" placeholder={skrzynka?.hasloUstawione ? "nowe hasło" : "hasło do skrzynki albo hasło aplikacji"} className="pole" autoComplete="new-password" />
              {skrzynka?.hasloUstawione ? (
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
            </div>
          )}
          {stan?.blad ? (
            <span className="mt-1 block text-[12px] text-[var(--color-tekst-3)]">Hasło nie wraca po błędzie — wpisz je ponownie, jeśli było zmieniane.</span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="przycisk" type="submit" disabled={trwa}>
          {trwa ? "Zapisuję i łączę się ze skrzynką…" : "Zapisz i przetestuj skrzynkę"}
        </button>
        <span className="text-[13px] text-[var(--color-tekst-3)]">Hasło szyfrujemy przed zapisem i nigdy nie pokazujemy go ponownie.</span>
      </div>
    </form>
  );
}
