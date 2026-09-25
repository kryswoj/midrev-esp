"use client";

import { useFormStatus } from "react-dom";

/** Przycisk formularza z opisem trwającej akcji — DNS i SMTP potrafią myśleć kilka sekund. */
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
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`przycisk ${wariant} ${maly ? "przycisk-maly" : ""}`}>
      {pending ? trwa : children}
    </button>
  );
}
