import { ocenFiltr, type Filtr } from "../filtry";
import { OKNO_WYZWALANIA_MS, TOLERANCJA_PRZYSZLOSCI_MS, type ZrodloZdarzenia as ZrodloZKontraktu } from "../zdarzenia/kontrakt";
import type { MetrykaRef, PonowneWejscie } from "./graf";

/**
 * Reguly wejscia do automatyzacji z wyzwalaczem metrycznym (AD-39, AD-41, plan 2.6 i 3.4).
 * Czysta domena plus PORT zrodla zdarzen, ktory dostarcza silnikowi kandydatow.
 */

/** Jak daleko zdarzenie moze byc spoznione (dotarcie - zajscie), zeby jeszcze wyzwalac flow (kontrakt A↔B). */
export const MAX_SPOZNIENIE_MS = OKNO_WYZWALANIA_MS;
/** Zdarzenie "z przyszlosci" (zly zegar zrodla) ponad ten margines nie wyzwala. */
export const MARGINES_PRZYSZLOSCI_MS = TOLERANCJA_PRZYSZLOSCI_MS;
/** Zakladka skanu: transakcje zatwierdzone poza kolejnoscia (joby maja statement_timeout 60 s). */
export const ZAKLADKA_SKANU_MIN = 15;
/** Zdarzenie zarejestrowane dawniej niz tyle przed tikiem nie wchodzi (worker lezal) - alert. */
export const MAX_ZALEGLOSC_SKANU_MIN = 24 * 60;

export type ZrodloZdarzenia = ZrodloZKontraktu;

/** Zdarzenie-kandydat do wejscia (jeden wiersz strumienia). */
export interface ZdarzenieWyzwalajace {
  id: string;
  profileId: string;
  /** dokladny tekst znacznika czasu z bazy (klucz partycji, kursor) */
  occurredAt: string;
  recordedAt: string;
  occurredAtMs: number;
  recordedAtMs: number;
  /**
   * Kiedy zdarzenie do nas DOTARLO (metric_events.ingested_at, kontrakt A↔B). Od niego liczy
   * sie regula 4 h: opozniony worker nie zamienia swiezego zdarzenia w spoznione. Brak
   * (stara tabela events) = recorded_at.
   */
  ingestedAtMs?: number;
  properties: Record<string, unknown>;
  backfill: boolean;
  source: ZrodloZdarzenia;
  /** dane przebiegu dla dotychczasowych warunkow (np. orderId, totalMinor) */
  context: Record<string, unknown>;
}

export type PowodOdrzucenia = "backfill" | "import" | "spoznione" | "z_przyszlosci" | "sprzed_wlaczenia" | "filtr_wyzwalacza";

/**
 * Czy zdarzenie w ogole moze wyzwolic flow (AD-39): zapis do statystyk zawsze, wejscie tylko
 * dla swiezych, nie-importowanych, nie-backfillowych i nie starszych niz wlaczenie flow.
 */
export function regulaCzasu(e: Pick<ZdarzenieWyzwalajace, "occurredAtMs" | "recordedAtMs" | "ingestedAtMs" | "backfill" | "source">, activeSinceMs: number): PowodOdrzucenia | null {
  if (e.backfill) return "backfill";
  if (e.source === "import") return "import";
  const dotarlo = e.ingestedAtMs ?? e.recordedAtMs;
  if (dotarlo - e.occurredAtMs > MAX_SPOZNIENIE_MS) return "spoznione";
  if (e.occurredAtMs - dotarlo > MARGINES_PRZYSZLOSCI_MS) return "z_przyszlosci";
  if (e.occurredAtMs < activeSinceMs) return "sprzed_wlaczenia";
  return null;
}

/** Pelna decyzja o jednym zdarzeniu: regula czasu, potem filtr wyzwalacza. */
export function ocenKandydata(e: ZdarzenieWyzwalajace, activeSinceMs: number, filtr: Filtr | undefined, teraz: Date): PowodOdrzucenia | null {
  const czas = regulaCzasu(e, activeSinceMs);
  if (czas) return czas;
  if (!ocenFiltr(filtr, { zdarzenie: e.properties, teraz })) return "filtr_wyzwalacza";
  return null;
}

/** Klucz wejscia (AD-41): "raz" = jedno wejscie na zawsze, inaczej jedno wejscie na zdarzenie. */
export function kluczWejscia(tryb: PonowneWejscie["tryb"], zdarzenie: { id: string } | { listId: string; addedAtEpoch: string }): string {
  if (tryb === "raz") return "raz";
  if ("id" in zdarzenie) return `e:${zdarzenie.id}`;
  return `l:${zdarzenie.listId}:${zdarzenie.addedAtEpoch}`;
}

export function minutPonownegoWejscia(p: PonowneWejscie): number | null {
  if (p.tryb !== "po") return null;
  return p.ilosc * (p.jednostka === "minuty" ? 1 : p.jednostka === "godziny" ? 60 : 1440);
}

// ── Port: zrodlo zdarzen dla wyzwalaczy ─────────────────────────────────────

/** Minimalny interfejs polaczenia (domena nie importuje sterownika bazy). */
export interface Wykonawca {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(sql: string, parametry?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** Kursor skanu: ostatnie przetworzone zdarzenie w porzadku (recorded_at, id). */
export interface KursorSkanu {
  recordedAt: string;
  id: string;
}

/** Najmniejszy uuid: kursor "przed pierwszym zdarzeniem tej chwili". */
export const UUID_ZERO = "00000000-0000-0000-0000-000000000000";

/**
 * Dwa rodzaje odczytu (plan 2.6):
 *  - `nowe`: (recorded_at, id) > kursor, rosnaco, z limitem. Zawsze posuwa kursor naprzod,
 *    wiec duzy wolumen nie zapetla skanu; `nieWczesniejNiz` = teraz - 24 h (worker lezal);
 *  - `zakladka`: recorded_at w (kursor - 15 min, kursor]: transakcje zatwierdzone poza
 *    kolejnoscia, niewidoczne przy poprzednim skanie. Ponowne przetworzenie jest bezpieczne
 *    (unikalnosc wejscia), kursor sie nie rusza.
 */
export interface ZapytanieKandydatow {
  tenantId: string;
  metryka: MetrykaRef;
  zakres:
    | { rodzaj: "nowe"; kursor: KursorSkanu; nieWczesniejNiz: string }
    | { rodzaj: "zakladka"; od: string; kursor: KursorSkanu };
  /** dolna granica zajscia (przycina partycje metric_events) */
  zaszlePo: string;
  limit: number;
}

/**
 * Skad silnik bierze zdarzenia do wyzwalaczy metrycznych. Dzis implementacja na tabeli
 * `events` (`zrodloZdarzenEvents`); po scaleniu strumienia A: `metric_events` (AD-36).
 * Kontrakt: kandydaci posortowani po (recorded_at, id), wylacznie z profilem, wylacznie
 * tego tenanta; `pobierzWlasciwosci` szuka zdarzenia w granicach tenanta.
 */
export interface ZrodloZdarzenDoWyzwalaczy {
  readonly nazwa: string;
  kandydaci(klient: Wykonawca, z: ZapytanieKandydatow): Promise<ZdarzenieWyzwalajace[]>;
  /** properties zdarzenia wyzwalajacego do szablonu maila (null = brak / nie tego tenanta) */
  pobierzWlasciwosci(klient: Wykonawca, tenantId: string, eventId: string, occurredAt: string | null): Promise<Record<string, unknown> | null>;
  /** id metryki tenanta (do flows.trigger_metric_id), null gdy zrodlo nie zna metryk */
  idMetryki(klient: Wykonawca, tenantId: string, metryka: MetrykaRef): Promise<string | null>;
}

/** Metryka w katalogu tenanta (wybor wyzwalacza w kanwie). */
export interface MetrykaKatalogu {
  id: string | null;
  integracja: string;
  nazwa: string;
  canTrigger: boolean;
}

/** Port katalogu metryk tenanta (lista do wyboru wyzwalacza). Po scaleniu A: tabela `metrics`. */
export interface KatalogMetryk {
  lista(klient: Wykonawca, tenantId: string): Promise<MetrykaKatalogu[]>;
}
