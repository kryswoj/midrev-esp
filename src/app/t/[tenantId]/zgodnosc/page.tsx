import { sklepyTenanta } from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import { formatujDate } from "../../../../domain/daty";
import { sprawdzZgodnosc } from "../../../../usecases/sprawdz-zgodnosc";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Stat } from "../../../ui";
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
      <div className="tresc-strony">
        {sklepy.length === 0 ? (
          <Card>
            <EmptyState icon="zgodnosc" title="Nie ma jeszcze danych do porównania" description="Podłącz sklep i wykonaj pierwszy import. Kontrola zgodności ruszy automatycznie, gdy pojawią się zamówienia." action={<Button href={`/t/${tenantId}/sklepy`} variant="secondary">Przejdź do integracji</Button>} />
          </Card>
        ) : (
        <div className={`grid gap-6 lg:items-start ${wyniki.length > 1 ? "xl:grid-cols-2" : "max-w-[900px]"}`}>
          {wyniki.map((w, i) => {
          const s = sklepy[i];
          return (
            <Card key={w.storeId}>
              <CardHeader
                title={s.base_url.replace(/^https?:\/\//, "")}
                description={<>Porównanie zamówień od <span className="liczba">{formatujDate(w.okresOd)}</span></>}
                action={<Badge ton={w.stan === "zgodne" ? "ok" : w.stan === "rozjazd" ? "blad" : "uwaga"}>{w.stan === "zgodne" ? "zgodne" : w.stan === "rozjazd" ? "rozjazd" : "nieustalone"}</Badge>}
              />

              <div className="grid grid-cols-3 divide-x divide-[var(--color-linia-0)]">
                <Stat label="W sklepie" value={String(w.wSklepie ?? "—")} missing={w.wSklepie === null} />
                <Stat label="W bazie" value={String(w.wBazie)} />
                <Stat label="Różnica" value={String(w.roznica ?? "—")} missing={w.roznica === null} className={w.roznica !== null && w.roznica !== 0 ? "[&_.wielkosc-hero]:!text-[var(--color-blad)]" : ""} />
              </div>

              {w.stan === "nieustalone" ? (
                <div className="border-t border-[var(--color-linia-0)] p-4 sm:p-6">
                <Alert tone="uwaga" title="Sklep nie odpowiedział">
                  Sklep nie odpowiedział. To nie jest rozjazd danych, tylko brak odpowiedzi, i tak
                  jest liczone, żeby niedostępność sklepu nie wywoływała fałszywych alarmów.
                </Alert>
                </div>
              ) : null}
              {w.stan === "rozjazd" ? (
                <div className="border-t border-[var(--color-linia-0)] p-4 sm:p-6">
                  <Alert tone="blad" title="Liczba zamówień się nie zgadza">Dane sklepu i panelu wymagają sprawdzenia.</Alert>
                </div>
              ) : null}
            </Card>
          );
          })}
        </div>
        )}
      </div>
    </>
  );
}
