import { notFound } from "next/navigation";
import { odczytajInstrukcje } from "../../../usecases/wysylka-konfiguracja/instrukcja-dns";
import { TabelaRekordow } from "../../_dns/tabela-rekordow";
import { WskazowkaDostawcy } from "../../_dns/wskazowka-dostawcy";
import { Alert } from "../../ui";

export const dynamic = "force-dynamic";
// link prywatny: wyszukiwarki i podglądy linków nie mają go indeksować
export const metadata = { title: "Rekordy DNS do wpisania", robots: { index: false, follow: false } };

/**
 * Publiczna instrukcja dla informatyka klienta (bez konta). Token 14 dni, tylko odczyt.
 * Pokazuje WYŁĄCZNIE domenę i rekordy: bez nazwy konta, adresów e-mail i danych firmy.
 * Token nieznany, wygasły albo unieważniony = 404 (bez rozróżnienia, żeby nie zdradzać,
 * czy link kiedyś istniał).
 */
export default async function InstrukcjaDns({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const i = await odczytajInstrukcje(token);
  if (!i) notFound();
  const oceny = i.raport?.rekordy ?? {};
  const zostalo = i.rekordy.filter((r) => oceny[r.klucz]?.stan !== "ok").length;
  return (
    <main className="min-h-screen bg-[var(--color-plotno)] px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-[920px] space-y-5">
        <div className="flex items-center gap-2.5 px-1">
          <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--color-akcent)] text-[17px] font-bold text-white shadow-sm">m</span>
          <span className="text-[15px] font-[650]">MidRev</span>
        </div>
        <section className="karta overflow-hidden">
          <div className="karta-naglowek">
            <div className="min-w-0">
              <h1 className="break-all text-[22px] font-[650] leading-[29px] tracking-[-0.02em]">Rekordy DNS dla {i.domena}</h1>
              <p className="karta-opis">
                Ktoś poprosił Cię o dodanie tych rekordów w strefie {i.strefa}. Służą do wysyłki newslettera z tej domeny. Nie zmieniają zwykłej poczty firmy ani strony.
              </p>
            </div>
          </div>
          <div className="space-y-5 p-6 max-md:p-4">
            {i.gotowa ? (
              <Alert tone="ok" title="Wszystko gotowe">Rekordy są na miejscu i potwierdzone. Nic więcej nie trzeba robić.</Alert>
            ) : (
              <p className="tekst-pomocniczy">
                Do dodania: {zostalo} z {i.rekordy.length}. Nazwy podajemy względem strefy {i.strefa} (bez niej na końcu). Stan rekordów odświeża się sam co kilka minut — odśwież stronę, żeby go zobaczyć.
              </p>
            )}
            {(i.raport?.ostrzezenia ?? []).map((o) => (
              <Alert key={o} tone={o.startsWith("PILNE") ? "blad" : "uwaga"}>{o.replace(/^PILNE:\s*/, "")}</Alert>
            ))}
            {!i.gotowa ? <WskazowkaDostawcy dostawca={i.dostawca} strefa={i.strefa} /> : null}
            <div className="overflow-hidden rounded-[10px] border border-[var(--color-linia)]">
              <TabelaRekordow rekordy={i.rekordy} oceny={oceny} />
            </div>
            <p className="tekst-meta">Link ważny do {new Date(i.wygasa).toLocaleDateString("pl-PL")}.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
