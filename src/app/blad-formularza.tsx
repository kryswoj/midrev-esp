"use client";

// Komunikat błędu renderowany PRZY formularzu, z którego przyszedł błąd
// (audyt B4: baner na innej stronie + pusty formularz kasował pracę operatora).
// Czysto prezentacyjny; client, bo używają go formularze z useActionState.
export function BladFormularza({ blad }: { blad?: string }) {
  if (!blad) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-[var(--color-blad)] bg-[var(--color-blad-tlo)] px-3 py-2 text-[12px] leading-[17px] text-[var(--color-blad)]"
    >
      {blad}
    </p>
  );
}
