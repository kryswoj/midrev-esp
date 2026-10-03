import { getPool } from "../../adapters/db/pool";

/**
 * „Sprawdź połączenie” w kreatorze integracji: co ostatnio przyszło z tej strony.
 *
 * Dwa źródła:
 *   1. pamięć procesu (ostatnie 30 sygnałów na klucz strony, najwyżej 1 h): pobranie skryptu,
 *      zdarzenia anonimowe (gość jeszcze nierozpoznany, więc NIC nie zapisujemy w bazie),
 *      odrzucenia (zły origin, zastrzeżona nazwa). Bez danych osobowych: nazwa metryki,
 *      sama ścieżka adresu (bez query, które bywa nośnikiem e-maila) i origin.
 *   2. baza: ostatnie zdarzenia `source = 'client'` tenanta ze strumienia (rozpoznane osoby),
 *      z odnośnikiem do profilu.
 * Jeden proces Next (plan 2.4) = pamięć wystarcza; przy drugim procesie podgląd pokaże
 * tylko sygnały z procesu, który obsłużył żądanie panelu (zdarzenia z bazy zawsze).
 */

export type RodzajSygnalu = "skrypt" | "anonimowe" | "przyjete" | "odrzucone" | "subskrypcja";

export interface Sygnal {
  rodzaj: RodzajSygnalu;
  kiedy: number;
  metryka: string | null;
  sciezka: string | null;
  origin: string | null;
  powod?: string;
}

const MAKS_NA_KLUCZ = 30;
const WAZNOSC_MS = 3600_000;
const sygnaly = new Map<string, Sygnal[]>();

/** Sama ścieżka (bez query i fragmentu), najwyżej 200 znaków; null gdy to nie jest URL http(s). */
export function sciezkaBezDanych(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return (u.pathname || "/").slice(0, 200);
  } catch {
    return null;
  }
}

/** Origin w postaci `https://host[:port]`; null dla czegokolwiek innego. */
export function originBezDanych(origin: unknown): string | null {
  if (typeof origin !== "string" || !origin || origin === "null") return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin.slice(0, 200);
  } catch {
    return null;
  }
}

export function zanotujSygnal(kluczStrony: string, s: Omit<Sygnal, "kiedy"> & { kiedy?: number }): void {
  const teraz = s.kiedy ?? Date.now();
  if (!sygnaly.has(kluczStrony) && sygnaly.size > 2_000) sygnaly.clear();
  const lista = (sygnaly.get(kluczStrony) ?? []).filter((x) => teraz - x.kiedy < WAZNOSC_MS);
  lista.unshift({
    rodzaj: s.rodzaj,
    kiedy: teraz,
    metryka: s.metryka ? s.metryka.slice(0, 127) : null,
    sciezka: s.sciezka,
    origin: s.origin,
    ...(s.powod ? { powod: s.powod.slice(0, 120) } : {}),
  });
  sygnaly.set(kluczStrony, lista.slice(0, MAKS_NA_KLUCZ));
}

export function sygnalyStrony(kluczStrony: string, teraz = Date.now()): Sygnal[] {
  return (sygnaly.get(kluczStrony) ?? []).filter((x) => teraz - x.kiedy < WAZNOSC_MS);
}

export interface ZdarzenieStrony {
  id: string;
  metryka: string;
  kiedy: Date;
  sciezka: string | null;
  profileId: string | null;
  /** e-mail zamaskowany (a***@sklep.pl): podgląd ma pokazać, ŻE osoba jest rozpoznana */
  osoba: string | null;
}

function maskujEmail(email: string | null): string | null {
  if (!email) return null;
  const [lokal, domena] = email.split("@");
  if (!domena) return null;
  return `${lokal.slice(0, 1)}***@${domena}`;
}

/** Ostatnie zdarzenia z przeglądarki (źródło `client`) z ostatniej doby, najnowsze pierwsze. */
export async function ostatnieZdarzeniaStrony(tenantId: string, limit = 15): Promise<ZdarzenieStrony[]> {
  const { rows } = await getPool().query<{
    id: string;
    name: string;
    occurred_at: Date;
    url: string | null;
    profile_id: string | null;
    email: string | null;
  }>(
    `select e.id, m.name, e.occurred_at,
            coalesce(e.properties ->> 'URL', e.properties ->> 'url', e.properties ->> 'CheckoutURL', e.properties ->> 'page') as url,
            e.profile_id, p.email
       from metric_events e
       join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
       left join profiles p on p.tenant_id = e.tenant_id and p.id = e.profile_id
      where e.tenant_id = $1 and e.source = 'client'
        and e.occurred_at >= now() - interval '1 day'
      order by e.recorded_at desc
      limit $2`,
    [tenantId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    metryka: r.name,
    kiedy: r.occurred_at,
    sciezka: sciezkaBezDanych(r.url),
    profileId: r.profile_id,
    osoba: maskujEmail(r.email),
  }));
}

/** Tylko testy. */
export function wyczyscSygnaly(): void {
  sygnaly.clear();
}
