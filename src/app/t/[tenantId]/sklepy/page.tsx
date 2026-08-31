import { sklepyTenanta } from "../../../../adapters/db/repozytoria";
import { importujAkcja, podlaczSklepAkcja } from "../../../akcje";
import { Komunikat, Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

export default async function Sklepy({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
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
          <div className="border-b border-[var(--color-line)] px-4 py-3">
            <h2 className="text-sm font-semibold">Podłączone</h2>
          </div>
          {sklepy.length === 0 ? (
            <p className="p-4 text-sm text-[var(--color-muted)]">Żaden sklep nie jest jeszcze podłączony.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {sklepy.map((s) => (
                <li key={s.id} className="p-4">
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{s.base_url.replace(/^https?:\/\//, "")}</div>
                      <div className="mt-0.5 text-xs text-[var(--color-faint)]">
                        {s.platform} · dodany {new Date(s.created_at).toLocaleDateString("pl-PL")}
                      </div>
                    </div>
                    <span className={`plakietka ${s.status === "connected" ? "plakietka-ok" : "plakietka-blad"}`}>
                      {s.status === "connected" ? "połączony" : s.status}
                    </span>
                  </div>

                  <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
                    {Object.entries(s.capabilities ?? {}).map(([nazwa, wartosc]) => (
                      <span key={nazwa} className={`plakietka ${wartosc ? "plakietka-ok" : ""}`}>
                        {nazwa}: {wartosc ? "tak" : "nie"}
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
          <p className="mb-4 text-xs text-[var(--color-muted)]">
            Poświadczenia lądują w bazie zaszyfrowane i nie pojawiają się w logach ani w odpowiedziach API.
          </p>
          <form action={podlaczSklepAkcja} className="space-y-3">
            <input type="hidden" name="tenantId" value={tenantId} />
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Adres sklepu</span>
              <input name="baseUrl" required placeholder="https://sklep.pl" className="pole" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Consumer key</span>
              <input name="consumerKey" required placeholder="ck_..." className="pole" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Consumer secret</span>
              <input name="consumerSecret" required type="password" placeholder="cs_..." className="pole" />
            </label>
            <button className="przycisk" type="submit">Sprawdź i podłącz</button>
          </form>
        </section>
      </div>
    </>
  );
}
