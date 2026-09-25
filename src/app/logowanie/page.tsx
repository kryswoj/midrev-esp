import { redirect } from "next/navigation";
import { aktualnaSesja } from "../../adapters/auth-sesja";
import { FormularzLogowania } from "./formularz";

export const dynamic = "force-dynamic";

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
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-plotno)] px-4 py-10 sm:px-6">
      <div className="w-full max-w-[424px]">
        <div className="mb-8 flex items-center justify-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-[10px] bg-[var(--color-akcent)] text-[17px] font-bold text-white shadow-sm">m</span>
          <span className="text-[17px] leading-6 font-semibold tracking-[-0.01em]">midrev esp</span>
        </div>
        <section className="karta p-6 sm:p-8">
          <FormularzLogowania dalej={dalej} />
        </section>
      </div>
    </main>
  );
}
