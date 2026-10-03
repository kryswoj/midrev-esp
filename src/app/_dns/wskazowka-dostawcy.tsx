/** „Gdzie to wpisać" — krótka instrukcja dla rozpoznanego dostawcy DNS. */
import type { DostawcaDns } from "../../domain/email/dostawcy-dns";
import { Icon } from "../ui";

export function WskazowkaDostawcy({ dostawca, strefa, jedenWpis = false }: { dostawca: DostawcaDns; strefa: string; jedenWpis?: boolean }) {
  const znany = dostawca.klucz !== "inny";
  return (
    <div className="karta-plaska flex items-start gap-3 p-4">
      <Icon name="info" size={18} className="mt-0.5 shrink-0 text-[var(--color-akcent)]" />
      <div className="min-w-0 space-y-1.5 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
        <p className="font-semibold text-[var(--color-tekst)]">
          {znany ? `Domena ${strefa} jest w ${dostawca.nazwa}` : `Gdzie wpisać rekordy dla ${strefa}`}
        </p>
        <p>{dostawca.gdzie}</p>
        {dostawca.uwaga && !jedenWpis ? <p className="text-[var(--color-tekst)]">{dostawca.uwaga}</p> : null}
        <p>
          {jedenWpis
            ? "Dodaj nowy rekord typu NS. Istniejących wpisów nie zmieniaj: strona i zwykła poczta działają dalej bez zmian."
            : "Dodaj każdy rekord z tabeli jako osobny wpis. Niczego nie usuwaj — Twoja zwykła poczta działa dalej bez zmian."}
        </p>
        {dostawca.link ? (
          <a href={dostawca.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-[var(--color-akcent)] hover:underline">
            Otwórz panel {dostawca.nazwa}
          </a>
        ) : null}
      </div>
    </div>
  );
}
