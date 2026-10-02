"use client";

import { useRef, useState, type CSSProperties } from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, AlignCenter, AlignLeft, AlignRight, Check, Code, ImageIcon, Images, Loader2, ShoppingBag, Upload, X } from "lucide-react";
import {
  bezpiecznyKolor,
  bezpiecznyUrl,
  KROJE,
  ROZMIARY_PRZYCISKU,
  SIECI,
  tekstNaTle,
  WARIANTY_TEKSTU,
  type Blok,
  type Kolumna,
  type StyleMaila,
} from "../../../../../../../domain/email/bloki";
import { TekstEdytowalny } from "./tekst-edytowalny";
import { AKCEPTOWANE_OBRAZY, wyslijObraz } from "./obrazy-klient";
import { OknoBiblioteki } from "./pole-obrazu";

/**
 * Widok bloku na płótnie. To NIE jest HTML maila, tylko jego odwzorowanie w Reakcie —
 * z edycją tekstu wprost na miejscu. Liczby (rozmiary, wagi, kolory) pochodzą z tych
 * samych stałych co render maila (`wyglad.ts`), żeby płótno nie rozjeżdżało się z mailem.
 * Wiarygodny podgląd całości daje tryb „Podgląd": prawdziwy HTML ze złożenia silnika.
 */

export interface WlasciwosciWidoku {
  blok: Blok;
  styl: StyleMaila;
  mobile: boolean;
  tylkoDoOdczytu: boolean;
  onZmiana: (zmiany: Partial<Blok>, klucz?: string) => void;
  /**
   * Czy tekst bloku jest teraz edytowalny. Edytor kampanii włącza pisanie dopiero po
   * drugim kliknięciu albo Enterze (pierwszy klik tylko zaznacza blok). Domyślnie `true`:
   * edytor wiadomości automatyzacji korzysta z tego samego widoku po staremu.
   */
  edycjaTekstu?: boolean;
}

const WYROWNANIE: Record<string, CSSProperties["textAlign"]> = { left: "left", center: "center", right: "right" };
const FLEX: Record<string, string> = { left: "flex-start", center: "center", right: "flex-end" };

function ZastepczyObraz({ opis, wysokosc = 180, ikona: Ikona = ImageIcon }: { opis: string; wysokosc?: number; ikona?: typeof ImageIcon }) {
  return (
    <div
      className="flex w-full flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-[#cdd2d9] bg-[#f7f8fa] text-center text-[13px] text-[#697079]"
      style={{ height: wysokosc }}
    >
      <Ikona size={26} strokeWidth={1.5} aria-hidden="true" />
      <span className="max-w-[26ch] leading-[18px]">{opis}</span>
    </div>
  );
}

/**
 * Ostrzeżenie w miejscu (audyt UX P1-7): przycisk bez linku ma przy sobie widoczny dymek
 * „Dodaj link", a nie nieme kółko. Klik otwiera pole adresu wprost na płótnie.
 * Adres przechodzi ten sam test co render maila (`bezpiecznyUrl`), więc javascript: i inne
 * schematy nie wejdą do dokumentu ani z tego pola.
 */
function DymekLinku({ zlyLink, onLink, wewnatrz }: { zlyLink: boolean; onLink: (url: string) => void; wewnatrz: boolean }) {
  const [otwarty, setOtwarty] = useState(false);
  const [adres, setAdres] = useState("");
  const [blad, setBlad] = useState<string | null>(null);
  const zapisz = () => {
    const url = bezpiecznyUrl(adres, "www-lub-mail");
    if (!url) {
      setBlad("Wpisz pełny adres strony (https://…) albo e-mail (mailto:…).");
      return;
    }
    onLink(adres.trim());
    setOtwarty(false);
    setAdres("");
    setBlad(null);
  };
  return (
    <span className={`absolute top-1/2 z-30 -translate-y-1/2 ${wewnatrz ? "right-2" : "left-full ml-2"}`} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOtwarty((o) => !o)}
        aria-expanded={otwarty}
        className="flex h-6 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-2 text-[11px] font-semibold leading-none text-[var(--color-czeka)] shadow-[var(--cien-karta)] hover:brightness-95"
        style={{ fontFamily: "var(--font-sans, system-ui)" }}
      >
        <AlertTriangle size={12} aria-hidden="true" /> {zlyLink ? "Popraw link" : "Dodaj link"}
      </button>
      {otwarty ? (
        <span
          role="group"
          aria-label="Link przycisku"
          className={`absolute top-8 z-40 block w-[300px] ${wewnatrz ? "right-0" : "left-0"} rounded-[10px] border border-[var(--color-linia)] bg-white p-2.5 text-left shadow-[var(--cien-uniesiony)]`}
          style={{ fontFamily: "var(--font-sans, system-ui)" }}
        >
          <span className="flex items-center gap-1.5">
            <input
              autoFocus
              value={adres}
              onChange={(e) => {
                setAdres(e.target.value);
                setBlad(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  zapisz();
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setOtwarty(false);
                }
              }}
              placeholder="https://sklep.pl/promocja"
              aria-label="Adres linku"
              aria-invalid={Boolean(blad)}
              className="pole h-9 min-w-0 flex-1 text-[13px]"
            />
            <button type="button" onClick={zapisz} aria-label="Zapisz link" className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--color-akcent)] text-white hover:brightness-110">
              <Check size={15} />
            </button>
            <button type="button" onClick={() => setOtwarty(false)} aria-label="Anuluj" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)]">
              <X size={15} />
            </button>
          </span>
          {blad ? (
            <span role="alert" className="mt-1.5 block text-[12px] leading-[16px] text-[var(--color-blad)]">
              {blad}
            </span>
          ) : (
            <span className="mt-1.5 block text-[12px] leading-[16px] text-[var(--color-tekst-2)]">Wklej pełny adres, np. https://sklep.pl/promocja. Enter zapisuje, Esc zamyka.</span>
          )}
        </span>
      ) : null}
    </span>
  );
}

/** Pusty obraz na płótnie: wgranie z dysku albo wybór z biblioteki bez szukania pola w panelu. */
function PustyObraz({ opis, onObraz, wysokosc = 180 }: { opis: string; onObraz?: (url: string) => void; wysokosc?: number }) {
  const params = useParams<{ tenantId?: string }>();
  const tenantId = typeof params?.tenantId === "string" ? params.tenantId : "";
  const plikRef = useRef<HTMLInputElement>(null);
  const [wgrywa, setWgrywa] = useState(false);
  const [blad, setBlad] = useState<string | null>(null);
  const [biblioteka, setBiblioteka] = useState(false);
  if (!onObraz || !tenantId) return <ZastepczyObraz opis={opis} wysokosc={wysokosc} />;
  return (
    <div
      className="flex w-full flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed border-[#cdd2d9] bg-[#f7f8fa] px-4 text-center text-[13px] text-[#5b616b]"
      style={{ minHeight: wysokosc, fontFamily: "var(--font-sans, system-ui)" }}
    >
      <ImageIcon size={26} strokeWidth={1.5} aria-hidden="true" className="text-[#868d97]" />
      <span className="max-w-[34ch] leading-[18px]">Upuść tu zdjęcie z dysku albo:</span>
      <span className="flex flex-wrap justify-center gap-2" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="przycisk przycisk-maly" disabled={wgrywa} onClick={() => plikRef.current?.click()}>
          {wgrywa ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {wgrywa ? "Wgrywam…" : "Wgraj z dysku"}
        </button>
        <button type="button" className="przycisk przycisk-wtorny przycisk-maly" disabled={wgrywa} onClick={() => setBiblioteka(true)}>
          <Images size={14} /> Z biblioteki
        </button>
      </span>
      <input
        ref={plikRef}
        type="file"
        accept={AKCEPTOWANE_OBRAZY}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={async (e) => {
          const plik = e.target.files?.[0];
          e.target.value = "";
          if (!plik) return;
          setBlad(null);
          setWgrywa(true);
          const w = await wyslijObraz(tenantId, plik);
          setWgrywa(false);
          if (w.ok) onObraz(w.obraz.url);
          else setBlad(w.blad);
        }}
      />
      {blad ? (
        <span role="alert" className="max-w-[40ch] text-[12px] leading-[16px] text-[var(--color-blad)]">
          {blad}
        </span>
      ) : null}
      {biblioteka ? (
        <OknoBiblioteki
          tenantId={tenantId}
          wybrany=""
          onWybor={(url) => {
            onObraz(url);
            setBiblioteka(false);
          }}
          onZamknij={() => setBiblioteka(false)}
        />
      ) : null}
    </div>
  );
}

function PrzyciskPlotna({
  tekst,
  onTekst,
  tlo,
  kolor,
  promien,
  rozmiar,
  pelna,
  wyrownanie,
  font,
  tylkoDoOdczytu,
  bezLinku,
  zlyLink = false,
  onLink,
  edycjaTekstu = true,
}: {
  tekst: string;
  onTekst: (t: string) => void;
  tlo: string;
  kolor: string;
  promien: number;
  rozmiar: keyof typeof ROZMIARY_PRZYCISKU;
  pelna: boolean;
  wyrownanie: string;
  font: string;
  tylkoDoOdczytu: boolean;
  bezLinku: boolean;
  /** link jest wpisany, ale niepoprawny (napis dymka „Popraw link") */
  zlyLink?: boolean;
  /** zapis linku z dymka; bez niego zostaje sam znacznik braku */
  onLink?: (url: string) => void;
  edycjaTekstu?: boolean;
}) {
  const w = ROZMIARY_PRZYCISKU[rozmiar];
  return (
    <div className="flex" style={{ justifyContent: FLEX[wyrownanie] }}>
      <div
        className="relative"
        style={{
          display: pelna ? "block" : "inline-block",
          width: pelna ? "100%" : undefined,
          background: tlo,
          color: kolor,
          borderRadius: promien,
          padding: `${w.py}px ${w.px}px`,
          fontFamily: font,
          fontSize: w.fs,
          lineHeight: `${w.fs + 4}px`,
          fontWeight: 600,
          textAlign: "center",
        }}
      >
        <TekstEdytowalny wartosc={tekst} onZmiana={onTekst} tylkoDoOdczytu={tylkoDoOdczytu || !edycjaTekstu} etykieta="Napis na przycisku" placeholder="Napis" />
        {bezLinku && onLink && !tylkoDoOdczytu ? (
          <DymekLinku zlyLink={zlyLink} onLink={onLink} wewnatrz={pelna} />
        ) : bezLinku ? (
          <span className="absolute -right-2 -top-2 grid h-4 w-4 place-items-center rounded-full bg-[var(--color-czeka)] text-[10px] font-bold text-white" title="Przycisk nie ma linku">
            !
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Obraz({ src, alt, szerokosc, promien, wyrownanie, opisBraku, wysokoscZastepcza }: { src: string; alt: string; szerokosc: string; promien: number; wyrownanie: string; opisBraku: string; wysokoscZastepcza?: number }) {
  const bezpieczny = bezpiecznyUrl(src);
  const [blad, setBlad] = useState<string | null>(null);
  if (!bezpieczny) {
    return <ZastepczyObraz opis={src.trim() ? "Adres obrazu musi zaczynać się od https://" : opisBraku} wysokosc={wysokoscZastepcza} />;
  }
  if (blad === bezpieczny) return <ZastepczyObraz opis="Nie udało się wczytać obrazu z tego adresu" wysokosc={wysokoscZastepcza} />;
  return (
    <div className="flex" style={{ justifyContent: FLEX[wyrownanie] }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={bezpieczny}
        alt={alt}
        draggable={false}
        onError={() => setBlad(bezpieczny)}
        style={{ display: "block", width: szerokosc, maxWidth: "100%", height: "auto", borderRadius: promien }}
      />
    </div>
  );
}

function KolumnaPlotna({ kol, onZmiana, font, kolor, marka, wyrownanie, tylkoDoOdczytu, nazwa, edycjaTekstu }: { kol: Kolumna; onZmiana: (k: Partial<Kolumna>, klucz?: string) => void; font: string; kolor: string; marka: string; wyrownanie: string; tylkoDoOdczytu: boolean; nazwa: string; edycjaTekstu: boolean }) {
  const zObrazem = kol.obrazUrl.trim() || kol.obrazAlt.trim();
  return (
    <div className="min-w-0 flex-1 space-y-3">
      {zObrazem ? <Obraz src={kol.obrazUrl} alt={kol.obrazAlt} szerokosc="100%" promien={0} wyrownanie="center" opisBraku="Adres obrazu wpisz w panelu" wysokoscZastepcza={120} /> : null}
      <TekstEdytowalny
        bogaty
        wartosc={kol.html}
        onZmiana={(html) => onZmiana({ html }, `kol-${nazwa}`)}
        tylkoDoOdczytu={tylkoDoOdczytu || !edycjaTekstu}
        etykieta={`Tekst: kolumna ${nazwa}`}
        placeholder="Tekst kolumny"
        className="[&_a]:underline [&_a]:[color:var(--kolor-linku)]"
        style={{ fontFamily: font, fontSize: 15, lineHeight: "23px", color: kolor, textAlign: WYROWNANIE[wyrownanie], ["--kolor-linku" as string]: marka }}
      />
      {kol.przyciskTekst.trim() ? (
        <PrzyciskPlotna
          tekst={kol.przyciskTekst}
          onTekst={(przyciskTekst) => onZmiana({ przyciskTekst }, `kol-przycisk-${nazwa}`)}
          tlo={marka}
          kolor={tekstNaTle(marka)}
          promien={8}
          rozmiar="maly"
          pelna={false}
          wyrownanie={wyrownanie}
          font={font}
          tylkoDoOdczytu={tylkoDoOdczytu}
          edycjaTekstu={edycjaTekstu}
          bezLinku={!bezpiecznyUrl(kol.przyciskLink)}
          zlyLink={kol.przyciskLink.trim() !== ""}
          onLink={(przyciskLink) => onZmiana({ przyciskLink }, `kol-link-${nazwa}`)}
        />
      ) : null}
    </div>
  );
}

function PodgladHtml({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [wysokosc, setWysokosc] = useState(160);
  if (!html.trim()) return <ZastepczyObraz opis="Pusty blok HTML — wklej kod w panelu po prawej" wysokosc={120} ikona={Code} />;
  return (
    <iframe
      ref={ref}
      title="Własny HTML"
      srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px/1.6 -apple-system,Segoe UI,sans-serif;color:#1f2328}img{max-width:100%}</style></head><body>${html}</body></html>`}
      // allow-same-origin BEZ allow-scripts: skrypty w środku nie ruszą (nie da się ich
      // włączyć bez allow-scripts), a panel może odczytać wysokość treści, żeby ramka nie
      // ucinała maila. Formularze, okna i nawigacja rodzica pozostają zablokowane.
      sandbox="allow-same-origin"
      className="pointer-events-none block w-full border-0"
      style={{ height: wysokosc }}
      onLoad={() => {
        const d = ref.current?.contentDocument;
        if (d?.body) setWysokosc(Math.min(4000, Math.max(40, d.documentElement.scrollHeight)));
      }}
    />
  );
}

export function WidokBloku({ blok, styl, mobile, tylkoDoOdczytu, onZmiana, edycjaTekstu = true }: WlasciwosciWidoku) {
  // tekst nieedytowalny do drugiego kliknięcia; dymki i wgrywanie działają od razu
  const ro = tylkoDoOdczytu || !edycjaTekstu;
  const font = (KROJE[styl.kroj] ?? KROJE.systemowy).stos;
  const tloBloku = bezpiecznyKolor(blok.tlo, "") || styl.tloTresci;
  const kolorNaTle = blok.tlo ? tekstNaTle(tloBloku, "#ffffff", styl.kolorTekstu) : styl.kolorTekstu;
  const tekstLinkow = { ["--kolor-linku" as string]: styl.kolorMarki } as CSSProperties;

  switch (blok.typ) {
    case "naglowek": {
      if (blok.logoUrl.trim()) {
        return <Obraz src={blok.logoUrl} alt={blok.logoAlt} szerokosc={`${blok.logoSzerokosc}px`} promien={0} wyrownanie={blok.wyrownanie} opisBraku="" wysokoscZastepcza={80} />;
      }
      return (
        <TekstEdytowalny
          wartosc={blok.nazwa}
          onZmiana={(nazwa) => onZmiana({ nazwa }, "nazwa")}
          tylkoDoOdczytu={ro}
          etykieta="Nazwa sklepu w nagłówku"
          placeholder="Nazwa sklepu albo logo"
          style={{ fontFamily: font, fontSize: 22, lineHeight: "28px", fontWeight: 700, letterSpacing: "-0.01em", color: kolorNaTle, textAlign: WYROWNANIE[blok.wyrownanie] }}
        />
      );
    }
    case "tekst": {
      const w = WARIANTY_TEKSTU[blok.wariant];
      const kolor = bezpiecznyKolor(blok.kolor, kolorNaTle);
      return (
        <TekstEdytowalny
          bogaty
          wartosc={blok.html}
          onZmiana={(html) => onZmiana({ html }, "html")}
          tylkoDoOdczytu={ro}
          etykieta="Tekst"
          placeholder="Wpisz tekst…"
          dodatki={
            <>
              <select
                aria-label="Styl tekstu"
                value={blok.wariant}
                onChange={(e) => onZmiana({ wariant: e.target.value as typeof blok.wariant })}
                className="h-7 rounded-md border border-[var(--color-linia)] bg-white px-1.5 text-[12px] text-[var(--color-tekst)]"
              >
                {(Object.keys(WARIANTY_TEKSTU) as (keyof typeof WARIANTY_TEKSTU)[]).map((k) => (
                  <option key={k} value={k}>
                    {WARIANTY_TEKSTU[k].etykieta}
                  </option>
                ))}
              </select>
              {([
                ["left", AlignLeft, "Do lewej"],
                ["center", AlignCenter, "Do środka"],
                ["right", AlignRight, "Do prawej"],
              ] as const).map(([w, I, opis]) => (
                <button
                  key={w}
                  type="button"
                  title={opis}
                  aria-label={opis}
                  aria-pressed={blok.wyrownanie === w}
                  onClick={() => onZmiana({ wyrownanie: w })}
                  className={`grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--color-powierzchnia-2)] ${blok.wyrownanie === w ? "bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]" : "text-[var(--color-tekst-2)]"}`}
                >
                  <I size={15} />
                </button>
              ))}
            </>
          }
          className="[&_a]:underline [&_a]:[color:var(--kolor-linku)]"
          style={{ ...tekstLinkow, ["--kolor-linku" as string]: blok.tlo ? kolor : styl.kolorMarki, fontFamily: font, fontSize: w.fs, lineHeight: `${w.lh}px`, fontWeight: w.fw, color: kolor, textAlign: WYROWNANIE[blok.wyrownanie] }}
        />
      );
    }
    case "obraz":
      if (!blok.src.trim()) {
        return <PustyObraz opis="Wgraj obraz albo wklej jego adres w panelu po prawej" onObraz={tylkoDoOdczytu ? undefined : (src) => onZmiana({ src }, "src")} />;
      }
      return <Obraz src={blok.src} alt={blok.alt} szerokosc={`${mobile ? 100 : blok.szerokosc}%`} promien={blok.zaokraglenie} wyrownanie={blok.wyrownanie} opisBraku="Wgraj obraz albo wklej jego adres w panelu po prawej" />;
    case "przycisk": {
      const tlo = bezpiecznyKolor(blok.kolorTla, styl.kolorMarki);
      return (
        <PrzyciskPlotna
          tekst={blok.tekst}
          onTekst={(tekst) => onZmiana({ tekst }, "tekst")}
          tlo={tlo}
          kolor={bezpiecznyKolor(blok.kolorTekstu, tekstNaTle(tlo))}
          promien={blok.zaokraglenie}
          rozmiar={blok.rozmiar}
          pelna={blok.pelnaSzerokosc}
          wyrownanie={blok.wyrownanie}
          font={font}
          tylkoDoOdczytu={tylkoDoOdczytu}
          edycjaTekstu={edycjaTekstu}
          bezLinku={!bezpiecznyUrl(blok.link, "www-lub-mail")}
          zlyLink={blok.link.trim() !== ""}
          onLink={(link) => onZmiana({ link }, "link")}
        />
      );
    }
    case "separator":
      return (
        <div className="flex justify-center">
          <div style={{ width: `${blok.szerokosc}%`, borderTop: `${blok.grubosc}px ${blok.styl} ${blok.kolor}` }} />
        </div>
      );
    case "odstep":
      return <div style={{ height: blok.wysokosc }} aria-label={`Odstęp ${blok.wysokosc} px`} />;
    case "kolumny": {
      const [pl, pp] = blok.proporcja === "33-67" ? [1, 2] : blok.proporcja === "67-33" ? [2, 1] : [1, 1];
      const wspolne = { font, kolor: kolorNaTle, marka: styl.kolorMarki, wyrownanie: blok.wyrownanie, tylkoDoOdczytu, edycjaTekstu };
      return (
        <div className="flex" style={{ flexDirection: mobile ? "column" : "row", gap: mobile ? 20 : blok.odstepKolumn }}>
          <div style={{ flex: mobile ? "1 1 auto" : pl }} className="min-w-0">
            <KolumnaPlotna kol={blok.lewa} nazwa="lewa" onZmiana={(z, k) => onZmiana({ lewa: { ...blok.lewa, ...z } } as Partial<Blok>, k)} {...wspolne} />
          </div>
          <div style={{ flex: mobile ? "1 1 auto" : pp }} className="min-w-0">
            <KolumnaPlotna kol={blok.prawa} nazwa="prawa" onZmiana={(z, k) => onZmiana({ prawa: { ...blok.prawa, ...z } } as Partial<Blok>, k)} {...wspolne} />
          </div>
        </div>
      );
    }
    case "produkt": {
      const tekstStyl = { fontFamily: font, textAlign: WYROWNANIE[blok.wyrownanie] } as CSSProperties;
      return (
        <div className="space-y-2">
          <div className="mb-4 flex" style={{ justifyContent: FLEX[blok.wyrownanie] }}>
            <div style={{ width: "100%", maxWidth: 360 }}>
              {bezpiecznyUrl(blok.obrazUrl) ? (
                <Obraz src={blok.obrazUrl} alt={blok.obrazAlt} szerokosc="100%" promien={8} wyrownanie="center" opisBraku="" />
              ) : (
                <ZastepczyObraz opis="Zdjęcie produktu: wgraj je w panelu po prawej" wysokosc={200} ikona={ShoppingBag} />
              )}
            </div>
          </div>
          <TekstEdytowalny wartosc={blok.nazwa} onZmiana={(nazwa) => onZmiana({ nazwa }, "nazwa")} tylkoDoOdczytu={ro} etykieta="Nazwa produktu" placeholder="Nazwa produktu" style={{ ...tekstStyl, fontSize: 18, lineHeight: "26px", fontWeight: 600, color: kolorNaTle }} />
          <TekstEdytowalny wartosc={blok.opis} onZmiana={(opis) => onZmiana({ opis }, "opis")} tylkoDoOdczytu={ro} etykieta="Opis produktu" placeholder="Krótki opis (opcjonalnie)" style={{ ...tekstStyl, fontSize: 15, lineHeight: "22px", color: kolorNaTle, opacity: 0.8 }} />
          <div className="flex items-baseline gap-3" style={{ justifyContent: FLEX[blok.wyrownanie], fontFamily: font }}>
            {blok.cenaPrzed.trim() ? <span style={{ color: "#868d97", textDecoration: "line-through", fontSize: 15 }}>{blok.cenaPrzed}</span> : null}
            <TekstEdytowalny wartosc={blok.cena} onZmiana={(cena) => onZmiana({ cena }, "cena")} tylkoDoOdczytu={ro} etykieta="Cena" placeholder="Cena" style={{ fontSize: 18, lineHeight: "24px", fontWeight: 700, color: blok.cenaPrzed.trim() ? styl.kolorMarki : kolorNaTle }} />
          </div>
          {blok.przyciskTekst.trim() ? (
            <div className="pt-2">
              <PrzyciskPlotna tekst={blok.przyciskTekst} onTekst={(przyciskTekst) => onZmiana({ przyciskTekst }, "przyciskTekst")} tlo={styl.kolorMarki} kolor={tekstNaTle(styl.kolorMarki)} promien={8} rozmiar="sredni" pelna={false} wyrownanie={blok.wyrownanie} font={font} tylkoDoOdczytu={tylkoDoOdczytu} edycjaTekstu={edycjaTekstu} bezLinku={!bezpiecznyUrl(blok.link)} zlyLink={blok.link.trim() !== ""} onLink={(link) => onZmiana({ link }, "link")} />
            </div>
          ) : null}
        </div>
      );
    }
    case "kod": {
      const napis = tekstNaTle(blok.tloKodu);
      return (
        <div className="px-4 py-5 text-center" style={{ border: `2px dashed ${blok.kolorRamki}`, borderRadius: 10, background: blok.tloKodu, fontFamily: font }}>
          <TekstEdytowalny wartosc={blok.tytul} onZmiana={(tytul) => onZmiana({ tytul }, "tytul")} tylkoDoOdczytu={ro} etykieta="Tytuł kodu" placeholder="Tytuł (opcjonalnie)" style={{ fontSize: 14, lineHeight: "20px", fontWeight: 600, color: napis, marginBottom: 6 }} />
          <TekstEdytowalny wartosc={blok.kod} onZmiana={(kod) => onZmiana({ kod }, "kod")} tylkoDoOdczytu={ro} etykieta="Kod rabatowy" placeholder="KOD" style={{ fontFamily: "'Courier New',Courier,monospace", fontSize: 28, lineHeight: "36px", fontWeight: 700, letterSpacing: 3, color: blok.kolorRamki }} />
          <TekstEdytowalny wartosc={blok.opis} onZmiana={(opis) => onZmiana({ opis }, "opis")} tylkoDoOdczytu={ro} etykieta="Opis kodu" placeholder="Warunki (opcjonalnie)" style={{ fontSize: 13, lineHeight: "19px", color: napis, opacity: 0.8, marginTop: 6 }} />
        </div>
      );
    }
    case "social":
      return (
        <div className="flex flex-wrap gap-2" style={{ justifyContent: FLEX[blok.wyrownanie], fontFamily: font }}>
          {blok.linki.length === 0 ? <span className="text-[13px] text-[#697079]">Dodaj profile w panelu po prawej</span> : null}
          {blok.linki.map((l, i) => {
            const siec = SIECI[l.siec];
            const [tlo, kolor, obrys] = blok.styl === "kolor" ? [siec.kolor, "#ffffff", siec.kolor] : blok.styl === "ciemny" ? ["#1f2328", "#ffffff", "#1f2328"] : ["#ffffff", "#1f2328", "#cdd2d9"];
            const brak = !bezpiecznyUrl(l.url);
            return (
              <span
                key={i}
                title={brak ? "Brak linku — w mailu ten profil zostanie pominięty" : l.url}
                style={{ background: tlo, color: kolor, border: `1px solid ${obrys}`, opacity: brak ? 0.35 : 1 }}
                className="inline-block rounded-full px-3.5 py-[7px] text-[13px] font-semibold leading-4"
              >
                {siec.etykieta}
              </span>
            );
          })}
        </div>
      );
    case "stopka":
      return (
        <TekstEdytowalny
          bogaty
          wartosc={blok.html}
          onZmiana={(html) => onZmiana({ html }, "html")}
          tylkoDoOdczytu={ro}
          etykieta="Stopka"
          placeholder="Tekst od siebie, np. kontakt. Adres firmy dodajemy pod mailem sami."
          className="[&_a]:underline"
          style={{ fontFamily: font, fontSize: 12, lineHeight: "19px", color: bezpiecznyKolor(blok.kolor, "#868d97"), textAlign: WYROWNANIE[blok.wyrownanie] }}
        />
      );
    case "html":
      return <PodgladHtml html={blok.html} />;
  }
}
