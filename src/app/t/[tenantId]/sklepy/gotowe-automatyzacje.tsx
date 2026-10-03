import Link from "next/link";
import { stanSzablonowKreatora } from "../../../../usecases/automatyzacje/journeye";
import { Badge, Card, CardHeader, PrzyciskFormularza } from "../../../ui";
import { utworzSzablonSklepuAkcja, wlaczSzablonSklepuAkcja } from "./akcje";

/**
 * Krok „Gotowe automatyzacje” kreatora (plan integracji F.1 pkt 5). Wspólny dla Woo, Shopify
 * i własnej strony: szablony stoją na rolach metryk, więc ta sama karta działa na każdej
 * platformie. Najpierw szkic (maile do przejrzenia), potem „Włącz” jednym kliknięciem.
 */
export async function GotoweAutomatyzacje({ tenantId, powrot, uwaga }: { tenantId: string; powrot: string; uwaga?: string }) {
  const szablony = await stanSzablonowKreatora(tenantId);
  return (
    <Card id="automatyzacje" className="scroll-mt-24">
      <CardHeader title="Gotowe automatyzacje" description="Maile powstają jako szkic. Porzucone koszyki i oglądane produkty wychodzą tylko do osób ze zgodą, a kto kupi, wypada przed mailem." />
      {uwaga ? <p className="px-6 pt-2 text-[13px] text-[var(--color-tekst-2)] max-md:px-4">{uwaga}</p> : null}
      <ul className="grid gap-3 p-6 max-md:p-4 md:grid-cols-2">
        {szablony.map((s) => (
          <li key={s.klucz} className="karta-plaska flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold">{s.nazwa}</span>
              {s.flow ? <Badge ton={s.flow.status === "wlaczony" ? "ok" : s.flow.status === "wstrzymany" ? "uwaga" : "szkic"}>{s.flow.status === "wlaczony" ? "włączona" : s.flow.status === "wstrzymany" ? "wstrzymana" : "szkic"}</Badge> : null}
            </div>
            <p className="text-[13px] leading-5 text-[var(--color-tekst-2)]">{s.opis}</p>
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
              {!s.flow ? (
                <form action={utworzSzablonSklepuAkcja}>
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <input type="hidden" name="powrot" value={powrot} />
                  <input type="hidden" name="szablon" value={s.klucz} />
                  <PrzyciskFormularza variant="secondary" size="sm" trwa="Tworzę…">Utwórz</PrzyciskFormularza>
                </form>
              ) : (
                <>
                  {s.flow.status !== "wlaczony" ? (
                    <form action={wlaczSzablonSklepuAkcja}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="powrot" value={powrot} />
                      <input type="hidden" name="flowId" value={s.flow.id} />
                      <PrzyciskFormularza size="sm" trwa="Włączam…">Włącz</PrzyciskFormularza>
                    </form>
                  ) : null}
                  <Link className="przycisk przycisk-wtorny przycisk-maly" href={`/t/${tenantId}/automatyzacje/${s.flow.id}/edytor`}>Zobacz maile</Link>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
