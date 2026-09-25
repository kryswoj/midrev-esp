/** Plakietka statusu z tekstem i kształtem spełniającym NFR33. */
import type { ReactNode } from "react";

type Ton = "ok" | "uwaga" | "blad" | "szkic" | "nieaktywna" | "neutral";

export function Badge({ children, ton = "neutral", className = "" }: { children: ReactNode; ton?: Ton; className?: string }) {
  const odmiana = ton === "neutral" ? "" : `plakietka-${ton}`;
  return <span className={["plakietka", odmiana, className].filter(Boolean).join(" ")}>{children}</span>;
}
