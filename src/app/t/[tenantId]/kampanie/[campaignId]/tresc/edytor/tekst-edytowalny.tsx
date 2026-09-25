"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Bold, Check, Italic, Link2, RemoveFormatting, Underline, Unlink, X } from "lucide-react";
import { bezpiecznyUrl, sanityzujTekst } from "../../../../../../../domain/email/bloki";

/**
 * Edycja tekstu wprost na płótnie (contenteditable).
 *
 * Bezpieczeństwo: DOM edytora jest tylko brudnopisem. Do stanu (i dalej do bazy i maila)
 * trafia wyłącznie wynik `sanityzujTekst` — biała lista b/i/u/br i <a href> z adresem
 * http(s)/mailto. Wklejanie idzie jako czysty tekst, upuszczanie HTML-u jest zablokowane,
 * a treść wczytana z bazy przechodzi przez sanityzację ZANIM trafi do innerHTML.
 *
 * Zwykły napis (`bogaty = false`) to jedna linijka bez formatowania: Enter nic nie robi,
 * a do stanu idzie `textContent`.
 */
export function TekstEdytowalny({
  wartosc,
  onZmiana,
  bogaty = false,
  tylkoDoOdczytu = false,
  className = "",
  style,
  placeholder,
  etykieta,
  dodatki,
}: {
  wartosc: string;
  onZmiana: (nowa: string) => void;
  bogaty?: boolean;
  tylkoDoOdczytu?: boolean;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  etykieta: string;
  /** dodatkowe kontrolki paska formatowania (np. styl i wyrównanie bloku tekstu) */
  dodatki?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // ostatnia wartość, którą SAMI wysłaliśmy w górę — żeby nie nadpisywać DOM-u (i kursora)
  // echem własnego pisania. DOM nadpisujemy tylko, gdy zmiana przyszła z zewnątrz:
  // cofnij/ponów, panel właściwości, szablon.
  const ostatnia = useRef<string | null>(null);
  const [aktywny, setAktywny] = useState(false);
  const [trybLinku, setTrybLinku] = useState(false);
  const [adres, setAdres] = useState("");
  const [bladLinku, setBladLinku] = useState<string | null>(null);
  const zakres = useRef<Range | null>(null);
  const pasekRef = useRef<HTMLDivElement>(null);
  // stan formatowania pod kursorem — aktywne B/I/U mają być widoczne jak w każdym edytorze
  const [aktywne, setAktywne] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!aktywny || !bogaty) return;
    const odswiez = () => {
      const sel = window.getSelection();
      if (!sel?.anchorNode || !ref.current?.contains(sel.anchorNode)) return;
      setAktywne({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        underline: document.queryCommandState("underline"),
        link: Boolean((sel.anchorNode.parentElement as HTMLElement | null)?.closest("a")),
      });
    };
    odswiez();
    document.addEventListener("selectionchange", odswiez);
    return () => document.removeEventListener("selectionchange", odswiez);
  }, [aktywny, bogaty]);
  // Pasek formatowania ląduje w pasku narzędzi edytora (jak w Klaviyo), a nie nad tekstem:
  // nie zasłania maila i nie przesuwa układu. Brak gniazda (np. w testach) = pasek nad tekstem.
  const [gniazdo, setGniazdo] = useState<HTMLElement | null>(null);
  useEffect(() => setGniazdo(document.getElementById("edytor-formatowanie")), []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || wartosc === ostatnia.current) return;
    if (bogaty) el.innerHTML = sanityzujTekst(wartosc);
    else el.textContent = wartosc;
    ostatnia.current = wartosc;
  }, [wartosc, bogaty]);

  const odczytaj = () => {
    const el = ref.current;
    if (!el) return;
    const nowa = bogaty ? sanityzujTekst(el.innerHTML) : (el.textContent ?? "").replace(/\s+/g, " ");
    if (nowa === ostatnia.current) return;
    ostatnia.current = nowa;
    onZmiana(nowa);
  };

  const polecenie = (nazwa: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(nazwa, false, arg);
    odczytaj();
  };

  const zapamietajZaznaczenie = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ref.current?.contains(sel.anchorNode)) zakres.current = sel.getRangeAt(0).cloneRange();
  };

  const wstawLink = () => {
    const url = bezpiecznyUrl(adres, "www-lub-mail");
    if (!url) {
      setBladLinku("Adres musi zaczynać się od https://, http:// albo mailto:");
      return;
    }
    const sel = window.getSelection();
    ref.current?.focus();
    if (sel && zakres.current) {
      sel.removeAllRanges();
      sel.addRange(zakres.current);
    }
    if (sel && sel.isCollapsed) {
      // nic nie zaznaczono: wstawiamy sam adres jako tekst linku
      document.execCommand("insertText", false, adres.trim());
      const r = sel.getRangeAt(0);
      r.setStart(r.endContainer, Math.max(0, r.endOffset - adres.trim().length));
      sel.removeAllRanges();
      sel.addRange(r);
    }
    document.execCommand("createLink", false, url);
    odczytaj();
    setTrybLinku(false);
    setAdres("");
    setBladLinku(null);
  };

  return (
    <div
      className="relative"
      onBlur={(e) => {
        // fokus przechodzący między tekstem a paskiem formatowania nie zamyka paska
        // (pasek siedzi w portalu, więc sprawdzamy oba drzewa DOM)
        const cel = e.relatedTarget as Node | null;
        if (cel && (e.currentTarget.contains(cel) || pasekRef.current?.contains(cel))) return;
        setAktywny(false);
        setTrybLinku(false);
      }}
    >
      {bogaty && aktywny && !tylkoDoOdczytu
        ? (() => {
            const pasek = (
        <div
          ref={pasekRef}
          role="toolbar"
          aria-label="Formatowanie tekstu"
          className={`${gniazdo ? "relative " : "absolute -top-[52px] left-0 z-40 shadow-[var(--cien-uniesiony)] "}flex items-center whitespace-nowrap gap-0.5 rounded-lg border border-[var(--color-linia)] bg-white p-1`}
          // mousedown zabrałby zaznaczenie z tekstu, zanim przycisk zdąży zadziałać
          onMouseDown={(e) => {
            if (!["INPUT", "SELECT", "OPTION"].includes((e.target as HTMLElement).tagName)) e.preventDefault();
          }}
        >
          {trybLinku ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                wstawLink();
              }}
            >
              <input
                autoFocus
                value={adres}
                onChange={(e) => {
                  setAdres(e.target.value);
                  setBladLinku(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setTrybLinku(false);
                }}
                placeholder="https://sklep.pl/promocja"
                aria-label="Adres linku"
                aria-invalid={Boolean(bladLinku)}
                className="pole h-7 w-56 text-[13px]"
              />
              <button type="submit" className="grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--color-powierzchnia-2)]" aria-label="Wstaw link">
                <Check size={15} />
              </button>
              <button type="button" onClick={() => setTrybLinku(false)} className="grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--color-powierzchnia-2)]" aria-label="Anuluj">
                <X size={15} />
              </button>
              {bladLinku ? (
                <span role="alert" className="absolute left-0 top-full mt-1 whitespace-nowrap rounded-md bg-[var(--color-blad)] px-2 py-1 text-[12px] text-white">
                  {bladLinku}
                </span>
              ) : null}
            </form>
          ) : (
            <>
              {[
                { ikona: Bold, nazwa: "bold", opis: "Pogrubienie (Ctrl+B)" },
                { ikona: Italic, nazwa: "italic", opis: "Kursywa (Ctrl+I)" },
                { ikona: Underline, nazwa: "underline", opis: "Podkreślenie (Ctrl+U)" },
              ].map(({ ikona: Ikona, nazwa, opis }) => (
                <button
                  key={nazwa}
                  type="button"
                  title={opis}
                  aria-label={opis}
                  aria-pressed={Boolean(aktywne[nazwa])}
                  onClick={() => polecenie(nazwa)}
                  className={`grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--color-powierzchnia-2)] ${aktywne[nazwa] ? "bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)] ring-1 ring-[var(--color-akcent-ramka)]" : "text-[var(--color-tekst-2)] hover:text-[var(--color-tekst)]"}`}
                >
                  <Ikona size={15} />
                </button>
              ))}
              <span className="mx-0.5 h-5 w-px bg-[var(--color-linia)]" />
              <button
                type="button"
                title="Wstaw link (Ctrl+K)"
                aria-label="Wstaw link"
                aria-pressed={Boolean(aktywne.link)}
                onClick={() => {
                  zapamietajZaznaczenie();
                  setTrybLinku(true);
                }}
                className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)]"
              >
                <Link2 size={15} />
              </button>
              <button
                type="button"
                title="Usuń link"
                aria-label="Usuń link"
                onClick={() => polecenie("unlink")}
                className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)]"
              >
                <Unlink size={15} />
              </button>
              <button
                type="button"
                title="Wyczyść formatowanie zaznaczenia"
                aria-label="Wyczyść formatowanie zaznaczenia"
                onClick={() => {
                  polecenie("removeFormat");
                  polecenie("unlink");
                }}
                className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)]"
              >
                <RemoveFormatting size={15} />
              </button>
              {dodatki ? (
                <>
                  <span className="mx-0.5 h-5 w-px bg-[var(--color-linia)]" />
                  {dodatki}
                </>
              ) : null}
            </>
          )}
        </div>
            );
            return gniazdo ? createPortal(pasek, gniazdo) : pasek;
          })()
        : null}
      <div
        ref={ref}
        role="textbox"
        aria-label={etykieta}
        aria-multiline={bogaty}
        contentEditable={!tylkoDoOdczytu}
        suppressContentEditableWarning
        spellCheck
        data-placeholder={placeholder}
        className={`outline-none [overflow-wrap:anywhere] empty:before:pointer-events-none empty:before:text-[#9aa0a6] empty:before:content-[attr(data-placeholder)] ${className}`}
        style={style}
        onInput={odczytaj}
        onFocus={() => setAktywny(true)}
        onBlur={odczytaj}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (bogaty) polecenie("insertLineBreak");
          }
          if (bogaty && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            zapamietajZaznaczenie();
            setTrybLinku(true);
          }
        }}
        onPaste={(e) => {
          // wklejka ze strony albo z Worda niesie style, skrypty i śmieci — bierzemy sam tekst
          e.preventDefault();
          const tekst = e.clipboardData.getData("text/plain");
          document.execCommand("insertText", false, bogaty ? tekst : tekst.replace(/\s+/g, " "));
        }}
        onDrop={(e) => e.preventDefault()}
      />
    </div>
  );
}
