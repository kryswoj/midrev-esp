"use client";

import {
  kluczMetryki,
  etykietaMetryki,
  zdarzenieV1,
  type PonowneWejscie,
  type ZrodloWyzwalacza,
} from "../../../../../../domain/automatyzacje/graf";
import { EdytorFiltra, type KatalogFiltra } from "../../../../../ui/edytor-filtra";

/**
 * UI wyzwalacza: metryka albo lista, filtr wyzwalacza (wspolny EdytorFiltra, E4b 4.11:
 * pola z katalogu wlasciwosci metryki) i wybor ponownego wejscia.
 */

export interface MetrykaDoWyboru {
  integracja: string;
  nazwa: string;
  canTrigger: boolean;
  etykieta: string;
}

export function PanelZrodla({
  zrodlo,
  metryki,
  listy,
  grafV2Dostepny = false,
  katalog = null,
  onZmiana,
}: {
  zrodlo: ZrodloWyzwalacza;
  metryki: MetrykaDoWyboru[];
  listy: { id: string; name: string }[];
  katalog?: KatalogFiltra | null;
  /** false: tylko metryki wbudowane v1 i bez filtra (zapis w v1, bezpieczny rollback kodu) */
  grafV2Dostepny?: boolean;
  onZmiana: (z: ZrodloWyzwalacza) => void;
}) {
  const wybrana = zrodlo.rodzaj === "metryka" ? kluczMetryki(zrodlo.metryka) : "";
  // biezaca metryka zawsze na liscie (np. wbudowana, ktorej katalog jeszcze nie zna)
  const opcje = zrodlo.rodzaj === "metryka" && !metryki.some((m) => kluczMetryki(m) === wybrana)
    // spoza katalogu: wbudowana v1 jest poprawna, kazda inna (usunieta, cudza) jawnie niedostepna
    ? [...metryki, { ...zrodlo.metryka, canTrigger: zdarzenieV1(zrodlo.metryka) !== null, etykieta: `${etykietaMetryki(zrodlo.metryka)}${zdarzenieV1(zrodlo.metryka) ? "" : " (nie ma w koncie)"}` }]
    : metryki;
  return (
    <>
      <label className="block">
        <span className="etykieta mb-1 block">Rodzaj</span>
        <select className="pole" value={zrodlo.rodzaj} onChange={(e) => {
          if (e.target.value === "lista") onZmiana({ rodzaj: "lista", ...(listy[0] ? { listId: listy[0].id } : {}) });
          else {
            const m = metryki.find((x) => x.canTrigger) ?? { integracja: "midrev", nazwa: "Submitted Form" };
            onZmiana({ rodzaj: "metryka", metryka: { integracja: m.integracja, nazwa: m.nazwa } });
          }
        }}>
          <option value="metryka">Metryka (zdarzenie)</option>
          <option value="lista">Dołączenie do listy</option>
        </select>
      </label>
      {zrodlo.rodzaj === "metryka" ? (
        <>
          <label className="block">
            <span className="etykieta mb-1 block">Metryka</span>
            <select className="pole" value={wybrana} onChange={(e) => {
              const m = opcje.find((x) => kluczMetryki(x) === e.target.value);
              if (m) onZmiana({ ...zrodlo, metryka: { integracja: m.integracja, nazwa: m.nazwa } });
            }}>
              {opcje.map((m) => (
                <option key={kluczMetryki(m)} value={kluczMetryki(m)} disabled={!m.canTrigger || (!grafV2Dostepny && !zdarzenieV1(m))}>
                  {m.etykieta}{m.etykieta !== m.nazwa ? ` (${m.nazwa})` : ""}{m.canTrigger ? (!grafV2Dostepny && !zdarzenieV1(m) ? " — po włączeniu nowych automatyzacji" : "") : " — nie może uruchamiać"}
                </option>
              ))}
            </select>
          </label>
          <div>
            <span className="etykieta mb-1 block">Filtr wyzwalacza</span>
            {!grafV2Dostepny && !zrodlo.filtr ? (
              <p className="text-[12px] leading-4 text-[var(--color-tekst-3)]">Filtr wyzwalacza będzie dostępny po włączeniu nowych automatyzacji.</p>
            ) : (
            <EdytorFiltra rodzaje={["zdarzenie"]} katalog={katalog} filtr={zrodlo.filtr} etykietaDodaj="Dodaj filtr wyzwalacza" onZmiana={(filtr) => onZmiana(filtr ? { ...zrodlo, filtr } : { rodzaj: "metryka", metryka: zrodlo.metryka })} />
            )}
            {grafV2Dostepny || zrodlo.filtr ? <p className="mt-1.5 text-[12px] leading-4 text-[var(--color-tekst-3)]">Tylko zdarzenia spełniające filtr uruchamiają automatyzację. Tekst porównujemy dokładnie, z wielkością liter.</p> : null}
          </div>
        </>
      ) : (
        <>
          <label className="block">
            <span className="etykieta mb-1 block">Lista</span>
            {listy.length ? (
              <select className="pole" value={zrodlo.listId ?? ""} onChange={(e) => onZmiana({ ...zrodlo, listId: e.target.value })}>
                {listy.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            ) : <p className="text-[13px] text-[var(--color-tekst-2)]">Nie ma jeszcze żadnej listy.</p>}
          </label>
          <label className="flex items-start gap-2.5 rounded-md border border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-3 py-2.5 text-[13px] leading-5">
            <input type="checkbox" className="mt-1 accent-[var(--color-akcent)]" checked={zrodlo.takzeMasowe === true} onChange={(e) => onZmiana({ ...zrodlo, takzeMasowe: e.target.checked })} />
            <span>
              Także dodania masowe (import, cały segment)
              <span className="block text-[12px] text-[var(--color-czeka)]">Import tysięcy adresów na tę listę uruchomi automatyzację dla każdego z nich naraz. Domyślnie wchodzą tylko osoby dodane pojedynczo: ręcznie albo formularzem.</span>
            </span>
          </label>
        </>
      )}
      <p className="text-[12px] leading-4 text-[var(--color-tekst-3)]">Nie uruchamiają automatyzacji: zdarzenia sprzed jej włączenia, import historii, zdarzenia oznaczone jako uzupełnienie (backfill) i te, które dotarły do nas ponad 4 godziny po fakcie. Liczą się w statystykach, maili nie wysyłają.</p>
    </>
  );
}

export function WyborPonownegoWejscia({
  wartosc,
  dostepne,
  onZmiana,
}: {
  wartosc: PonowneWejscie;
  dostepne: boolean;
  onZmiana: (p: PonowneWejscie) => void;
}) {
  const opcja = (tryb: PonowneWejscie["tryb"], tytul: string, opis: string) => (
    <label className={`flex items-start gap-2.5 text-[13px] leading-5 ${tryb !== "raz" && !dostepne ? "opacity-60" : ""}`}>
      <input
        type="radio"
        name="ponowne-wejscie"
        className="mt-1 accent-[var(--color-akcent)]"
        checked={wartosc.tryb === tryb}
        disabled={tryb !== "raz" && !dostepne && wartosc.tryb !== tryb}
        onChange={() => onZmiana(tryb === "po" ? { tryb: "po", ilosc: 30, jednostka: "dni" } : { tryb })}
      />
      <span>{tytul}<span className="block text-[12px] text-[var(--color-tekst-3)]">{opis}</span></span>
    </label>
  );
  return (
    <div className="space-y-2">
      {opcja("raz", "Tylko raz", "Osoba przechodzi tę automatyzację najwyżej raz w życiu.")}
      {opcja("zawsze", "Za każdym razem", "Każde zdarzenie to nowy przebieg (np. dwa zamówienia = dwa podziękowania).")}
      {opcja("po", "Ponownie po upływie czasu", "Kolejne wejście dopiero, gdy od poprzedniego minął wskazany czas.")}
      {wartosc.tryb === "po" ? (
        <div className="grid grid-cols-[1fr_120px] gap-2 pl-6">
          <input type="number" min={1} max={100000} className="pole" aria-label="ile" value={wartosc.ilosc} onChange={(e) => onZmiana({ ...wartosc, ilosc: Math.max(1, Math.min(100000, Math.trunc(Number(e.target.value) || 1))) })} />
          <select className="pole" aria-label="jednostka" value={wartosc.jednostka} onChange={(e) => onZmiana({ ...wartosc, jednostka: e.target.value as "minuty" | "godziny" | "dni" })}>
            <option value="minuty">minut</option>
            <option value="godziny">godzin</option>
            <option value="dni">dni</option>
          </select>
        </div>
      ) : null}
      {!dostepne ? <p className="text-[12px] leading-4 text-[var(--color-czeka)]">Ponowne wejście włączymy po najbliższej aktualizacji systemu. Do tego czasu każda osoba wchodzi raz.</p> : null}
    </div>
  );
}
