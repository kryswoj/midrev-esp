/** Zestaw powierzchni karty z przewiewnym nagłówkiem, treścią i stopką. */
import type { HTMLAttributes, ReactNode } from "react";

export function Card({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`karta overflow-hidden ${className}`} {...props} />;
}

export function CardHeader({
  title,
  description,
  action,
  actionPosition = "center",
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  actionPosition?: "center" | "title";
  className?: string;
}) {
  if (actionPosition === "title") {
    return (
      <header className={`karta-naglowek ${className}`}>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-4 max-md:flex-wrap">
            <h2>{title}</h2>
            {action ? <div className="karta-akcja shrink-0 max-md:w-full max-md:justify-start">{action}</div> : null}
          </div>
          {description ? <div className="karta-opis">{description}</div> : null}
        </div>
      </header>
    );
  }

  return (
    <header className={`karta-naglowek ${className}`}>
      <div className="karta-naglowek-tresc min-w-0 flex-1">
        <h2>{title}</h2>
        {description ? <div className="karta-opis">{description}</div> : null}
      </div>
      {action ? <div className="karta-akcja shrink-0">{action}</div> : null}
    </header>
  );
}

export function CardBody({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-6 max-md:p-4 ${className}`} {...props} />;
}

export function CardFooter({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <footer className={`karta-stopka ${className}`} {...props} />;
}
