/** Przycisk akcji działający jako button albo prawdziwy link Next.js. */
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Wariant = "primary" | "secondary" | "danger" | "ghost";
type Rozmiar = "sm" | "md";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  children: ReactNode;
  href?: string;
  variant?: Wariant;
  size?: Rozmiar;
  className?: string;
  powodBlokady?: string;
}

export function Button({
  children,
  href,
  variant = "primary",
  size = "md",
  className = "",
  disabled = false,
  powodBlokady,
  type = "button",
  ...buttonProps
}: ButtonProps) {
  const zablokowany = disabled || Boolean(powodBlokady);
  const klasy = [
    "przycisk",
    variant === "secondary" ? "przycisk-wtorny" : "",
    variant === "danger" ? "przycisk-niebezpieczny" : "",
    variant === "ghost" ? "przycisk-wtorny border-transparent bg-transparent shadow-none" : "",
    size === "sm" ? "przycisk-maly" : "",
    className,
  ].filter(Boolean).join(" ");

  const kontrolka = href && !zablokowany ? (
    <Link href={href} className={klasy}>{children}</Link>
  ) : href ? (
    <span className={klasy} aria-disabled="true">{children}</span>
  ) : (
    <button {...buttonProps} type={type} disabled={zablokowany} className={klasy}>{children}</button>
  );

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {kontrolka}
      {zablokowany && powodBlokady ? (
        <span className="tekst-meta max-w-[34ch] !text-[var(--color-tekst-2)]">
          {powodBlokady}
        </span>
      ) : null}
    </span>
  );
}
