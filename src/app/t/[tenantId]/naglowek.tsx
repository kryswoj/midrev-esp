/** Kompatybilne komponenty nagłówka i metryk używane przez wszystkie ekrany. */
import { Alert, Card, Icon, PageHeader, Stat, StatGrid } from "../../ui";

export function Naglowek({ tytul, opis, akcja, podtytul, powrot, oznaczenie, akcjaMobilnaPelna = false }: {
  tytul: string;
  opis?: string;
  akcja?: React.ReactNode;
  podtytul?: React.ReactNode;
  powrot?: { href: string; etykieta: string };
  oznaczenie?: React.ReactNode;
  akcjaMobilnaPelna?: boolean;
}) {
  const dlugiOpis = Boolean(opis && opis.length > 160);
  return (
    <PageHeader
      title={tytul}
      subtitle={podtytul ?? (dlugiOpis ? undefined : opis)}
      actions={akcja}
      back={powrot ? { href: powrot.href, label: powrot.etykieta } : undefined}
      leading={oznaczenie}
      help={dlugiOpis ? (
        <details className="group relative z-20">
          <summary className="grid h-7 w-7 cursor-pointer list-none place-items-center rounded-full text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-akcent)]" aria-label="Informacje o tym ekranie">
            <Icon name="info" size={16} />
          </summary>
          <div className="tekst-pomocniczy fixed left-4 right-4 top-32 w-auto rounded-[10px] border border-[var(--color-linia)] bg-white p-4 font-normal tracking-normal shadow-[var(--cien-uniesiony)] md:absolute md:left-0 md:right-auto md:top-9 md:w-[min(520px,calc(100vw-32px))]">
            {opis}
          </div>
        </details>
      ) : null}
      actionsFullWidthOnMobile={akcjaMobilnaPelna}
    />
  );
}

export function Komunikat({ ok, blad }: { ok?: string; blad?: string }) {
  if (!ok && !blad) return null;
  return <div className="pb-4"><Alert tone={blad ? "blad" : "ok"} title={blad ? "Błąd" : "Gotowe"}>{blad ?? ok}</Alert></div>;
}

export function PasekMetryk({ pozycje }: { pozycje: { etykieta: string; wartosc: string; opis?: string }[] }) {
  return (
    <div className="pasek-metryk grid grid-cols-2 overflow-hidden rounded-[10px] border border-[var(--color-linia)] bg-white lg:grid-cols-4">
      {pozycje.map((p, i) => <Stat key={p.etykieta} label={p.etykieta} value={p.wartosc} description={p.opis} className={`${i % 2 === 0 ? "border-r" : ""} ${i < 2 ? "border-b lg:border-b-0" : ""} border-[var(--color-linia-0)] lg:border-r lg:last:border-r-0`} />)}
    </div>
  );
}

export function MetrykaWiodaca({ etykieta, wartosc, opis, dodatek }: { etykieta: string; wartosc: string; opis?: string; dodatek?: React.ReactNode }) {
  return <Card><StatGrid><Stat label={etykieta} value={wartosc} description={opis} /><div className="flex items-center justify-end p-6 max-md:p-4">{dodatek}</div></StatGrid></Card>;
}

export function Kafelek({ etykieta, wartosc, opis }: { etykieta: string; wartosc: string; opis?: string }) {
  return <Card><Stat label={etykieta} value={wartosc} description={opis} /></Card>;
}
