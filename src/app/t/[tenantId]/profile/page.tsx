import { profileTenanta } from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import { formatujDate } from "../../../../domain/daty";
import { zGroszy } from "../../../../domain/kwoty";
import { Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export const metadata = { title: "Profile" };

export default async function Profile({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const profile = await profileTenanta(tenantId, 200);

  return (
    <>
      <Naglowek
        tytul="Profile"
        opis="Tożsamość profilu to znormalizowany adres e-mail: bez wielkości liter i bez spacji na brzegach. Dzięki temu Anna@Sklep.pl i anna@sklep.pl to jedna osoba, a nie dwie kartoteki."
      />
      <div className="px-6 py-6">
        <div className="karta overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                <th>Klient</th>
                <th className="text-right">Zamówienia</th>
                <th className="text-right">Wartość opłaconych</th>
                <th className="text-right">Ostatni zakup</th>
              </tr>
            </thead>
            <tbody>
              {profile.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div>{[p.first_name, p.last_name].filter(Boolean).join(" ") || "—"}</div>
                    <div className="text-xs text-[var(--color-tekst-3)]">{p.email ?? "brak adresu"}</div>
                  </td>
                  <td className="liczba text-right">{p.zamowien}</td>
                  <td className="liczba text-right">{zGroszy(Number(p.wydal_minor ?? 0))}</td>
                  <td className="liczba text-right text-[var(--color-tekst-2)]">
                    {formatujDate(p.ostatnie)}
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
