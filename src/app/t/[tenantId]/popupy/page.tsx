import { config } from "../../../../config";
import { popupyTenanta } from "../../../../usecases/popupy/zarzadzaj";
import { Komunikat, Naglowek } from "../naglowek";
import { przelaczPopupAkcja, utworzPopupAkcja } from "./akcje";

export const dynamic = "force-dynamic";

export default async function Popupy({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  const { ok, blad } = await searchParams;
  const popupy = await popupyTenanta(tenantId);
  // snippet budowany z APP_URL, bo to ten sam adres, na ktory skrypt wysle zgloszenia;
  // recznie wpisany host rozjechalby sie przy zmianie srodowiska
  const snippet = `<script src="${config().APP_URL}/s/${tenantId}"></script>`;

  return (
    <>
      <Naglowek
        tytul="Popupy"
        opis="Popup zbiera adresy e-mail bezpośrednio na stronie sklepu: sklep wkleja jeden tag script, a każdy zapis tworzy profil, zgodę ze źródłem popup i zdarzenie. Na stronie pokazywany jest najnowszy WŁĄCZONY popup, więc zmiana treści to nowy popup i przełączenie, a nie edycja tego, który już wisi."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="grid gap-6 p-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <section className="karta overflow-hidden">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Popup</th>
                  <th>Status</th>
                  <th className="text-right">Zgłoszenia</th>
                  <th className="text-right"></th>
                </tr>
              </thead>
              <tbody>
                {popupy.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="font-medium">{p.name}</div>
                      <div className="text-[12px] text-[var(--color-tekst-3)]">
                        {p.headline}
                        {p.discount_code ? ` · kod ${p.discount_code}` : ""}
                        {` · po ${p.rules?.delay_seconds ?? 0} s`}
                      </div>
                    </td>
                    <td>
                      {p.active ? (
                        <span className="plakietka plakietka-ok">włączony</span>
                      ) : (
                        <span className="plakietka">wyłączony</span>
                      )}
                    </td>
                    <td className="text-right">
                      <span className="wielkosc text-lg">{p.zgloszen}</span>
                    </td>
                    <td className="text-right">
                      <form action={przelaczPopupAkcja}>
                        <input type="hidden" name="tenantId" value={tenantId} />
                        <input type="hidden" name="popupId" value={p.id} />
                        <input type="hidden" name="wlacz" value={p.active ? "0" : "1"} />
                        <button className="przycisk-wtorny" type="submit">
                          {p.active ? "Wyłącz" : "Włącz"}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
                {popupy.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-[var(--color-tekst-3)]">
                      Nie ma jeszcze żadnego popupu.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>

          <section className="karta p-4">
            <h2 className="mb-1 text-sm font-semibold">Wklej na stronę sklepu</h2>
            <p className="mb-3 text-xs text-[var(--color-tekst-3)]">
              Jeden tag przed zamknięciem body. Skrypt sam pobiera najnowszy włączony popup,
              więc po włączeniu albo wyłączeniu popupu w panelu nic na stronie nie trzeba zmieniać.
            </p>
            <code className="karta-plaska block overflow-x-auto whitespace-nowrap px-3 py-2 text-[12px]">
              {snippet}
            </code>
          </section>
        </div>

        <section className="karta h-fit p-4">
          <h2 className="mb-1 text-sm font-semibold">Nowy popup</h2>
          <p className="mb-4 text-xs text-[var(--color-tekst-3)]">
            Popup rodzi się wyłączony: najpierw sprawdź treść, potem włącz go w tabeli.
          </p>
          <form action={utworzPopupAkcja} className="space-y-3">
            <input type="hidden" name="tenantId" value={tenantId} />
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">Nazwa robocza</span>
              <input name="name" required placeholder="np. Rabat powitalny" className="pole" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">Nagłówek</span>
              <input name="headline" required placeholder="np. -10% na pierwsze zakupy" className="pole" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">Treść</span>
              <textarea
                name="bodyText"
                required
                rows={3}
                placeholder="Zostaw adres e-mail, a wyślemy Ci kod rabatowy."
                className="pole"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">Tekst przycisku</span>
              <input name="buttonText" required placeholder="np. Odbieram rabat" className="pole" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">
                Kod rabatowy (opcjonalny)
              </span>
              <input name="discountCode" placeholder="np. WITAJ10" className="pole" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-tekst-3)]">
                Pokaż po (sekundy)
              </span>
              <input name="delaySeconds" type="number" min={0} max={600} defaultValue={5} className="pole" />
            </label>
            <button className="przycisk w-full justify-center" type="submit">
              Zapisz popup
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
