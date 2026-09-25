/** Pola formularza ze spójną etykietą, podpowiedzią i komunikatem błędu. */
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Field({ label, htmlFor, hint, error, children, className = "" }: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="etykieta mb-1.5 block">{label}</label>
      {children}
      {error ? <p className="tekst-meta mt-1.5 !text-[var(--color-blad)]">{error}</p> : hint ? <p className="tekst-meta mt-1.5">{hint}</p> : null}
    </div>
  );
}
export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) { return <input className={`pole ${className}`} {...props} />; }
export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) { return <select className={`pole ${className}`} {...props} />; }
export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea className={`pole ${className}`} {...props} />; }
