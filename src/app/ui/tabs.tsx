/** Zakładki są wyłącznie linkami do istniejących tras, bez atrap interakcji. */
import Link from "next/link";

export function Tabs({ items, className = "" }: { items: { href: string; label: string; active?: boolean }[]; className?: string }) {
  return (
    <nav aria-label="Zakładki" className={`flex gap-1 overflow-x-auto border-b border-[var(--color-linia)] ${className}`}>
      {items.map((item) => (
        <Link key={item.href} href={item.href} aria-current={item.active ? "page" : undefined} className={`relative whitespace-nowrap px-3 py-3 text-[14px] leading-5 font-medium ${item.active ? "text-[var(--color-akcent)] after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--color-akcent)]" : "text-[var(--color-tekst-2)] hover:text-[var(--color-tekst)]"}`}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
