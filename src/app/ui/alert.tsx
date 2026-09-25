/** Komunikat kontekstowy z ikoną i tonem odpowiadającym znaczeniu. */
import type { ReactNode } from "react";
import { Icon, type NazwaIkony } from "./icon";

const TONY = {
  info: { icon: "info" as NazwaIkony, style: "border-[var(--color-info-ramka)] bg-[var(--color-info-tlo)] text-[var(--color-info)]" },
  uwaga: { icon: "uwaga" as NazwaIkony, style: "border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] text-[var(--color-czeka)]" },
  blad: { icon: "blad" as NazwaIkony, style: "border-[var(--color-blad-ramka)] bg-[var(--color-blad-tlo)] text-[var(--color-blad)]" },
  ok: { icon: "gotowe" as NazwaIkony, style: "border-[var(--color-ok-ramka)] bg-[var(--color-ok-tlo)] text-[var(--color-ok)]" },
};

export function Alert({ tone = "info", title, children, className = "" }: { tone?: keyof typeof TONY; title?: string; children: ReactNode; className?: string }) {
  const config = TONY[tone];
  return (
    <div role={tone === "blad" ? "alert" : "status"} className={`tekst-pomocniczy flex items-start gap-3 rounded-[10px] border px-4 py-3 ${config.style} ${className}`}>
      <Icon name={config.icon} size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 text-[var(--color-tekst-2)]">
        {title ? <div className="mb-0.5 font-semibold text-[var(--color-tekst)]">{title}</div> : null}
        {children}
      </div>
    </div>
  );
}
