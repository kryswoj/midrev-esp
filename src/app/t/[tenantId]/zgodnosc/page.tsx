import { sklepyTenanta } from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import { formatujDate } from "../../../../domain/daty";
import { sprawdzZgodnosc } from "../../../../usecases/sprawdz-zgodnosc";
import { Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export const metadata = { title: "Zgodność danych" };

export default async function Zgodnosc({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const sklepy = await sklepyTenanta(tenantId);
  const wyniki = await Promise.all(sklepy.map((s) => sprawdzZgodnosc(tenantId, s.id, 400)));

  return (
    <>
      <Naglowek
        tytul="Zgodność danych"
        opis="Webhooki potrafią przestać przychodzić bez żadnego błędu i nikt tego nie zauważa aż do raportu dla klienta. Dlatego liczba zamówień w sklepie jest codziennie porównywana z liczbą w bazie, a rozjazd powyżej pół procenta idzie alertem do człowieka, nie do logu."
      />
      <div className="grid gap-4 px-6 py-6 lg:grid-cols-2">
        {wyniki.map((w, i) => {
          const s = sklepy[i];
          return (
            <div key={w.storeId} className="karta p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">{s.base_url.replace(/^https?:\/\//, "")}</div>
                  <div className="text-xs text-[var(--color-tekst-3)]">
                    okres od {formatujDate(w.okresOd)}
                  </div>
                </div>
                <span
                  className={`plakietka ${
                    w.stan === "zgodne" ? "plakietka-ok" : w.stan === "rozjazd" ? "plakietka-blad" : "plakietka-uwaga"
                  }`}
                >
                  {w.stan === "zgodne" ? "zgodne" : w.stan === "rozjazd" ? "rozjazd" : "nieustalone"}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-xs text-[var(--color-tekst-3)]">W sklepie</div>
                  <div className="wielkosc-hero">{w.wSklepie ?? "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-[var(--color-tekst-3)]">W bazie</div>
                  <div className="wielkosc-hero">{w.wBazie}</div>
                </div>
                <div>
                  <div className="text-xs text-[var(--color-tekst-3)]">Różnica</div>
                  <div
                    className={`wielkosc-hero ${
                      w.roznica === 0 ? "" : w.roznica === null ? "text-[var(--color-czeka)]" : "text-[var(--color-blad)]"
                    }`}
                  >
                    {w.roznica === null ? "—" : w.roznica}
                  </div>
                </div>
              </div>

              {w.stan === "nieustalone" ? (
                <p className="mt-4 text-xs text-[var(--color-tekst-2)]">
                  Sklep nie odpowiedział. To nie jest rozjazd danych, tylko brak odpowiedzi, i tak
                  jest liczone, żeby niedostępność sklepu nie wywoływała fałszywych alarmów.
                </p>
              ) : null}
            </div>
          );
        })}
        {sklepy.length === 0 ? (
          <p className="text-sm text-[var(--color-tekst-2)]">Podłącz sklep, żeby zobaczyć kontrolę zgodności.</p>
        ) : null}
      </div>
    </>
  );
}
