import { notFound } from "next/navigation";
import { aktualnaSesja } from "../../../../adapters/auth-sesja";
import { TRIGGERY, journeyeTenanta } from "../../../../usecases/automatyzacje/journeye";
import { Komunikat, Naglowek } from "../naglowek";
import {
  przelaczAutomatyzacjeAkcja,
  utworzAutomatyzacjeAkcja,
  utworzZSzablonuAkcja,
} from "./akcje";

export const dynamic = "force-dynamic";

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
  // sam adres ujawnialby automatyzacje cudzego tenanta. Layout strefy /t/ sprawdza
  // dzis tylko istnienie tenanta, wiec strona broni sie sama (review, runda 2).
  const sesja = await aktualnaSesja();
  if (!sesja || !sesja.tenantIds.includes(tenantId)) notFound();
  const journeye = await journeyeTenanta(tenantId);

  return (
    <>
      <Naglowek
        tytul="Automatyzacje"
        opis="Automatyzacja reaguje na zdarzenie (zapis z popupu, złożone zamówienie) i wysyła jeden mail na profil, przez te same bramki zgód i wykluczeń co kampanie. Włączenie działa od tej chwili w przód: nikt nie dostanie powitania za zapis sprzed dwóch dni. Wysłane liczymy z faktycznych wysyłek, nie z planu."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="grid gap-6 p-4 lg:grid-cols-[1fr_320px]">
        <section className="karta overflow-hidden">
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
                    <span className="mt-0.5 block text-xs text-[var(--color-muted)]">{j.subject}</span>
                  </td>
                  <td className="text-[var(--color-muted)]">
                    {TRIGGERY[j.trigger_event] ?? j.trigger_event}
                  </td>
                  <td className="text-[var(--color-muted)]">{opiszOpoznienie(j.delay_minutes)}</td>
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
                      <button className="przycisk-wtorny" type="submit">
                        {j.active ? "Wyłącz" : "Włącz"}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {journeye.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-[var(--color-muted)]">
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
            <p className="mb-3 text-xs text-[var(--color-muted)]">
              Gotowy temat i treść po polsku. Przed włączeniem podmień link do sklepu.
            </p>
            <div className="space-y-2">
              <form action={utworzZSzablonuAkcja}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="szablon" value="welcome" />
                <button className="przycisk-wtorny w-full justify-center" type="submit">
                  Utwórz z szablonu: Powitanie po zapisie
                </button>
              </form>
              <form action={utworzZSzablonuAkcja}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="szablon" value="postpurchase" />
                <button className="przycisk-wtorny w-full justify-center" type="submit">
                  Utwórz z szablonu: Podziękowanie po zakupie
                </button>
              </form>
            </div>
          </div>

          <div className="karta p-4">
            <h2 className="mb-1 text-sm font-semibold">Nowa automatyzacja</h2>
            <p className="mb-4 text-xs text-[var(--color-muted)]">
              Powstaje wyłączona. Włączysz ją przełącznikiem, gdy treść będzie gotowa.
            </p>
            <form action={utworzAutomatyzacjeAkcja} className="space-y-3">
              <input type="hidden" name="tenantId" value={tenantId} />
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">Nazwa</span>
                <input name="nazwa" required placeholder="np. Powitanie po zapisie" className="pole" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">Wyzwalacz</span>
                <select name="trigger" className="pole" defaultValue="popup.submitted">
                  {Object.entries(TRIGGERY).map(([wartosc, etykieta]) => (
                    <option key={wartosc} value={wartosc}>
                      {etykieta}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">
                  Opóźnienie (minuty od zdarzenia)
                </span>
                <input name="opoznienie" type="number" min={0} defaultValue={0} className="pole" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">Temat wiadomości</span>
                <input name="temat" required placeholder="to zobaczy odbiorca" className="pole" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">Treść (HTML)</span>
                <textarea
                  name="html"
                  required
                  rows={6}
                  placeholder="<p>Cześć!</p>"
                  className="pole font-mono text-xs"
                />
              </label>
              <button className="przycisk w-full justify-center" type="submit">
                Utwórz automatyzację
              </button>
            </form>
          </div>
        </section>
      </div>
    </>
  );
}
