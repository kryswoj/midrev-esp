/**
 * Delegacja subdomeny wysyłkowej do strefy Route 53 platformy („jeden wpis u dostawcy").
 *
 * Klient wpisuje u siebie JEDEN rekord NS (nazwa `news`, cztery serwery Route 53), a
 * wszystkie rekordy pod news.<domena> (podpis, adres zwrotny, ochrona) zakłada i utrzymuje
 * platforma przez API. Ten plik to port (AD-7) i czysta logika: rekordy strefy, różnica
 * stanu, ocena delegacji widzianej u rodzica. Zero sieci, zero bazy.
 *
 * Izolacja tenantów: strefa należy do JEDNEGO tenanta. Dowody: wiersz w dns_hosted_zones
 * (złożony klucz z tenant_id), deterministyczny CallerReference wyliczony z tenanta i domeny
 * oraz tag `midrev_tenant` na strefie. Strefa bez naszego CallerReference albo z tagiem
 * innego tenanta nigdy nie jest przejmowana.
 */

import { createHash } from "node:crypto";
import type { RekordPlatformowy } from "./domena-platformowa";

export interface StrefaRoute53 {
  /** identyfikator bez prefiksu /hostedzone/, np. Z0123456789ABCDEFGHIJ */
  id: string;
  /** nazwa strefy bez kropki na końcu, małymi literami */
  nazwa: string;
  callerReference: string;
  /** serwery z DelegationSet (bez kropki); przy ListHostedZonesByName puste */
  serweryNs: string[];
}

export type TypRekorduR53 = "SOA" | "NS" | "CNAME" | "MX" | "TXT" | "A" | "AAAA";

export interface RekordRoute53 {
  /** pełna nazwa bez kropki, małymi literami */
  nazwa: string;
  typ: TypRekorduR53 | string;
  ttl: number;
  /** wartości w formacie Route 53 (TXT w cudzysłowach, MX „10 host.") */
  wartosci: string[];
}

export interface ZmianaRoute53 {
  akcja: "UPSERT" | "DELETE";
  rekord: RekordRoute53;
}

export type StanZmianyR53 = "PENDING" | "INSYNC";

export interface PortRoute53 {
  /** CreateHostedZone. Ten sam CallerReference drugi raz = BladAws AlreadyExists. */
  utworzStrefe(nazwa: string, o: { callerReference: string; komentarz: string }): Promise<StrefaRoute53>;
  /** ListHostedZonesByName zawężone do DOKŁADNIE tej nazwy (Route 53 dopuszcza kilka stref o tej samej nazwie) */
  strefyONazwie(nazwa: string): Promise<StrefaRoute53[]>;
  /** GetHostedZone; null = nie ma takiej strefy */
  odczytajStrefe(id: string): Promise<StrefaRoute53 | null>;
  tagiStrefy(id: string): Promise<Record<string, string>>;
  ustawTagiStrefy(id: string, tagi: Record<string, string>): Promise<void>;
  rekordy(id: string): Promise<RekordRoute53[]>;
  /** ChangeResourceRecordSets: jedna partia, atomowo (wszystko albo nic) */
  zmienRekordy(id: string, zmiany: ZmianaRoute53[], komentarz: string): Promise<{ changeId: string; stan: StanZmianyR53 }>;
  stanZmiany(changeId: string): Promise<StanZmianyR53>;
}

export const TTL_REKORDOW = 300;
export const TAG_TENANTA = "midrev_tenant";

/** /hostedzone/Z123 → Z123; cokolwiek innego niż [A-Z0-9] = null (identyfikator idzie do ścieżki URL). */
export function normalizujIdStrefy(surowy: string | null | undefined): string | null {
  const id = String(surowy ?? "").replace(/^\/?hostedzone\//, "");
  return /^Z[A-Z0-9]{1,32}$/.test(id) ? id : null;
}

export function normalizujIdZmiany(surowy: string | null | undefined): string | null {
  const id = String(surowy ?? "").replace(/^\/?change\//, "");
  return /^[A-Z0-9]{1,64}$/.test(id) ? id : null;
}

export function nazwaBezKropki(n: string): string {
  return n.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * CallerReference: deterministyczny z (tenant, domena), więc powtórzone podłączenie po
 * zgubionej odpowiedzi nie tworzy drugiej strefy, a inny tenant tej samej domeny nigdy nie
 * trafi w cudzą. Route 53 pamięta CallerReference na zawsze (także po usunięciu strefy).
 */
export function callerReferenceStrefy(tenantId: string, domena: string): string {
  return `midrev-${createHash("sha256").update(`${tenantId}:${nazwaBezKropki(domena)}`).digest("hex").slice(0, 48)}`;
}

/** Wartość TXT w formacie Route 53: w cudzysłowach, dzielona na kawałki ≤ 255 znaków. */
export function wartoscTxt(tekst: string): string {
  const czysty = tekst.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const kawalki: string[] = [];
  for (let i = 0; i < czysty.length; i += 255) kawalki.push(`"${czysty.slice(i, i + 255)}"`);
  return kawalki.join(" ") || '""';
}

/** Rekordy, które platforma utrzymuje w strefie news.<domena> (z tych samych danych co tabela ręczna). */
export function rekordyStrefyDelegowanej(rekordy: readonly RekordPlatformowy[]): RekordRoute53[] {
  const wynik = new Map<string, RekordRoute53>();
  for (const r of rekordy) {
    const nazwa = nazwaBezKropki(r.nazwaPelna);
    const wartosc =
      r.typ === "CNAME" ? `${r.oczekiwana}.` : r.typ === "MX" ? `${r.priorytet ?? 10} ${r.oczekiwana}.` : wartoscTxt(r.oczekiwana);
    const klucz = `${nazwa}|${r.typ}`;
    const byl = wynik.get(klucz);
    // MX i TXT pod bounce.<domena> to dwa różne typy; ten sam typ pod tą samą nazwą łączymy w jeden zestaw
    if (byl) byl.wartosci.push(wartosc);
    else wynik.set(klucz, { nazwa, typ: r.typ, ttl: TTL_REKORDOW, wartosci: [wartosc] });
  }
  return [...wynik.values()];
}

function porownywalne(r: RekordRoute53): string {
  return [...r.wartosci].map((w) => w.trim().toLowerCase()).sort().join("\n");
}

/**
 * Różnica stanu strefy: UPSERT brakujących i innych, DELETE naszych typów, których już nie
 * chcemy (np. stary podpis po zmianie tokenów). SOA i NS samej strefy są nietykalne.
 * Rekordy spoza strefy (nazwa nie kończy się na strefie) to błąd programisty: rzucamy.
 */
export function roznicaStrefy(strefa: string, obecne: readonly RekordRoute53[], chciane: readonly RekordRoute53[]): ZmianaRoute53[] {
  const s = nazwaBezKropki(strefa);
  const wStrefie = (n: string) => n === s || n.endsWith(`.${s}`);
  for (const r of chciane) {
    if (!wStrefie(r.nazwa)) throw new Error(`rekord ${r.nazwa} jest poza strefą ${s}`);
    if (r.nazwa === s && (r.typ === "NS" || r.typ === "SOA")) throw new Error("NS i SOA strefy są nietykalne");
  }
  const mapa = new Map(obecne.map((r) => [`${nazwaBezKropki(r.nazwa)}|${r.typ}`, r]));
  const zmiany: ZmianaRoute53[] = [];
  const chcianeKlucze = new Set<string>();
  for (const r of chciane) {
    const k = `${r.nazwa}|${r.typ}`;
    chcianeKlucze.add(k);
    const jest = mapa.get(k);
    if (!jest || porownywalne(jest) !== porownywalne(r) || jest.ttl !== r.ttl) zmiany.push({ akcja: "UPSERT", rekord: r });
  }
  for (const r of obecne) {
    const n = nazwaBezKropki(r.nazwa);
    if (n === s && (r.typ === "NS" || r.typ === "SOA")) continue;
    if (!["CNAME", "MX", "TXT"].includes(String(r.typ))) continue;
    if (!chcianeKlucze.has(`${n}|${r.typ}`)) zmiany.push({ akcja: "DELETE", rekord: { ...r, nazwa: n } });
  }
  return zmiany;
}

// ── Ocena delegacji widzianej u rodzica ─────────────────────────────────────────

export type StanDelegacji = "brak" | "czeka" | "czesciowa" | "bledna" | "konflikt" | "dziala";

export interface OcenaDelegacji {
  stan: StanDelegacji;
  /** jedno, dwa zdania dla klienta, bez żargonu (null przy „dziala") */
  komunikat: string | null;
  /** sprawa, która psuje zwykłą pocztę albo stronę klienta (czerwony alert) */
  pilne: string | null;
  /** serwery, które teraz widać u dostawcy klienta pod nazwą subdomeny */
  znalezione: string[];
  brakujace: string[];
}

/**
 * Złożenie obserwacji w stan. Wejście to fakty z DNS (adapter autorytatywny i resolver),
 * wyjście to stan i jedno zdanie dla klienta.
 *
 *   rodzic      — serwery NS pod nazwą subdomeny w strefie dostawcy klienta (null = nie
 *                 udało się zapytać serwerów dostawcy)
 *   podwojona   — NS pod news.sklep.pl.sklep.pl (panel sam dopisał domenę do pola Nazwa)
 *   apex        — NS samej domeny głównej (wpis dodany pod „@" zamiast pod news)
 *   konflikty   — typy rekordów, które serwery dostawcy podają z autorytetem POD nazwą
 *                 subdomeny (stary CNAME/MX/A obok NS: wtedy delegacja nie działa)
 *   publicznie  — NS subdomeny widziane przez zwykły resolver (to, co widzi internet)
 */
export function ocenDelegacje(o: {
  domena: string;
  strefa: string;
  nasze: readonly string[];
  nazwaWzgledna: string;
  rodzic: readonly string[] | null;
  podwojona: readonly string[];
  apex: readonly string[];
  konflikty: readonly string[];
  publicznie: readonly string[] | null;
}): OcenaDelegacji {
  const nasze = o.nasze.map(nazwaBezKropki);
  const naszeSet = new Set(nasze);
  const norm = (l: readonly string[]) => [...new Set(l.map(nazwaBezKropki))];
  const rodzic = o.rodzic ? norm(o.rodzic) : null;
  const apexNasze = norm(o.apex).filter((n) => naszeSet.has(n));
  const pilne = apexNasze.length
    ? `Serwery z naszego wpisu są dodane do całej domeny ${o.strefa}, a nie tylko do ${o.domena}. To może wyłączyć stronę i zwykłą pocztę. Usuń je z domeny głównej i dodaj pod nazwą ${o.nazwaWzgledna}.`
    : null;
  const brakujaceZ = (z: string[]) => nasze.filter((n) => !z.includes(n));
  const bazowa = { pilne, znalezione: rodzic ?? [], brakujace: brakujaceZ(rodzic ?? []) };

  if (o.konflikty.length) {
    return {
      ...bazowa,
      stan: "konflikt",
      komunikat: `Pod nazwą ${o.nazwaWzgledna} jest jeszcze stary wpis (${[...new Set(o.konflikty)].join(", ")}). Usuń go: przez niego wpis NS nie działa. Rekordy pod innymi nazwami zostaw.`,
    };
  }
  if (rodzic === null) {
    // serwery dostawcy nie odpowiedziały: zostaje to, co widzi internet
    const pub = o.publicznie ? norm(o.publicznie) : [];
    if (pub.length && pub.every((n) => naszeSet.has(n))) return { ...bazowa, stan: "dziala", komunikat: null, znalezione: pub, brakujace: [] };
    return { ...bazowa, stan: "czeka", komunikat: "Nie udało się teraz zapytać serwerów Twojego dostawcy domeny. Sprawdzimy ponownie za kilka minut." };
  }
  if (!rodzic.length) {
    if (norm(o.podwojona).some((n) => naszeSet.has(n))) {
      return {
        ...bazowa,
        stan: "bledna",
        komunikat: `Panel dopisał nazwę domeny drugi raz (wyszło ${o.domena}.${o.strefa}). Edytuj wpis i w polu Nazwa zostaw tylko: ${o.nazwaWzgledna}.`,
      };
    }
    return { ...bazowa, stan: "brak", komunikat: null };
  }
  const doklejone = rodzic.filter((n) => nasze.some((x) => n === `${x}.${o.strefa}`));
  if (doklejone.length) {
    return {
      ...bazowa,
      stan: "bledna",
      komunikat: `Panel dopisał .${o.strefa} na końcu serwera (${doklejone[0]}). Edytuj wpis (nie dodawaj drugiego) i wklej wartość razem z kropką na końcu.`,
    };
  }
  const obce = rodzic.filter((n) => !naszeSet.has(n));
  if (obce.length) {
    return {
      ...bazowa,
      stan: "bledna",
      komunikat: `Wpis ${o.nazwaWzgledna} wskazuje na inne serwery (${obce.slice(0, 2).join(", ")}${obce.length > 2 ? "…" : ""}). Zamień je na cztery serwery z tabeli.`,
    };
  }
  const brakujace = brakujaceZ(rodzic);
  if (brakujace.length) {
    return {
      ...bazowa,
      stan: "czesciowa",
      komunikat: `Widzimy ${rodzic.length} z ${nasze.length} serwerów. Dodaj brakujące: ${brakujace.join(", ")}.`,
      brakujace,
    };
  }
  const pub = o.publicznie ? norm(o.publicznie) : [];
  if (pub.length && pub.every((n) => naszeSet.has(n))) return { ...bazowa, stan: "dziala", komunikat: null, brakujace: [] };
  return {
    ...bazowa,
    stan: "czeka",
    komunikat: "Wpis jest poprawny. Internet potrzebuje zwykle kilku minut (czasem do kilku godzin), żeby go zauważyć. Nic więcej nie trzeba robić.",
    brakujace: [],
  };
}
