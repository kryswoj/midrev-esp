import { redirect } from "next/navigation";
import { aktualnaSesja } from "../../adapters/auth-sesja";
import { FormularzLogowania } from "./formularz";

export const dynamic = "force-dynamic";

// Ekran logowania w kierunku "Noc": jedna karta na plotnie, istniejace klasy
// (.karta, .pole, .przycisk, .etykieta), zero nowych tokenow w globals.css.
// Formularz to komponent klientowy z useActionState - blad nie kasuje e-maila.

export default async function StronaLogowania({
  searchParams,
}: {
  searchParams: Promise<{ dalej?: string }>;
}) {
  const { dalej } = await searchParams;

  // zalogowany nie oglada formularza; cel z ?dalej dopiero po odkazeniu,
  // bo to parametr z URL-a, czyli wejscie atakujacego (open redirect)
  const sesja = await aktualnaSesja();
  if (sesja) {
    redirect(dalej && dalej.startsWith("/") && !dalej.startsWith("//") ? dalej : "/");
  }

  return (
    <main
      style={{ background: "var(--color-plotno)" }}
      className="flex min-h-screen items-center justify-center px-4"
    >
      <FormularzLogowania dalej={dalej} />
    </main>
  );
}
