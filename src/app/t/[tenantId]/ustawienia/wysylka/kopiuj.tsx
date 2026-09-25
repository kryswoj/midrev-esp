"use client";

import { useState } from "react";

/**
 * Kopiowanie wartości rekordu DNS jednym kliknięciem (wzorzec Klaviyo: przycisk przy
 * każdej komórce Host i Wartość). Ręczne zaznaczanie długiej wartości TXT to najczęstsze
 * źródło uciętego rekordu. Stan „skopiowano" jest słowem, nie samym kolorem.
 */
export function Kopiuj({ wartosc, etykieta }: { wartosc: string; etykieta: string }) {
  const [stan, ustawStan] = useState<"" | "ok" | "blad">("");
  return (
    <button
      type="button"
      className="przycisk przycisk-wtorny przycisk-maly shrink-0"
      aria-label={`Kopiuj ${etykieta}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(wartosc);
          ustawStan("ok");
        } catch {
          // schowek bywa niedostępny (http bez TLS): mówimy to, zamiast udawać sukces
          ustawStan("blad");
        }
        setTimeout(() => ustawStan(""), 2000);
      }}
    >
      {stan === "ok" ? "Skopiowano" : stan === "blad" ? "Zaznacz ręcznie" : "Kopiuj"}
    </button>
  );
}
