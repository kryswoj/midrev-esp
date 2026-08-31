"use client";

import { useState } from "react";

// Mały przycisk kopiowania do schowka (audyt P3): link akceptacji operator
// przekazuje klientowi ręcznie, więc ma go dostać jednym kliknięciem.
export function PrzyciskKopiuj({ tekst }: { tekst: string }) {
  const [skopiowano, setSkopiowano] = useState(false);

  return (
    <button
      type="button"
      className="przycisk przycisk-wtorny shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(tekst);
          setSkopiowano(true);
          setTimeout(() => setSkopiowano(false), 2000);
        } catch {
          // brak uprawnień do schowka (np. http bez TLS) - link i tak jest
          // widoczny obok, operator zaznaczy go ręcznie
        }
      }}
    >
      {skopiowano ? "Skopiowano" : "Kopiuj"}
    </button>
  );
}
