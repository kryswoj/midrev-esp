"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { ImagePlus, Images, Trash2, Upload, X } from "lucide-react";
import { PoleUrl } from "./kontrolki";

/**
 * Pole obrazu bloku (Obraz, Produkt): adres URL jak dotąd ORAZ biblioteka obrazów sklepu
 * (audyt #14) — „Wgraj" z dysku i „Wybierz z biblioteki" (siatka miniatur tenanta).
 * Po wgraniu blok dostaje ABSOLUTNY adres z APP_URL, bo mail otwiera się w cudzej skrzynce.
 *
 * Tenant bierzemy z segmentu adresu (`/t/[tenantId]/…`), a nie z nowego propsa: edytor
 * automatyzacji importuje ten sam panel właściwości i jego API ma zostać bez zmian.
 * Serwer i tak sprawdza tenant z sesją — adres to tylko deklaracja.
 */

const MAKS_BAJTOW = 5 * 1024 * 1024;
const AKCEPTOWANE = "image/png,image/jpeg,image/gif,image/webp";

interface ObrazBiblioteki {
  id: string;
  url: string;
  sciezka: string;
  nazwa: string;
  rozmiar: number;
  szerokosc: number;
  wysokosc: number;
  wgranoO: string;
  blokadaUsuniecia: string | null;
  szkice: number;
}

function rozmiar(bajty: number): string {
  if (bajty >= 1024 * 1024) return `${(bajty / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(bajty / 1024))} KB`;
}

async function wyslijPlik(tenantId: string, plik: File): Promise<{ ok: true; obraz: ObrazBiblioteki } | { ok: false; blad: string }> {
  if (plik.size > MAKS_BAJTOW) return { ok: false, blad: `„${plik.name}" ma ${rozmiar(plik.size)}. Limit to 5 MB.` };
  if (plik.size === 0) return { ok: false, blad: "Plik jest pusty." };
  try {
    const odp = await fetch(`/api/obrazy/${tenantId}`, {
      method: "POST",
      headers: { "x-nazwa-pliku": encodeURIComponent(plik.name), "content-type": "application/octet-stream" },
      body: plik,
    });
    const dane = await odp.json().catch(() => null);
    if (!odp.ok || !dane?.ok) return { ok: false, blad: dane?.blad ?? `Serwer odrzucił plik (${odp.status}).` };
    return { ok: true, obraz: dane.obraz };
  } catch {
    return { ok: false, blad: "Nie udało się wysłać pliku — sprawdź połączenie i spróbuj ponownie." };
  }
}

export function PoleObrazu({ etykieta, wartosc, onZmiana, podpowiedz }: { etykieta: string; wartosc: string; onZmiana: (w: string) => void; podpowiedz?: ReactNode }) {
  const params = useParams<{ tenantId?: string }>();
  const tenantId = typeof params?.tenantId === "string" ? params.tenantId : "";
  const plikRef = useRef<HTMLInputElement>(null);
  const [wgrywa, setWgrywa] = useState(false);
  const [blad, setBlad] = useState<string | null>(null);
  const [biblioteka, setBiblioteka] = useState(false);

  const wgraj = async (plik: File | undefined) => {
    if (!plik || !tenantId) return;
    setBlad(null);
    setWgrywa(true);
    const w = await wyslijPlik(tenantId, plik);
    setWgrywa(false);
    if (!w.ok) setBlad(w.blad);
    else onZmiana(w.obraz.url);
  };

  return (
    <div className="space-y-2">
      <PoleUrl etykieta={etykieta} wartosc={wartosc} onZmiana={onZmiana} podpowiedz={podpowiedz} />
      {tenantId ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="przycisk przycisk-wtorny przycisk-maly" disabled={wgrywa} onClick={() => plikRef.current?.click()}>
              <Upload size={14} /> {wgrywa ? "Wgrywam…" : "Wgraj"}
            </button>
            <button type="button" className="przycisk przycisk-wtorny przycisk-maly" disabled={wgrywa} onClick={() => setBiblioteka(true)}>
              <Images size={14} /> Wybierz z biblioteki
            </button>
            <input
              ref={plikRef}
              type="file"
              accept={AKCEPTOWANE}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const plik = e.target.files?.[0];
                e.target.value = "";
                void wgraj(plik);
              }}
            />
          </div>
          {wgrywa ? <p className="text-[12px] leading-[17px] text-[var(--color-tekst-2)]">Wysyłam obraz, przycisk wróci po zapisie.</p> : null}
          {blad ? (
            <p role="alert" className="text-[12px] leading-[17px] text-[var(--color-blad)]">
              {blad}
            </p>
          ) : (
            <p className="text-[12px] leading-[17px] text-[var(--color-tekst-3)]">PNG, JPEG, GIF albo WebP, do 5 MB. Obraz trafia do biblioteki sklepu.</p>
          )}
          {biblioteka ? (
            <OknoBiblioteki
              tenantId={tenantId}
              wybrany={wartosc}
              onWybor={(url) => {
                onZmiana(url);
                setBiblioteka(false);
              }}
              onZamknij={() => setBiblioteka(false)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function OknoBiblioteki({ tenantId, wybrany, onWybor, onZamknij }: { tenantId: string; wybrany: string; onWybor: (url: string) => void; onZamknij: () => void }) {
  const [obrazy, setObrazy] = useState<ObrazBiblioteki[] | null>(null);
  const [blad, setBlad] = useState<string | null>(null);
  const [wgrywa, setWgrywa] = useState(false);
  const [potwierdza, setPotwierdza] = useState<string | null>(null);
  const [usuwa, setUsuwa] = useState<string | null>(null);
  const [komunikat, setKomunikat] = useState<string | null>(null);
  const plikRef = useRef<HTMLInputElement>(null);
  const zamknijRef = useRef<HTMLButtonElement>(null);

  const wczytaj = useCallback(async () => {
    try {
      const odp = await fetch(`/api/obrazy/${tenantId}`, { cache: "no-store" });
      const dane = await odp.json().catch(() => null);
      if (!odp.ok || !dane?.ok) throw new Error(dane?.blad ?? String(odp.status));
      setObrazy(dane.obrazy);
      setBlad(null);
    } catch {
      setBlad("Nie udało się wczytać biblioteki. Zamknij okno i spróbuj ponownie.");
      setObrazy([]);
    }
  }, [tenantId]);

  useEffect(() => {
    void wczytaj();
  }, [wczytaj]);

  useEffect(() => {
    zamknijRef.current?.focus();
    const klawisz = (e: KeyboardEvent) => {
      if (e.key === "Escape") onZamknij();
    };
    window.addEventListener("keydown", klawisz);
    return () => window.removeEventListener("keydown", klawisz);
  }, [onZamknij]);

  const wgraj = async (plik: File | undefined) => {
    if (!plik) return;
    setBlad(null);
    setWgrywa(true);
    const w = await wyslijPlik(tenantId, plik);
    setWgrywa(false);
    if (!w.ok) setBlad(w.blad);
    else onWybor(w.obraz.url);
  };

  const usun = async (o: ObrazBiblioteki) => {
    setUsuwa(o.id);
    setBlad(null);
    try {
      const odp = await fetch(`/api/obrazy/${tenantId}/${o.id}`, { method: "DELETE" });
      const dane = await odp.json().catch(() => null);
      if (!odp.ok || !dane?.ok) {
        setBlad(dane?.blad ?? `Nie udało się usunąć obrazu (${odp.status}).`);
      } else {
        setKomunikat(`Usunięto „${o.nazwa}".`);
      }
    } catch {
      setBlad("Nie udało się usunąć obrazu — sprawdź połączenie.");
    }
    setUsuwa(null);
    setPotwierdza(null);
    await wczytaj();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(22,24,29,0.45)] p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onZamknij(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="biblioteka-obrazow-tytul" className="flex max-h-[85vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[10px] border border-[var(--color-linia)] bg-white shadow-[var(--cien-uniesiony)]">
        <div className="flex items-center gap-3 border-b border-[var(--color-linia)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="biblioteka-obrazow-tytul" className="text-[15px]">Biblioteka obrazów</h2>
            <p className="mt-0.5 text-[12px] leading-[17px] text-[var(--color-tekst-3)]">Obrazy tego sklepu. Kliknij miniaturę, żeby wstawić ją do bloku.</p>
          </div>
          <button type="button" className="przycisk przycisk-maly" disabled={wgrywa} onClick={() => plikRef.current?.click()}>
            <ImagePlus size={14} /> {wgrywa ? "Wgrywam…" : "Wgraj nowy"}
          </button>
          <input ref={plikRef} type="file" accept={AKCEPTOWANE} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { const p = e.target.files?.[0]; e.target.value = ""; void wgraj(p); }} />
          <button ref={zamknijRef} type="button" aria-label="Zamknij bibliotekę" onClick={onZamknij} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--color-tekst-2)] hover:bg-[var(--color-powierzchnia-2)]">
            <X size={16} />
          </button>
        </div>
        {blad ? <p role="alert" className="border-b border-[var(--color-blad-ramka)] bg-[var(--color-blad-tlo)] px-5 py-2.5 text-[13px] text-[var(--color-blad)]">{blad}</p> : null}
        {komunikat && !blad ? <p role="status" className="border-b border-[var(--color-ok-ramka)] bg-[var(--color-ok-tlo)] px-5 py-2.5 text-[13px] text-[var(--color-ok)]">{komunikat}</p> : null}
        <div className="min-h-[200px] overflow-y-auto p-5">
          {obrazy === null ? (
            <p className="text-[13px] text-[var(--color-tekst-2)]">Wczytuję bibliotekę…</p>
          ) : obrazy.length === 0 ? (
            <div className="pusty-stan">
              <h3>Biblioteka jest pusta</h3>
              <div className="tekst-pomocniczy">Wgraj pierwszy obraz przyciskiem „Wgraj nowy". PNG, JPEG, GIF albo WebP, do 5 MB.</div>
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {obrazy.map((o) => {
                const aktywny = o.url === wybrany;
                return (
                  <li key={o.id} className={`flex flex-col overflow-hidden rounded-[10px] border ${aktywny ? "border-[var(--color-akcent)] ring-2 ring-[var(--color-akcent-ramka)]" : "border-[var(--color-linia)]"}`}>
                    <button type="button" onClick={() => onWybor(o.url)} className="group block text-left" aria-label={`Wstaw ${o.nazwa}`}>
                      <span className="grid aspect-[4/3] place-items-center overflow-hidden bg-[var(--color-powierzchnia-2)]">
                        {/* miniatura przez ścieżkę względną: działa pod każdym adresem panelu */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={o.sciezka} alt="" loading="lazy" className="max-h-full max-w-full object-contain transition-transform group-hover:scale-[1.02]" />
                      </span>
                      <span className="block px-3 pt-2.5">
                        <span className="block truncate text-[13px] font-semibold" title={o.nazwa}>{o.nazwa}</span>
                        <span className="block text-[12px] tabular-nums text-[var(--color-tekst-3)]">
                          {o.szerokosc}×{o.wysokosc} · {rozmiar(o.rozmiar)}{aktywny ? " · w bloku" : ""}
                        </span>
                      </span>
                    </button>
                    <div className="mt-auto px-3 pb-3 pt-2">
                      {o.blokadaUsuniecia ? (
                        <div className="space-y-1">
                          <button type="button" disabled className="przycisk przycisk-wtorny przycisk-maly">
                            <Trash2 size={13} /> Usuń
                          </button>
                          <p className="text-[12px] leading-[16px] text-[var(--color-tekst-2)]">{o.blokadaUsuniecia}</p>
                        </div>
                      ) : potwierdza === o.id ? (
                        <div className="space-y-1.5">
                          <p className="text-[12px] leading-[16px] text-[var(--color-tekst-2)]">
                            {o.szkice > 0
                              ? `Obraz jest w ${o.szkice === 1 ? "jednym szkicu" : `${o.szkice} szkicach`} — zniknie z ${o.szkice === 1 ? "niego" : "nich"}, a lista kontrolna zatrzyma wysyłkę do czasu podmiany.`
                              : "Nie jest użyty w żadnej kampanii."}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            <button type="button" className="przycisk przycisk-niebezpieczny przycisk-maly" disabled={usuwa === o.id} onClick={() => void usun(o)}>
                              {usuwa === o.id ? "Usuwam…" : "Usuń na stałe"}
                            </button>
                            <button type="button" className="przycisk przycisk-wtorny przycisk-maly" disabled={usuwa === o.id} onClick={() => setPotwierdza(null)}>
                              Anuluj
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={() => setPotwierdza(o.id)}>
                          <Trash2 size={13} /> Usuń
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
