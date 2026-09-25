/** Metryki liczbowe układane w responsywną siatkę bez technicznego wyglądu. */
import type { ReactNode } from "react";

export function Stat({
  label,
  value,
  description,
  icon,
  missing = false,
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  missing?: boolean;
  className?: string;
}) {
  return (
    <div className={`min-w-0 px-6 py-6 max-md:px-4 max-md:py-4 ${className}`}>
      <div className="flex items-center gap-2 text-[13px] leading-[18px] font-medium text-[var(--color-tekst-2)]">
        {icon ? <span className="text-[var(--color-tekst-3)]">{icon}</span> : null}
        {label}
      </div>
      <div className={`${missing ? "wielkosc wielkosc-brak" : "wielkosc-hero"} mt-1.5`}>{value}</div>
      {description ? <div className="tekst-pomocniczy mt-1 !text-[var(--color-tekst-3)]">{description}</div> : null}
    </div>
  );
}

export function StatGrid({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`grid divide-y divide-[var(--color-linia-0)] md:grid-cols-2 md:divide-x md:divide-y-0 ${className}`}>{children}</div>;
}
