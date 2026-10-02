"use client";

/**
 * Strażnik wersji panelu (audyt UX 02.10, P0-1 „stara karta po wdrożeniu”).
 *
 * Karta zna wersję, z którą została zbudowana (process.env.ESP_WERSJA, wkompilowane
 * z pliku REVISION w next.config.ts). Co 5 minut, po powrocie do karty i przy jej
 * fokusie pyta /api/wersja. Gdy serwer ma inną wersję, pokazuje stały pasek
 * „Jest nowa wersja panelu” z przyciskiem „Odśwież”.
 *
 * Czego celowo NIE robi (review: pętla odświeżania, utrata danych formularza):
 * - nigdy nie przeładowuje strony sam: przeładowanie jest wyłącznie po kliknięciu,
 *   więc nie ma jak wpaść w pętlę ani skasować tego, co ktoś właśnie wpisuje,
 * - nie blokuje wysyłki formularzy (zapis może się udać; jeśli nie, error boundary
 *   pokaże „Panel został zaktualizowany. Odśwież stronę.”),
 * - każdą odpowiedź inną niż 200 z polem `wersja` (brak sesji, 5xx w trakcie restartu,
 *   przekierowanie na logowanie, sieć) traktuje jako „nie wiadomo” i nic nie zmienia.
 * Bez wersji w buildzie (dev, testy) nie robi nic.
 */
import { useEffect, useRef, useState } from "react";

const CO_ILE_MS = 5 * 60 * 1000;
const NAJRZADZIEJ_MS = 30 * 1000;

async function wersjaSerwera(): Promise<string | null> {
  try {
    const odp = await fetch("/api/wersja", { cache: "no-store", credentials: "same-origin", redirect: "manual" });
    if (odp.status !== 200 || !(odp.headers.get("content-type") ?? "").includes("application/json")) return null;
    const dane: unknown = await odp.json();
    const wersja = (dane as { wersja?: unknown })?.wersja;
    return typeof wersja === "string" && wersja ? wersja : null;
  } catch {
    return null;
  }
}

export function StraznikWersji() {
  const wersjaKarty = process.env.ESP_WERSJA ?? "";
  const [nowa, ustawNowa] = useState(false);
  const ostatnio = useRef(0);

  useEffect(() => {
    if (!wersjaKarty) return;
    let aktywny = true;
    const sprawdz = async (wymus = false) => {
      const teraz = Date.now();
      if (!wymus && teraz - ostatnio.current < NAJRZADZIEJ_MS) return;
      ostatnio.current = teraz;
      const serwer = await wersjaSerwera();
      // pasek znika sam, gdy serwer wróci do wersji karty (np. automatyczny rollback deployu)
      if (aktywny && serwer) ustawNowa(serwer !== wersjaKarty);
    };
    const naWidocznosc = () => { if (document.visibilityState === "visible") void sprawdz(); };
    const naFokus = () => void sprawdz();
    const zegar = window.setInterval(() => { if (document.visibilityState === "visible") void sprawdz(true); }, CO_ILE_MS);
    document.addEventListener("visibilitychange", naWidocznosc);
    window.addEventListener("focus", naFokus);
    return () => {
      aktywny = false;
      window.clearInterval(zegar);
      document.removeEventListener("visibilitychange", naWidocznosc);
      window.removeEventListener("focus", naFokus);
    };
  }, [wersjaKarty]);

  if (!nowa) return null;
  return (
    <div role="status" className="straznik-wersji">
      <span className="min-w-0 flex-1">
        <strong className="font-semibold">Jest nowa wersja panelu.</strong>{" "}
        Odśwież stronę, zanim zapiszesz kolejne zmiany.
      </span>
      <button type="button" className="przycisk przycisk-maly" onClick={() => window.location.reload()}>
        Odśwież
      </button>
    </div>
  );
}
