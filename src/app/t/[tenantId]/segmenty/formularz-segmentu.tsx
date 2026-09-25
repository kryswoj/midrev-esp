"use client";

import { useState } from "react";
import { utworzSegmentAkcja } from "../../../akcje";
import { Icon } from "../../../ui";

const REGULY = {
  kupil_w_ostatnich: { etykieta: "kupił w ostatnich N dniach", wartosc: "Liczba dni", domyslna: 30 },
  nie_kupil_od: { etykieta: "nie kupił od N dni", wartosc: "Liczba dni", domyslna: 30 },
  wydal_powyzej: { etykieta: "wydał powyżej N zł", wartosc: "Kwota w zł", domyslna: 30 },
  liczba_zamowien_min: { etykieta: "złożył co najmniej N zamówień", wartosc: "Liczba zamówień", domyslna: 30 },
  ma_zgode: { etykieta: "ma zgodę na e-mail", wartosc: null, domyslna: 0 },
} as const;

type TypReguly = keyof typeof REGULY;

export function FormularzSegmentu({ tenantId }: { tenantId: string }) {
  const [typ, setTyp] = useState<TypReguly>("kupil_w_ostatnich");
  const regula = REGULY[typ];

  return (
    <form action={utworzSegmentAkcja} className="space-y-6">
      <input type="hidden" name="tenantId" value={tenantId} />
      <label className="block max-w-[460px]">
        <span className="etykieta mb-1.5 block">Nazwa segmentu</span>
        <input name="nazwa" required placeholder="np. Kupili w 30 dni" className="pole" />
      </label>

      <div className="blok-warunku">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-semibold">
            <Icon name="segment" size={17} className="text-[var(--color-akcent)]" />
            Warunek
          </div>
          <span className="tekst-meta font-medium">1 warunek</span>
        </div>
        <div className="wiersz-warunku">
          <span className="zeton-warunku">Osoba</span>
          <label className={regula.wartosc ? "block" : "block md:col-span-2"}>
            <span className="etykieta mb-1.5 block">Warunek</span>
            <select name="typ" className="pole" value={typ} onChange={(e) => setTyp(e.target.value as TypReguly)}>
              {Object.entries(REGULY).map(([wartosc, ustawienie]) => <option key={wartosc} value={wartosc}>{ustawienie.etykieta}</option>)}
            </select>
          </label>
          {regula.wartosc ? (
            <label className="block">
              <span className="etykieta mb-1.5 block">{regula.wartosc}</span>
              <input key={typ} name="wartosc" type="number" min={0} defaultValue={regula.domyslna} className="pole" />
            </label>
          ) : (
            <input type="hidden" name="wartosc" value="0" />
          )}
        </div>
      </div>

      <button className="przycisk min-w-48 justify-center" type="submit">Zapisz segment</button>
    </form>
  );
}
