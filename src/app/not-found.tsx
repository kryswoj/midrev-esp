import Link from "next/link";

/**
 * Własna 404 zamiast domyślnej, angielskiej strony Next.js na białym tle:
 * błąd też jest częścią panelu i mówi językiem panelu.
 */
export default function NieZnaleziono() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-plotno)] px-6">
      <div className="karta max-w-md p-6">
        <p className="etykieta mb-2">404</p>
        <h1>Nie ma takiej strony</h1>
        <p className="mt-2 text-[13px] text-[var(--color-tekst-2)]">
          Adres jest nieaktualny albo wskazuje na sklep lub kampanię, której już nie ma.
        </p>
        <Link href="/" className="przycisk przycisk-wtorny mt-4">
          Wróć do listy sklepów
        </Link>
      </div>
    </main>
  );
}
