import { formatujDateICzas } from "../../../../../domain/daty";
import { kluczeTenanta, OPISY_ZAKRESOW, ZAKRESY } from "../../../../../usecases/api/klucze";
import { wymaganyTenant } from "../../../../autoryzacja";
import { Table, TBody, Td, Th, THead } from "../../../../ui";
import { Komunikat, Naglowek } from "../../naglowek";
import { PrzyciskAkcji } from "../wysylka/przycisk";
import { uniewaznijKluczAkcja } from "./akcje";
import { FormularzKlucza } from "./formularz-klucza";

export const dynamic = "force-dynamic";

export const metadata = { title: "Klucze API" };

/** Zakresy zaznaczone domyślnie: to, czego potrzebuje workflow n8n (zdarzenia + profile). */
const DOMYSLNE = new Set(["events:write", "profiles:read", "profiles:write"]);

export default async function KluczeApi({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21)
  await wymaganyTenant(tenantId);
  const { ok, blad } = await searchParams;
  const klucze = await kluczeTenanta(tenantId);

  return (
    <>
      <Naglowek
        tytul="Klucze API"
        opis="Klucz prywatny pozwala n8n albo serwerowi sklepu wysyłać zdarzenia do tego konta tak jak do Klaviyo: ten sam kształt żądań, zmieniasz tylko adres i klucz. Klucz działa wyłącznie dla tego konta. Traktuj go jak hasło."
      />
      <Komunikat ok={ok} blad={blad} />
      <div className="mx-auto max-w-[880px] space-y-4 p-4">
        <section className="karta overflow-hidden">
          <div className="karta-naglowek">
            <div className="min-w-0">
              <h2>Nowy klucz</h2>
              <p className="karta-opis mt-0.5">Klucz zobaczysz tylko raz. Zgubiony klucz unieważnij i utwórz nowy.</p>
            </div>
          </div>
          <div className="p-4">
            <FormularzKlucza
              tenantId={tenantId}
              zakresy={ZAKRESY.map((z) => ({ wartosc: z, opis: OPISY_ZAKRESOW[z], domyslny: DOMYSLNE.has(z) }))}
            />
          </div>
        </section>

        <section className="karta overflow-hidden">
          <div className="karta-naglowek">
            <div className="min-w-0">
              <h2>Klucze tego konta</h2>
              <p className="karta-opis mt-0.5">Ostatnie użycie odświeża się najwyżej raz na minutę.</p>
            </div>
          </div>
          {klucze.length === 0 ? (
            <p className="p-4 text-[13px] text-[var(--color-tekst-2)]">Nie ma jeszcze żadnego klucza.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[720px]">
                <THead>
                  <tr>
                    <Th>Nazwa</Th>
                    <Th>Klucz</Th>
                    <Th>Zakresy</Th>
                    <Th>Utworzony</Th>
                    <Th>Ostatnie użycie</Th>
                    <Th>Stan</Th>
                  </tr>
                </THead>
                <TBody>
                  {klucze.map((k) => (
                    <tr key={k.id}>
                      <Td>{k.nazwa}</Td>
                      <Td>
                        <code>{k.prefiks}…</code>
                      </Td>
                      <Td className="text-[12px]">{k.zakresy.join(", ")}</Td>
                      <Td>{formatujDateICzas(k.utworzono)}</Td>
                      <Td>{k.ostatnieUzycie ? formatujDateICzas(k.ostatnieUzycie) : "nigdy"}</Td>
                      <Td>
                        {k.uniewazniono ? (
                          <span className="plakietka plakietka-blad">unieważniony {formatujDateICzas(k.uniewazniono)}</span>
                        ) : (
                          <form action={uniewaznijKluczAkcja}>
                            <input type="hidden" name="tenantId" value={tenantId} />
                            <input type="hidden" name="kluczId" value={k.id} />
                            <PrzyciskAkcji trwa="Unieważniam…" wariant="przycisk-niebezpieczny">
                              Unieważnij
                            </PrzyciskAkcji>
                          </form>
                        )}
                      </Td>
                    </tr>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
