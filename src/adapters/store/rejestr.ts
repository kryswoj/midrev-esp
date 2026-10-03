import type {
  BytSklepu,
  KlientSklepu,
  PlatformaSklepu,
  PortSklepu,
  ProduktSklepu,
  RolaStatusu,
  ZamowienieSklepu,
} from "../../domain/store/contract";
import { DEFINICJA_WOO } from "./woo/definicja";

/**
 * Rejestr platform portu „Sklep” (plan integracji E.1). Jedno miejsce, w którym system
 * dowiaduje się, jak rozmawiać z konkretną platformą. Wszystko poza tym plikiem i katalogiem
 * adaptera (`adapters/store/<platforma>/`) jest wspólne: podłączenie, rejestracja webhooków,
 * ingest webhooków (faza 1 i 2), import historii, katalog, koszyki, zgody, role metryk.
 *
 * Nowa platforma (Shopify, Shoper) = nowy plik `definicja.ts` w swoim katalogu + jeden wpis
 * w `DEFINICJE` niżej + trasa `/api/webhooks/<skrót>/[storeId]` wołająca `przyjmijWebhookSklepu`.
 * Kontrakt opisany w research/.../integracje-2026-10-03/KONTRAKT-PORT-SKLEP.md.
 */

/** Webhooki po stronie platformy: tematy, podpis, klucz idempotencji. */
export interface DefinicjaWebhookow {
  /** tematy subskrybowane przy podłączeniu (rejestracja i dedup po (adres, temat)) */
  readonly tematy: readonly string[];
  /** ścieżka trasy dostawy pod APP_URL; MUSI być stała dla sklepu (dedup po adresie) */
  sciezkaDostawy(storeId: string): string;
  /** temat z nagłówków dostawy; pusty = brak (400) */
  temat(naglowki: Headers): string;
  /** weryfikacja podpisu surowego ciała (stały czas porównania) */
  zweryfikujPodpis(naglowki: Headers, cialo: string, sekret: string): boolean;
  /** dostawa testowa bez podpisu (Woo: `webhook_id=...`): 200 bez zapisu */
  ping?(naglowki: Headers, cialo: string): boolean;
  /** czy temat jest subskrybowany (inne: 200 bez zapisu, żeby platforma nie wyłączyła webhooka) */
  obslugiwany(temat: string): boolean;
  /** byt z tematu; null = temat nieobsługiwany przez fazę 2 */
  bytTematu(temat: string): BytSklepu | null;
  /**
   * Walidacja minimalna payloadu i klucz idempotencji opisujący BYT (AD-24):
   * `{platforma}:{tenant}:{byt}:{id}:{wersja ze źródła}`. Błąd = 400 z tym opisem.
   */
  klucz(tenantId: string, byt: BytSklepu, dane: any): { klucz: string } | { blad: string };
}

export interface DefinicjaPlatformy {
  readonly platforma: Exclude<PlatformaSklepu, "custom">;
  /** wartość `raw_events.source` dla tej platformy (webhook i import) */
  readonly zrodloSurowych: string;
  /** adapter API z odszyfrowanych poświadczeń (`stores.credentials_encrypted`) */
  utworzAdapter(tenantId: string, baseUrl: string, poswiadczenia: Record<string, unknown>): PortSklepu;
  /** sekret podpisu webhooków z poświadczeń; null = sklep nie zweryfikuje niczego */
  sekretWebhooka(poswiadczenia: Record<string, unknown>): string | null;
  webhooki?: DefinicjaWebhookow;
  /** mapowanie surowych payloadów (webhook i REST mają ten sam kształt) */
  mapujZamowienie(payload: unknown): ZamowienieSklepu;
  mapujKlienta(payload: unknown): KlientSklepu;
  mapujProdukt?(payload: unknown): ProduktSklepu;
  /** status zamówienia -> rola metryki statusu (Fulfilled/Cancelled/Refunded) albo null */
  rolaStatusu(status: string): RolaStatusu | null;
  /** wersja bytu do klucza idempotencji importu; MUSI być równa tej z webhooka */
  wersjaBytu(byt: { surowe: unknown; zmodyfikowaneAt: Date }): string;
}

const DEFINICJE: Partial<Record<PlatformaSklepu, DefinicjaPlatformy>> = {
  woocommerce: DEFINICJA_WOO,
};

/** Definicja platformy albo null (custom nie ma adaptera API: dane idą przez /api i /client). */
export function definicjaPlatformy(platforma: string): DefinicjaPlatformy | null {
  return (DEFINICJE as Record<string, DefinicjaPlatformy | undefined>)[platforma] ?? null;
}

/** Definicja po `raw_events.source` (faza 2 webhooka). */
export function definicjaPoZrodle(zrodlo: string): DefinicjaPlatformy | null {
  for (const d of Object.values(DEFINICJE)) if (d && d.zrodloSurowych === zrodlo) return d;
  return null;
}
