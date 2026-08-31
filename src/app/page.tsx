import Link from "next/link";
import { listaTenantow, podsumowanieTenanta } from "../adapters/db/repozytoria";
import { utworzTenantaAkcja } from "./akcje";
import { zGroszy } from "../domain/kwoty";

export const dynamic = "force-dynamic";

export default async function Strona() {
  const tenanci = await listaTenantow();
  const podsumowania = await Promise.all(
    tenanci.map(async (t) => ({ tenant: t, dane: await podsumowanieTenanta(t.id) })),
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-14">
      <div className="mb-10 flex items-end justify-between gap-6">
        <div>
          <p className="etykieta mb-2">MidRev</p>
          <h1 className="text-3xl font-bold">Sklepy klientów</h1>
          <p className="mt-2 max-w-xl text-[var(--color-muted)]">
            Każdy klient agencji ma osobny workspace z własnymi danymi, własną domeną wysyłkową
            i własną listą wykluczeń.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {podsumowania.map(({ tenant, dane }) => (
          <Link key={tenant.id} href={`/t/${tenant.id}`} className="karta block p-5 transition hover:-translate-y-0.5 hover:border-[var(--color-akcent)]">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{tenant.name}</h2>
              <span className="plakietka">{dane.sklepy} {dane.sklepy === 1 ? "sklep" : "sklepy"}</span>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-xs text-[var(--color-faint)]">Profile</div>
                <div className="wielkosc text-lg">{dane.profile}</div>
              </div>
              <div>
                <div className="text-xs text-[var(--color-faint)]">Zamówienia</div>
                <div className="wielkosc text-lg">{dane.zamowienia}</div>
              </div>
              <div>
                <div className="text-xs text-[var(--color-faint)]">Przychód</div>
                <div className="wielkosc text-lg">{zGroszy(Number(dane.przychod_minor))}</div>
              </div>
            </div>
          </Link>
        ))}

        <form action={utworzTenantaAkcja} className="karta flex flex-col justify-between gap-3 border-dashed p-5">
          <div>
            <h2 className="mb-1 text-lg font-semibold">Nowy klient</h2>
            <p className="text-xs text-[var(--color-muted)]">
              Konto zakłada MidRev. Nie ma rejestracji z ulicy, bo to narzędzie agencji, nie SaaS.
            </p>
          </div>
          <div className="flex gap-2">
            <input name="nazwa" required placeholder="Nazwa sklepu" className="pole" />
            <button className="przycisk whitespace-nowrap" type="submit">Dodaj</button>
          </div>
        </form>
      </div>
    </main>
  );
}
