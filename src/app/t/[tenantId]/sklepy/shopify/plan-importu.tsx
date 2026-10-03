"use client";

import { useState } from "react";
import { Alert, Button, PrzyciskFormularza } from "../../../../ui";
import { planImportuAkcja, rozpocznijImportAkcja } from "./akcje";
import type { PlanImportuShopify } from "../../../../../usecases/shopify/import";

/**
 * Import historii: najpierw plan z licznościami i skutkami (lista kontrolna, pkt 6: skutki
 * uboczne PRZED startem), potem jedno potwierdzenie.
 */
export function PlanImportu({ tenantId, storeId }: { tenantId: string; storeId: string }) {
  const [plan, ustawPlan] = useState<PlanImportuShopify | null>(null);
  const [blad, ustawBlad] = useState<string | null>(null);
  const [trwa, ustawTrwa] = useState(false);
  const liczba = (n: number | null) => (n === null ? "?" : n.toLocaleString("pl-PL"));

  async function policz() {
    ustawTrwa(true);
    ustawBlad(null);
    try {
      const w = await planImportuAkcja(tenantId, storeId);
      if ("blad" in w) ustawBlad(w.blad);
      else ustawPlan(w);
    } catch {
      ustawBlad("Nie udało się policzyć. Spróbuj ponownie.");
    } finally {
      ustawTrwa(false);
    }
  }

  if (!plan) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Button variant="secondary" onClick={policz} disabled={trwa} aria-busy={trwa || undefined}>
          {trwa ? "Liczę w sklepie…" : "Policz, co wejdzie"}
        </Button>
        {blad ? <Alert tone="blad">{blad}</Alert> : null}
      </div>
    );
  }
  const od = new Date(plan.od).toLocaleDateString("pl-PL");
  return (
    <form action={rozpocznijImportAkcja} className="flex flex-col gap-3">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="storeId" value={storeId} />
      <dl className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        {[
          ["Zamówienia", plan.zamowienia, `złożone od ${od}`],
          ["Klienci w sklepie", plan.klienci, "wejdą tylko osoby ze zgodą na e-maile"],
          ["Produkty", plan.produkty, "katalog do bloków w mailach"],
        ].map(([t, n, o]) => (
          <div key={String(t)} className="rounded-lg border border-[var(--color-linia)] px-3 py-2.5">
            <dt className="tekst-meta">{t}</dt>
            <dd className="liczba text-[20px] font-semibold leading-7 text-[var(--color-tekst)]">{liczba(n as number | null)}</dd>
            <dd className="tekst-meta">{o}</dd>
          </div>
        ))}
      </dl>
      <Alert tone="info" title="Co się stanie">
        Kupujący z zamówień dostaną profile bez zgody marketingowej (nie dostaną kampanii). Import nie uruchomi żadnej automatyzacji ani maila: zamówienia
        wchodzą jako historia, z datami ze sklepu.
        {plan.tylko60Dni ? " Aplikacja nie ma zakresu read_all_orders, więc Shopify odda tylko zamówienia z ostatnich 60 dni." : ""}
      </Alert>
      <label className="flex items-start gap-2 text-[14px] leading-5 text-[var(--color-tekst)]">
        <input type="checkbox" name="potwierdzam" value="tak" className="mt-0.5 h-4 w-4 accent-[var(--color-akcent)]" />
        Rozumiem, co wejdzie do bazy.
      </label>
      <div>
        <PrzyciskFormularza trwa="Uruchamiam…">Importuj historię</PrzyciskFormularza>
      </div>
    </form>
  );
}
