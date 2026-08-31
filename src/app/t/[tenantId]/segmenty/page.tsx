import { segmentyTenanta } from "../../../../adapters/db/repozytoria";
import { policzSegment } from "../../../../adapters/db/segmenty";
import { opiszRegule, type Regula } from "../../../../domain/segmenty";
import { utworzSegmentAkcja } from "../../../akcje";
import { Komunikat, Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export default async function Segmenty({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  const { ok, blad } = await searchParams;
  const segmenty = await segmentyTenanta(tenantId);
  const zLiczba = await Promise.all(
    segmenty.map(async (s: any) => ({
      ...s,
      ile: await policzSegment(tenantId, s.rules as Regula[]),
    })),
  );

  return (
    <>
      <Naglowek
        tytul="Segmenty"
        opis="Segment to definicja reguł, nie zamrożona lista ludzi. Liczebność jest przeliczana przy każdym otwarciu, bo lista zapisana wczoraj kłamie już dzisiaj. W fazie 1 działa zamknięty zestaw reguł: otwarty builder wraca wtedy, gdy klient poprosi o coś, czego się z tego nie złoży."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="grid gap-6 p-4 lg:grid-cols-[1fr_320px]">
        <section className="karta overflow-hidden">
          <table className="tabela">
            <thead>
              <tr>
                <th>Segment</th>
                <th>Reguły</th>
                <th className="text-right">Odbiorcy</th>
              </tr>
            </thead>
            <tbody>
              {zLiczba.map((s: any) => (
                <tr key={s.id}>
                  <td className="font-medium">{s.name}</td>
                  <td className="text-[var(--color-muted)]">
                    {(s.rules as Regula[]).map((r) => opiszRegule(r)).join(" · ")}
                  </td>
                  <td className="text-right">
                    <span className="wielkosc text-lg">{s.ile}</span>
                  </td>
                </tr>
              ))}
              {zLiczba.length === 0 ? (
                <tr>
                  <td colSpan={3} className="text-[var(--color-muted)]">
                    Nie ma jeszcze żadnego segmentu.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <section className="karta h-fit p-4">
          <h2 className="mb-1 text-sm font-semibold">Nowy segment</h2>
          <p className="mb-4 text-xs text-[var(--color-muted)]">
            Reguły liczą się na żywych danych sklepu. Liczebność zobaczysz od razu po zapisaniu.
          </p>
          <form action={utworzSegmentAkcja} className="space-y-3">
            <input type="hidden" name="tenantId" value={tenantId} />
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Nazwa</span>
              <input name="nazwa" required placeholder="np. Kupili w 30 dni" className="pole" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Reguła</span>
              <select name="typ" className="pole" defaultValue="kupil_w_ostatnich">
                <option value="kupil_w_ostatnich">kupił w ostatnich N dniach</option>
                <option value="nie_kupil_od">nie kupił od N dni</option>
                <option value="wydal_powyzej">wydał powyżej N zł</option>
                <option value="liczba_zamowien_min">złożył co najmniej N zamówień</option>
                <option value="ma_zgode">ma zgodę na e-mail</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Wartość N</span>
              <input name="wartosc" type="number" defaultValue={30} className="pole" />
            </label>
            <button className="przycisk w-full justify-center" type="submit">
              Zapisz segment
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
