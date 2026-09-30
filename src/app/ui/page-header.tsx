/** Nagłówek strony z okruszkami, podtytułem i miejscem na realne akcje. */
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "./ikona";

export function PageHeader({
  title,
  subtitle,
  back,
  actions,
  leading,
  help,
  actionsFullWidthOnMobile = false,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  back?: { href: string; label: string };
  actions?: ReactNode;
  leading?: ReactNode;
  help?: ReactNode;
  actionsFullWidthOnMobile?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="pb-6 pt-6 md:pb-8 md:pt-8">
      {back ? (
        <Link href={back.href} className="tekst-pomocniczy mb-4 inline-flex items-center gap-1.5 font-medium hover:!text-[var(--color-akcent)]">
          <Icon name="cofniecie" size={15} />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {leading ? (
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3.5 gap-y-1.5">
            <div className="shrink-0">{leading}</div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1>{title}</h1>
              {help}
            </div>
            {subtitle ? <div className="col-start-2 max-w-[76ch] text-[14px] leading-5 text-[var(--color-tekst-2)]">{subtitle}</div> : null}
          </div>
        ) : (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h1>{title}</h1>{help}</div>
            {subtitle ? <div className="mt-1 max-w-[76ch] text-[14px] leading-5 text-[var(--color-tekst-2)]">{subtitle}</div> : null}
          </div>
        )}
        {actions ? <div className={`flex shrink-0 flex-wrap items-center gap-2 ${actionsFullWidthOnMobile ? "max-md:w-full max-md:[&>*]:w-full" : ""}`}>{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
