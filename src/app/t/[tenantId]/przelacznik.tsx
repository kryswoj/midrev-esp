"use client";

/** Działający przełącznik sklepu z natywnym selectem i czytelną oprawą. */
import { useRouter } from "next/navigation";
import { Icon } from "../../ui/ikona";

export function PrzelacznikTenanta({ tenanci, biezacyId, compact = false }: {
  tenanci: { id: string; name: string }[];
  biezacyId: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const biezacy = tenanci.find((tenant) => tenant.id === biezacyId);
  const nazwa = biezacy?.name ?? "Wybierz sklep";
  const inicjal = nazwa.trim().slice(0, 1).toUpperCase() || "S";

  return (
    <label className={`group relative block min-w-0 ${compact ? "flex-1" : "w-full"}`}>
      <span className="sr-only">Sklep</span>
      <span className={`pointer-events-none flex min-h-12 items-center gap-3 rounded-[9px] px-2.5 transition-colors group-hover:bg-[var(--color-powierzchnia-2)] group-focus-within:bg-[var(--color-powierzchnia-2)] group-focus-within:shadow-[0_0_0_2px_var(--color-akcent)] ${compact ? "min-h-9 gap-2 px-2" : ""}`}>
        <span className={`grid shrink-0 place-items-center rounded-[8px] bg-[var(--color-akcent-tlo)] text-[12px] font-semibold text-[var(--color-akcent)] ${compact ? "h-7 w-7" : "h-8 w-8"}`} aria-hidden="true">
          {inicjal}
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 block break-words text-[14px] leading-5 font-semibold text-[var(--color-tekst)]" title={nazwa}>{nazwa}</span>
        </span>
        <Icon name="chevronDown" size={15} className="shrink-0 text-[var(--color-tekst-3)]" />
      </span>
      <select
        aria-label="Zmień sklep"
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
        value={biezacyId}
        onChange={(e) => router.push(`/t/${e.target.value}`)}
      >
        {tenanci.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </label>
  );
}
