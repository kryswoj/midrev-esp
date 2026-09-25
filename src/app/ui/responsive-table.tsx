/** Tabela na desktopie i osobna, priorytetyzowana lista na telefonie. */
import type { HTMLAttributes, ReactNode } from "react";

export function ResponsiveTable({ table, mobile }: { table: ReactNode; mobile: ReactNode }) {
  return (
    <>
      <div className="tabela-responsywna-desktop">{table}</div>
      <div className="lista-mobilna">{mobile}</div>
    </>
  );
}

export function MobileList({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`lista-mobilna ${className}`} {...props} />;
}

export function MobileListItem({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`lista-mobilna-element ${className}`} {...props} />;
}
