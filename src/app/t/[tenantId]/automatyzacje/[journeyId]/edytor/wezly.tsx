"use client";

import Link from "next/link";
import { AlertTriangle, Banknote, ExternalLink, MousePointerClick, PackageCheck, Send, Trash2, Users } from "lucide-react";
import { zGroszy } from "../../../../../../domain/kwoty";
import { odmien } from "../../../../../../domain/liczebniki";
import {
  DNI_TYGODNIA,
  NAZWY_WEZLOW,
  opiszWezel,
  tytulWezla,
  type RegulaWarunku,
  type Slowniki,
  type Wezel,
} from "../../../../../../domain/automatyzacje/graf";
import type { StatystykiEmaila } from "../../../../../../usecases/automatyzacje/journeye";
import { IKONY_WEZLOW, KAFELEK } from "./biblioteka-krokow";
import { PanelZrodla, type MetrykaDoWyboru } from "./wyzwalacz";

export type Tryb = "edycja" | "analityka";

/** Wysokosc karty na kanwie: staly wymiar per typ i tryb, zeby uklad byl deterministyczny. */
export function wysokoscWezla(w: Wezel, tryb: Tryb): number {
  if (w.typ === "koniec") return 32;
  if (w.typ === "email") return tryb === "analityka" ? 228 : 140;
  return 132;
}

export interface StatWezla {
  wToku: number;
  /** tylko wyzwalacz: ile osob weszlo lacznie */
  weszlo?: number;
  zakonczeni: number;
  email: StatystykiEmaila | null;
}

export function KartaWezla({
  wezel,
  slowniki,
  zaznaczony,
  tryb,
  stat,
  blad,
  waluta,
  onZaznacz,
  onUsun,
}: {
  wezel: Wezel;
  slowniki: Slowniki;
  zaznaczony: boolean;
  tryb: Tryb;
  stat: StatWezla;
  blad: string | null;
  waluta: string;
  onZaznacz: () => void;
  onUsun: (() => void) | null;
}) {
  if (wezel.typ === "koniec") {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); onZaznacz(); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onZaznacz(); } }}
        aria-label={`Koniec ścieżki, zakończyło ${stat.zakonczeni}`}
        className={`flex h-full w-full items-center justify-center gap-1.5 rounded-full border text-[12px] font-medium ${
          zaznaczony ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]" : "border-[var(--color-linia)] bg-[var(--color-powierzchnia-2)] text-[var(--color-tekst-2)]"
        }`}
      >
        Koniec
        {stat.zakonczeni > 0 ? <span className="liczba rounded-full bg-white px-1.5 text-[11px] text-[var(--color-tekst-3)]">{stat.zakonczeni}</span> : null}
      </div>
    );
  }
  const Ikona = IKONY_WEZLOW[wezel.typ];
  const tytul = tytulWezla(wezel, slowniki);
  const opis = opiszWezel(wezel, slowniki);
  const e = wezel.typ === "email" ? stat.email : null;
  return (
    <div
      role="button"
      tabIndex={0}
      data-wezel={wezel.id}
      onClick={(ev) => { ev.stopPropagation(); onZaznacz(); }}
      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onZaznacz(); } }}
      aria-label={`${NAZWY_WEZLOW[wezel.typ]}: ${tytul}${zaznaczony ? ", zaznaczony" : ""}`}
      className={`group/karta flex h-full w-full flex-col rounded-xl border bg-white text-left shadow-[var(--cien-karta)] transition-[box-shadow,border-color] ${
        zaznaczony ? "border-[var(--color-akcent)] ring-2 ring-[var(--color-akcent-ramka)]" : blad ? "border-[var(--color-blad-ramka)]" : "border-[var(--color-linia)] hover:border-[var(--color-linia-mocna)] hover:shadow-[var(--cien-uniesiony)]"
      }`}
    >
      <div className="flex items-center gap-2.5 px-3.5 pt-3">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${KAFELEK[wezel.typ]}`}><Ikona size={16} strokeWidth={2} /></span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-5">{tytul}</span>
        {onUsun ? (
          <button
            type="button"
            onClick={(ev) => { ev.stopPropagation(); onUsun(); }}
            aria-label={`Usuń krok: ${tytul}`}
            title="Usuń krok"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--color-tekst-3)] opacity-0 hover:bg-[var(--color-blad-tlo)] hover:text-[var(--color-blad)] focus-visible:opacity-100 group-hover/karta:opacity-100"
          >
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>
      <div className="mx-3.5 mt-2.5 shrink-0 truncate rounded-md bg-[var(--color-powierzchnia-2)] px-2.5 py-1.5 text-[13px] leading-5 text-[var(--color-tekst-2)]" title={opis}>
        {opis}
      </div>
      {wezel.typ === "email" && tryb === "analityka" ? (
        <dl className="mx-3.5 mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[12px] leading-4">
          <dt className="flex items-center gap-1.5 text-[var(--color-tekst-2)]"><Send size={12} /> Wysłane</dt>
          <dd className="liczba text-right font-semibold">{e?.wyslane ?? 0}</dd>
          <dt className="flex items-center gap-1.5 text-[var(--color-tekst-2)]"><PackageCheck size={12} /> Dostarczone</dt>
          <dd className="liczba text-right font-semibold">{e?.dostarczone ?? 0}</dd>
          <dt className="flex items-center gap-1.5 text-[var(--color-tekst-2)]"><MousePointerClick size={12} /> Kliknięcia</dt>
          <dd className="liczba text-right font-semibold">{e?.klikniecia ?? 0}</dd>
          <dt className="flex items-center gap-1.5 text-[var(--color-tekst-2)]"><Banknote size={12} /> Przychód</dt>
          <dd className="liczba text-right font-semibold" title={e?.przychodMinor === null ? "Atrybucji jeszcze nie przeliczono" : undefined}>
            {e && e.przychodMinor !== null && e.przychodMinor !== undefined ? zGroszy(e.przychodMinor, waluta) : "—"}
            {e && e.zamowien ? <span className="ml-1 font-normal text-[var(--color-tekst-3)]">({e.zamowien} zam.)</span> : null}
          </dd>
        </dl>
      ) : null}
      <div className="mt-auto flex items-center gap-2 px-3.5 pb-3 pt-2 text-[12px] leading-4">
        {wezel.typ === "wyzwalacz" ? (
          <span className="flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-linia)] bg-white px-2 py-0.5 text-[var(--color-tekst-2)]" title="Osoby, które weszły do automatyzacji">
            <Users size={12} /> <span className="liczba font-semibold text-[var(--color-tekst)]">{stat.weszlo ?? 0}</span> weszło
          </span>
        ) : (
          <span className="flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-linia)] bg-white px-2 py-0.5 text-[var(--color-tekst-2)]" title="Osoby, które są teraz w tym kroku">
            <Users size={12} /> <span className="liczba font-semibold text-[var(--color-tekst)]">{stat.wToku}</span> w tym kroku
          </span>
        )}
        {wezel.typ === "email" && tryb === "edycja" ? (
          <span className="flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-linia)] bg-white px-2 py-0.5 text-[var(--color-tekst-2)]" title="Maile wysłane z tego kroku">
            <Send size={12} /> <span className="liczba font-semibold text-[var(--color-tekst)]">{e?.wyslane ?? 0}</span> wysłane
          </span>
        ) : null}
        {blad ? <span className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--color-blad-tlo)] text-[var(--color-blad)]" title={blad}><AlertTriangle size={13} aria-hidden="true" /><span className="sr-only">Do poprawy: {blad}</span></span> : null}
      </div>
    </div>
  );
}

// ── Panel wlasciwosci ────────────────────────────────────────────────────────

const RODZAJE_REGUL: { rodzaj: RegulaWarunku["rodzaj"]; etykieta: string }[] = [
  { rodzaj: "kupil_od_wejscia", etykieta: "kupił od wejścia do automatyzacji" },
  { rodzaj: "kupil_w_dniach", etykieta: "kupił w ostatnich N dniach" },
  { rodzaj: "kliknal_poprzedni", etykieta: "kliknął w poprzedni e-mail" },
  { rodzaj: "ma_zgode", etykieta: "ma zgodę na e-mail" },
  { rodzaj: "w_segmencie", etykieta: "jest w segmencie" },
  { rodzaj: "wartosc_zamowienia", etykieta: "zamówienie warte co najmniej" },
];

function domyslnaRegula(rodzaj: RegulaWarunku["rodzaj"], segmenty: { id: string }[]): RegulaWarunku {
  switch (rodzaj) {
    case "kupil_w_dniach": return { rodzaj, dni: 30 };
    case "w_segmencie": return { rodzaj, segmentId: segmenty[0]?.id ?? "" };
    case "wartosc_zamowienia": return { rodzaj, minMinor: 20000 };
    default: return { rodzaj } as RegulaWarunku;
  }
}

function Sekcja({ tytul, children }: { tytul: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-[var(--color-linia-0)] px-4 py-4">
      <h3 className="mb-3 text-[13px] font-semibold text-[var(--color-tekst)]">{tytul}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Pole({ etykieta, children, podpowiedz }: { etykieta: string; children: React.ReactNode; podpowiedz?: string }) {
  return (
    <label className="block">
      <span className="etykieta mb-1 block">{etykieta}</span>
      {children}
      {podpowiedz ? <span className="mt-1 block text-[12px] leading-4 text-[var(--color-tekst-3)]">{podpowiedz}</span> : null}
    </label>
  );
}

export function PanelWezla({
  wezel,
  slowniki,
  listy,
  segmenty,
  metryki = [],
  grafV2Dostepny = false,
  emaile,
  bledy,
  ostrzezenia = [],
  tenantId,
  flowId,
  stat,
  onZmiana,
  onZmianaEmaila,
  onUsun,
}: {
  wezel: Wezel;
  slowniki: Slowniki;
  listy: { id: string; name: string }[];
  segmenty: { id: string; name: string }[];
  metryki?: MetrykaDoWyboru[];
  grafV2Dostepny?: boolean;
  emaile: Record<string, { nazwa: string; temat: string; maTresc: boolean }>;
  bledy: string[];
  ostrzezenia?: string[];
  tenantId: string;
  flowId: string;
  stat: StatWezla;
  onZmiana: (zmiany: Partial<Wezel>) => void;
  onZmianaEmaila: (emailId: string, zmiany: { nazwa?: string; temat?: string }) => void;
  onUsun: (() => void) | null;
}) {
  const Ikona = IKONY_WEZLOW[wezel.typ];
  // brak tematu i brak tresci pokazujemy przy polach maila, nie w banerze nad panelem
  const BEZ_TEMATU = "Wiadomość nie ma tematu.";
  const bezTematu = wezel.typ === "email" && (bledy.includes(BEZ_TEMATU) || !(emaile[wezel.emailId]?.temat ?? "").trim());
  const bledyBanera = wezel.typ === "email" ? bledy.filter((b) => b !== BEZ_TEMATU && b !== "Wiadomość nie ma treści.") : bledy;
  return (
    <div>
      <div className="flex items-center gap-2.5 border-b border-[var(--color-linia)] px-4 py-3.5">
        <span className={`grid h-8 w-8 place-items-center rounded-lg ${KAFELEK[wezel.typ]}`}><Ikona size={16} /></span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold leading-5">{NAZWY_WEZLOW[wezel.typ]}</div>
          <div className="text-[12px] leading-4 text-[var(--color-tekst-3)]">{odmien(stat.wToku, "osoba", "osoby", "osób")} w tym kroku</div>
        </div>
      </div>
      {bledyBanera.length ? (
        <div className="border-b border-[var(--color-linia-0)] bg-[var(--color-blad-tlo)] px-4 py-3 text-[12px] leading-4 text-[var(--color-blad)]" role="alert">
          {bledyBanera.map((b) => <p key={b} className="flex items-start gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{b}</p>)}
        </div>
      ) : null}

      {ostrzezenia.length ? (
        <div className="border-b border-[var(--color-linia-0)] bg-[var(--color-czeka-tlo)] px-4 py-3 text-[12px] leading-4 text-[var(--color-czeka)]">
          {ostrzezenia.map((b) => <p key={b} className="flex items-start gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{b}</p>)}
        </div>
      ) : null}
      {wezel.typ === "wyzwalacz" ? (
        <Sekcja tytul="Kiedy osoba wchodzi">
          <PanelZrodla zrodlo={wezel.zrodlo} metryki={metryki} listy={listy} grafV2Dostepny={grafV2Dostepny} onZmiana={(zrodlo) => onZmiana({ zrodlo } as Partial<Wezel>)} />
        </Sekcja>
      ) : null}

      {wezel.typ === "opoznienie" ? (
        <Sekcja tytul="Ile czekać">
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <Pole etykieta="Ilość">
              <input type="number" min={1} max={100000} className="pole" value={wezel.ilosc} onChange={(e) => onZmiana({ ilosc: Math.max(1, Math.min(100000, Math.trunc(Number(e.target.value) || 1))) } as Partial<Wezel>)} />
            </Pole>
            <Pole etykieta="Jednostka">
              <select className="pole" value={wezel.jednostka} onChange={(e) => onZmiana({ jednostka: e.target.value } as Partial<Wezel>)}>
                <option value="minuty">minut</option>
                <option value="godziny">godzin</option>
                <option value="dni">dni</option>
              </select>
            </Pole>
          </div>
          <p className="text-[12px] leading-4 text-[var(--color-tekst-3)]">Liczone od chwili wejścia w ten krok. Pierwsze opóźnienie liczy się od daty zdarzenia, nie od tiku systemu.</p>
        </Sekcja>
      ) : null}

      {wezel.typ === "czekaj_do" ? (
        <Sekcja tytul="Do kiedy czekać">
          <Pole etykieta="Dni tygodnia">
            <div className="flex flex-wrap gap-1.5">
              {DNI_TYGODNIA.map((d, i) => {
                const nr = i + 1;
                const wybrany = wezel.dni.includes(nr);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={wybrany}
                    onClick={() => {
                      const dni = wybrany ? wezel.dni.filter((x) => x !== nr) : [...wezel.dni, nr].sort((a, b) => a - b);
                      if (dni.length) onZmiana({ dni } as Partial<Wezel>);
                    }}
                    className={`h-8 w-9 rounded-md border text-[12px] font-medium ${wybrany ? "border-[var(--color-akcent)] bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]" : "border-[var(--color-linia-mocna)] bg-white text-[var(--color-tekst-2)]"}`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </Pole>
          <Pole etykieta="Godzina" podpowiedz="Czas polski (Europe/Warsaw). Najbliższy wskazany dzień po wejściu w krok.">
            <input type="time" className="pole" value={wezel.godzina} onChange={(e) => e.target.value && onZmiana({ godzina: e.target.value } as Partial<Wezel>)} />
          </Pole>
        </Sekcja>
      ) : null}

      {wezel.typ === "warunek" ? (
        <Sekcja tytul="Warunek (Tak / Nie)">
          <Pole etykieta="Nazwa kroku (opcjonalnie)">
            <input className="pole" maxLength={80} placeholder="np. Kupił po zapisie?" value={wezel.etykieta ?? ""} onChange={(e) => onZmiana({ etykieta: e.target.value } as Partial<Wezel>)} />
          </Pole>
          <Pole etykieta="Osoba…">
            <select className="pole" value={wezel.regula.rodzaj} onChange={(e) => onZmiana({ regula: domyslnaRegula(e.target.value as RegulaWarunku["rodzaj"], segmenty) } as Partial<Wezel>)}>
              {RODZAJE_REGUL.map((r) => <option key={r.rodzaj} value={r.rodzaj} disabled={r.rodzaj === "w_segmencie" && !segmenty.length}>{r.etykieta}{r.rodzaj === "w_segmencie" && !segmenty.length ? " (brak segmentów)" : ""}</option>)}
            </select>
          </Pole>
          {wezel.regula.rodzaj === "kupil_w_dniach" ? (
            <Pole etykieta="Liczba dni">
              <input type="number" min={1} max={3650} className="pole" value={wezel.regula.dni} onChange={(e) => onZmiana({ regula: { rodzaj: "kupil_w_dniach", dni: Math.max(1, Math.min(3650, Math.trunc(Number(e.target.value) || 1))) } } as Partial<Wezel>)} />
            </Pole>
          ) : null}
          {wezel.regula.rodzaj === "w_segmencie" ? (
            <Pole etykieta="Segment">
              <select className="pole" value={wezel.regula.segmentId} onChange={(e) => onZmiana({ regula: { rodzaj: "w_segmencie", segmentId: e.target.value } } as Partial<Wezel>)}>
                {segmenty.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Pole>
          ) : null}
          {wezel.regula.rodzaj === "wartosc_zamowienia" ? (
            <Pole etykieta="Kwota (zł)" podpowiedz="Liczą się tylko zamówienia opłacone (w realizacji albo zrealizowane): zamówienie z wyzwalacza, a gdy go nie ma, najnowsze od wejścia do automatyzacji. Zaraz po złożeniu zamówienie bywa jeszcze nieopłacone, dlatego przed tym warunkiem postaw opóźnienie.">
              <input type="number" min={0} step={1} className="pole" value={Math.floor(wezel.regula.minMinor / 100)} onChange={(e) => onZmiana({ regula: { rodzaj: "wartosc_zamowienia", minMinor: Math.max(0, Math.trunc(Number(e.target.value) || 0)) * 100 } } as Partial<Wezel>)} />
            </Pole>
          ) : null}
          <p className="text-[12px] leading-4 text-[var(--color-tekst-3)]">Sprawdzane na danych z chwili, w której osoba dochodzi do tego kroku. Chcesz dać jej czas na zakup? Postaw opóźnienie przed warunkiem.</p>
        </Sekcja>
      ) : null}

      {wezel.typ === "ab_split" ? (
        <Sekcja tytul="Podział ruchu">
          <Pole etykieta={`Gałąź A: ${wezel.procentA}% · gałąź B: ${100 - wezel.procentA}%`}>
            <input type="range" min={1} max={99} value={wezel.procentA} onChange={(e) => onZmiana({ procentA: Number(e.target.value) } as Partial<Wezel>)} className="w-full accent-[var(--color-akcent)]" aria-label="Procent osób na gałąź A" />
          </Pole>
          <p className="text-[12px] leading-4 text-[var(--color-tekst-3)]">Losowanie przy dojściu do kroku. Zwycięzcę wybierasz sam, porównując maile w trybie analityki.</p>
        </Sekcja>
      ) : null}

      {wezel.typ === "email" ? (
        <>
          <Sekcja tytul="Wiadomość">
            <Pole etykieta="Nazwa robocza">
              <input className="pole" maxLength={200} value={emaile[wezel.emailId]?.nazwa ?? ""} onChange={(e) => onZmianaEmaila(wezel.emailId, { nazwa: e.target.value })} />
            </Pole>
            <Pole etykieta="Temat" podpowiedz={bezTematu ? undefined : "To zobaczy odbiorca."}>
              <input className={`pole ${bezTematu ? "!border-[var(--color-blad-ramka)]" : ""}`} aria-invalid={bezTematu || undefined} data-niepoprawne={bezTematu || undefined} maxLength={250} placeholder="np. Witaj! Dobrze, że jesteś" value={emaile[wezel.emailId]?.temat ?? ""} onChange={(e) => onZmianaEmaila(wezel.emailId, { temat: e.target.value })} />
              {bezTematu ? <span className="mt-1 block text-[12px] leading-4 text-[var(--color-blad)]">Wpisz temat. Bez niego automatyzacji nie da się włączyć.</span> : null}
            </Pole>
            <Link href={`/t/${tenantId}/automatyzacje/${flowId}/edytor/wiadomosc/${wezel.emailId}`} className="przycisk w-full">
              {emaile[wezel.emailId]?.maTresc ? "Edytuj treść" : "Ułóż treść"} <ExternalLink size={14} />
            </Link>
            {!emaile[wezel.emailId]?.maTresc ? <p className="text-[12px] leading-4 text-[var(--color-blad)]">Wiadomość nie ma jeszcze treści. Bez niej automatyzacji nie da się włączyć.</p> : null}
          </Sekcja>
          {stat.email && stat.email.wyslane > 0 ? (
            <Sekcja tytul="Wyniki tego maila">
              <dl className="grid grid-cols-2 gap-2 text-[13px]">
                <div className="rounded-md bg-[var(--color-powierzchnia-2)] px-3 py-2"><dt className="etykieta">Wysłane</dt><dd className="liczba text-[16px] font-semibold">{stat.email.wyslane}</dd></div>
                <div className="rounded-md bg-[var(--color-powierzchnia-2)] px-3 py-2"><dt className="etykieta">Dostarczone</dt><dd className="liczba text-[16px] font-semibold">{stat.email.dostarczone}</dd></div>
                <div className="rounded-md bg-[var(--color-powierzchnia-2)] px-3 py-2"><dt className="etykieta">Kliknięcia</dt><dd className="liczba text-[16px] font-semibold">{stat.email.klikniecia}</dd></div>
                <div className="rounded-md bg-[var(--color-powierzchnia-2)] px-3 py-2"><dt className="etykieta">Zamówienia</dt><dd className="liczba text-[16px] font-semibold">{stat.email.zamowien ?? 0}</dd></div>
              </dl>
            </Sekcja>
          ) : null}
        </>
      ) : null}

      {wezel.typ === "profil" ? (
        <Sekcja tytul="Co zrobić z profilem">
          <Pole etykieta="Akcja">
            <select className="pole" value={wezel.akcja.rodzaj} onChange={(e) => onZmiana({ akcja: { ...wezel.akcja, rodzaj: e.target.value as "dodaj_do_listy" | "usun_z_listy" } } as Partial<Wezel>)}>
              <option value="dodaj_do_listy">dodaj do listy</option>
              <option value="usun_z_listy">usuń z listy</option>
            </select>
          </Pole>
          <Pole etykieta="Lista">
            <select className="pole" value={wezel.akcja.listId} onChange={(e) => onZmiana({ akcja: { ...wezel.akcja, listId: e.target.value } } as Partial<Wezel>)}>
              {listy.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Pole>
        </Sekcja>
      ) : null}

      {wezel.typ === "koniec" ? (
        <Sekcja tytul="Koniec ścieżki">
          <p className="text-[13px] leading-5 text-[var(--color-tekst-2)]">Osoba, która tu dojdzie, kończy automatyzację. Zakończyło tędy: <span className="liczba font-semibold text-[var(--color-tekst)]">{stat.zakonczeni}</span>.</p>
        </Sekcja>
      ) : null}

      {onUsun ? (
        <div className="px-4 py-4">
          <button type="button" onClick={onUsun} className="przycisk przycisk-wtorny przycisk-maly w-full hover:!border-[var(--color-blad-ramka)] hover:!bg-[var(--color-blad-tlo)] hover:!text-[var(--color-blad)]">
            <Trash2 size={14} /> Usuń krok
          </button>
          {wezel.typ === "warunek" || wezel.typ === "ab_split" ? <p className="mt-2 text-[12px] leading-4 text-[var(--color-tekst-3)]">Zostanie gałąź {wezel.typ === "warunek" ? "„Tak”" : "A"}; druga gałąź zniknie razem ze swoimi krokami.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
