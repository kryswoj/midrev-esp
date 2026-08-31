/**
 * Nagłówek strony: 48px, nie 118px. Sticky nagłówek zabierający jedną szóstą ekranu
 * w narzędziu, w którym siedzi się godzinami, to zmarnowane miejsce na dane.
 * Opis strony schodzi pod nagłówek jako zwijalna notka, nie jako blok tekstu na górze.
 */
export function Naglowek({
  tytul,
  opis,
  akcja,
}: {
  tytul: string;
  opis?: string;
  akcja?: React.ReactNode;
}) {
  return (
    <>
      <header className="sticky top-0 z-10 flex h-11 items-center justify-between gap-4 border-b border-[var(--color-linia)] bg-[var(--color-app)] px-4">
        <h1>{tytul}</h1>
        {akcja}
      </header>
      {opis ? (
        <details className="border-b border-[var(--color-linia-0)] px-4 py-2">
          <summary className="cursor-pointer list-none text-[12px] text-[var(--color-tekst-3)] marker:hidden">
            <span className="underline decoration-dotted underline-offset-2">
              Jak to działa
            </span>
          </summary>
          <p className="mt-2 max-w-[74ch] text-[12px] leading-[18px] text-[var(--color-tekst-3)]">{opis}</p>
        </details>
      ) : null}
    </>
  );
}

export function Komunikat({ ok, blad }: { ok?: string; blad?: string }) {
  if (!ok && !blad) return null;
  return (
    <div className="px-4 pt-3">
      <div
        className="flex items-center gap-2 rounded-md px-3 py-2 text-[13px]"
        style={{
          background: blad ? "var(--color-blad-tlo)" : "var(--color-ok-tlo)",
          border: `1px solid ${blad ? "var(--color-blad)" : "var(--color-ok-ramka)"}`,
          color: blad ? "var(--color-blad)" : "var(--color-ok)",
        }}
        role="status"
      >
        <span className="font-medium">{blad ? "Błąd" : "Gotowe"}</span>
        <span className="text-[var(--color-tekst-2)]">{blad ?? ok}</span>
      </div>
    </div>
  );
}

/** Wąski pasek metryk. Zastępuje siedem dużych kafelków, które zajmowały pół ekranu. */
export function PasekMetryk({
  pozycje,
}: {
  pozycje: { etykieta: string; wartosc: string; opis?: string }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-[var(--color-linia)] bg-[var(--color-linia)] sm:grid-cols-4">
      {pozycje.map((p) => (
        <div key={p.etykieta} className="bg-[var(--color-powierzchnia)] px-3 py-2.5">
          <div className="etykieta">{p.etykieta}</div>
          <div className="liczba mt-1 text-[15px] font-medium leading-[20px]">
            {p.wartosc}
          </div>
          {p.opis ? <div className="mt-0.5 text-[12px] text-[var(--color-tekst-3)]">{p.opis}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** Metryka wiodąca: jedna liczba, która ma być pierwszą rzeczą na ekranie. */
export function MetrykaWiodaca({
  etykieta,
  wartosc,
  opis,
  dodatek,
}: {
  etykieta: string;
  wartosc: string;
  opis?: string;
  dodatek?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 rounded-md border border-[var(--color-linia)] bg-[var(--color-powierzchnia)] px-4 py-3.5">
      <div>
        <div className="etykieta">{etykieta}</div>
        <div className="wielkosc-hero mt-1">{wartosc}</div>
        {opis ? <div className="mt-1 text-[12px] text-[var(--color-tekst-3)]">{opis}</div> : null}
      </div>
      {dodatek}
    </div>
  );
}

export function Kafelek({
  etykieta,
  wartosc,
  opis,
}: {
  etykieta: string;
  wartosc: string;
  opis?: string;
}) {
  return (
    <div className="karta px-3 py-2.5">
      <div className="etykieta">{etykieta}</div>
      <div className="wielkosc mt-1">{wartosc}</div>
      {opis ? <div className="mt-1 text-[12px] text-[var(--color-tekst-3)]">{opis}</div> : null}
    </div>
  );
}
