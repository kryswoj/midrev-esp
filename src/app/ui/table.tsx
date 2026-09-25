/** Lekkie elementy tabeli z lokalnym przewijaniem i kolumnami liczbowymi. */
import type { HTMLAttributes, TableHTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from "react";

export function Table({ className = "", ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <div className="max-w-full overflow-x-auto"><table className={`tabela ${className}`} {...props} /></div>;
}
export function THead(props: HTMLAttributes<HTMLTableSectionElement>) { return <thead {...props} />; }
export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) { return <tbody {...props} />; }
export function Th({ num = false, className = "", ...props }: ThHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return <th className={`${num ? "num" : ""} ${className}`} {...props} />;
}
export function Td({ num = false, className = "", ...props }: TdHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return <td className={`${num ? "num liczba" : ""} ${className}`} {...props} />;
}

export function TableCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`karta overflow-hidden ${className}`}>{children}</section>;
}
