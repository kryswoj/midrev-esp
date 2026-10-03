import { NAZWY_TYPOW, type TypFormularza } from "../../../../../domain/formularze/model";
import { SZABLONY } from "../../../../../domain/formularze/szablony";
import { stylDomyslnyKonta } from "../../../../../usecases/popupy/formularze";
import { nazwaFirmyTenanta } from "../../../../../usecases/popupy/zarzadzaj";
import { wymaganyTenant } from "../../../../autoryzacja";
import { Card, CardBody, PrzyciskFormularza } from "../../../../ui";
import { Komunikat, Naglowek } from "../../naglowek";
import { utworzFormularzAkcja } from "../akcje";
import { AtrapaSklepu, PodgladFormularza, StylePodgladu } from "../podglad";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nowy formularz" };

/**
 * Galeria szablonów (jak „Create form” w Klaviyo): nazwa, typ i szablon w jednym kroku.
 * Formularz powstaje jako szkic i od razu otwiera się builder. Bez JS-a: zwykły formularz
 * z radiami, zaznaczenie widać przez :has(:checked).
 */
export default async function NowyFormularz({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ blad?: string }> }) {
  const { tenantId } = await params;
  await wymaganyTenant(tenantId);
  const { blad } = await searchParams;
  const [firma, styl] = await Promise.all([nazwaFirmyTenanta(tenantId), stylDomyslnyKonta(tenantId)]);
  const szablony = SZABLONY.map((s) => ({ s, def: s.zbuduj(firma, styl) }));
  const typy: TypFormularza[] = ["popup", "flyout", "embed"];

  return (
    <>
      <StylePodgladu />
      <Naglowek tytul="Nowy formularz" opis="Wybierz szablon i typ. Treść, wygląd i zachowanie dopasujesz w builderze." powrot={{ href: `/t/${tenantId}/popupy`, etykieta: "Formularze zapisu" }} />
      <Komunikat blad={blad} />
      <form action={utworzFormularzAkcja} className="tresc-strony">
        <input type="hidden" name="tenantId" value={tenantId} />
        <Card>
          <CardBody className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <div>
              <label htmlFor="nazwa" className="etykieta mb-1.5 block">Nazwa formularza</label>
              <input id="nazwa" name="nazwa" className="pole" placeholder="np. Rabat powitalny" maxLength={120} />
              <p className="tekst-meta mt-1">Widzisz ją tylko Ty. Trafia też do rejestru zgód jako źródło zapisu.</p>
            </div>
            <fieldset>
              <legend className="etykieta mb-1.5 block">Typ</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {typy.map((t, i) => (
                  <label key={t} className="cursor-pointer rounded-[10px] border border-[var(--color-linia)] px-3 py-2.5 hover:border-[var(--color-linia-mocna)] has-[:checked]:border-[var(--color-akcent)] has-[:checked]:bg-[var(--color-akcent-tlo)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-akcent)]">
                    <input type="radio" name="typ" value={t} defaultChecked={i === 0} className="sr-only" />
                    <span className="block text-[14px] font-semibold">{NAZWY_TYPOW[t].nazwa}</span>
                    <span className="mt-0.5 block text-[12px] leading-[17px] text-[var(--color-tekst-2)]">{NAZWY_TYPOW[t].opis}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </CardBody>
        </Card>

        <fieldset>
          <legend className="mb-3 text-[15px] font-semibold">Szablon</legend>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {szablony.map(({ s, def }, i) => (
              <label key={s.id} className="group cursor-pointer overflow-hidden rounded-xl border border-[var(--color-linia)] bg-white shadow-[var(--cien-karta)] transition-shadow hover:shadow-[var(--cien-uniesiony)] has-[:checked]:border-[var(--color-akcent)] has-[:checked]:ring-2 has-[:checked]:ring-[var(--color-akcent)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-akcent)]">
                <input type="radio" name="szablon" value={s.id} defaultChecked={i === 0} className="sr-only" />
                <span className="relative block h-[230px] overflow-hidden border-b border-[var(--color-linia)] bg-[#e9ecf0]" aria-hidden="true">
                  <span className="pointer-events-none absolute inset-0 block origin-top-left" style={{ zoom: 0.5, width: "200%", height: "200%" }}>
                    <AtrapaSklepu>
                      <PodgladFormularza def={{ ...def, typ: "popup" }} krok={def.kroki[0]} />
                    </AtrapaSklepu>
                  </span>
                </span>
                <span className="block px-4 py-3">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[15px] font-semibold">{s.nazwa}</span>
                    <span className="tekst-meta whitespace-nowrap">{s.sklad}</span>
                  </span>
                  <span className="mt-1 block text-[13px] leading-[18px] text-[var(--color-tekst-2)]">{s.opis}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-3 border-t border-[var(--color-linia)] bg-[var(--color-tlo,#fafafa)]/95 px-1 py-3 backdrop-blur">
          <span className="tekst-meta max-sm:hidden">Formularz powstanie jako szkic. Na stronie pojawi się dopiero po publikacji.</span>
          <PrzyciskFormularza trwa="Tworzę…">Utwórz i otwórz builder</PrzyciskFormularza>
        </div>
      </form>
    </>
  );
}
