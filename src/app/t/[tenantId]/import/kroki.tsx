import Link from "next/link";
import { Icon } from "../../../ui";

/**
 * Pasek czterech krokow kreatora. Krok zrobiony jest linkiem (mozna wrocic i poprawic,
 * dopoki import nie wystartowal), biezacy jest wyrozniony, przyszly nieaktywny.
 */
export const KROKI = [
  { klucz: "plik", etykieta: "Plik" },
  { klucz: "mapowanie", etykieta: "Mapowanie kolumn" },
  { klucz: "supresje", etykieta: "Wypisy i skargi" },
  { klucz: "podglad", etykieta: "Podgląd i start" },
] as const;

export type KrokKreatora = (typeof KROKI)[number]["klucz"];

export function Kroki({ biezacy, tenantId, jobId, zablokowane = false }: { biezacy: KrokKreatora; tenantId: string; jobId?: string; zablokowane?: boolean }) {
  const indeks = KROKI.findIndex((k) => k.klucz === biezacy);
  const hrefKroku = (klucz: KrokKreatora) => {
    if (klucz === "plik") return `/t/${tenantId}/import`;
    if (!jobId) return null;
    return `/t/${tenantId}/import/${jobId}/${klucz}`;
  };
  return (
    <ol className="karta mb-4 grid grid-cols-2 gap-0 overflow-hidden md:grid-cols-4" aria-label="Kroki importu">
      {KROKI.map((k, i) => {
        const zrobiony = i < indeks;
        const aktywny = i === indeks;
        const href = zrobiony && !zablokowane ? hrefKroku(k.klucz) : null;
        const tresc = (
          <>
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${
                zrobiony ? "bg-[var(--color-ok)] text-white" : aktywny ? "bg-[var(--color-akcent)] text-white" : "border border-[var(--color-linia-mocna)] bg-white text-[var(--color-tekst-3)]"
              }`}
            >
              {zrobiony ? <Icon name="check" size={14} strokeWidth={2.5} /> : i + 1}
            </span>
            <span className={`text-[13px] leading-[18px] ${aktywny ? "font-semibold text-[var(--color-tekst)]" : zrobiony ? "font-medium text-[var(--color-tekst-2)]" : "font-medium text-[var(--color-tekst-3)]"}`}>
              {k.etykieta}
            </span>
          </>
        );
        const klasy = `flex items-center gap-3 px-4 py-3.5 border-b md:border-b-0 md:border-r border-[var(--color-linia-0)] last:border-r-0 ${aktywny ? "bg-[var(--color-akcent-tlo)]" : ""}`;
        return (
          <li key={k.klucz} aria-current={aktywny ? "step" : undefined} className="min-w-0">
            {href ? <Link href={href} className={`${klasy} hover:bg-[var(--color-powierzchnia-2)]`}>{tresc}</Link> : <div className={klasy}>{tresc}</div>}
          </li>
        );
      })}
    </ol>
  );
}
