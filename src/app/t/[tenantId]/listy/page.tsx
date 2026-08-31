import { listyTenanta } from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import { utworzListeAkcja } from "../../../akcje";
import { Komunikat, Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export const metadata = { title: "Listy" };

export default async function Listy({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const { ok, blad } = await searchParams;
  const listy = await listyTenanta(tenantId);

  return (
    <>
      <Naglowek
        tytul="Listy"
        opis="Lista to statyczny zbiór osób: zapisy z formularza, import z pliku, ręczny dobór. Różnica wobec segmentu jest istotna przy sporze o zgodę: lista pamięta, kto i kiedy do niej wszedł, a segment tylko opisuje warunek."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="grid gap-6 p-4 lg:grid-cols-[1fr_320px]">
        <section className="karta overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                <th>Lista</th>
                <th>Opis</th>
                <th className="text-right">Osoby</th>
              </tr>
            </thead>
            <tbody>
              {listy.map((l: any) => (
                <tr key={l.id}>
                  <td className="font-medium">{l.name}</td>
                  <td className="text-[var(--color-tekst-2)]">{l.description ?? "—"}</td>
                  <td className="text-right">
                    <span className="wielkosc text-lg">{l.czlonkow}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="karta h-fit p-4">
          <h2 className="mb-4 text-sm font-semibold">Nowa lista</h2>
          <form action={utworzListeAkcja} className="space-y-3">
            <input type="hidden" name="tenantId" value={tenantId} />
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-tekst-2)]">Nazwa</span>
              <input name="nazwa" required placeholder="np. Zapisy z popupu" className="pole" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-tekst-2)]">Opis</span>
              <input name="opis" placeholder="skąd pochodzą te osoby" className="pole" />
            </label>
            <button className="przycisk w-full justify-center" type="submit">
              Utwórz listę
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
