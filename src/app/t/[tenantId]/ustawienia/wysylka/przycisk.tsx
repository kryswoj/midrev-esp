"use client";

import { PrzyciskFormularza } from "../../../../ui/przycisk-formularza";

/**
 * Przycisk formularza z opisem trwającej akcji — DNS i SMTP potrafią myśleć kilka sekund.
 * Stara sygnatura zostaje dla istniejących wywołań; stan „trwa” daje wspólny
 * PrzyciskFormularza (src/app/ui/przycisk-formularza.tsx).
 */
export function PrzyciskAkcji({
  children,
  trwa,
  wariant = "przycisk-wtorny",
  maly = true,
}: {
  children: React.ReactNode;
  trwa: string;
  wariant?: "przycisk-wtorny" | "" | "przycisk-niebezpieczny";
  maly?: boolean;
}) {
  const variant = wariant === "przycisk-wtorny" ? "secondary" : wariant === "przycisk-niebezpieczny" ? "danger" : "primary";
  return (
    <PrzyciskFormularza trwa={trwa} variant={variant} size={maly ? "sm" : "md"}>
      {children}
    </PrzyciskFormularza>
  );
}
