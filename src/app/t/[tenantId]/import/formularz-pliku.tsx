"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Icon } from "../../../ui";

const MAKS_MB = 50;

/**
 * Wybor i wysylka pliku CSV. XMLHttpRequest zamiast fetch, bo tylko XHR daje postep
 * wysylki, a przy 50 MB pasek postepu to roznica miedzy "dziala" a "zawiesilo sie".
 * Plik idzie jako surowe cialo; nazwa w naglowku (odkazana po stronie serwera).
 */
export function FormularzPliku({
  url,
  dalej,
  listaId,
  etykieta,
  opis,
}: {
  url: string;
  /** cel po sukcesie; "{jobId}" zostaje podmienione na identyfikator z odpowiedzi */
  dalej: string;
  listaId?: string | null;
  etykieta: string;
  opis: string;
}) {
  const router = useRouter();
  const wejscie = useRef<HTMLInputElement>(null);
  const [plik, ustawPlik] = useState<File | null>(null);
  const [blad, ustawBlad] = useState<string | null>(null);
  const [postep, ustawPostep] = useState<number | null>(null);
  const [przeciaganie, ustawPrzeciaganie] = useState(false);

  const przyjmij = (kandydat: File | null) => {
    ustawBlad(null);
    if (!kandydat) return;
    if (!/\.csv$/i.test(kandydat.name) && kandydat.type !== "text/csv") {
      ustawBlad("To nie jest plik CSV. Wyeksportuj listę z Klaviyo jako CSV.");
      return;
    }
    if (kandydat.size > MAKS_MB * 1024 * 1024) {
      ustawBlad(`Plik ma ${(kandydat.size / 1024 / 1024).toFixed(1)} MB, a limit to ${MAKS_MB} MB. Podziel eksport na kilka list.`);
      return;
    }
    if (kandydat.size === 0) {
      ustawBlad("Plik jest pusty.");
      return;
    }
    ustawPlik(kandydat);
  };

  const wyslij = () => {
    if (!plik) return;
    ustawBlad(null);
    ustawPostep(0);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("x-nazwa-pliku", encodeURIComponent(plik.name));
    xhr.setRequestHeader("content-type", "text/csv");
    if (listaId) xhr.setRequestHeader("x-lista-id", listaId);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) ustawPostep(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => {
      ustawPostep(null);
      ustawBlad("Połączenie zostało przerwane. Spróbuj ponownie.");
    };
    xhr.onload = () => {
      ustawPostep(null);
      let odpowiedz: { ok?: boolean; blad?: string; jobId?: string } = {};
      try {
        odpowiedz = JSON.parse(xhr.responseText);
      } catch {
        ustawBlad(xhr.status === 200 ? "Sesja wygasła. Zaloguj się ponownie." : `Serwer odpowiedział błędem ${xhr.status}.`);
        return;
      }
      if (!odpowiedz.ok || !odpowiedz.jobId) {
        ustawBlad(odpowiedz.blad ?? "Nie udało się przyjąć pliku.");
        return;
      }
      router.push(dalej.replace("{jobId}", odpowiedz.jobId));
    };
    xhr.send(plik);
  };

  const rozmiar = plik ? (plik.size >= 1024 * 1024 ? `${(plik.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(plik.size / 1024))} KB`) : "";

  return (
    <div className="space-y-4">
      <div
        role="button"
        tabIndex={0}
        aria-label={etykieta}
        onClick={() => wejscie.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            wejscie.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          ustawPrzeciaganie(true);
        }}
        onDragLeave={() => ustawPrzeciaganie(false)}
        onDrop={(e) => {
          e.preventDefault();
          ustawPrzeciaganie(false);
          przyjmij(e.dataTransfer.files?.[0] ?? null);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[10px] border-2 border-dashed px-6 py-10 text-center transition-colors ${
          przeciaganie ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)]" : "border-[var(--color-linia-mocna)] bg-[var(--color-powierzchnia-2)] hover:border-[var(--color-akcent)]"
        }`}
      >
        <span className="grid h-11 w-11 place-items-center rounded-full bg-white text-[var(--color-akcent)] shadow-[var(--cien-karta)]">
          <Icon name="dokument" size={21} />
        </span>
        {plik ? (
          <>
            <div className="text-[14px] font-semibold text-[var(--color-tekst)]">{plik.name}</div>
            <div className="tekst-pomocniczy">{rozmiar} · kliknij, żeby wybrać inny plik</div>
          </>
        ) : (
          <>
            <div className="text-[14px] font-semibold text-[var(--color-tekst)]">{etykieta}</div>
            <div className="tekst-pomocniczy max-w-[46ch]">{opis}</div>
          </>
        )}
        <input
          ref={wejscie}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => przyjmij(e.target.files?.[0] ?? null)}
        />
      </div>

      {blad ? (
        <p role="alert" className="rounded-md border border-[var(--color-blad)] bg-[var(--color-blad-tlo)] px-3 py-2 text-[12px] leading-[17px] text-[var(--color-blad)]">
          {blad}
        </p>
      ) : null}

      {postep !== null ? (
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[13px] text-[var(--color-tekst-2)]">
            <span>{postep < 100 ? "Wysyłanie pliku…" : "Sprawdzanie kolumn i liczenie wierszy…"}</span>
            <span className="liczba">{postep}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--color-powierzchnia-2)]" role="progressbar" aria-valuenow={postep} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-[var(--color-akcent)] transition-[width]" style={{ width: `${postep}%` }} />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="przycisk" disabled={!plik} onClick={wyslij}>
            Wgraj i przejdź do mapowania
          </button>
          {!plik ? <span className="tekst-meta !text-[var(--color-tekst-2)]">Najpierw wybierz plik CSV.</span> : null}
        </div>
      )}
    </div>
  );
}
