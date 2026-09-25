"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { autozapisUstawienAkcja, zapiszUstawieniaAkcja } from "../../../../../akcje";
import { BladFormularza } from "../../../../../blad-formularza";

/**
 * Krok 3: nazwa robocza, temat i preheader, z podglądem skrzynki odbiorczej obok —
 * operator widzi, jak temat i preheader złożą się w jedną linijkę na liście maili.
 * useActionState: błąd zapisu nie kasuje wpisanych pól (audyt B4).
 */
export function FormularzUstawien({
  tenantId,
  campaignId,
  nazwa,
  temat,
  preheader,
  nadawcaNazwa,
  poWysylce,
  autozapis,
  children,
}: {
  tenantId: string;
  campaignId: string;
  nazwa: string;
  temat: string;
  preheader: string;
  nadawcaNazwa: string;
  poWysylce: boolean;
  /** szkic zapisuje się sam; kampania u klienta — ręcznie, bo zmiana cofa akceptację */
  autozapis: boolean;
  /** karta nadawcy (renderowana na serwerze) pod polami tematu */
  children?: React.ReactNode;
}) {
  const [stan, akcja, trwa] = useActionState(zapiszUstawieniaAkcja, undefined);
  const [t, setT] = useState(stan?.wartosci?.temat ?? temat);
  const [p, setP] = useState(stan?.wartosci?.preheader ?? preheader);
  const [n, setN] = useState(stan?.wartosci?.nazwa ?? nazwa);
  const [auto, setAuto] = useState<{ trwa: boolean; blad?: string; zapisano?: boolean }>({ trwa: false });
  const zapisane = useRef(JSON.stringify({ n: nazwa, t: temat, p: preheader }));
  // `wersja` rośnie po każdym zakończonym zapisie: efekt autozapisu porównuje wtedy ekran
  // z tym, co NAPRAWDĘ zapisano (cofnięcie do A w trakcie zapisu B musi dostać własny zapis)
  const [wersja, setWersja] = useState(0);
  const ostatnioWyslana = useRef(zapisane.current);
  // „brudny" także wtedy, gdy ekran wrócił do zapisanej wersji A, a w drodze jest jeszcze B:
  // bez tego wyjście przepuściłoby B do bazy (review Codeksa, runda 4)
  const ekran = JSON.stringify({ n, t, p });
  const brudny = ekran !== zapisane.current || ekran !== ostatnioWyslana.current;
  const stanRef = useRef({ brudny, n, t, p });
  stanRef.current = { brudny, n, t, p };

  // Zapisy w kolejce (jeden po drugim) i pamięć ostatnio WYSŁANEJ wersji: cofnięcie ekranu
  // do A w trakcie zapisu B musi trafić do bazy, także przy wyjściu z kroku (review Codeksa).
  const kolejka = useRef<Promise<unknown>>(Promise.resolve());
  // migawka, której zapis serwer odrzucił: tej samej nie ponawiamy w kółko (np. za długa nazwa)
  const odrzucona = useRef<string | null>(null);

  /** Zapis bieżącego stanu ekranu. Zwraca true, gdy w bazie leży dokładnie ten stan. */
  const zapiszTeraz = (): Promise<boolean> => {
    const { n: nn, t: tt, p: pp } = stanRef.current;
    const migawka = JSON.stringify({ n: nn, t: tt, p: pp });
    if (migawka === ostatnioWyslana.current && migawka === zapisane.current) return Promise.resolve(true);
    if (!nn.trim()) {
      setAuto({ trwa: false, blad: "Nazwa robocza nie może być pusta." });
      odrzucona.current = migawka;
      return Promise.resolve(false);
    }
    ostatnioWyslana.current = migawka;
    const zadanie = kolejka.current.then(async () => {
      setAuto({ trwa: true });
      try {
        const w = await autozapisUstawienAkcja(tenantId, campaignId, { nazwa: nn, temat: tt, preheader: pp });
        if (!w.ok) {
          odrzucona.current = migawka;
          setAuto({ trwa: false, blad: w.blad });
          return false;
        }
        zapisane.current = migawka;
        odrzucona.current = null;
        const teraz = JSON.stringify({ n: stanRef.current.n, t: stanRef.current.t, p: stanRef.current.p });
        stanRef.current = { ...stanRef.current, brudny: teraz !== migawka || teraz !== ostatnioWyslana.current };
        setAuto({ trwa: false, zapisano: true, blad: w.planZdjety ? "Plan wysyłki zdjęty — zaplanuj ponownie w przeglądzie." : undefined });
        return true;
      } catch {
        odrzucona.current = migawka;
        setAuto({ trwa: false, blad: "Brak połączenia z serwerem — zmiany NIE zostały zapisane." });
        return false;
      } finally {
        setWersja((v) => v + 1);
      }
    });
    kolejka.current = zadanie.catch(() => false);
    return zadanie;
  };
  const zapiszRef = useRef(zapiszTeraz);
  zapiszRef.current = zapiszTeraz;

  useEffect(() => {
    if (!autozapis || poWysylce || !brudny || auto.trwa) return;
    if (JSON.stringify({ n, t, p }) === odrzucona.current) return;
    const timer = setTimeout(() => void zapiszRef.current(), 1000);
    return () => clearTimeout(timer);
  }, [autozapis, poWysylce, brudny, n, t, p, wersja, auto.trwa]);

  // Wyjście z kroku przed upływem sekundy nie może zgubić wpisanego tematu (review Codeksa):
  // link — zapis i dopiero potem przejście; zamknięcie karty — ostrzeżenie; nawigacja
  // historią (Wstecz) odmontowuje formularz — wtedy zapis „w tle" przy odmontowaniu.
  useEffect(() => {
    if (poWysylce) return;
    const klik = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!a || !stanRef.current.brudny || a.target === "_blank" || e.button !== 0 || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (!autozapis) {
        if (window.confirm("Masz niezapisane zmiany tematu. Wyjść bez zapisywania?")) {
          stanRef.current = { ...stanRef.current, brudny: false };
          window.location.assign(a.href);
        }
        return;
      }
      void zapiszRef.current().then((ok) => {
        if (ok) window.location.assign(a.href);
      });
    };
    const przedWyjsciem = (e: BeforeUnloadEvent) => {
      if (!stanRef.current.brudny) return;
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("click", klik, true);
    window.addEventListener("beforeunload", przedWyjsciem);
    return () => {
      document.removeEventListener("click", klik, true);
      window.removeEventListener("beforeunload", przedWyjsciem);
      // porównanie z ostatnio WYSŁANĄ wersją (nie z potwierdzoną) — zapis w tle przy wyjściu
      const { n: nn, t: tt, p: pp } = stanRef.current;
      if (autozapis && JSON.stringify({ n: nn, t: tt, p: pp }) !== ostatnioWyslana.current) void zapiszRef.current();
    };
  }, [autozapis, poWysylce]);

  const licznik = (dl: number, zalecane: number) => (
    <span className={`text-[12px] ${dl > zalecane ? "text-[var(--color-czeka)]" : "text-[var(--color-tekst-3)]"}`}>
      {dl}/{zalecane} znaków{dl > zalecane ? " — skrzynka może uciąć" : ""}
    </span>
  );

  return (
    <form action={akcja}>
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="campaignId" value={campaignId} />
      <div className="grid gap-6 p-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-6">
        <section className="karta space-y-5 p-5">
          <BladFormularza blad={stan?.blad} />
          <label className="block">
            <span className="etykieta mb-1.5 block">Nazwa robocza (widzi ją tylko zespół)</span>
            <input name="nazwa" value={n} onChange={(e) => setN(e.target.value)} required readOnly={poWysylce} className="pole" />
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center justify-between">
              <span className="etykieta">Temat</span>
              {licznik(t.length, 60)}
            </span>
            <input
              name="temat"
              value={t}
              onChange={(e) => setT(e.target.value)}
              readOnly={poWysylce}
              maxLength={250}
              className="pole"
              placeholder="to zobaczy odbiorca w skrzynce"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center justify-between">
              <span className="etykieta">Preheader</span>
              {licznik(p.length, 90)}
            </span>
            <input
              name="preheader"
              value={p}
              onChange={(e) => setP(e.target.value)}
              readOnly={poWysylce}
              maxLength={250}
              className="pole"
              placeholder="szara linijka obok tematu, dopowiada go"
            />
            <span className="mt-1.5 block text-[12px] text-[var(--color-tekst-3)]">
              Trafia do maila jako ukryta pierwsza linijka treści. Bez niej skrzynka pokaże tu początek maila.
            </span>
          </label>
        </section>
        {children}
        </div>

        <aside className="karta h-fit overflow-hidden">
          <div className="karta-naglowek">
            <h2>Tak to zobaczy odbiorca</h2>
          </div>
          <div className="bg-[var(--color-powierzchnia-2)] p-4">
            <div className="rounded-[10px] border border-[var(--color-linia)] bg-white shadow-[var(--cien-karta)]">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className={`flex gap-3 px-4 py-3 ${i === 0 ? "border-b border-[var(--color-linia-0)]" : "opacity-40"}`}
                >
                  <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--color-akcent-tlo)] text-[13px] font-semibold text-[var(--color-akcent)]">
                    {(i === 0 ? nadawcaNazwa : "Inny sklep").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[14px] font-semibold">{i === 0 ? nadawcaNazwa : "Inny sklep"}</span>
                      <span className="shrink-0 text-[12px] text-[var(--color-tekst-3)]">{i === 0 ? "teraz" : "wczoraj"}</span>
                    </span>
                    <span className="block truncate text-[13px] font-medium">
                      {i === 0 ? t || "(brak tematu)" : "Nowa kolekcja już jest"}
                    </span>
                    <span className="block truncate text-[13px] text-[var(--color-tekst-2)]">
                      {i === 0 ? p || "(brak preheadera — skrzynka pokaże początek treści)" : "Sprawdź, co dla Ciebie mamy"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-linia)] px-5 py-4">
        <a href={`/t/${tenantId}/kampanie/${campaignId}/tresc`} className="przycisk przycisk-wtorny">
          ← Treść
        </a>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {poWysylce ? (
            <span className="text-[13px] text-[var(--color-tekst-2)]">
              po starcie wysyłki temat jest zamrożony razem z treścią
            </span>
          ) : autozapis ? (
            <>
              <span className="flex items-center gap-1.5 text-[13px]" role="status">
                {auto.trwa ? (
                  <>
                    <Loader2 size={14} className="animate-spin text-[var(--color-tekst-3)]" /> <span className="text-[var(--color-tekst-2)]">Zapisuję…</span>
                  </>
                ) : auto.blad ? (
                  <>
                    <AlertTriangle size={14} className="text-[var(--color-blad)]" /> <span className="text-[var(--color-blad)]">{auto.blad}</span>
                  </>
                ) : (
                  <>
                    {brudny ? (
                      <span className="flex items-center gap-1.5 font-medium text-[var(--color-czeka)]">
                        <span className="h-2 w-2 rounded-full bg-[var(--color-czeka)]" /> Niezapisane zmiany
                      </span>
                    ) : (
                      <>
                        <Check size={14} className="text-[var(--color-ok)]" /> <span className="text-[var(--color-tekst-2)]">{auto.zapisano ? "Zapisano" : "Wszystko zapisane"}</span>
                      </>
                    )}
                  </>
                )}
              </span>
              <a
                href={`/t/${tenantId}/kampanie/${campaignId}`}
                className="przycisk"
              >
                Dalej: przegląd →
              </a>
            </>
          ) : (
            <>
              <span className="text-[12px] text-[var(--color-czeka)]">Zmiana tematu cofnie kampanię do szkicu i unieważni link klienta.</span>
              <button className="przycisk przycisk-wtorny" type="submit" name="dalej" value="nie" disabled={trwa}>
                {trwa ? "Zapisuję…" : "Zapisz"}
              </button>
              <button className="przycisk" type="submit" name="dalej" value="tak" disabled={trwa}>
                Zapisz i przejdź do przeglądu →
              </button>
            </>
          )}
        </div>
      </div>
    </form>
  );
}
