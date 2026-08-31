import { sklepyTenanta } from "../../../../adapters/db/repozytoria";
import { wymaganyTenant } from "../../../autoryzacja";
import { formatujDate } from "../../../../domain/daty";
import { nazwaMozliwosci } from "../../../../domain/statusy";
import { importujAkcja } from "../../../akcje";
import { Komunikat, Naglowek } from "../naglowek";
import { FormularzPodlaczenia } from "./formularz-podlaczenia";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sklepy" };

export default async function Sklepy({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const { ok, blad } = await searchParams;
  const sklepy = await sklepyTenanta(tenantId);

  return (
    <>
      <Naglowek
        tytul="Sklepy"
        opis="Klucze REST generuje merchant po swojej stronie. Sprawdzamy każde uprawnienie osobno, zanim cokolwiek zapiszemy, bo klucze bez dostępu do zamówień przechodzą zwykły test połączenia, a import kończy się pustym wynikiem wyglądającym jak sklep bez historii."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="grid gap-6 px-6 py-6 lg:grid-cols-2">
        <section className="karta">
          <div className="border-b border-[var(--color-linia)] px-4 py-3">
            <h2 className="text-sm font-semibold">Podłączone</h2>
          </div>
          {sklepy.length === 0 ? (
            <p className="p-4 text-sm text-[var(--color-tekst-2)]">Żaden sklep nie jest jeszcze podłączony.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-linia)]">
              {sklepy.map((s) => (
                <li key={s.id} className="p-4">
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{s.base_url.replace(/^https?:\/\//, "")}</div>
                      <div className="mt-0.5 text-xs text-[var(--color-tekst-3)]">
                        {s.platform} · dodany {formatujDate(s.created_at)}
                      </div>
                    </div>
                    <span className={`plakietka ${s.status === "connected" ? "plakietka-ok" : "plakietka-blad"}`}>
                      {s.status === "connected" ? "połączony" : s.status}
                    </span>
                  </div>

                  <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
                    {Object.entries(s.capabilities ?? {}).map(([nazwa, wartosc]) => (
                      <span key={nazwa} className={`plakietka ${wartosc ? "plakietka-ok" : ""}`}>
                        {nazwaMozliwosci(nazwa)}: {wartosc ? "tak" : "nie"}
                      </span>
                    ))}
                  </div>

                  <form action={importujAkcja}>
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="storeId" value={s.id} />
                    <button className="przycisk przycisk-wtorny" type="submit">
                      Importuj historię
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="karta p-4">
          <h2 className="mb-1 text-sm font-semibold">Podłącz sklep WooCommerce</h2>
          <p className="mb-4 text-xs text-[var(--color-tekst-2)]">
            Poświadczenia lądują w bazie zaszyfrowane i nie pojawiają się w logach ani w odpowiedziach API.
          </p>
          <FormularzPodlaczenia tenantId={tenantId} />
        </section>
      </div>
    </>
  );
}
