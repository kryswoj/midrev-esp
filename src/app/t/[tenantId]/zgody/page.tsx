import {
  statystykiZgod,
  wykluczeniaGlobalne,
  wykluczeniaTenanta,
  zgodyTenanta,
} from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import { formatujDate } from "../../../../domain/daty";
import { zrodloZgody } from "../../../../domain/statusy";
import { Kafelek, Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export const metadata = { title: "Zgody i wykluczenia" };

export default async function Zgody({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const [statystyki, zgody, wykluczenia, globalne] = await Promise.all([
    statystykiZgod(tenantId),
    zgodyTenanta(tenantId),
    wykluczeniaTenanta(tenantId),
    wykluczeniaGlobalne(),
  ]);

  return (
    <>
      <Naglowek
        tytul="Zgody i wykluczenia"
        opis="Zgoda nie jest polem w profilu, tylko wpisem w rejestrze: data, źródło i treść klauzuli, na którą osoba się zgodziła. Aktualny stan to ostatni wpis, więc wycofanie zgody nie kasuje historii. Wykluczenia działają na dwóch poziomach: lokalne to wypisania z tego sklepu, globalne chronią reputację całej platformy."
      />

      <div className="grid gap-4 p-4 sm:grid-cols-3">
        <Kafelek
          etykieta="Zgody na e-mail"
          wartosc={String(statystyki.zgody_email)}
          opis={`na ${statystyki.profile} profili w bazie`}
        />
        <Kafelek
          etykieta="Wycofane"
          wartosc={String(statystyki.wycofane_email)}
          opis="stan liczony z ostatniego wpisu"
        />
        <Kafelek
          etykieta="Wykluczenia"
          wartosc={String(wykluczenia.filter((w: any) => w.action === "suppressed").length)}
          opis="lokalne dla tego sklepu"
        />
      </div>

      <div className="grid gap-6 px-4 pb-4 xl:grid-cols-2">
        <section className="karta overflow-hidden">
          <div className="border-b border-[var(--color-linia)] px-4 py-3">
            <h2 className="text-sm font-semibold">Rejestr zgód</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Osoba</th>
                  <th>Stan</th>
                  <th>Źródło</th>
                  <th className="text-right">Data</th>
                </tr>
              </thead>
              <tbody>
                {zgody.map((z: any) => {
                  // Zgoda i wykluczenie to dwa rejestry, ale operator patrzy na jeden ekran:
                  // adres ze zgodą obecny w wykluczeniach musi być oznaczony, inaczej "zgoda"
                  // obok wpisu o wypisaniu wygląda jak sprzeczność.
                  const wykluczony = Boolean(z.wykluczony);
                  return (
                    <tr key={`${z.profile_id}-${z.channel}`}>
                      <td>
                        <div>{[z.first_name, z.last_name].filter(Boolean).join(" ") || "—"}</div>
                        <div className="text-xs text-[var(--color-tekst-3)]">{z.email}</div>
                      </td>
                      <td>
                        {z.state === "granted" ? (
                          wykluczony ? (
                            <span className="plakietka plakietka-uwaga">zgoda · wykluczony</span>
                          ) : (
                            <span className="plakietka plakietka-ok">zgoda</span>
                          )
                        ) : (
                          <span className="plakietka plakietka-blad">wycofana</span>
                        )}
                      </td>
                      <td className="text-xs text-[var(--color-tekst-2)]">{zrodloZgody(z.source)}</td>
                      <td className="liczba text-right text-xs text-[var(--color-tekst-2)]">
                        {formatujDate(z.occurred_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="space-y-6">
          <section className="karta overflow-hidden">
            <div className="border-b border-[var(--color-linia)] px-4 py-3">
              <h2 className="text-sm font-semibold">Wykluczenia tego sklepu</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Adres</th>
                    <th>Powód</th>
                    <th className="text-right">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {wykluczenia.map((w: any) => (
                    <tr key={w.email}>
                      <td className="text-xs">{w.email}</td>
                      <td className="text-xs text-[var(--color-tekst-2)]">{w.reason}</td>
                      <td className="liczba text-right text-xs text-[var(--color-tekst-2)]">
                        {formatujDate(w.occurred_at)}
                      </td>
                    </tr>
                  ))}
                  {wykluczenia.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-sm text-[var(--color-tekst-2)]">
                        Nikt się jeszcze nie wypisał.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="karta overflow-hidden">
            <div className="border-b border-[var(--color-linia)] px-4 py-3">
              <h2 className="text-sm font-semibold">Wykluczenia globalne</h2>
              <p className="mt-0.5 text-xs text-[var(--color-tekst-2)]">
                Wspólne dla wszystkich klientów agencji. Adres, który zgłosił skargę u jednego
                sklepu, nie dostanie maila od żadnego innego.
              </p>
            </div>
            {globalne.length === 0 ? (
              <p className="p-4 text-sm text-[var(--color-tekst-2)]">
                Lista jest pusta. Zapełni się automatycznie z odbić i skarg, gdy ruszy wysyłka.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="tabela">
                  <tbody>
                    {globalne.map((g: any) => (
                      <tr key={g.email}>
                        <td className="text-xs">{g.email}</td>
                        <td className="text-xs text-[var(--color-tekst-2)]">{g.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
