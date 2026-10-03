"use client";

import type { CSSProperties, ReactNode } from "react";
import { CSS_FORMULARZA, zmienneStylu } from "../../../../domain/formularze/css";
import { bezpiecznyAdres, type Blok, type DefinicjaFormularza, type Krok } from "../../../../domain/formularze/model";

/**
 * Podgląd formularza w panelu: ta sama struktura klas `mf-*` i ten sam arkusz
 * (CSS_FORMULARZA) co skrypt na stronie sklepu, więc builder pokazuje to, co zobaczy klient.
 * Różnice tylko w ramie: nakładka i wysuwany są pozycjonowane względem płótna (absolute),
 * nie okna, i bez animacji wejścia.
 */
export const CSS_PODGLADU = `${CSS_FORMULARZA}
.mf-podglad.mf-nakladka,.mf-podglad.mf-flyout,.mf-podglad.mf-teaser{position:absolute;animation:none}
.mf-podglad.mf-nakladka{z-index:1}
.mf-podglad .mf-karta{max-height:none}
.mf-root.mf-statyczny{height:100%}
.mfb{position:relative;border-radius:6px;outline:1.5px solid transparent;outline-offset:3px;cursor:pointer;transition:outline-color .12s}
.mfb:hover{outline-color:rgba(129,74,200,.45)}
.mfb[data-zaznaczony=true]{outline:2px solid #814ac8}
.mfb[data-przeciagany=true]{opacity:.35}
.mf-pusty-obraz{display:grid;place-items:center;height:120px;border:1.5px dashed color-mix(in srgb,var(--mf-tekst) 30%,transparent);border-radius:8px;font-size:13px;opacity:.7}
.mf-wskaznik{height:3px;margin:-7px 0 4px;border-radius:2px;background:#814ac8}
.mf-pusty-krok{display:grid;place-items:center;min-height:140px;padding:16px;border:1.5px dashed color-mix(in srgb,var(--mf-tekst) 30%,transparent);border-radius:10px;font-size:14px;text-align:center;opacity:.75}
`;

export function StylePodgladu() {
  return <style dangerouslySetInnerHTML={{ __html: CSS_PODGLADU }} />;
}

function tloObrazu(url: string): CSSProperties | undefined {
  const u = bezpiecznyAdres(url);
  return u ? { backgroundImage: `url("${encodeURI(u).replace(/"/g, "%22")}")` } : undefined;
}

/** Jeden blok tak, jak go narysuje skrypt (pola nieaktywne, bo to podgląd). */
export function WidokBloku({ blok, zgoda }: { blok: Blok; zgoda?: { tekst: string; url: string } }) {
  switch (blok.typ) {
    case "naglowek":
      return <h2 className="mf-blok mf-naglowek" style={{ fontSize: blok.rozmiar }}>{blok.tekst || "Nagłówek"}</h2>;
    case "tekst":
      return <p className="mf-blok mf-tekst">{blok.tekst || "Tekst"}</p>;
    case "obraz": {
      const u = bezpiecznyAdres(blok.url);
      // eslint-disable-next-line @next/next/no-img-element
      return u ? <img className="mf-blok mf-img" src={u} alt={blok.alt} style={{ width: `${blok.szerokosc}%` }} /> : <div className="mf-pusty-obraz">Wybierz obraz w panelu po prawej</div>;
    }
    case "email":
    case "imie":
    case "telefon":
      return (
        <label className="mf-blok">
          <span className="mf-sr">{blok.etykieta}</span>
          <input className="mf-pole" readOnly tabIndex={-1} placeholder={blok.placeholder} aria-label={blok.etykieta} />
        </label>
      );
    case "pytanie":
      return (
        <fieldset className="mf-blok mf-pytanie">
          <legend>{blok.pytanie}</legend>
          <div className="mf-opcje">
            {blok.opcje.filter(Boolean).map((o, i) => (
              <label key={i} className="mf-opcja">
                <input type={blok.wielokrotny ? "checkbox" : "radio"} tabIndex={-1} readOnly checked={false} onChange={() => {}} />
                {o}
              </label>
            ))}
          </div>
        </fieldset>
      );
    case "zgoda": {
      const tekst = zgoda?.tekst ?? blok.tekst;
      const url = zgoda?.url ?? blok.adresPolityki;
      return (
        <div className="mf-blok mf-zgoda">
          <input type="checkbox" tabIndex={-1} checked={false} readOnly onChange={() => {}} aria-label="Zgoda" />
          <div>
            <label>{tekst || "Treść zgody"}</label>
            {bezpiecznyAdres(url) ? (
              <>
                {" "}
                <a href={url} onClick={(e) => e.preventDefault()} tabIndex={-1}>
                  Polityka prywatności
                </a>
              </>
            ) : null}
          </div>
        </div>
      );
    }
    case "kod":
      return (
        <div className="mf-blok">
          {blok.opis ? <p className="mf-kod-opis">{blok.opis}</p> : null}
          <div className="mf-kod">
            <span className="mf-kod-wartosc">{blok.kod || "KOD"}</span>
            <span className="mf-kopiuj" style={{ display: "inline-flex", alignItems: "center" }}>Kopiuj</span>
          </div>
        </div>
      );
    case "nie_dziekuje":
      return <span className="mf-blok mf-nie" style={{ display: "block", textAlign: "center" }}>{blok.tekst}</span>;
    case "przycisk":
      return <span className={`mf-blok mf-przycisk${blok.akcja === "dalej" || blok.akcja === "zamknij" ? " mf-drugi" : ""}`}>{blok.tekst || "Przycisk"}</span>;
  }
}

/**
 * Formularz z jednym krokiem w ramie (nakładka, wysuwany, osadzony). `owinBlok` pozwala
 * builderowi opakować każdy blok w element do zaznaczania i przeciągania.
 */
export function PodgladFormularza({
  def,
  krok,
  owinBlok,
  poBlokach,
  statyczny,
  bezNakladki,
  className,
}: {
  def: DefinicjaFormularza;
  krok: Krok;
  owinBlok?: (b: Blok, i: number, widok: ReactNode) => ReactNode;
  poBlokach?: ReactNode;
  /** bez pozycjonowania absolutnego (miniatury, galeria szablonów) */
  statyczny?: boolean;
  bezNakladki?: boolean;
  className?: string;
}) {
  const s = def.styl;
  const vars = zmienneStylu(s) as CSSProperties;
  const ramka = def.typ === "popup" ? (bezNakladki ? "" : "mf-nakladka mf-podglad") : def.typ === "flyout" ? (statyczny ? "" : `mf-flyout mf-rog-${s.rog} mf-podglad`) : "mf-embed";
  const zObrazem = s.obrazPozycja === "lewo" || s.obrazPozycja === "prawo" || s.obrazPozycja === "gora";
  const sukces = krok.id === def.sukces.id;
  return (
    <div className={`mf-root ${statyczny ? "mf-statyczny" : ""} ${className ?? ""}`} style={vars}>
      <div className={ramka} style={statyczny && def.typ === "popup" && !bezNakladki ? { position: "absolute" } : undefined}>
        <div className={`mf-karta mf-obraz-${s.obrazPozycja}`} style={s.obrazPozycja === "tlo" ? tloObrazu(s.obraz) : undefined}>
          {zObrazem ? <div className="mf-obraz" aria-hidden="true" style={tloObrazu(s.obraz) ?? { background: "color-mix(in srgb, var(--mf-tekst) 10%, transparent)" }} /> : null}
          <div className="mf-tresc">
            {krok.bloki.length === 0 ? <div className="mf-pusty-krok">{sukces ? "Przeciągnij tu podziękowanie albo kod rabatowy" : "Przeciągnij tu bloki z lewego panelu"}</div> : null}
            {krok.bloki.map((b, i) => {
              const widok = <WidokBloku blok={b} />;
              return owinBlok ? owinBlok(b, i, widok) : <div key={b.id}>{widok}</div>;
            })}
            {poBlokach}
          </div>
          {def.typ !== "embed" ? (
            <span className="mf-zamknij" aria-hidden="true">
              ×
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Teaser (zakładka po zamknięciu) w podglądzie. */
export function PodgladTeasera({ def }: { def: DefinicjaFormularza }) {
  return (
    <div className="mf-root" style={zmienneStylu(def.styl) as CSSProperties}>
      <div className={`mf-teaser mf-rog-${def.styl.rog} mf-podglad`}>
        <span style={{ padding: "10px 4px" }}>{def.teaser.tekst || "Tekst zakładki"}</span>
        <span className="mf-teaser-x" aria-hidden="true">
          ×
        </span>
      </div>
    </div>
  );
}

/** Atrapa strony sklepu pod formularzem (płótno buildera, galeria szablonów). */
export function AtrapaSklepu({ mobile, children }: { mobile?: boolean; children?: ReactNode }) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-white" aria-hidden={children ? undefined : true}>
      <div className="flex h-12 items-center gap-3 border-b border-[#eceef1] px-5">
        <span className="h-4 w-20 rounded bg-[#d9dce1]" />
        {!mobile ? (
          <span className="ml-auto flex gap-4">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-2.5 w-12 rounded bg-[#e6e8ec]" />
            ))}
          </span>
        ) : (
          <span className="ml-auto h-4 w-5 rounded bg-[#e6e8ec]" />
        )}
      </div>
      <div className={`m-5 rounded-xl bg-[#f1f2f4] ${mobile ? "h-44" : "h-60"}`} />
      <div className={`mx-5 grid gap-4 ${mobile ? "grid-cols-2" : "grid-cols-4"}`}>
        {Array.from({ length: mobile ? 4 : 8 }, (_, i) => (
          <div key={i}>
            <div className="aspect-square rounded-lg bg-[#f1f2f4]" />
            <div className="mt-2 h-2.5 w-3/4 rounded bg-[#e6e8ec]" />
            <div className="mt-1.5 h-2.5 w-1/3 rounded bg-[#eceef1]" />
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}
