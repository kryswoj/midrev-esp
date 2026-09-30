/** Pusty stan z jedną ikoną, krótkim wyjaśnieniem i pojedynczą akcją. */
import type { ReactNode } from "react";
import { Icon, type NazwaIkony } from "./ikona";

export function EmptyState({ icon = "dokument", title, description, action, inTable = false }: {
  icon?: NazwaIkony;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  inTable?: boolean;
}) {
  return (
    <div className={`pusty-stan ${inTable ? "pusty-stan-w-tabeli" : ""}`}>
      <span className="mb-1 grid h-11 w-11 place-items-center rounded-full bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]">
        <Icon name={icon} size={21} />
      </span>
      <h3>{title}</h3>
      <div className="tekst-pomocniczy">{description}</div>
      {action}
    </div>
  );
}
