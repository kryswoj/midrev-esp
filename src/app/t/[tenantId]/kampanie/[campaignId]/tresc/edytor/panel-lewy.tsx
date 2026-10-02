"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, LayoutGrid, LayoutTemplate, Images, Loader2 } from "lucide-react";
import { SZABLONY, type Blok, type DaneKonta, type DokumentMaila } from "../../../../../../../domain/email/bloki";
import type { TypBloku } from "../../../../../../../domain/email/bloki";
import { Biblioteka } from "./biblioteka";
import { AKCEPTOWANE_OBRAZY, pobierzBiblioteke, rozmiarPliku, wyslijObraz, type ObrazBiblioteki } from "./obrazy-klient";

/**
 * Lewy panel edytora w trybie pełnego ekranu: zakładki „Bloki", „Szablony", „Obrazy"
 * (audyt UX 02.10, wizja 4.1). Biblioteka obrazów jest tu pod ręką: klik w miniaturę
 * wstawia obraz pod zaznaczonym blokiem albo podmienia obraz w zaznaczonym bloku obrazu.
 */

export type ZakladkaLewa = "bloki" | "szablony" | "obrazy";

function MiniaturaBloku({ blok, marka }: { blok: Blok; marka: string }) {
  const szary = "bg-[#e3e6ea]";
  switch (blok.typ) {
    case "naglowek":
      return <div className="mx-auto h-2 w-10 rounded-sm" style={{ background: blok.tlo || "#1f2328" }} />;
    case "obraz":
      return <div className={`h-6 w-full rounded-sm ${szary}`} />;
    case "tekst":
      return blok.wariant === "h1" ? <div className="mx-auto h-2 w-3/4 rounded-sm bg-[#1f2328]" /> : <div className={`h-1.5 w-full rounded-sm ${szary}`} />;
    case "przycisk":
      return <div className="mx-auto h-2.5 w-12 rounded-sm" style={{ background: marka }} />;
    case "kod":
      return <div className="mx-auto h-4 w-3/4 rounded-sm border border-dashed" style={{ borderColor: marka }} />;
    case "kolumny":
      return (
        <div className="flex gap-1">
          <div className={`h-4 flex-1 rounded-sm ${szary}`} />
          <div className={`h-4 flex-1 rounded-sm ${szary}`} />
        </div>
      );
    case "produkt":
      return <div className={`mx-auto h-5 w-1/2 rounded-sm ${szary}`} />;
    default:
      return <div className="h-1 w-full rounded-sm bg-[#eef0f3]" />;
  }
}

export function KartySzablonow({ onWybierz, konto, kolumny = 2 }: { onWybierz: (d: DokumentMaila) => void; konto: DaneKonta; kolumny?: 1 | 2 | 4 }) {
  return (
    <div className={`grid gap-3 ${kolumny === 1 ? "grid-cols-1" : kolumny === 2 ? "grid-cols-2" : "grid-cols-2 lg:grid-cols-4"}`}>
      {SZABLONY.map((s) => {
        const d = s.zbuduj(konto);
        return (
          <button
            key={s.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onWybierz(s.zbuduj(konto));
            }}
            className="group flex flex-col overflow-hidden rounded-[10px] border border-[var(--color-linia)] bg-white text-left shadow-[var(--cien-karta)] transition-[border-color,box-shadow] hover:border-[var(--color-akcent-ramka)] hover:shadow-[var(--cien-uniesiony)]"
          >
            <div className="flex h-[112px] flex-col gap-1 overflow-hidden bg-[var(--color-powierzchnia-2)] px-5 pt-4" aria-hidden="true">
              {d.bloki.length === 0 ? (
                <div className="grid flex-1 place-items-center rounded-t-md border-2 border-dashed border-[var(--color-linia-mocna)] bg-white text-[12px] text-[var(--color-tekst-3)]">pusty</div>
              ) : (
                <div className="flex flex-1 flex-col gap-1 rounded-t-md bg-white p-2 shadow-[var(--cien-karta)]">
                  {d.bloki.slice(0, 7).map((b) => (
                    <MiniaturaBloku key={b.id} blok={b} marka={d.style.kolorMarki} />
                  ))}
                </div>
              )}
            </div>
            <div className="border-t border-[var(--color-linia)] px-3 py-2.5">
              <div className="text-[13px] font-semibold group-hover:text-[var(--color-akcent)]">{s.nazwa}</div>
              <div className="mt-0.5 text-[12px] leading-[16px] text-[var(--color-tekst-3)]">{s.opis}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ZakladkaObrazow({ tenantId, onWstaw, odswiez }: { tenantId: string; onWstaw: (url: string) => void; odswiez: number }) {
  const [obrazy, setObrazy] = useState<ObrazBiblioteki[] | null>(null);
  const [blad, setBlad] = useState<string | null>(null);
  const [wgrywa, setWgrywa] = useState(false);
  const plikRef = useRef<HTMLInputElement>(null);
  const wczytaj = useCallback(async () => {
    const w = await pobierzBiblioteke(tenantId);
    if (w.ok) {
      setObrazy(w.obrazy);
      setBlad(null);
    } else {
      setObrazy([]);
      setBlad(w.blad);
    }
  }, [tenantId]);
  useEffect(() => {
    void wczytaj();
  }, [wczytaj, odswiez]);

  return (
    <div className="space-y-3 p-4">
      <button type="button" className="przycisk przycisk-wtorny w-full" disabled={wgrywa} onClick={() => plikRef.current?.click()}>
        {wgrywa ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />} {wgrywa ? "Wgrywam…" : "Wgraj obraz"}
      </button>
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
          setWgrywa(true);
          setBlad(null);
          const w = await wyslijObraz(tenantId, plik);
          setWgrywa(false);
          if (!w.ok) {
            setBlad(w.blad);
            return;
          }
          onWstaw(w.obraz.url);
          void wczytaj();
        }}
      />
      <p className="text-[12px] leading-[17px] text-[var(--color-tekst-3)]">Kliknij zdjęcie, żeby wstawić je do maila. Plik z dysku możesz też upuścić wprost na płótno.</p>
      {blad ? (
        <p role="alert" className="text-[12px] leading-[17px] text-[var(--color-blad)]">
          {blad}
        </p>
      ) : null}
      {obrazy === null ? (
        <ul className="grid grid-cols-2 gap-2" aria-label="Wczytuję obrazy">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="aspect-square animate-pulse rounded-lg bg-[var(--color-powierzchnia-2)]" />
          ))}
        </ul>
      ) : obrazy.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-linia-mocna)] px-3 py-6 text-center text-[12px] leading-[17px] text-[var(--color-tekst-3)]">
          <Images size={22} className="mx-auto mb-2" aria-hidden="true" />
          Tu pojawią się obrazy sklepu. Wgraj pierwszy albo upuść plik na płótno.
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-2">
          {obrazy.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => onWstaw(o.url)}
                title={`${o.nazwa} · ${o.szerokosc}×${o.wysokosc} · ${rozmiarPliku(o.rozmiar)}`}
                aria-label={`Wstaw ${o.nazwa}`}
                className="group grid aspect-square w-full place-items-center overflow-hidden rounded-lg border border-[var(--color-linia)] bg-[var(--color-powierzchnia-2)] hover:border-[var(--color-akcent)]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={o.sciezka} alt="" loading="lazy" className="max-h-full max-w-full object-contain transition-transform group-hover:scale-[1.03]" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PanelLewy({
  tenantId,
  zakladka,
  onZakladka,
  onDodaj,
  onSzablon,
  onObraz,
  konto,
  zablokowane,
  odswiezObrazy,
  maTresc,
}: {
  tenantId: string;
  zakladka: ZakladkaLewa;
  onZakladka: (z: ZakladkaLewa) => void;
  onDodaj: (typ: TypBloku) => void;
  onSzablon: (d: DokumentMaila) => void;
  onObraz: (url: string) => void;
  konto: DaneKonta;
  zablokowane: boolean;
  /** licznik: rośnie po każdym wgraniu z płótna, żeby zakładka pokazała nowy obraz */
  odswiezObrazy: number;
  /** mail ma już bloki: szablon zastąpi treść, więc najpierw pytamy */
  maTresc: boolean;
}) {
  const [doPotwierdzenia, setDoPotwierdzenia] = useState<DokumentMaila | null>(null);
  const ZAKLADKI: { klucz: ZakladkaLewa; etykieta: string; Ikona: typeof LayoutGrid }[] = [
    { klucz: "bloki", etykieta: "Bloki", Ikona: LayoutGrid },
    { klucz: "szablony", etykieta: "Szablony", Ikona: LayoutTemplate },
    { klucz: "obrazy", etykieta: "Obrazy", Ikona: Images },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Panel elementów" className="grid shrink-0 grid-cols-3 gap-1 border-b border-[var(--color-linia)] p-2">
        {ZAKLADKI.map(({ klucz, etykieta, Ikona }) => (
          <button
            key={klucz}
            type="button"
            role="tab"
            aria-selected={zakladka === klucz}
            onClick={() => onZakladka(klucz)}
            className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors ${
              zakladka === klucz ? "bg-[var(--color-akcent-tlo)] text-[var(--color-akcent)]" : "text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)]"
            }`}
          >
            <Ikona size={15} aria-hidden="true" /> {etykieta}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
        {zakladka === "bloki" ? (
          <Biblioteka onDodaj={onDodaj} zablokowane={zablokowane} />
        ) : zakladka === "szablony" ? (
          <div className="space-y-3 p-4">
            <p className="text-[12px] leading-[17px] text-[var(--color-tekst-3)]">Szablon zastępuje obecną treść. Zmienisz zdanie, Ctrl+Z przywróci poprzednią wersję.</p>
            {doPotwierdzenia ? (
              <div role="alertdialog" aria-label="Zastąpić obecną treść?" className="sticky top-0 z-10 rounded-[10px] border border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] p-3 shadow-[var(--cien-karta)]">
                <div className="text-[13px] font-semibold">Zastąpić obecną treść?</div>
                <p className="mt-0.5 text-[12px] leading-[17px] text-[var(--color-tekst-2)]">Bloki, które masz w mailu, zastąpi szablon. Ctrl+Z je przywróci.</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" className="przycisk przycisk-maly" onClick={() => { onSzablon(doPotwierdzenia); setDoPotwierdzenia(null); }}>Zastąp treść</button>
                  <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => setDoPotwierdzenia(null)}>Anuluj</button>
                </div>
              </div>
            ) : null}
            <KartySzablonow kolumny={1} konto={konto} onWybierz={(d) => (maTresc ? setDoPotwierdzenia(d) : onSzablon(d))} />
          </div>
        ) : (
          <ZakladkaObrazow tenantId={tenantId} onWstaw={onObraz} odswiez={odswiezObrazy} />
        )}
      </div>
    </div>
  );
}
