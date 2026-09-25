import { lookup as lookupSystemowy } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Obrona przed SSRF przy serwerze SMTP podanym przez użytkownika panelu.
 *
 * Host SMTP to DANE UŻYTKOWNIKA, a serwer aplikacji się z nim łączy. Bez tej bramki
 * ktoś wpisze 127.0.0.1:5433 (nasz Postgres), adres z sieci wewnętrznej albo metadane
 * chmury (169.254.169.254) i użyje panelu jako skanera portów: różne komunikaty błędu
 * („odmowa połączenia" kontra „timeout") wystarczą, żeby zmapować sieć.
 *
 * Trzy zasady:
 *  1. Sprawdzamy ADRES PO ROZWIĄZANIU NAZWY, nie samą nazwę. Nazwa `wewn.example`
 *     rozwiązująca się na 10.0.0.5 jest tym samym atakiem co wpisanie 10.0.0.5.
 *  2. Wszystkie adresy z odpowiedzi muszą być publiczne. Jeden prywatny = odmowa, bo
 *     klient TCP może wybrać dowolny z nich.
 *  3. Łączymy się z ADRESEM, który sprawdziliśmy, a nie ponownie z nazwą. Drugie
 *     rozwiązanie nazwy przez bibliotekę SMTP otwierałoby okno na DNS rebinding
 *     (pierwsza odpowiedź publiczna, druga 127.0.0.1). Nazwa idzie dalej tylko jako
 *     SNI i do weryfikacji certyfikatu.
 *
 * Wyjątek jest JAWNY: para host:port z `SMTP_HOSTY_DEWELOPERSKIE` (lokalny Mailpit).
 */

/** Porty, na których serwer SMTP realnie przyjmuje pocztę do wysłania. */
export const DOZWOLONE_PORTY = [25, 465, 587, 2525] as const;
/** Porty IMAP skrzynki zwrotnej (odbicia): 993 = TLS, 143 = STARTTLS. Ta sama bramka SSRF. */
export const DOZWOLONE_PORTY_IMAP = [993, 143] as const;

/** Rozwiązanie nazwy nie może zawiesić akcji panelu ani partii wysyłki. */
const LIMIT_CZASU_DNS_MS = 5_000;

const ZABLOKOWANE = new BlockList();
// IPv4: "this network", prywatne, CGNAT, loopback, link-local (w tym metadane chmury),
// zakresy protokołowe i dokumentacyjne, benchmark, multicast, zarezerwowane, broadcast
for (const [siec, prefiks] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  ZABLOKOWANE.addSubnet(siec, prefiks, "ipv4");
}
// IPv6: nieokreślony, loopback, discard, dokumentacja, ULA, link-local, site-local, multicast.
// Adresy z osadzonym IPv4 (::ffff:a.b.c.d, 64:ff9b::a.b.c.d) rozpakowujemy osobno niżej.
for (const [siec, prefiks] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001::", 32], // Teredo: tunel z osadzonym (zaciemnionym) IPv4
  ["2001:db8::", 32],
  ["64:ff9b:1::", 48], // lokalny NAT64
  // UWAGA: bez "::ffff:0:0/96" — BlockList w Node dopasowuje taki wpis także do CZYSTYCH
  // adresów IPv4 i zablokowałby cały internet. Mapped IPv4 rozpakowuje osadzonyIpv4().
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  ZABLOKOWANE.addSubnet(siec, prefiks, "ipv6");
}

/** Adres IPv6 jako 16 bajtów (rozwija `::` i końcówkę w zapisie kropkowym). */
function bajtyIpv6(adres: string): number[] | null {
  let a = adres.toLowerCase().split("%")[0];
  const kropkowy = a.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (kropkowy) {
    const o = kropkowy[2].split(".").map(Number);
    if (o.some((x) => x > 255)) return null;
    a = `${kropkowy[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [lewa, prawa, nadmiar] = a.split("::");
  if (nadmiar !== undefined) return null;
  const l = lewa ? lewa.split(":") : [];
  const r = prawa !== undefined && prawa ? prawa.split(":") : [];
  const brakuje = 8 - l.length - r.length;
  if (prawa === undefined ? l.length !== 8 : brakuje < 1) return null;
  const grupy = [...l, ...(prawa === undefined ? [] : Array(brakuje).fill("0")), ...r];
  const bajty: number[] = [];
  for (const g of grupy) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bajty.push(v >> 8, v & 255);
  }
  return bajty.length === 16 ? bajty : null;
}

/**
 * IPv4 osadzony w IPv6 — w KAŻDYM zapisie (skróconym, rozwiniętym, kropkowym), bo
 * rozpoznawanie po tekście przepuszczało `0:0:0:0:0:ffff:7f00:1` jako „publiczne IPv6".
 * Obsługiwane: IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), NAT64 (64:ff9b::/96),
 * 6to4 (2002::/16). `null` = brak osadzonego IPv4.
 */
function osadzonyIpv4(adres: string): string | null {
  const b = bajtyIpv6(adres);
  if (!b) return null;
  const zera = (od: number, do_: number) => b.slice(od, do_).every((x) => x === 0);
  const v4 = (i: number) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
  if (zera(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4(12);
  if (zera(0, 12)) return v4(12);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zera(4, 12)) return v4(12);
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2);
  return null;
}

/** Czy adres IP jest publiczny (wolno się z nim łączyć z panelu). */
export function czyAdresPubliczny(adres: string): boolean {
  const rodzina = isIP(adres);
  if (rodzina === 4) return !ZABLOKOWANE.check(adres, "ipv4");
  if (rodzina === 6) {
    if (!bajtyIpv6(adres)) return false; // nie umiemy rozebrać = nie wpuszczamy
    const v4 = osadzonyIpv4(adres);
    if (v4) return czyAdresPubliczny(v4);
    return !ZABLOKOWANE.check(adres, "ipv6");
  }
  return false;
}

export class BladHostaSmtp extends Error {
  constructor(
    readonly kod: "host" | "port" | "adres_prywatny" | "dns",
    komunikat: string,
  ) {
    super(komunikat);
    this.name = "BladHostaSmtp";
  }
}

export type FunkcjaLookup = (host: string) => Promise<{ address: string; family: number }[]>;

const lookupDomyslny: FunkcjaLookup = (host) => lookupSystemowy(host, { all: true, verbatim: true });

/** Host wpisany przez człowieka: bez spacji, bez schematu, bez portu, małymi literami. */
export function normalizujHost(surowy: string): string {
  const host = surowy.trim().toLowerCase().replace(/\.$/, "");
  const bezNawiasow = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bezNawiasow)) return bezNawiasow;
  if (
    !host ||
    host.length > 253 ||
    !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host)
  ) {
    throw new BladHostaSmtp("host", "Adres serwera ma wyglądać jak smtp.twojadomena.pl — bez http://, bez portu i bez spacji.");
  }
  return host;
}

function kluczDeweloperski(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

export function czyHostDeweloperski(host: string, port: number, hostyDeweloperskie: readonly string[]): boolean {
  return hostyDeweloperskie.includes(kluczDeweloperski(host, port).toLowerCase());
}

export interface CelPolaczenia {
  /** nazwa podana przez użytkownika (SNI, certyfikat, komunikaty) */
  host: string;
  /** SPRAWDZONY adres IP, z którym faktycznie się łączymy */
  adres: string;
  /** wszystkie adresy z odpowiedzi DNS (wszystkie sprawdzone) — do oceny SPF */
  adresy: string[];
  port: number;
  /** serwer z jawnej listy deweloperskiej: omija blokadę adresów i FR45 */
  deweloperski: boolean;
}

async function zLimitemCzasu<T>(obietnica: Promise<T>, ms: number, komunikat: string): Promise<T> {
  let zegar: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      obietnica,
      new Promise<never>((_, odrzuc) => {
        zegar = setTimeout(() => odrzuc(new BladHostaSmtp("dns", komunikat)), ms);
      }),
    ]);
  } finally {
    clearTimeout(zegar);
  }
}

/**
 * Rozwiązuje i sprawdza serwer SMTP. Zwraca adres IP, z którym WOLNO się połączyć,
 * albo rzuca `BladHostaSmtp` z komunikatem dla człowieka. Komunikaty celowo nie mówią,
 * CO stoi pod zablokowanym adresem — tylko że adres jest niedozwolony.
 */
export async function rozwiazHostSmtp(
  surowyHost: string,
  port: number,
  opcje: {
    hostyDeweloperskie: readonly string[];
    lookup?: FunkcjaLookup;
    /** lista portów innej usługi (IMAP skrzynki zwrotnej); domyślnie porty SMTP */
    dozwolonePorty?: readonly number[];
    /** nazwa usługi do komunikatu o porcie */
    usluga?: "smtp" | "imap";
  },
): Promise<CelPolaczenia> {
  const host = normalizujHost(surowyHost);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BladHostaSmtp("port", "Port musi być liczbą.");
  }
  const lookup = opcje.lookup ?? lookupDomyslny;
  const deweloperski = czyHostDeweloperski(host, port, opcje.hostyDeweloperskie);
  const dozwolone = opcje.dozwolonePorty ?? DOZWOLONE_PORTY;

  if (!deweloperski && !dozwolone.includes(port)) {
    throw new BladHostaSmtp(
      "port",
      opcje.usluga === "imap"
        ? `Port ${port} nie jest portem IMAP. Dozwolone: ${dozwolone.join(", ")} (993 z TLS albo 143 ze STARTTLS).`
        : `Port ${port} nie jest portem wysyłki poczty. Dozwolone: ${dozwolone.join(", ")} (najczęściej 587 ze STARTTLS albo 465 z TLS).`,
    );
  }

  let adresy: string[];
  if (isIP(host)) {
    adresy = [host];
  } else {
    try {
      const wynik = await zLimitemCzasu(
        lookup(host),
        LIMIT_CZASU_DNS_MS,
        `Nie udało się rozwiązać nazwy ${host} w ${LIMIT_CZASU_DNS_MS / 1000} s.`,
      );
      adresy = wynik.map((w) => w.address);
    } catch (blad) {
      if (blad instanceof BladHostaSmtp) throw blad;
      throw new BladHostaSmtp("dns", `Nazwa ${host} nie istnieje w DNS albo DNS nie odpowiada. Sprawdź literówkę w adresie serwera.`);
    }
  }
  if (adresy.length === 0) {
    throw new BladHostaSmtp("dns", `Nazwa ${host} nie ma żadnego adresu IP.`);
  }

  if (!deweloperski && adresy.some((a) => !czyAdresPubliczny(a))) {
    throw new BladHostaSmtp(
      "adres_prywatny",
      isIP(host)
        ? `Adres ${host} jest adresem prywatnym, lokalnym albo zarezerwowanym. Podaj publiczny serwer SMTP.`
        : `Nazwa ${host} wskazuje na adres prywatny, lokalny albo zarezerwowany. Podaj publiczny serwer SMTP.`,
    );
  }

  return { host, adres: adresy[0], adresy, port, deweloperski };
}
