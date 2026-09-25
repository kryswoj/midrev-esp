"use client";

import { useActionState, useState } from "react";
import { BladFormularza } from "../../../../blad-formularza";
import type { StanFormularza } from "../../../../formularze";
import { usunDaneAkcja } from "./akcje";
import { FRAZA_POTWIERDZENIA } from "./stale";

/**
 * Usunięcie danych osoby (FR22): operacja nieodwracalna, więc wymaga wpisania
 * frazy z ręki, a przycisk do tego czasu stoi zablokowany Z WIDOCZNYM POWODEM
 * obok (kanon: nigdy sam wyszarzony przycisk).
 *
 * useActionState, nie redirect z `?blad=`: błąd wraca przy polu i nie kasuje
 * wpisanego powodu żądania (audyt UX B4).
 */
export function FormularzUsunieciaDanych({
  tenantId,
  profileId,
  juzUsuniete,
}: {
  tenantId: string;
  profileId: string;
  juzUsuniete: boolean;
}) {
  const [stan, akcja, wTrakcie] = useActionState<StanFormularza | undefined, FormData>(
    usunDaneAkcja,
    undefined,
  );
  const [fraza, setFraza] = useState(stan?.wartosci?.potwierdzenie ?? "");
  const pasuje = fraza.trim().toUpperCase() === FRAZA_POTWIERDZENIA;
  const zablokowany = juzUsuniete || !pasuje || wTrakcie;

  const powodBlokady = juzUsuniete
    ? "Dane tej osoby zostały już usunięte — nie ma czego usuwać drugi raz."
    : !pasuje
      ? `Przycisk odblokuje się po wpisaniu ${FRAZA_POTWIERDZENIA} w polu powyżej.`
      : wTrakcie
        ? "Trwa usuwanie danych."
        : null;

  return (
    <form action={akcja} className="space-y-4">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="profileId" value={profileId} />

      <BladFormularza blad={stan?.blad} />

      <label className="block">
        <span className="etykieta mb-1.5 block">
          Powód albo numer żądania (trafi do logu)
        </span>
        <input
          name="powod"
          className="pole"
          defaultValue={stan?.wartosci?.powod ?? ""}
          placeholder="np. mail z 22.09.2026"
          disabled={juzUsuniete}
        />
      </label>

      <label className="block">
        <span className="etykieta mb-1.5 block">
          Wpisz {FRAZA_POTWIERDZENIA}, żeby potwierdzić
        </span>
        <input
          name="potwierdzenie"
          className="pole"
          autoComplete="off"
          value={fraza}
          onChange={(z) => setFraza(z.target.value)}
          placeholder={FRAZA_POTWIERDZENIA}
          disabled={juzUsuniete}
        />
      </label>

      <div className="flex flex-col gap-2">
        {/* akcja nieodwracalna ma własny wariant, żeby różniła się wyglądem,
            zanim ktoś ją kliknie (kanon „Dzień”) */}
        <button
          className="przycisk przycisk-niebezpieczny w-full justify-center"
          type="submit"
          disabled={zablokowany}
        >
          {wTrakcie ? "Usuwam…" : "Usuń dane osobowe"}
        </button>
        {powodBlokady ? (
          <span className="tekst-pomocniczy">
            {powodBlokady}
          </span>
        ) : (
          <span className="tekst-pomocniczy font-medium !text-[var(--color-blad)]">
            Operacji nie da się cofnąć.
          </span>
        )}
      </div>
    </form>
  );
}
