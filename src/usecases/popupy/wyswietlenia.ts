import { getPool } from "../../adapters/db/pool";
import { METRYKI_WBUDOWANE } from "../../domain/zdarzenia/kontrakt";
import { zapiszZdarzenie } from "../zdarzenia/zapisz-zdarzenie";
import { formularzPubliczny } from "./formularze";

/**
 * Lekkie zdarzenia wyświetleń formularza (0043) do jednego strumienia metric_events
 * (AD-36): „Viewed Form” dla pierwszego kroku i „Viewed Form Step” dla kolejnych (także
 * kroku sukcesu). Gość jest anonimowy (profile_id NULL), więc to tylko statystyka: nie
 * wyzwala automatyzacji (mozeWyzwalac: false) i nie zostawia na profilu żadnych danych.
 *
 * Objętość: unique_id `v:{formularz}:{krok}:{gość}:{dzień UTC}`, więc deduplikacja strumienia
 * (AD-38, event_keys) przepuszcza najwyżej jedno wyświetlenie kroku na gościa dziennie,
 * niezależnie od liczby odsłon. Identyfikator gościa to losowy napis z localStorage, bez
 * powiązania z osobą (nie ma w nim adresu ani IP).
 */

export const WZOR_GOSCIA = /^[a-z0-9]{8,32}$/;

export type WynikWyswietlenia = "zapisano" | "powtorzone" | "nie_znaleziono" | "zly_krok";

export async function zapiszWyswietlenie(popupId: string, dane: { krok: number; gosc: string }, teraz = new Date()): Promise<WynikWyswietlenia> {
  if (!WZOR_GOSCIA.test(dane.gosc) || !Number.isInteger(dane.krok) || dane.krok < 0) return "zly_krok";
  const f = await formularzPubliczny(popupId);
  if (!f) return "nie_znaleziono";
  const def = f.definicja;
  // krok sukcesu ma indeks równy liczbie kroków
  if (dane.krok > def.kroki.length) return "zly_krok";
  const nazwaKroku = dane.krok === def.kroki.length ? def.sukces.nazwa || "Sukces" : def.kroki[dane.krok].nazwa || `Krok ${dane.krok + 1}`;
  const dzien = teraz.toISOString().slice(0, 10);
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const w = await zapiszZdarzenie(klient, {
      tenantId: f.tenantId,
      metryka: dane.krok === 0 ? METRYKI_WBUDOWANE.wyswietlenieFormularza : METRYKI_WBUDOWANE.wyswietlenieKrokuFormularza,
      profileId: null,
      occurredAt: teraz,
      uniqueId: `v:${f.id}:${dane.krok}:${dane.gosc}:${dzien}`,
      properties: { form_id: f.id, form_name: f.nazwa, form_type: def.typ, step_index: dane.krok, step_name: nazwaKroku },
      source: "client",
    });
    await klient.query("commit");
    return w.duplikat ? "powtorzone" : "zapisano";
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}

export interface WynikiFormularza {
  dni: number;
  wyswietlenia: number;
  zapisy: number;
  /** zapisy / wyświetlenia, w procentach; null bez wyświetleń */
  konwersja: number | null;
  /** wyświetlenia każdego kroku (indeks jak w definicji; ostatni = sukces) */
  kroki: { indeks: number; wyswietlenia: number }[];
  /** wszystkie zapisy od początku (stary licznik z events, także sprzed 0043) */
  zapisyRazem: number;
}

/** Wyniki formularza z ostatnich `dni` dni. Predykat tenant_id na każdej tabeli (AD-2). */
export async function wynikiFormularza(tenantId: string, popupId: string, dni: number): Promise<WynikiFormularza> {
  const okres = Math.min(Math.max(Math.round(dni), 1), 365);
  const nazwy = [METRYKI_WBUDOWANE.wyswietlenieFormularza.nazwa, METRYKI_WBUDOWANE.wyswietlenieKrokuFormularza.nazwa, METRYKI_WBUDOWANE.zgloszenieFormularza.nazwa];
  const { rows } = await getPool().query<{ name: string; krok: string | null; ile: number }>(
    `select m.name, e.properties->>'step_index' as krok, count(*)::int as ile
       from metric_events e
       join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
      where e.tenant_id = $1 and m.tenant_id = $1 and m.integration_key = 'midrev' and m.name = any($3::text[])
        and e.occurred_at >= now() - make_interval(days => $4)
        and e.properties->>'form_id' = $2
      group by 1, 2`,
    [tenantId, popupId, nazwy, okres],
  );
  const { rows: razem } = await getPool().query<{ ile: number }>(
    `select count(*)::int as ile from events where tenant_id = $1 and event_type = 'popup.submitted' and payload->>'popup_id' = $2`,
    [tenantId, popupId],
  );
  let wyswietlenia = 0;
  let zapisy = 0;
  const kroki = new Map<number, number>();
  for (const r of rows) {
    if (r.name === nazwy[2]) zapisy += r.ile;
    else {
      const i = Number(r.krok ?? 0);
      if (r.name === nazwy[0]) wyswietlenia += r.ile;
      kroki.set(i, (kroki.get(i) ?? 0) + r.ile);
    }
  }
  return {
    dni: okres,
    wyswietlenia,
    zapisy,
    konwersja: wyswietlenia > 0 ? Math.round((zapisy / wyswietlenia) * 1000) / 10 : null,
    kroki: [...kroki.entries()].sort((a, b) => a[0] - b[0]).map(([indeks, w]) => ({ indeks, wyswietlenia: w })),
    zapisyRazem: razem[0]?.ile ?? 0,
  };
}

/** Wyniki wszystkich formularzy tenanta naraz (lista formularzy): id → {wyświetlenia, zapisy}. */
export async function wynikiFormularzyTenanta(tenantId: string, dni = 30): Promise<Map<string, { wyswietlenia: number; zapisy: number }>> {
  const { rows } = await getPool().query<{ form_id: string; name: string; ile: number }>(
    `select e.properties->>'form_id' as form_id, m.name, count(*)::int as ile
       from metric_events e
       join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
      where e.tenant_id = $1 and m.tenant_id = $1 and m.integration_key = 'midrev' and m.name = any($2::text[])
        and e.occurred_at >= now() - make_interval(days => $3)
      group by 1, 2`,
    [tenantId, [METRYKI_WBUDOWANE.wyswietlenieFormularza.nazwa, METRYKI_WBUDOWANE.zgloszenieFormularza.nazwa], dni],
  );
  const m = new Map<string, { wyswietlenia: number; zapisy: number }>();
  for (const r of rows) {
    if (!r.form_id) continue;
    const w = m.get(r.form_id) ?? { wyswietlenia: 0, zapisy: 0 };
    if (r.name === METRYKI_WBUDOWANE.zgloszenieFormularza.nazwa) w.zapisy += r.ile;
    else w.wyswietlenia += r.ile;
    m.set(r.form_id, w);
  }
  return m;
}
