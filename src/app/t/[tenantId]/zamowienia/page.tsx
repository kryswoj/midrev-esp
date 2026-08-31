import { zamowieniaTenanta } from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import { formatujDate } from "../../../../domain/daty";
import { zGroszy } from "../../../../domain/kwoty";
import { odmien } from "../../../../domain/liczebniki";
import { nazwaStatusu, wagaStatusu } from "../../../../domain/statusy";
import { Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export const metadata = { title: "Zamówienia" };

export default async function Zamowienia({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const zamowienia = await zamowieniaTenanta(tenantId, 200);

  return (
    <>
      <Naglowek
        tytul="Zamówienia"
        opis="Kwoty trzymane w groszach jako liczby całkowite, nigdy jako liczby zmiennoprzecinkowe. Data zamówienia pochodzi ze sklepu."
        akcja={
          <span className="text-[12px] text-[var(--color-tekst-3)]">
            {odmien(zamowienia.length, "zamówienie", "zamówienia", "zamówień")}
          </span>
        }
      />
      <div className="px-6 py-6">
        <div className="karta overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                <th>Numer</th>
                <th>Klient</th>
                <th>Status</th>
                <th className="text-right">Kwota</th>
                <th className="text-right">Data zamówienia</th>
              </tr>
            </thead>
            <tbody>
              {zamowienia.map((z) => (
                <tr key={z.id}>
                  <td className="liczba">#{z.number ?? z.external_id}</td>
                  <td>
                    <div>{[z.first_name, z.last_name].filter(Boolean).join(" ") || "—"}</div>
                    <div className="text-xs text-[var(--color-tekst-3)]">{z.email ?? "brak adresu"}</div>
                  </td>
                  <td>
                    <span className={`plakietka plakietka-${wagaStatusu(z.status)}`}>
                      {nazwaStatusu(z.status)}
                    </span>
                  </td>
                  <td className="liczba text-right">{zGroszy(Number(z.total_minor), z.currency)}</td>
                  <td className="liczba text-right text-[var(--color-tekst-2)]">
                    {formatujDate(z.occurred_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
