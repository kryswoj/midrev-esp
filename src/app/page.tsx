import Link from "next/link";
import { listaTenantow, podsumowanieTenanta } from "../adapters/db/repozytoria";
import { utworzTenantaAkcja } from "./akcje";
import { wymaganaSesja } from "./autoryzacja";
import { zGroszy } from "../domain/kwoty";
import { odmien } from "../domain/liczebniki";

export const dynamic = "force-dynamic";

export default async function Strona({
  searchParams,
}: {
  searchParams: Promise<{ blad?: string }>;
}) {
  // Lista tenantow tylko dla zalogowanych i tylko te z sesji (AD-21):
  // client widzi wylacznie swoje membershipy, nie caly portfel agencji.
  const sesja = await wymaganaSesja();
  const { blad } = await searchParams;
  const tenanci = (await listaTenantow()).filter((t) => sesja.tenantIds.includes(t.id));
  const podsumowania = await Promise.all(
    tenanci.map(async (t) => ({ tenant: t, dane: await podsumowanieTenanta(t.id) })),
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-14">
      <div className="mb-10 flex items-end justify-between gap-6">
        <div>
          <p className="etykieta mb-2">MidRev</p>
          <h1>Sklepy klientów</h1>
          <p className="mt-2 max-w-xl text-[var(--color-tekst-2)]">
            Każdy klient agencji ma osobny workspace z własnymi danymi, własną domeną wysyłkową
            i własną listą wykluczeń.
          </p>
        </div>
      </div>

      {blad ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-[var(--color-blad)] bg-[var(--color-blad-tlo)] px-3 py-2 text-[12px] text-[var(--color-blad)]"
        >
          {blad}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {podsumowania.map(({ tenant, dane }) => (
          <Link key={tenant.id} href={`/t/${tenant.id}`} className="karta block p-5 transition hover:border-[var(--color-akcent)]">
            <div className="mb-4 flex items-center justify-between">
              <h2>{tenant.name}</h2>
              <span className="liczba text-[12px] text-[var(--color-tekst-3)]">{odmien(Number(dane.sklepy), "sklep", "sklepy", "sklepów")}</span>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-xs text-[var(--color-tekst-3)]">Profile</div>
                <div className="wielkosc">{dane.profile}</div>
              </div>
              <div>
                <div className="text-xs text-[var(--color-tekst-3)]">Zamówienia</div>
                <div className="wielkosc">{dane.zamowienia}</div>
              </div>
              <div>
                <div className="text-xs text-[var(--color-tekst-3)]">Przychód</div>
                <div className="wielkosc">{zGroszy(Number(dane.przychod_minor))}</div>
              </div>
            </div>
          </Link>
        ))}

        {/* workspace'y zakłada MidRev: formularz tylko dla admin/operator,
            akcja i tak weryfikuje rolę sama (formularz to nie autoryzacja) */}
        {sesja.role !== "client" && (
        <form action={utworzTenantaAkcja} className="karta flex flex-col justify-between gap-3 border-dashed p-5">
          <div>
            <h2 className="mb-1">Nowy klient</h2>
            <p className="text-xs text-[var(--color-tekst-2)]">
              Konto zakłada MidRev. Nie ma rejestracji z ulicy, bo to narzędzie agencji, nie SaaS.
            </p>
          </div>
          <div className="flex gap-2">
            <input name="nazwa" required placeholder="Nazwa sklepu" aria-label="Nazwa sklepu" className="pole" />
            <button className="przycisk whitespace-nowrap" type="submit">Dodaj</button>
          </div>
        </form>
        )}
      </div>
    </main>
  );
}
