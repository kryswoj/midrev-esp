"use client";

import { useState } from "react";
import { Monitor, MousePointerClick, Smartphone, X } from "lucide-react";
import type { DefinicjaFormularza } from "../../../../../domain/formularze/model";
import { opisRegul, type RegulyWyswietlania } from "../../../../../domain/formularze/wyswietlanie";
import { Kopiuj } from "../../../../_dns/kopiuj";

/**
 * Zakładka „Wyświetlanie” (Klaviyo: Targeting & Behaviors): kiedy, komu, gdzie, na jakich
 * urządzeniach i jak często. Na górze jedno zdanie podsumowania, które zmienia się na żywo.
 */

function Karta({ tytul, opis, children }: { tytul: string; opis?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--color-linia)] bg-white p-5 shadow-[var(--cien-karta)] max-md:p-4">
      <h2 className="text-[15px]">{tytul}</h2>
      {opis ? <p className="mt-0.5 text-[13px] text-[var(--color-tekst-2)]">{opis}</p> : null}
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function Liczba({ wartosc, onZmiana, min, maks, etykieta, szer = "w-[72px]" }: { wartosc: number; onZmiana: (n: number) => void; min: number; maks: number; etykieta: string; szer?: string }) {
  const [tekst, setTekst] = useState(String(wartosc));
  const [poprz, setPoprz] = useState(wartosc);
  if (poprz !== wartosc) {
    setPoprz(wartosc);
    setTekst(String(wartosc));
  }
  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={etykieta}
      min={min}
      max={maks}
      value={tekst}
      onChange={(e) => {
        setTekst(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n)) onZmiana(Math.min(maks, Math.max(min, Math.round(n))));
      }}
      onBlur={() => setTekst(String(wartosc))}
      className={`pole inline-block h-9 ${szer} px-2 text-center tabular-nums`}
    />
  );
}

function Wiersz({ zaznaczony, onZmiana, children, opis }: { zaznaczony: boolean; onZmiana: (z: boolean) => void; children: React.ReactNode; opis?: string }) {
  return (
    <div className={`flex items-start gap-3 rounded-[10px] border px-3.5 py-3 ${zaznaczony ? "border-[var(--color-akcent-ramka)] bg-[var(--color-akcent-tlo)]" : "border-[var(--color-linia)]"}`}>
      <input type="checkbox" checked={zaznaczony} onChange={(e) => onZmiana(e.target.checked)} className="mt-[9px] h-4 w-4 shrink-0 accent-[var(--color-akcent)]" aria-label={opis} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-[14px] leading-9">{children}</div>
    </div>
  );
}

function Wybor<T extends string>({ wartosc, onZmiana, opcje, nazwa }: { wartosc: T; onZmiana: (w: T) => void; opcje: { w: T; tytul: string; opis: string }[]; nazwa: string }) {
  return (
    <div role="radiogroup" aria-label={nazwa} className="grid gap-2 sm:grid-cols-3">
      {opcje.map((o) => (
        <label key={o.w} className={`cursor-pointer rounded-[10px] border px-3.5 py-3 ${wartosc === o.w ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)]" : "border-[var(--color-linia)] hover:border-[var(--color-linia-mocna)]"} has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-akcent)]`}>
          <input type="radio" name={nazwa} className="sr-only" checked={wartosc === o.w} onChange={() => onZmiana(o.w)} />
          <span className="block text-[14px] font-semibold">{o.tytul}</span>
          <span className="mt-0.5 block text-[12px] leading-[17px] text-[var(--color-tekst-2)]">{o.opis}</span>
        </label>
      ))}
    </div>
  );
}

function ListaFraz({ wartosci, onZmiana, placeholder, etykieta }: { wartosci: string[]; onZmiana: (w: string[]) => void; placeholder: string; etykieta: string }) {
  const [nowa, setNowa] = useState("");
  const dodaj = () => {
    const v = nowa.trim().slice(0, 200);
    if (v && !wartosci.includes(v) && wartosci.length < 20) onZmiana([...wartosci, v]);
    setNowa("");
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {wartosci.map((w) => (
          <span key={w} className="inline-flex h-8 items-center gap-1 rounded-full border border-[var(--color-linia-mocna)] bg-white pl-3 pr-1 font-mono text-[12px]">
            {w}
            <button type="button" aria-label={`Usuń ${w}`} onClick={() => onZmiana(wartosci.filter((x) => x !== w))} className="grid h-6 w-6 place-items-center rounded-full text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)]">
              <X size={13} />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={nowa}
          aria-label={etykieta}
          placeholder={placeholder}
          onChange={(e) => setNowa(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              dodaj();
            }
          }}
          className="pole font-mono text-[13px]"
        />
        <button type="button" className="przycisk przycisk-wtorny przycisk-maly shrink-0" onClick={dodaj} disabled={!nowa.trim()}>
          Dodaj
        </button>
      </div>
    </div>
  );
}

export function ZakladkaWyswietlanie({ def, zmienReguly, formId, snippet }: { def: DefinicjaFormularza; zmienReguly: (z: Partial<RegulyWyswietlania>) => void; formId: string; snippet: string }) {
  const r = def.wyswietlanie;
  const osadzony = def.typ === "embed";
  const znacznik = `<div data-midrev-form="${formId}"></div>`;
  return (
    <div className="h-full overflow-y-auto bg-[var(--color-plotno)]">
      <div className="mx-auto max-w-[780px] space-y-4 px-4 py-6 md:px-6">
        <div className="rounded-xl border border-[var(--color-akcent-ramka)] bg-[var(--color-akcent-tlo)] px-5 py-4" aria-live="polite">
          <div className="etykieta mb-1 !text-[var(--color-akcent)]">W skrócie</div>
          <p className="text-[15px] leading-[22px] text-[var(--color-tekst)]">{opisRegul(r, def.typ)}</p>
        </div>

        {osadzony ? (
          <Karta tytul="Gdzie stoi formularz" opis="Formularz osadzony pokazuje się w miejscu znacznika. Wklej go w treść strony, np. w stopce albo na stronie „Newsletter”.">
            <div className="flex items-center gap-2 max-md:flex-col max-md:items-stretch">
              <code className="karta-plaska block min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-4 py-3 font-mono text-[12px]">{znacznik}</code>
              <Kopiuj wartosc={znacznik} etykieta="znacznik formularza" />
            </div>
          </Karta>
        ) : (
          <Karta tytul="Kiedy pokazać" opis="Zaznacz jeden albo kilka warunków. Formularz pojawi się, gdy spełni się którykolwiek z nich (nie muszą wszystkie naraz).">
            <Wiersz zaznaczony={r.poSekundach !== null} onZmiana={(z) => zmienReguly({ poSekundach: z ? 5 : null })} opis="Po czasie na stronie">
              <span>Po</span>
              <Liczba etykieta="Sekundy" wartosc={r.poSekundach ?? 5} onZmiana={(n) => zmienReguly({ poSekundach: n })} min={0} maks={600} />
              <span>sekundach na stronie</span>
            </Wiersz>
            <Wiersz zaznaczony={r.poPrzewinieciu !== null} onZmiana={(z) => zmienReguly({ poPrzewinieciu: z ? 50 : null })} opis="Po przewinięciu strony">
              <span>Po przewinięciu</span>
              <Liczba etykieta="Procent strony" wartosc={r.poPrzewinieciu ?? 50} onZmiana={(n) => zmienReguly({ poPrzewinieciu: n })} min={1} maks={100} />
              <span>% strony</span>
            </Wiersz>
            <Wiersz zaznaczony={r.przyWyjsciu} onZmiana={(z) => zmienReguly({ przyWyjsciu: z })} opis="Przy próbie wyjścia">
              <span>Przy próbie wyjścia</span>
              <span className="text-[12px] text-[var(--color-tekst-3)]">kursor wyjeżdża nad pasek przeglądarki (tylko komputer)</span>
            </Wiersz>
            <Wiersz zaznaczony={r.poKliknieciu !== null} onZmiana={(z) => zmienReguly({ poKliknieciu: z ? 'a[href="#newsletter"]' : null })} opis="Po kliknięciu elementu">
              <MousePointerClick size={15} className="text-[var(--color-tekst-3)]" aria-hidden="true" />
              <span>Po kliknięciu elementu</span>
              {r.poKliknieciu !== null ? (
                <span className="w-full">
                  <input value={r.poKliknieciu} maxLength={200} aria-label="Selektor elementu" onChange={(e) => zmienReguly({ poKliknieciu: e.target.value || 'a[href="#newsletter"]' })} className="pole font-mono text-[13px]" />
                  <span className="mt-1 block text-[12px] leading-[17px] text-[var(--color-tekst-3)]">
                    Najprościej: link <code className="font-mono">&lt;a href=&quot;#newsletter&quot;&gt;</code> w menu sklepu. Kliknięcie otwiera formularz zawsze, także po wcześniejszym zamknięciu.
                  </span>
                </span>
              ) : null}
            </Wiersz>
          </Karta>
        )}

        {!osadzony ? (
          <Karta tytul="Komu">
            <Wybor
              nazwa="komu"
              wartosc={r.komu}
              onZmiana={(komu) => zmienReguly({ komu })}
              opcje={[
                { w: "nie_subskrybenci", tytul: "Jeszcze niezapisanym", opis: "Nie pokazuj osobom, które zapisały się przez dowolny formularz sklepu." },
                { w: "nowi", tytul: "Nowym odwiedzającym", opis: "Osoby w pierwszej wizycie w sklepie: przez 30 minut od pierwszego wejścia." },
                { w: "wszyscy", tytul: "Wszystkim", opis: "Także osobom już zapisanym." },
              ]}
            />
          </Karta>
        ) : null}

        <Karta tytul="Na jakich stronach" opis="Adres strony zawiera wpisany fragment, np. /produkt albo ?utm_source=instagram.">
          <div>
            <span className="etykieta mb-1.5 block">Pokazuj tylko, gdy adres zawiera (puste = wszystkie strony)</span>
            <ListaFraz etykieta="Fragment adresu do pokazania" wartosci={r.adresZawiera} onZmiana={(adresZawiera) => zmienReguly({ adresZawiera })} placeholder="/kolekcja" />
          </div>
          <div>
            <span className="etykieta mb-1.5 block">Nie pokazuj, gdy adres zawiera</span>
            <ListaFraz etykieta="Fragment adresu do wykluczenia" wartosci={r.adresWyklucz} onZmiana={(adresWyklucz) => zmienReguly({ adresWyklucz })} placeholder="/koszyk" />
          </div>
        </Karta>

        <Karta tytul="Urządzenia">
          <div role="radiogroup" aria-label="Urządzenia" className="inline-flex rounded-lg border border-[var(--color-linia-mocna)] bg-[var(--color-powierzchnia-2)] p-0.5">
            {(
              [
                ["wszystkie", "Komputer i telefon", null],
                ["komputer", "Tylko komputer", <Monitor key="m" size={14} />],
                ["telefon", "Tylko telefon", <Smartphone key="s" size={14} />],
              ] as const
            ).map(([w, t, ik]) => (
              <button key={w} type="button" role="radio" aria-checked={r.urzadzenia === w} onClick={() => zmienReguly({ urzadzenia: w })} className={`flex h-9 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium ${r.urzadzenia === w ? "bg-white text-[var(--color-tekst)] shadow-[var(--cien-karta)]" : "text-[var(--color-tekst-2)] hover:text-[var(--color-tekst)]"}`}>
                {ik}
                {t}
              </button>
            ))}
          </div>
        </Karta>

        {!osadzony ? (
          <Karta tytul="Jak często">
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <span>Po zamknięciu nie pokazuj ponownie przez</span>
              <Liczba etykieta="Dni" wartosc={r.poZamknieciuDni} onZmiana={(n) => zmienReguly({ poZamknieciuDni: n })} min={0} maks={365} />
              <span>dni</span>
              <span className="w-full text-[12px] text-[var(--color-tekst-3)]">0 = pokaż znowu przy kolejnej odsłonie. Pamiętamy to w przeglądarce osoby.</span>
            </div>
            <label className="flex cursor-pointer items-center gap-2.5 text-[14px]">
              <input type="checkbox" checked={r.poZapisieNigdy} onChange={(e) => zmienReguly({ poZapisieNigdy: e.target.checked })} className="h-4 w-4 accent-[var(--color-akcent)]" />
              Po zapisie przez ten formularz nie pokazuj go już nigdy
            </label>
          </Karta>
        ) : null}

        <Karta tytul="Instalacja" opis="Jeden tag na całym sklepie obsługuje wszystkie formularze. Jeśli już go wkleiłeś, nic nie zmieniaj.">
          <div className="flex items-center gap-2 max-md:flex-col max-md:items-stretch">
            <code className="karta-plaska block min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-4 py-3 font-mono text-[12px]">{snippet}</code>
            <Kopiuj wartosc={snippet} etykieta="tag skryptu" />
          </div>
        </Karta>
      </div>
    </div>
  );
}
