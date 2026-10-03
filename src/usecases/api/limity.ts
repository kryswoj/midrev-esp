import { getPool } from "../../adapters/db/pool";
import { wyslijAlert } from "../../jobs/alerty";

/**
 * Limity API (E2 / 2.5, plan 2.4). Token bucket w pamięci procesu, per klucz: jeden proces
 * Next = wystarczy (przy drugim procesie limiter musi przejść do Postgresa, plan 2.4).
 *
 *   POST /api/events: 350/s burst, 3500/min (tier XL Klaviyo)
 *   profile:          75/s, 700/min (tier L)  — dla E3
 *   dzienny sufit tenanta: domyślnie 1 mln zdarzeń/dobę (UTC), przekroczenie = 429 i alert
 *
 * Kubełki bez sprzątania rosłyby z każdym kluczem; kluczy jest mało (są w bazie), ale
 * i tak jest twardy sufit mapy.
 */

export interface ProfilLimitu {
  naSekunde: number;
  naMinute: number;
}

export const LIMIT_ZDARZEN: ProfilLimitu = { naSekunde: 350, naMinute: 3500 };
export const LIMIT_PROFILI: ProfilLimitu = { naSekunde: 75, naMinute: 700 };
export const DOBOWY_SUFIT_TENANTA = 1_000_000;

interface Kubelek {
  tokeny: number;
  pojemnosc: number;
  /** tokenów na milisekundę */
  przyrost: number;
  ostatnio: number;
}

const kubelki = new Map<string, Kubelek>();
const MAKS_KUBELKOW = 20_000;

function pobierz(klucz: string, pojemnosc: number, okresMs: number, teraz: number): Kubelek {
  let k = kubelki.get(klucz);
  if (!k) {
    if (kubelki.size >= MAKS_KUBELKOW) kubelki.clear();
    k = { tokeny: pojemnosc, pojemnosc, przyrost: pojemnosc / okresMs, ostatnio: teraz };
    kubelki.set(klucz, k);
  }
  // zegar nie cofa kubełka: skok czasu wstecz (NTP) nie może odebrać ani dodać tokenów
  k.tokeny = Math.min(k.pojemnosc, k.tokeny + Math.max(0, teraz - k.ostatnio) * k.przyrost);
  k.ostatnio = Math.max(k.ostatnio, teraz);
  return k;
}

export type WynikLimitu = { ok: true } | { ok: false; poSekundach: number };

/**
 * Zdejmuje po tokenie z obu kubełków (sekundowego i minutowego) albo z żadnego.
 * `poSekundach` = kiedy najwcześniej wróci token w pustym kubełku (nagłówek Retry-After).
 */
export function sprawdzLimit(trasa: string, kluczId: string, profil: ProfilLimitu, teraz = Date.now()): WynikLimitu {
  const sek = pobierz(`${trasa}:${kluczId}:s`, profil.naSekunde, 1000, teraz);
  const min = pobierz(`${trasa}:${kluczId}:m`, profil.naMinute, 60_000, teraz);
  if (sek.tokeny < 1 || min.tokeny < 1) {
    const brak = (k: Kubelek) => (k.tokeny >= 1 ? 0 : (1 - k.tokeny) / k.przyrost);
    return { ok: false, poSekundach: Math.max(1, Math.ceil(Math.max(brak(sek), brak(min)) / 1000)) };
  }
  sek.tokeny -= 1;
  min.tokeny -= 1;
  return { ok: true };
}

// ── Dzienny sufit tenanta ─────────────────────────────────────────────────────

interface LicznikDnia {
  dzien: string;
  ile: number;
  zaalarmowano: boolean;
}
const dzienne = new Map<string, LicznikDnia>();

function dzienUtc(teraz: number): string {
  return new Date(teraz).toISOString().slice(0, 10);
}

function sekundDoPolnocyUtc(teraz: number): number {
  const d = new Date(teraz);
  const polnoc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((polnoc - teraz) / 1000));
}

/**
 * Czy tenant zmieści jeszcze jedno zdarzenie dziś (bez zaliczania: zalicza `zaliczDoSufitu`).
 * Sufit MIĘKKI (świadomie, review Codeksa R3): równoległe żądania przy `ile = sufit - 1`
 * mogą go przekroczyć o liczbę żądań w locie. To ochrona przed zalaniem (1 mln/dobę), nie
 * rozliczenie, więc przekroczenie o kilkadziesiąt zdarzeń nie ma skutku. Licznik startuje z bazy (żądania API
 * przyjęte dziś, `raw_events` kanału api), więc restart procesu nie zeruje sufitu.
 * Przekroczenie: 429 do północy UTC i JEDEN alert na dobę na kanał techniczny.
 */
export async function sprawdzSufitDobowy(
  tenantId: string,
  sufit = DOBOWY_SUFIT_TENANTA,
  teraz = Date.now(),
  kanal: "api" | "client" = "api",
): Promise<WynikLimitu> {
  const dzien = dzienUtc(teraz);
  const klucz = kanal === "api" ? tenantId : `${kanal}:${tenantId}`;
  let l = dzienne.get(klucz);
  if (!l || l.dzien !== dzien) {
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from raw_events
        where tenant_id = $1 and channel = $3 and received_at >= $2::date::timestamptz`,
      [tenantId, dzien, kanal],
    );
    l = { dzien, ile: rows[0].n, zaalarmowano: false };
    dzienne.set(klucz, l);
  }
  if (l.ile >= sufit) {
    if (!l.zaalarmowano) {
      l.zaalarmowano = true;
      void wyslijAlert(`dzienny sufit zdarzeń ${kanal === "api" ? "API" : "ze strony (Client API)"} (${sufit}) przekroczony - kolejne żądania dostają 429 do północy UTC`, {
        poziom: "krytyczny",
        tenantId,
      });
    }
    return { ok: false, poSekundach: sekundDoPolnocyUtc(teraz) };
  }
  return { ok: true };
}

/**
 * Zaliczenie PRZYJĘTEGO zdarzenia do sufitu (po zapisie surowego żądania, tylko nowego):
 * odrzucone 400/413/415 i powtórki nie zjadają limitu (review Codeksa R2a).
 */
export function zaliczDoSufitu(tenantId: string, teraz = Date.now(), kanal: "api" | "client" = "api"): void {
  const l = dzienne.get(kanal === "api" ? tenantId : `${kanal}:${tenantId}`);
  if (l && l.dzien === dzienUtc(teraz)) l.ile += 1;
}

/** Tylko testy. */
export function wyczyscLimity(): void {
  kubelki.clear();
  dzienne.clear();
}
