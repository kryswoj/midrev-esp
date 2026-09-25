"use client";

import { useActionState } from "react";
import { BladFormularza } from "../../../../blad-formularza";
import { dodajDomeneAkcja } from "./akcje";

/**
 * Dodanie domeny wysyłkowej. Błąd wraca PRZY formularzu, a wpisane wartości zostają
 * w polach (audyt B4). Selektor i mechanizm SPF są opcjonalne na starcie — bez nich
 * sprawdzenie powie wprost, czego nie dało się ocenić.
 */
export function FormularzDomeny({ tenantId }: { tenantId: string }) {
  const [stan, akcja, trwa] = useActionState(dodajDomeneAkcja, undefined);
  const w = stan?.wartosci ?? {};
  return (
    <form action={akcja} className="space-y-4">
      <input type="hidden" name="tenantId" value={tenantId} />
      <BladFormularza blad={stan?.blad} />
      <label className="block">
        <span className="etykieta mb-1.5 block">Domena, z której wysyłasz</span>
        <input name="domena" required placeholder="sklep.pl" defaultValue={w.domena ?? ""} className="pole" autoComplete="off" />
        <span className="mt-1 block text-[12px] text-[var(--color-tekst-3)]">
          Ta sama domena, która stoi w adresie nadawcy (sklep@<b>sklep.pl</b>). Bez https:// i bez www.
        </span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="etykieta mb-1.5 block">Selektor DKIM</span>
          <input name="selektorDkim" placeholder="np. google, default, s1" defaultValue={w.selektorDkim ?? ""} className="pole font-mono text-[13px]" autoComplete="off" />
          <span className="mt-1 block text-[12px] text-[var(--color-tekst-3)]">
            Z panelu serwera pocztowego, w ustawieniach DKIM.
          </span>
        </label>
        <label className="block">
          <span className="etykieta mb-1.5 block">SPF dostawcy serwera (opcjonalnie)</span>
          <input name="mechanizmSpf" placeholder="include:_spf.google.com" defaultValue={w.mechanizmSpf ?? ""} className="pole font-mono text-[13px]" autoComplete="off" />
          <span className="mt-1 block text-[12px] text-[var(--color-tekst-3)]">
            Bez tego sprawdzimy SPF po adresie IP serwera SMTP.
          </span>
        </label>
      </div>
      <button className="przycisk" type="submit" disabled={trwa}>
        {trwa ? "Dodaję i sprawdzam DNS…" : "Dodaj domenę"}
      </button>
    </form>
  );
}
