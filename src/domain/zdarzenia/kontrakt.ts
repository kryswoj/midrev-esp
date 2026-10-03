/**
 * KONTRAKT strumienia zdarzeń metryk (strumień A → strumień B).
 *
 * Strumień A (zdarzenia, API, profil) buduje tabelę `metric_events` i jedyny punkt zapisu
 * `zapiszZdarzenie`. Strumień B (automatyzacje: graf v2, filtry, re-entry, zmienne) CZYTA
 * ze strumienia. Ten plik jest stałą umową między nimi: nazwy tabel i kolumn, kształt
 * zapisanego zdarzenia, metryki wbudowane, reguła „czy zdarzenie może wyzwolić flow”
 * (AD-39) i sygnatury funkcji odczytu. Zmiana czegokolwiek tutaj = zmiana umowy, uzgodniona
 * z drugim strumieniem (opis: research/.../metryki-i-profil-2026-09-30/KONTRAKT-A-B.md).
 *
 * Czysta domena: zero importów bazy. Implementacje funkcji z sekcji „Odczyt” żyją
 * w `src/usecases/zdarzenia/` (ścieżki podane przy typach).
 */

// ── Schemat (migracja 0030) ────────────────────────────────────────────────────

/** Tabela strumienia: partycjonowana miesięcznie po `occurred_at`, bez partycji DEFAULT (AD-45). */
export const TABELA_ZDARZEN = "metric_events" as const;
/** Słownik metryk: jedna metryka = (tenant, integration_key, name) (AD-37). */
export const TABELA_METRYK = "metrics" as const;

/**
 * Kolumny `metric_events` (klucz główny: `(tenant_id, occurred_at, id)`):
 *
 * | kolumna        | typ          | znaczenie |
 * |----------------|--------------|-----------|
 * | id             | uuid (v7)    | tożsamość zdarzenia; dla zdarzeń lustrzanych starej tabeli `events` = `events.id` |
 * | tenant_id      | uuid         | zawsze w predykacie (AD-2) |
 * | metric_id      | uuid         | FK złożony `(tenant_id, metric_id)` → metrics |
 * | profile_id     | uuid NULL    | FK złożony `(tenant_id, profile_id)` → profiles; NULL = gość bez adresu albo profil usunięty |
 * | occurred_at    | timestamptz  | kiedy zdarzenie się stało, ZE ŹRÓDŁA (AD-10), precyzja: sekunda (AD-39); klucz partycji |
 * | recorded_at    | timestamptz  | kiedy wiersz zapisano w strumieniu (clock_timestamp()); kursor skanu wejść |
 * | ingested_at    | timestamptz  | kiedy zdarzenie DOTARŁO do nas (API: `raw_events.received_at`); od niego liczy się reguła 4 h |
 * | unique_id      | text         | `unique_id` Klaviyo; brak = epoch w sekundach (AD-38) |
 * | value_minor    | bigint NULL  | `$value` w jednostkach minor waluty (AD-11) |
 * | value_currency | char(3) NULL | waluta `value_minor` |
 * | properties     | jsonb        | właściwości zdarzenia (top-level jak w Klaviyo; `$extra`, `$value` zostają w środku) |
 * | source         | text         | api / client / webhook / system / import |
 * | backfill       | boolean      | true = zdarzenie NIE wyzwala flow (patrz `czyBackfill`) — wyliczone i zapisane przy zapisie |
 * | message_id     | uuid NULL    | metryki e-mail: łącznik do messages (poza MVP) |
 */
export const KOLUMNY_ZDARZENIA = [
  "id",
  "tenant_id",
  "metric_id",
  "profile_id",
  "occurred_at",
  "recorded_at",
  "ingested_at",
  "unique_id",
  "value_minor",
  "value_currency",
  "properties",
  "source",
  "backfill",
  "message_id",
] as const;

export type ZrodloZdarzenia = "api" | "client" | "webhook" | "system" | "import";

export type IntegracjaMetryki = "midrev" | "api" | "woocommerce" | "stripe" | "shopify";

export type KategoriaIntegracji = "Internal" | "API" | "eCommerce" | "Payments";

export const KATEGORIA_INTEGRACJI: Record<IntegracjaMetryki, KategoriaIntegracji> = {
  midrev: "Internal",
  api: "API",
  woocommerce: "eCommerce",
  stripe: "Payments",
  shopify: "eCommerce",
};

/** Klucz naturalny metryki (AD-37). */
export interface KluczMetryki {
  integracja: IntegracjaMetryki;
  nazwa: string;
}

/** Wiersz `metrics` w kształcie dla kodu. */
export interface Metryka {
  id: string;
  tenantId: string;
  integracja: IntegracjaMetryki;
  nazwa: string;
  wbudowana: boolean;
  /** false: metryka nie może być wyzwalaczem flow (Opened/Clicked Email, techniczne) */
  mozeWyzwalac: boolean;
  /** true: techniczna (rodo.*, customer.*), ukryta na listach w UI */
  ukryta: boolean;
  pierwszeZdarzenie: Date | null;
  ostatnieZdarzenie: Date | null;
}

/** Zdarzenie odczytane ze strumienia. To jest to, co dostaje silnik automatyzacji. */
export interface ZapisaneZdarzenie {
  id: string;
  tenantId: string;
  metricId: string;
  profileId: string | null;
  /** czas zdarzenia ze źródła, pełne sekundy; razem z `id` identyfikuje wiersz (klucz partycji) */
  occurredAt: Date;
  recordedAt: Date;
  ingestedAt: Date;
  uniqueId: string;
  /** bigint jako tekst (pg zwraca int8 jako string, JS number traci precyzję > 2^53) */
  valueMinor: string | null;
  valueCurrency: string | null;
  properties: Record<string, unknown>;
  source: ZrodloZdarzenia;
  backfill: boolean;
  messageId: string | null;
}

// ── Metryki wbudowane (plan, sekcja 1.3; MVP: popup, Woo, techniczne) ─────────

export interface DefinicjaMetrykiWbudowanej extends KluczMetryki {
  mozeWyzwalac: boolean;
  ukryta: boolean;
}

export const METRYKI_WBUDOWANE = {
  /** popup (zglos-popup.ts); unique_id `form:{popup_id}:{event_id}`; properties `{form_id, form_name}` */
  zgloszenieFormularza: { integracja: "midrev", nazwa: "Submitted Form", mozeWyzwalac: true, ukryta: false },
  /**
   * wyświetlenie formularza na stronie (pierwszy krok; 0043); profil NULL (anonimowy gość);
   * unique_id `v:{form_id}:0:{gość}:{dzień UTC}` = najwyżej jedno na gościa dziennie;
   * properties `{form_id, form_name, form_type, step_index, step_name}`. Nie wyzwala flow.
   */
  wyswietlenieFormularza: { integracja: "midrev", nazwa: "Viewed Form", mozeWyzwalac: false, ukryta: false },
  /** wyświetlenie kolejnego kroku (step_index ≥ 1, także krok sukcesu); jak wyżej, ukryte */
  wyswietlenieKrokuFormularza: { integracja: "midrev", nazwa: "Viewed Form Step", mozeWyzwalac: false, ukryta: true },
  /** zamówienie Woo przy PIERWSZYM pojawieniu się; unique_id = orders.id; value_minor = suma zamówienia */
  zlozoneZamowienie: { integracja: "woocommerce", nazwa: "Placed Order", mozeWyzwalac: true, ukryta: false },
  /** jedna na pozycję zamówienia Woo; unique_id `{orders.id}:{line_id}`; properties w kształcie Klaviyo (ProductID, ProductName, Quantity...) */
  zamowionyProdukt: { integracja: "woocommerce", nazwa: "Ordered Product", mozeWyzwalac: true, ukryta: false },
  /** techniczne, ukryte, nie wyzwalają */
  klientUtworzony: { integracja: "midrev", nazwa: "customer.created", mozeWyzwalac: false, ukryta: true },
  klientZaktualizowany: { integracja: "midrev", nazwa: "customer.updated", mozeWyzwalac: false, ukryta: true },
  rodoEksport: { integracja: "midrev", nazwa: "rodo.eksport", mozeWyzwalac: false, ukryta: true },
  rodoAnonimizacja: { integracja: "midrev", nazwa: "rodo.anonimizacja", mozeWyzwalac: false, ukryta: true },
} as const satisfies Record<string, DefinicjaMetrykiWbudowanej>;

export type NazwaWbudowanej = keyof typeof METRYKI_WBUDOWANE;

/**
 * Mapa dla upgradera grafu v1 → v2 (strumień B): stary `event_type` z tabeli `events`
 * → metryka w strumieniu. `list.joined` NIE jest metryką (wyzwalacz listowy zostaje).
 */
export const METRYKA_ZE_STAREGO_TYPU: Readonly<Record<string, DefinicjaMetrykiWbudowanej>> = {
  "popup.submitted": METRYKI_WBUDOWANE.zgloszenieFormularza,
  "order.created": METRYKI_WBUDOWANE.zlozoneZamowienie,
  "customer.created": METRYKI_WBUDOWANE.klientUtworzony,
  "customer.updated": METRYKI_WBUDOWANE.klientZaktualizowany,
  "rodo.eksport": METRYKI_WBUDOWANE.rodoEksport,
  "rodo.anonimizacja": METRYKI_WBUDOWANE.rodoAnonimizacja,
};

// ── Reguła czasu i backfill (AD-39, plan 2.6) ─────────────────────────────────

/** Zdarzenie zarejestrowane później niż 4 h po czasie zdarzenia nie wyzwala flow. */
export const OKNO_WYZWALANIA_MS = 4 * 3600 * 1000;
/** Czas zdarzenia dalej w przyszłości niż 5 min (API prywatne) = backfill. */
export const TOLERANCJA_PRZYSZLOSCI_MS = 5 * 60 * 1000;

/**
 * Czy zdarzenie jest „backfillem” (zapis do statystyk tak, wyzwolenie flow nie).
 * Liczone RAZ, przy zapisie, i trzymane w kolumnie `backfill`; silnik nie liczy go
 * drugi raz inaczej. Warunki (plan 2.6): jawna flaga z żądania, import historii,
 * czas > teraz + 5 min, dotarcie później niż 4 h po czasie zdarzenia.
 */
export function czyBackfill(z: {
  flaga: boolean;
  source: ZrodloZdarzenia;
  occurredAt: Date;
  ingestedAt: Date;
}): boolean {
  if (z.flaga) return true;
  if (z.source === "import") return true;
  const roznica = z.ingestedAt.getTime() - z.occurredAt.getTime();
  if (roznica < -TOLERANCJA_PRZYSZLOSCI_MS) return true;
  if (roznica > OKNO_WYZWALANIA_MS) return true;
  return false;
}

/**
 * Czy zapisane zdarzenie może wyzwolić flow. `activeSince`: zdarzenie sprzed
 * włączenia flow nie wchodzi (plan 2.6, ostatni wiersz tabeli) — to warunek per flow,
 * więc podaje go silnik. Profil wymagany: bez osoby nie ma kogo wprowadzić do flow.
 */
export function czyMozeWyzwolic(
  z: Pick<ZapisaneZdarzenie, "backfill" | "source" | "occurredAt" | "ingestedAt" | "profileId">,
  activeSince?: Date | null,
): boolean {
  if (!z.profileId) return false;
  if (z.backfill) return false;
  if (z.source === "import") return false;
  if (z.ingestedAt.getTime() - z.occurredAt.getTime() > OKNO_WYZWALANIA_MS) return false;
  if (activeSince && z.occurredAt.getTime() < activeSince.getTime()) return false;
  return true;
}

/**
 * Ten sam warunek jako fragment SQL (bez `active_since`, który jest per flow).
 * `alias` to alias tabeli metric_events w zapytaniu; dopuszczalny tylko identyfikator.
 */
export function predykatWyzwalaniaSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`niedozwolony alias: ${alias}`);
  return `(${alias}.backfill = false and ${alias}.source <> 'import' and ${alias}.profile_id is not null and ${alias}.ingested_at - ${alias}.occurred_at <= interval '4 hours')`;
}

// ── Zapis (implementacja: src/usecases/zdarzenia/zapisz-zdarzenie.ts) ─────────

/** Wejście jedynego punktu zapisu strumienia (AD-36). */
export interface WejscieZdarzenia {
  tenantId: string;
  metryka: KluczMetryki & { mozeWyzwalac?: boolean; ukryta?: boolean; wbudowana?: boolean };
  profileId: string | null;
  /** czas ze źródła; ucinany do pełnej sekundy */
  occurredAt: Date;
  /** kiedy zdarzenie do nas dotarło; domyślnie teraz */
  ingestedAt?: Date;
  /** `unique_id` Klaviyo; brak = epoch sekund `occurredAt` */
  uniqueId?: string | null;
  properties?: Record<string, unknown>;
  /** kwota w jednostkach minor; alternatywnie `$value` w properties (przeliczane wg waluty) */
  valueMinor?: number | bigint | string | null;
  valueCurrency?: string | null;
  source: ZrodloZdarzenia;
  /** jawna flaga backfill z żądania */
  backfill?: boolean;
  /** wymuszony identyfikator (lustro starej tabeli `events`) */
  id?: string;
  messageId?: string | null;
}

export interface WynikZapisuZdarzenia {
  id: string;
  occurredAt: Date;
  metricId: string;
  /** true: to samo zdarzenie było już zapisane (AD-38), zwrócone `id` jest istniejące */
  duplikat: boolean;
  backfill: boolean;
}

// ── Odczyt dla silnika automatyzacji (implementacja: src/usecases/zdarzenia/odczyt.ts) ──

/**
 * Parametry skanu wejść (plan 2.6). Silnik trzyma własny znacznik `scanned_to` per flow
 * i podaje: `recordedPo` = scanned_to − 15 min (zakładka na transakcje zatwierdzone poza
 * kolejnością), `occurredOd` = scanned_to − 4 h 15 min (przycina partycje).
 * Zwracane są WYŁĄCZNIE zdarzenia spełniające `predykatWyzwalaniaSql`, posortowane
 * `(recorded_at, id)`, najwyżej `limit` (domyślnie 1000).
 */
export interface ParametrySkanu {
  tenantId: string;
  metricId: string;
  recordedPo: Date;
  occurredOd: Date;
  limit?: number;
}

/**
 * Funkcje odczytu udostępnione strumieniowi B. Pierwszy argument `db` to `Pool` albo
 * `PoolClient` z `pg` (skan wejść chodzi w transakcji silnika).
 *
 *   src/usecases/zdarzenia/odczyt.ts
 *     zdarzeniaDoSkanu(db, p: ParametrySkanu): Promise<ZapisaneZdarzenie[]>
 *     zdarzeniePoId(db, tenantId, id, occurredAt): Promise<ZapisaneZdarzenie | null>   // null = brak albo cudze (AD-40)
 *
 *   src/usecases/zdarzenia/metryki.ts
 *     metrykaPoKluczu(db, tenantId, klucz: KluczMetryki, { utworz?: boolean }): Promise<Metryka | null>
 *     metrykaPoId(db, tenantId, metricId): Promise<Metryka | null>                     // null = brak albo cudza (AD-40)
 *     metrykiTenanta(tenantId, { takzeUkryte?: boolean }): Promise<Metryka[]>
 *
 *   src/usecases/zdarzenia/zapisz-zdarzenie.ts
 *     zapiszZdarzenie(klient: PoolClient, w: WejscieZdarzenia): Promise<WynikZapisuZdarzenia>
 *     // jedyny INSERT do metric_events (AD-36); klient MUSI być w otwartej transakcji
 */
export const MODULY_ODCZYTU = {
  odczyt: "src/usecases/zdarzenia/odczyt.ts",
  metryki: "src/usecases/zdarzenia/metryki.ts",
  zapis: "src/usecases/zdarzenia/zapisz-zdarzenie.ts",
} as const;
