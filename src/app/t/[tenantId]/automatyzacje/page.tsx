import { TRIGGERY, journeyeTenanta } from "../../../../usecases/automatyzacje/journeye";
import { wymaganyTenant } from "../../../autoryzacja";
import { Komunikat, Naglowek } from "../naglowek";
import { przelaczAutomatyzacjeAkcja, utworzZSzablonuAkcja } from "./akcje";
import { FormularzAutomatyzacji } from "./formularz-automatyzacji";

export const dynamic = "force-dynamic";

export const metadata = { title: "Automatyzacje" };

function opiszOpoznienie(minuty: number): string {
  if (minuty === 0) return "od razu";
  if (minuty % 1440 === 0) return `po ${minuty / 1440} dn.`;
  if (minuty % 60 === 0) return `po ${minuty / 60} godz.`;
  return `po ${minuty} min`;
}

export default async function Automatyzacje({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  const { ok, blad } = await searchParams;
  // tenantId pochodzi z URL, czyli od klienta: bez sprawdzenia wobec sesji (AD-21)
  // sam adres ujawnialby automatyzacje cudzego tenanta. Strona weryfikuje sama,
  // wspolna bramka - patrz src/app/autoryzacja.ts.
  await wymaganyTenant(tenantId);
  const journeye = await journeyeTenanta(tenantId);

  return (
    <>
      <Naglowek
        tytul="Automatyzacje"
        opis="Automatyzacja reaguje na zdarzenie (zapis z popupu, złożone zamówienie) i wysyła jeden mail na profil, przez te same bramki zgód i wykluczeń co kampanie. Włączenie działa od tej chwili w przód: nikt nie dostanie powitania za zapis sprzed dwóch dni. Wysłane liczymy z faktycznych wysyłek, nie z planu."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="grid gap-6 p-4 lg:grid-cols-[1fr_320px]">
        <section className="karta overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                <th>Automatyzacja</th>
                <th>Wyzwalacz</th>
                <th>Opóźnienie</th>
                <th className="text-right">Wysłane</th>
                <th className="text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {journeye.map((j) => (
                <tr key={j.id}>
                  <td>
                    <span className="font-medium">{j.name}</span>
                    <span className="mt-0.5 block text-xs text-[var(--color-tekst-2)]">{j.subject}</span>
                  </td>
                  <td className="text-[var(--color-tekst-2)]">
                    {TRIGGERY[j.trigger_event] ?? j.trigger_event}
                  </td>
                  <td className="text-[var(--color-tekst-2)]">{opiszOpoznienie(j.delay_minutes)}</td>
                  <td className="text-right">
                    <span className="wielkosc text-lg">{j.wyslane}</span>
                  </td>
                  <td className="text-right">
                    <form action={przelaczAutomatyzacjeAkcja} className="inline-flex items-center gap-2">
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="journeyId" value={j.id} />
                      {/* stan docelowy, nie komenda "przelacz": podwojny submit nie odwraca decyzji */}
                      <input type="hidden" name="docelowa" value={j.active ? "0" : "1"} />
                      <span className={`plakietka ${j.active ? "plakietka-ok" : ""}`}>
                        {j.active ? "włączona" : "wyłączona"}
                      </span>
                      <button className="przycisk przycisk-wtorny" type="submit">
                        {j.active ? "Wyłącz" : "Włącz"}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {journeye.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-[var(--color-tekst-2)]">
                    Nie ma jeszcze żadnej automatyzacji. Zacznij od gotowego szablonu obok.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <section className="space-y-4">
          <div className="karta p-4">
            <h2 className="mb-1 text-sm font-semibold">Zacznij od szablonu</h2>
            <p className="mb-3 text-xs text-[var(--color-tekst-2)]">
              Gotowy temat i treść po polsku. Link w treści prowadzi do podłączonego sklepu.
            </p>
            <div className="space-y-2">
              <form action={utworzZSzablonuAkcja}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="szablon" value="welcome" />
                <button className="przycisk przycisk-wtorny w-full justify-center" type="submit">
                  Utwórz z szablonu: Powitanie po zapisie
                </button>
              </form>
              <form action={utworzZSzablonuAkcja}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="szablon" value="postpurchase" />
                <button className="przycisk przycisk-wtorny w-full justify-center" type="submit">
                  Utwórz z szablonu: Podziękowanie po zakupie
                </button>
              </form>
            </div>
          </div>

          <div className="karta p-4">
            <h2 className="mb-1 text-sm font-semibold">Nowa automatyzacja</h2>
            <p className="mb-4 text-xs text-[var(--color-tekst-2)]">
              Powstaje wyłączona. Włączysz ją przełącznikiem, gdy treść będzie gotowa.
            </p>
            <FormularzAutomatyzacji tenantId={tenantId} triggery={TRIGGERY} />
          </div>
        </section>
      </div>
    </>
  );
}
