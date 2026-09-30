import { createPublicKey } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { czyBrakRekordu, type ResolverDns } from "../../adapters/email/dns";

/**
 * Weryfikacja domeny nadawcy: SPF, DKIM, DMARC (plus MX informacyjnie).
 *
 * Zasada nadrzędna: BEZ ZGADYWANIA. Każdy rekord ma jeden z czterech stanów:
 *   ok             — rekord jest i robi to, co trzeba,
 *   brak           — DNS odpowiedział, że rekordu nie ma,
 *   bledny         — rekord jest, ale nie działa albo nie obejmuje naszego serwera,
 *   niesprawdzony  — nie da się tego rozstrzygnąć (DNS nie odpowiedział, brak selektora,
 *                    rekord używa makr SPF). Zawsze z powodem, nigdy po cichu jako „ok".
 *
 * Każdy stan inny niż ok niesie `poprawka`: co DOKŁADNIE wpisać albo zmienić.
 *
 * Przy własnym serwerze SMTP klienta to JEGO serwer podpisuje DKIM — my nie generujemy
 * kluczy, tylko sprawdzamy, że klucz publiczny pod podanym selektorem jest w DNS i jest
 * poprawny. Wzorzec ekranu: Klaviyo Settings → Domains (PANELE-ESP-NAWIGACJA, 1.9).
 */

export type StatusRekordu = "ok" | "brak" | "bledny" | "niesprawdzony";
export type StatusDomeny = "verified" | "partial" | "failed";
export type PolitykaDmarc = "none" | "quarantine" | "reject";

export interface WynikRekordu {
  status: StatusRekordu;
  /** surowa wartość znaleziona w DNS (albo opis, np. „CNAME → ...") */
  znaleziono: string | null;
  /** co jest nie tak — jedno zdanie */
  problem: string | null;
  /** co dokładnie zrobić */
  poprawka: string | null;
  /** zastrzeżenia, które nie psują statusu (p=none, klucz 1024, ?all) */
  uwagi: string[];
  /** true = „niesprawdzony" przez awarię DNS, a nie przez brak danych po naszej stronie */
  przejsciowy: boolean;
}

/**
 * Czy DMARC przejdzie przy tej konfiguracji (0029). DMARC wymaga, żeby SPF albo DKIM
 * przeszedł Z WYRÓWNANIEM do domeny From: SPF liczony jest na domenie koperty (Return-Path),
 * DKIM na domenie `d=` podpisu. Przy ścisłym trybie (`aspf=s`, `adkim=s`, midrev.pl ma oba)
 * „prawie ta sama domena" nie wystarcza — stąd ten wynik jest osobno i ma jasny komunikat.
 */
export interface WyrownanieDmarc {
  aspf: "s" | "r";
  adkim: "s" | "r";
  /** domena, na której odbiorca sprawdza SPF (koperta), i domena From */
  domenaSpf: string;
  domenaFrom: string;
  spf: "wyrownany" | "niewyrownany" | "nie_przechodzi";
  dkim: "wyrownany" | "nie_przechodzi";
  dmarcPrzejdzie: boolean;
  /** zdanie dla człowieka, gdy coś jest nie tak (null = obie nogi stoją) */
  komunikat: string | null;
}

export interface WynikWeryfikacji {
  spf: WynikRekordu;
  dkim: WynikRekordu;
  dmarc: WynikRekordu & { polityka: PolitykaDmarc | null };
  /** brak w raportach sprzed 0029 */
  wyrownanie?: WyrownanieDmarc | null;
  /** tryb, w którym oceniono SPF (brak w raportach sprzed 0029 = wlasny_serwer) */
  rodzajSerwera?: RodzajSerwera;
  mx: { rekordy: string[]; uwaga: string | null; przejsciowy: boolean };
  status: StatusDomeny;
  /** czy którykolwiek wynik jest niepewny przez awarię DNS — wtedy nie wolno obniżać statusu */
  awariaDns: boolean;
}

export type RodzajSerwera = "wlasny_serwer" | "przekaznik";

export interface KontekstSerwera {
  /**
   * `wlasny_serwer` (domyślnie): SPF oceniany dla adresów IP hosta SMTP.
   * `przekaznik` (SES, Brevo, Mailgun): host SMTP nie oddaje poczty odbiorcom, więc jego
   * IP nic nie mówi; SPF oceniany na domenie koperty (musi zawierać mechanizm dostawcy,
   * ≤10 zapytań DNS, MX dla odbić), bez porównywania IP.
   */
  rodzaj?: RodzajSerwera;
  /** domena koperty (Return-Path / custom MAIL FROM); null = koperta w domenie From */
  domenaKoperty?: string | null;
  /** selektor DKIM podany przez klienta */
  selektorDkim: string | null;
  /** mechanizm SPF dostawcy, np. "include:_spf.google.com" */
  mechanizmSpf: string | null;
  /** adresy IP serwera SMTP tenanta (po bramce SSRF); null = serwer nieznany */
  ipSerwera: string[] | null;
  /** host serwera SMTP (do komunikatów) */
  hostSerwera: string | null;
}

function wynik(status: StatusRekordu, pola: Partial<WynikRekordu> = {}): WynikRekordu {
  return { status, znaleziono: null, problem: null, poprawka: null, uwagi: [], przejsciowy: false, ...pola };
}

function opisAwarii(blad: unknown): string {
  const kod = String((blad as { code?: unknown })?.code ?? "");
  if (kod === "ETIMEOUT") return "serwer DNS nie odpowiedział w czasie";
  if (kod === "ESERVFAIL") return "serwer DNS domeny zwrócił błąd (SERVFAIL)";
  if (kod === "EREFUSED") return "serwer DNS odmówił odpowiedzi";
  return `zapytanie DNS nie powiodło się${kod ? ` (${kod})` : ""}`;
}

/** Normalizacja domeny wpisanej przez człowieka: bez schematu, bez www, bez kropki na końcu. */
export function normalizujDomene(surowa: string): string | null {
  let d = surowa.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (d.includes("@")) d = d.split("@").pop() ?? "";
  let ascii = "";
  try {
    // URL zamienia domenę z polskimi znakami na punycode (IDN), tak jak zrobi to DNS
    ascii = d ? new URL(`http://${d}`).hostname : "";
  } catch {
    return null;
  }
  if (
    !ascii ||
    ascii.length > 253 ||
    isIP(ascii) ||
    !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(ascii)
  ) {
    return null;
  }
  return ascii;
}

// ─────────────────────────────── SPF ────────────────────────────────────────

/** RFC 7208 4.6.4: najwyżej 10 zapytań DNS na całą ewaluację. */
const LIMIT_ZAPYTAN_SPF = 10;

type WynikSpf = "pass" | "fail" | "softfail" | "neutral" | "none" | "permerror" | "temperror" | "makra";

interface StanSpf {
  zapytania: number;
  resolver: ResolverDns;
}

class PrzerwanieSpf extends Error {
  constructor(readonly wynik: WynikSpf) {
    super(wynik);
  }
}

async function rekordySpf(domena: string, resolver: ResolverDns): Promise<string[]> {
  try {
    const txt = await resolver.txt(domena);
    return txt.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  } catch (blad) {
    if (czyBrakRekordu(blad)) return [];
    throw blad;
  }
}

function pasujeCidr(ip: string, siec: string, prefiks: number | null): boolean {
  const rodzinaIp = isIP(ip);
  const rodzinaSieci = isIP(siec);
  if (!rodzinaIp || rodzinaIp !== rodzinaSieci) return false;
  const lista = new BlockList();
  const typ = rodzinaIp === 4 ? "ipv4" : "ipv6";
  const p = prefiks ?? (rodzinaIp === 4 ? 32 : 128);
  try {
    lista.addSubnet(siec, p, typ);
  } catch {
    throw new PrzerwanieSpf("permerror");
  }
  return lista.check(ip, typ);
}

function dolicz(stan: StanSpf) {
  stan.zapytania++;
  if (stan.zapytania > LIMIT_ZAPYTAN_SPF) throw new PrzerwanieSpf("permerror");
}

async function adresyHosta(host: string, rodzina: number, stan: StanSpf): Promise<string[]> {
  try {
    return rodzina === 6 ? await stan.resolver.aaaa(host) : await stan.resolver.a(host);
  } catch (blad) {
    if (czyBrakRekordu(blad)) return [];
    throw new PrzerwanieSpf("temperror");
  }
}

function rozbierzCel(argument: string | undefined, domena: string) {
  // a[:domena][/cidr4][//cidr6], mx tak samo
  const m = (argument ?? "").match(/^(?::([^/]+))?(?:\/(\d{1,2}))?(?:\/\/(\d{1,3}))?$/);
  if (!m) throw new PrzerwanieSpf("permerror");
  return { cel: m[1] ?? domena, p4: m[2] ? Number(m[2]) : null, p6: m[3] ? Number(m[3]) : null };
}

/**
 * Ewaluacja check_host() z RFC 7208, w zakresie potrzebnym do pytania „czy ten IP może
 * wysyłać w imieniu tej domeny". Makra (%{...}) i `exists` z makrami nie są obsługiwane:
 * zamiast zgadywać, zwracamy „makra" i mówimy człowiekowi, że tego nie oceniliśmy.
 */
async function ewaluujSpf(ip: string, domena: string, stan: StanSpf): Promise<WynikSpf> {
  let rekordy: string[];
  try {
    rekordy = await rekordySpf(domena, stan.resolver);
  } catch {
    return "temperror";
  }
  if (rekordy.length === 0) return "none";
  if (rekordy.length > 1) return "permerror";
  const terminy = rekordy[0].trim().split(/\s+/).slice(1);
  if (terminy.some((t) => t.includes("%"))) return "makra";

  let przekierowanie: string | null = null;
  for (const termin of terminy) {
    const mod = termin.match(/^([a-z][a-z0-9_.-]*)=(.*)$/i);
    if (mod) {
      if (mod[1].toLowerCase() === "redirect") przekierowanie = mod[2];
      continue; // exp= i nieznane modyfikatory nie wpływają na wynik
    }
    const maKwalifikator = /^[+\-~?]/.test(termin);
    const kwalifikator = maKwalifikator ? termin[0] : "+";
    const tresc = maKwalifikator ? termin.slice(1) : termin;
    const [, nazwaRaw = "", argument = ""] = tresc.match(/^([a-z0-9]+)(.*)$/i) ?? [];
    const nazwa = (nazwaRaw ?? "").toLowerCase();
    let pasuje = false;

    switch (nazwa) {
      case "all":
        pasuje = true;
        break;
      case "ip4":
      case "ip6": {
        const m = argument.match(/^:([^/]+)(?:\/(\d{1,3}))?$/);
        if (!m) return "permerror";
        pasuje = pasujeCidr(ip, m[1], m[2] ? Number(m[2]) : null);
        break;
      }
      case "a": {
        dolicz(stan);
        const { cel, p4, p6 } = rozbierzCel(argument, domena);
        const rodzina = isIP(ip);
        for (const adres of await adresyHosta(cel, rodzina, stan)) {
          if (pasujeCidr(ip, adres, rodzina === 4 ? p4 : p6)) pasuje = true;
        }
        break;
      }
      case "mx": {
        dolicz(stan);
        const { cel, p4, p6 } = rozbierzCel(argument, domena);
        let mx: { exchange: string }[] = [];
        try {
          mx = await stan.resolver.mx(cel);
        } catch (blad) {
          if (!czyBrakRekordu(blad)) throw new PrzerwanieSpf("temperror");
        }
        const rodzina = isIP(ip);
        for (const rekord of mx.slice(0, 10)) {
          for (const adres of await adresyHosta(rekord.exchange, rodzina, stan)) {
            if (pasujeCidr(ip, adres, rodzina === 4 ? p4 : p6)) pasuje = true;
          }
        }
        break;
      }
      case "include": {
        dolicz(stan);
        const cel = argument.startsWith(":") ? argument.slice(1) : "";
        if (!cel) return "permerror";
        const w = await ewaluujSpf(ip, cel, stan);
        if (w === "pass") pasuje = true;
        else if (w === "temperror" || w === "makra") return w;
        else if (w === "permerror" || w === "none") return "permerror";
        break;
      }
      case "exists":
      case "ptr":
        // ptr jest odradzany (RFC 7208 5.5), exists bez makr jest rzadkie — nie zgadujemy
        dolicz(stan);
        return "makra";
      default:
        return "permerror";
    }

    if (pasuje) {
      return ({ "+": "pass", "-": "fail", "~": "softfail", "?": "neutral" } as const)[kwalifikator as "+"];
    }
  }

  if (przekierowanie) {
    dolicz(stan);
    const w = await ewaluujSpf(ip, przekierowanie, stan);
    return w === "none" ? "permerror" : w;
  }
  return "neutral";
}

async function bezpiecznieEwaluuj(ip: string, domena: string, resolver: ResolverDns): Promise<WynikSpf> {
  try {
    return await ewaluujSpf(ip, domena, { zapytania: 0, resolver });
  } catch (blad) {
    if (blad instanceof PrzerwanieSpf) return blad.wynik;
    return "temperror";
  }
}

/** Czy mechanizm dostawcy (include:x / ip4:y) występuje w rekordzie albo w jego include-ach. */
async function zawieraMechanizm(
  domena: string,
  mechanizm: string,
  resolver: ResolverDns,
  odwiedzone = new Set<string>(),
): Promise<boolean> {
  if (odwiedzone.has(domena) || odwiedzone.size >= LIMIT_ZAPYTAN_SPF) return false;
  odwiedzone.add(domena);
  const rekordy = await rekordySpf(domena, resolver).catch(() => []);
  if (rekordy.length !== 1) return false;
  const szukany = mechanizm.toLowerCase();
  const terminy = rekordy[0].toLowerCase().trim().split(/\s+/).slice(1);
  for (const t of terminy) {
    const bez = t.replace(/^[+?~-]/, "");
    if (bez === szukany && !t.startsWith("-") && !t.startsWith("~") && !t.startsWith("?")) return true;
    // `redirect=X` przekazuje całą ocenę do X — to jest równoważne `include:X` (gmail.com
    // ma dokładnie `v=spf1 redirect=_spf.google.com`)
    if (szukany.startsWith("include:") && bez === `redirect=${szukany.slice("include:".length)}`) return true;
    const inc = bez.match(/^include:(.+)$/) ?? bez.match(/^redirect=(.+)$/);
    if (inc && !/^[-~?]/.test(t) && (await zawieraMechanizm(inc[1], mechanizm, resolver, odwiedzone))) return true;
  }
  return false;
}

export function propozycjaSpf(kontekst: KontekstSerwera): string {
  const ip = kontekst.ipSerwera?.[0];
  const mechanizm =
    kontekst.mechanizmSpf ?? (ip ? `${isIP(ip) === 6 ? "ip6" : "ip4"}:${ip}` : "include:<SPF twojego dostawcy>");
  return `v=spf1 ${mechanizm} ~all`;
}

/** Adres z bloku dokumentacyjnego (RFC 5737): nie występuje w żadnym prawdziwym SPF. */
const IP_KONTROLNE = "192.0.2.1";

/**
 * SPF w trybie przekaźnika: rekord na domenie KOPERTY. Przekaźnik oddaje pocztę ze swoich
 * serwerów, a nie z hosta, z którym rozmawia panel, więc porównanie IP hosta SMTP
 * zablokowałoby każdą poprawną konfigurację SES (dotychczasowy błąd: FR45 blokowało SES).
 */
async function sprawdzSpfPrzekaznika(k: KontekstSerwera, resolver: ResolverDns): Promise<WynikRekordu> {
  const koperta = k.domenaKoperty;
  if (!koperta) {
    return wynik("niesprawdzony", {
      problem: "Przy przekaźniku (np. Amazon SES) SPF sprawdzamy na domenie koperty (Return-Path), a nie jest ona podana.",
      poprawka: "W ustawieniach serwera podaj domenę koperty, np. bounce.twojadomena.pl (u SES: „Custom MAIL FROM domain”).",
    });
  }
  if (!k.mechanizmSpf) {
    return wynik("niesprawdzony", {
      problem: "Nie wiemy, jaki mechanizm SPF ma mieć przekaźnik.",
      poprawka: "Podaj SPF dostawcy przy domenie, np. include:amazonses.com dla Amazon SES.",
    });
  }
  const propozycja = `v=spf1 ${k.mechanizmSpf} ~all`;
  let rekordy: string[];
  try {
    rekordy = await rekordySpf(koperta, resolver);
  } catch (blad) {
    return wynik("niesprawdzony", { problem: `Nie udało się odczytać SPF domeny koperty ${koperta}: ${opisAwarii(blad)}.`, poprawka: "Spróbuj ponownie za kilka minut.", przejsciowy: true });
  }
  if (rekordy.length === 0) {
    return wynik("brak", {
      problem: `Domena koperty ${koperta} nie ma rekordu SPF — odbiorcy sprawdzają SPF właśnie na niej.`,
      poprawka: `Dodaj rekord TXT na ${koperta}: ${propozycja}`,
    });
  }
  if (rekordy.length > 1) {
    return wynik("bledny", {
      znaleziono: rekordy.join("  |  "),
      problem: `Domena koperty ${koperta} ma ${rekordy.length} rekordy SPF (permerror).`,
      poprawka: `Zostaw jeden: ${propozycja}`,
    });
  }
  const rekord = rekordy[0].trim();
  const uwagi: string[] = [
    `SPF oceniany na domenie koperty ${koperta} (tryb przekaźnika). Adresu hosta SMTP nie porównujemy: pocztę do odbiorców oddają serwery dostawcy.`,
  ];
  const all = rekord.match(/\s([+\-~?]?)all(\s|$)/i);
  if (all && (all[1] === "+" || all[1] === "")) {
    return wynik("bledny", { znaleziono: rekord, problem: "Rekord kończy się na +all: każdy serwer może wysyłać w imieniu tej domeny.", poprawka: `Zamień rekord na: ${propozycja}` });
  }
  if (!(await zawieraMechanizm(koperta, k.mechanizmSpf, resolver))) {
    return wynik("bledny", {
      znaleziono: rekord,
      problem: `Rekord na ${koperta} nie zawiera ${k.mechanizmSpf}, więc serwery przekaźnika nie są dopuszczone.`,
      poprawka: `Ustaw rekord TXT na ${koperta}: ${propozycja}`,
    });
  }
  // Limit 10 zapytań DNS (RFC 7208): pełna ewaluacja dla adresu, który nie pasuje do
  // niczego, przechodzi przez wszystkie include — permerror = rekord za ciężki albo zepsuty.
  const kontrola = await bezpiecznieEwaluuj(IP_KONTROLNE, koperta, resolver);
  if (kontrola === "permerror") {
    return wynik("bledny", {
      znaleziono: rekord,
      problem: "Rekord SPF domeny koperty jest niepoprawny albo wymaga ponad 10 zapytań DNS (limit RFC 7208).",
      poprawka: `Uprość rekord do: ${propozycja}`,
    });
  }
  if (kontrola === "temperror") {
    return wynik("niesprawdzony", { znaleziono: rekord, problem: "Nie udało się rozwinąć wszystkich include w SPF domeny koperty (DNS nie odpowiedział).", poprawka: "Spróbuj ponownie za kilka minut.", przejsciowy: true });
  }
  // MX koperty: SES wymaga DOKŁADNIE jednego (feedback-smtp.<region>.amazonses.com). Bez
  // niego SES po cichu wraca do domyślnego MAIL FROM (amazonses.com) i SPF przestaje
  // być wyrównany — „ok" byłoby wtedy kłamstwem.
  let mx: { exchange: string }[] = [];
  try {
    mx = await resolver.mx(koperta);
  } catch (blad) {
    if (!czyBrakRekordu(blad)) {
      return wynik("niesprawdzony", { znaleziono: rekord, problem: `Nie udało się odczytać MX domeny koperty: ${opisAwarii(blad)}.`, poprawka: "Spróbuj ponownie za kilka minut.", przejsciowy: true });
    }
  }
  if (mx.length === 0) {
    return wynik("bledny", {
      znaleziono: rekord,
      problem: `Domena koperty ${koperta} nie ma rekordu MX. Przekaźnik nie przyjmie na nią odbić i (SES) wróci do własnej domeny koperty, a SPF przestanie być wyrównany z From.`,
      poprawka: `Dodaj rekord MX na ${koperta} wskazany przez dostawcę (SES: 10 feedback-smtp.<region>.amazonses.com).`,
    });
  }
  // Amazon SES (include:amazonses.com): custom MAIL FROM działa WYŁĄCZNIE z dokładnie
  // jednym MX na feedback-smtp.<region>.amazonses.com. Inny albo kilka MX = SES po cichu
  // wraca do własnej koperty (amazonses.com), SPF przestaje być wyrównany — więc „błędny",
  // nie uwaga. Inni dostawcy: kilka MX bywa poprawne, zostaje uwaga.
  const ses = k.mechanizmSpf.toLowerCase() === "include:amazonses.com";
  if (ses) {
    const cele = mx.map((m) => m.exchange.toLowerCase().replace(/\.$/, ""));
    if (mx.length !== 1 || !/^feedback-smtp\.[a-z0-9-]+\.amazonses\.com$/.test(cele[0])) {
      return wynik("bledny", {
        znaleziono: `${rekord}  |  MX: ${cele.join(", ")}`,
        problem: `Amazon SES wymaga na ${koperta} DOKŁADNIE jednego rekordu MX wskazującego feedback-smtp.<region>.amazonses.com (jest: ${cele.join(", ")}). Inaczej SES nie użyje tej domeny jako koperty i SPF nie będzie wyrównany.`,
        poprawka: `Zostaw jeden rekord MX na ${koperta}: 10 feedback-smtp.<region>.amazonses.com (region tożsamości SES, np. eu-central-1).`,
      });
    }
  } else if (mx.length > 1) {
    uwagi.push(`Domena koperty ma ${mx.length} rekordy MX — sprawdź u dostawcy, czy to zamierzone.`);
  }
  return wynik("ok", { znaleziono: rekord, uwagi });
}

async function sprawdzSpf(domena: string, k: KontekstSerwera, resolver: ResolverDns): Promise<WynikRekordu> {
  let rekordy: string[];
  try {
    rekordy = await rekordySpf(domena, resolver);
  } catch (blad) {
    return wynik("niesprawdzony", { problem: `Nie udało się odczytać SPF: ${opisAwarii(blad)}.`, poprawka: "Spróbuj ponownie za kilka minut.", przejsciowy: true });
  }
  const propozycja = propozycjaSpf(k);
  if (rekordy.length === 0) {
    return wynik("brak", {
      problem: "Domena nie ma rekordu SPF, więc serwery odbiorców nie wiedzą, kto może wysyłać w jej imieniu.",
      poprawka: `Dodaj rekord TXT na ${domena}: ${propozycja}`,
    });
  }
  if (rekordy.length > 1) {
    return wynik("bledny", {
      znaleziono: rekordy.join("  |  "),
      problem: `Domena ma ${rekordy.length} rekordy SPF. Serwery odbiorców traktują to jako błąd (permerror) i SPF nie przechodzi wcale.`,
      poprawka: "Połącz je w jeden rekord: jedno v=spf1, wszystkie include i ip4 obok siebie, jedno ~all na końcu.",
    });
  }
  const rekord = rekordy[0].trim();
  const uwagi: string[] = [];
  const all = rekord.match(/\s([+\-~?]?)all(\s|$)/i);
  if (all && (all[1] === "+" || all[1] === "")) {
    return wynik("bledny", {
      znaleziono: rekord,
      problem: "Rekord kończy się na +all: każdy serwer na świecie może wysyłać w imieniu tej domeny.",
      poprawka: "Zamień +all na ~all (albo -all, gdy wszystkie serwery są wpisane).",
    });
  }
  if (!all && !/redirect=/i.test(rekord)) uwagi.push("Rekord nie kończy się na ~all ani -all, więc nie chroni przed podszywaniem się pod domenę.");
  if (all?.[1] === "?") uwagi.push("?all niczego nie blokuje. Po sprawdzeniu, że poczta dochodzi, zmień na ~all.");

  // 1) Gdy znamy serwer SMTP, rozstrzyga PEŁNA ewaluacja SPF dla jego adresu IP.
  //    Sam tekst „include:x" w rekordzie nie wystarcza: mechanizm podaje klient, więc
  //    dowolny include dopisany do rekordu przepuściłby FR45 bez dopuszczenia serwera.
  // 2) Gdy serwera nie znamy (jeszcze nie skonfigurowany, albo deweloperski), sprawdzamy
  //    tylko obecność mechanizmu dostawcy — i piszemy, że to słabsze sprawdzenie. Silnik
  //    i tak sprawdza domenę ponownie po każdej zmianie serwera.
  if (k.mechanizmSpf && !(k.ipSerwera ?? []).length) {
    if (await zawieraMechanizm(domena, k.mechanizmSpf, resolver)) {
      return wynik("ok", {
        znaleziono: rekord,
        uwagi: [...uwagi, `Zawiera ${k.mechanizmSpf}. Adresu serwera SMTP jeszcze nie znamy — po jego ustawieniu sprawdzimy, czy SPF go dopuszcza.`],
      });
    }
  }
  const wynikiIp: { ip: string; w: WynikSpf }[] = [];
  for (const ip of k.ipSerwera ?? []) {
    wynikiIp.push({ ip, w: await bezpiecznieEwaluuj(ip, domena, resolver) });
  }
  // WSZYSTKIE adresy serwera muszą przejść: połączenie idzie na dowolny z nich (dziś
  // pierwszy z odpowiedzi DNS, jutro może być inny), więc „jeden z trzech" to loteria.
  const przepuszczony = wynikiIp.length > 0 && wynikiIp.every((x) => x.w === "pass") ? wynikiIp[0] : null;
  const czesciowo = wynikiIp.filter((x) => x.w === "pass");
  if (!przepuszczony && czesciowo.length > 0 && wynikiIp.every((x) => ["pass", "fail", "softfail", "neutral"].includes(x.w))) {
    const niedopuszczone = wynikiIp.filter((x) => x.w !== "pass").map((x) => x.ip);
    return wynik("bledny", {
      znaleziono: rekord,
      uwagi,
      problem: `Rekord dopuszcza tylko część adresów serwera ${k.hostSerwera ?? ""}: brakuje ${niedopuszczone.join(", ")}.`,
      poprawka: `Dopisz ${niedopuszczone.map((ip) => `${isIP(ip) === 6 ? "ip6" : "ip4"}:${ip}`).join(" ")} albo include dostawcy obejmujący wszystkie jego adresy. Nie zakładaj drugiego rekordu SPF.`,
    });
  }
  if (przepuszczony) {
    return wynik("ok", {
      znaleziono: rekord,
      uwagi: [
        ...uwagi,
        `Dopuszcza wszystkie adresy serwera ${k.hostSerwera ?? ""} (${wynikiIp.map((x) => x.ip).join(", ")}). Sprawdzamy adres, z którym łączy się panel — jeśli dostawca wysyła pocztę z innych adresów, podaj jego include.`,
      ],
    });
  }
  if (wynikiIp.some((x) => x.w === "permerror")) {
    return wynik("bledny", {
      znaleziono: rekord,
      problem: "Rekord SPF jest niepoprawny albo wymaga ponad 10 zapytań DNS (limit RFC 7208) — serwery odbiorców uznają go za błędny.",
      poprawka: "Usuń zbędne include albo zastąp je adresami ip4.",
    });
  }
  if (wynikiIp.some((x) => x.w === "temperror")) {
    return wynik("niesprawdzony", {
      znaleziono: rekord,
      problem: "Nie udało się rozwinąć wszystkich include w rekordzie SPF (DNS nie odpowiedział).",
      poprawka: "Spróbuj ponownie za kilka minut.",
      przejsciowy: true,
    });
  }
  if (wynikiIp.some((x) => x.w === "makra")) {
    return wynik("niesprawdzony", {
      znaleziono: rekord,
      problem: "Rekord używa makr, exists albo ptr — tego nie oceniamy automatycznie.",
      poprawka: k.mechanizmSpf ? null : "Podaj mechanizm SPF dostawcy serwera (np. include:_spf.dostawca.pl) — wtedy sprawdzimy, czy jest w rekordzie.",
    });
  }
  if (!k.mechanizmSpf && (k.ipSerwera ?? []).length === 0) {
    return wynik("niesprawdzony", {
      znaleziono: rekord,
      uwagi,
      problem: "Rekord SPF jest, ale nie wiemy, jaki serwer ma dopuszczać.",
      poprawka: "Skonfiguruj serwer SMTP niżej albo podaj mechanizm SPF dostawcy (np. include:_spf.google.com).",
    });
  }
  const ipMech = propozycjaSpf({ ...k, mechanizmSpf: null }).replace(/^v=spf1 /, "").replace(/ ~all$/, "");
  const dopisz = (k.ipSerwera ?? []).length && k.mechanizmSpf ? `${k.mechanizmSpf} (jeśli to właściwy dostawca) albo ${ipMech}` : k.mechanizmSpf ?? ipMech;
  return wynik("bledny", {
    znaleziono: rekord,
    uwagi,
    problem: (k.ipSerwera ?? []).length
      ? `Rekord nie dopuszcza serwera ${k.hostSerwera ?? ""} (${(k.ipSerwera ?? []).join(", ")})${k.mechanizmSpf ? `, mimo mechanizmu ${k.mechanizmSpf}` : ""}.`
      : `Rekord nie zawiera ${k.mechanizmSpf}, więc serwer dostawcy nie jest dopuszczony.`,
    poprawka: `Dopisz ${dopisz} do istniejącego rekordu, przed końcowym ~all albo -all. Nie zakładaj drugiego rekordu SPF.`,
  });
}

// ─────────────────────────────── DKIM ───────────────────────────────────────

function tagi(rekord: string): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const czesc of rekord.split(";")) {
    const i = czesc.indexOf("=");
    if (i === -1) continue;
    mapa.set(czesc.slice(0, i).trim().toLowerCase(), czesc.slice(i + 1).replace(/\s+/g, "").trim());
  }
  return mapa;
}

async function sprawdzDkim(domena: string, k: KontekstSerwera, resolver: ResolverDns): Promise<WynikRekordu> {
  if (!k.selektorDkim) {
    return wynik("niesprawdzony", {
      problem: "Bez selektora nie wiadomo, pod jaką nazwą szukać klucza DKIM.",
      poprawka: "Wpisz selektor DKIM z panelu serwera pocztowego (np. google, default, s1, mail) i sprawdź ponownie.",
    });
  }
  const nazwa = `${k.selektorDkim}._domainkey.${domena}`;
  const poprawkaBrak = `Dodaj rekord TXT na ${nazwa} z kluczem publicznym z panelu serwera pocztowego (wartość zaczyna się od v=DKIM1; k=rsa; p=…). Najpierw włącz podpisywanie DKIM dla tej domeny po stronie serwera.`;
  let rekordy: string[];
  try {
    rekordy = await resolver.txt(nazwa);
  } catch (blad) {
    if (czyBrakRekordu(blad)) {
      return wynik("brak", { problem: `Pod ${nazwa} nie ma rekordu DKIM.`, poprawka: poprawkaBrak });
    }
    return wynik("niesprawdzony", { problem: `Nie udało się odczytać DKIM: ${opisAwarii(blad)}.`, poprawka: "Spróbuj ponownie za kilka minut.", przejsciowy: true });
  }
  // CNAME tylko informacyjnie: rekord DKIM u dostawcy często jest CNAME-em do jego strefy
  let cname: string | null = null;
  try {
    cname = (await resolver.cname(nazwa))[0] ?? null;
  } catch {
    cname = null;
  }
  const kandydaci = rekordy.filter((r) => /(^|;)\s*p=/i.test(r) || /^v=DKIM1/i.test(r.trim()));
  const znaleziono = (cname ? `CNAME → ${cname}; ` : "") + (kandydaci[0] ?? rekordy[0] ?? "");
  if (kandydaci.length === 0) {
    return wynik("bledny", { znaleziono, problem: `Pod ${nazwa} jest rekord TXT, ale to nie jest klucz DKIM.`, poprawka: poprawkaBrak });
  }
  if (kandydaci.length > 1) {
    return wynik("bledny", { znaleziono, problem: `Pod ${nazwa} są ${kandydaci.length} klucze DKIM — serwery odbiorców nie wiedzą, którego użyć.`, poprawka: "Zostaw jeden rekord pod tym selektorem." });
  }
  const t = tagi(kandydaci[0]);
  const uwagi: string[] = [];
  if (t.has("v") && t.get("v") !== "DKIM1") {
    return wynik("bledny", { znaleziono, problem: `Tag v=${t.get("v")} — poprawna wartość to DKIM1.`, poprawka: "Skopiuj rekord z panelu serwera jeszcze raz, w całości." });
  }
  const p = t.get("p");
  if (p === undefined) {
    return wynik("bledny", { znaleziono, problem: "Rekord nie ma tagu p= z kluczem publicznym.", poprawka: "Skopiuj rekord z panelu serwera jeszcze raz, w całości." });
  }
  if (p === "") {
    return wynik("bledny", { znaleziono, problem: "Klucz jest unieważniony (puste p=). Podpisy tym selektorem nie przejdą.", poprawka: "Wygeneruj nowy klucz DKIM w panelu serwera i wklej jego rekord." });
  }
  const typ = (t.get("k") ?? "rsa").toLowerCase();
  let klucz: Buffer;
  try {
    klucz = Buffer.from(p, "base64");
  } catch {
    klucz = Buffer.alloc(0);
  }
  if (typ === "rsa") {
    let bity: number | undefined;
    try {
      bity = createPublicKey({ key: klucz, format: "der", type: "spki" }).asymmetricKeyDetails?.modulusLength;
    } catch {
      return wynik("bledny", {
        znaleziono,
        problem: "Klucz w p= nie jest poprawnym kluczem RSA — najczęściej ucięty przy wklejaniu (limit 255 znaków na fragment u części rejestratorów).",
        poprawka: "Wklej rekord ponownie w całości. Jeśli rejestrator ucina długie wartości, podziel ją na fragmenty w cudzysłowach.",
      });
    }
    if (bity !== undefined && bity < 1024) {
      return wynik("bledny", { znaleziono, problem: `Klucz RSA ma ${bity} bitów — Gmail i Yahoo odrzucają podpisy krótszymi niż 1024.`, poprawka: "Wygeneruj klucz 2048-bitowy w panelu serwera." });
    }
    if (bity === 1024) uwagi.push("Klucz 1024-bitowy działa, ale zalecane jest 2048.");
    if (bity) uwagi.push(`Klucz RSA ${bity} bitów.`);
  } else if (typ === "ed25519") {
    if (klucz.length !== 32) {
      return wynik("bledny", { znaleziono, problem: "Klucz ed25519 ma złą długość.", poprawka: "Wklej rekord ponownie w całości." });
    }
    uwagi.push("Klucz ed25519 — część serwerów odbiorców go nie weryfikuje, warto mieć równolegle klucz RSA.");
  } else {
    return wynik("bledny", { znaleziono, problem: `Nieznany typ klucza k=${typ}.`, poprawka: "Użyj klucza RSA (k=rsa)." });
  }
  if ((t.get("t") ?? "").split(":").includes("y")) {
    uwagi.push("Tag t=y: domena w trybie testowym DKIM — część odbiorców ignoruje wynik podpisu.");
  }
  return wynik("ok", { znaleziono, uwagi });
}

// ─────────────────────────────── DMARC ──────────────────────────────────────

async function rekordyDmarc(nazwa: string, resolver: ResolverDns): Promise<string[]> {
  try {
    return (await resolver.txt(`_dmarc.${nazwa}`)).filter((r) => /^v=DMARC1\s*(;|$)/i.test(r.trim()));
  } catch (blad) {
    if (czyBrakRekordu(blad)) return [];
    throw blad;
  }
}

/** Czy dwie domeny są wyrównane w trybie luźnym: ta sama albo jedna jest subdomeną drugiej. */
function wyrownaneLuzno(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function ocenWyrownanie(
  domena: string,
  tagiRekordu: Map<string, string> | null,
  nogi: { spfOk: boolean; dkimOk: boolean; domenaSpf: string },
): WyrownanieDmarc {
  const aspf = tagiRekordu?.get("aspf")?.toLowerCase() === "s" ? "s" : "r";
  const adkim = tagiRekordu?.get("adkim")?.toLowerCase() === "s" ? "s" : "r";
  const spfZgodny = aspf === "s" ? nogi.domenaSpf === domena : wyrownaneLuzno(nogi.domenaSpf, domena);
  const spf = !nogi.spfOk ? "nie_przechodzi" : spfZgodny ? "wyrownany" : "niewyrownany";
  // Klucz DKIM sprawdzamy pod <selektor>._domainkey.<domena From>, więc podpis tym kluczem
  // ma d= równe domenie From: wyrównany także przy adkim=s.
  const dkim = nogi.dkimOk ? "wyrownany" : "nie_przechodzi";
  const dmarcPrzejdzie = spf === "wyrownany" || dkim === "wyrownany";
  let komunikat: string | null = null;
  if (!dmarcPrzejdzie) {
    komunikat =
      spf === "niewyrownany"
        ? `DMARC NIE przejdzie: SPF przechodzi na ${nogi.domenaSpf}, ale przy aspf=${aspf} nie jest wyrównany z ${domena}, a DKIM nie jest poprawny. Skrzynki z polityką quarantine/reject wrzucą pocztę do spamu albo ją odrzucą.`
        : `DMARC NIE przejdzie: ani SPF (${nogi.domenaSpf}), ani DKIM nie dają wyrównania z ${domena}. Popraw DKIM — to jedyna noga, która działa niezależnie od koperty.`;
  } else if (spf !== "wyrownany") {
    komunikat =
      spf === "niewyrownany"
        ? `DMARC stoi wyłącznie na DKIM: przy aspf=${aspf} koperta ${nogi.domenaSpf} nie jest wyrównana z ${domena}. Awaria podpisu DKIM oznaczałaby od razu spam albo odrzucenie. Rozwiązanie: własny rekord DMARC dla ${domena} z aspf=r.`
        : `DMARC stoi wyłącznie na DKIM: SPF koperty ${nogi.domenaSpf} nie przechodzi.`;
  } else if (dkim !== "wyrownany") {
    komunikat = `DMARC stoi wyłącznie na SPF (koperta ${nogi.domenaSpf}). Przekazanie maila dalej psuje SPF — popraw DKIM, żeby mieć drugą nogę.`;
  }
  return { aspf, adkim, domenaSpf: nogi.domenaSpf, domenaFrom: domena, spf, dkim, dmarcPrzejdzie, komunikat };
}

async function sprawdzDmarc(
  domena: string,
  dkimOk: boolean,
  resolver: ResolverDns,
  nogi: { spfOk: boolean; domenaSpf: string } = { spfOk: false, domenaSpf: domena },
): Promise<WynikRekordu & { polityka: PolitykaDmarc | null; wyrownanie: WyrownanieDmarc | null }> {
  const propozycja = `v=DMARC1; p=none; rua=mailto:dmarc@${domena}`;
  // Spacer w górę drzewa (DMARCbis): brak rekordu na mail.firma.pl oznacza, że obowiązuje
  // rekord z firma.pl. Zatrzymujemy się przed samą domeną najwyższego poziomu. Przy
  // sufiksach typu com.pl sprawdzimy też com.pl — tam rekordu nie ma, więc nic nie zmyślimy.
  const etykiety = domena.split(".");
  let znalezione: string[] = [];
  let zrodlo = domena;
  try {
    for (let i = 0; i < Math.min(etykiety.length - 1, 8); i++) {
      zrodlo = etykiety.slice(i).join(".");
      znalezione = await rekordyDmarc(zrodlo, resolver);
      if (znalezione.length) break;
    }
  } catch (blad) {
    return { ...wynik("niesprawdzony", { problem: `Nie udało się odczytać DMARC: ${opisAwarii(blad)}.`, poprawka: "Spróbuj ponownie za kilka minut.", przejsciowy: true }), polityka: null, wyrownanie: null };
  }
  if (znalezione.length === 0) {
    return {
      ...wynik("brak", {
        problem: "Domena nie ma rekordu DMARC. Gmail i Yahoo wymagają go od nadawców masowych — bez niego poczta trafia do spamu albo jest odrzucana.",
        poprawka: `Dodaj rekord TXT na _dmarc.${domena}: ${propozycja}`,
      }),
      polityka: null,
      wyrownanie: null,
    };
  }
  if (znalezione.length > 1) {
    return {
      ...wynik("bledny", { znaleziono: znalezione.join("  |  "), problem: `Pod _dmarc.${zrodlo} są ${znalezione.length} rekordy DMARC — odbiorcy ignorują wtedy wszystkie.`, poprawka: "Zostaw jeden rekord." }),
      polityka: null,
      wyrownanie: null,
    };
  }
  const rekord = znalezione[0];
  const t = tagi(rekord);
  const dziedziczony = zrodlo !== domena;
  const surowaPolityka = (dziedziczony ? t.get("sp") ?? t.get("p") : t.get("p"))?.toLowerCase();
  const uwagi: string[] = [];
  if (dziedziczony) uwagi.push(`Rekord dziedziczony z domeny nadrzędnej ${zrodlo}${t.has("sp") ? " (tag sp=)" : ""}.`);
  if (surowaPolityka !== "none" && surowaPolityka !== "quarantine" && surowaPolityka !== "reject") {
    return {
      ...wynik("bledny", { znaleziono: rekord, problem: "Rekord nie ma poprawnego tagu p= (none, quarantine albo reject).", poprawka: `Popraw rekord, np.: ${propozycja}` }),
      polityka: null,
      wyrownanie: null,
    };
  }
  const polityka = surowaPolityka as PolitykaDmarc;
  if (polityka === "none") uwagi.push("p=none to tryb obserwacji: spełnia wymóg Gmaila i Yahoo, ale nie chroni domeny przed podszywaniem. Po kilku tygodniach raportów warto przejść na quarantine.");
  if (!t.get("rua")) uwagi.push("Brak rua= — nie zobaczysz raportów, kto wysyła w imieniu domeny.");
  const pct = t.get("pct");
  if (pct && pct !== "100") uwagi.push(`pct=${pct}: polityka obejmuje tylko część poczty.`);
  if (t.get("adkim")?.toLowerCase() === "s") {
    uwagi.push(`adkim=s: serwer musi podpisywać DKIM dokładnie domeną ${domena} (d=${domena}). Podpis domeną nadrzędną albo dostawcy nie wystarczy.`);
  }
  if (t.get("aspf")?.toLowerCase() === "s") {
    uwagi.push(
      nogi.domenaSpf === domena
        ? `aspf=s: koperta (Return-Path) jest dokładnie w ${domena}, więc SPF daje wyrównanie.`
        : `aspf=s: SPF liczony jest na kopercie ${nogi.domenaSpf}, która nie jest dokładnie ${domena} — przy ścisłym trybie SPF nie da wyrównania i DMARC stoi wyłącznie na DKIM.`,
    );
  }
  if (polityka !== "none" && !dkimOk) {
    uwagi.push(`Polityka ${polityka} przy niezweryfikowanym DKIM: każdy mail, który nie przejdzie SPF z wyrównaniem, trafi do spamu albo zostanie odrzucony.`);
  }
  const wyrownanie = ocenWyrownanie(domena, t, { spfOk: nogi.spfOk, dkimOk, domenaSpf: nogi.domenaSpf });
  if (wyrownanie.komunikat) uwagi.push(wyrownanie.komunikat);
  return { ...wynik("ok", { znaleziono: rekord, uwagi }), polityka, wyrownanie };
}

// ─────────────────────────────── MX ─────────────────────────────────────────

async function sprawdzMx(domena: string, resolver: ResolverDns) {
  try {
    const mx = await resolver.mx(domena);
    const rekordy = mx.sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`);
    return { rekordy, uwaga: rekordy.length ? null : "Domena nie ma rekordu MX.", przejsciowy: false };
  } catch (blad) {
    if (czyBrakRekordu(blad)) {
      return {
        rekordy: [],
        uwaga: "Domena nie ma rekordu MX: odpowiedzi klientów i odbicia na adres nadawcy nie dojdą, a część serwerów odrzuca pocztę od domen bez MX.",
        przejsciowy: false,
      };
    }
    return { rekordy: [], uwaga: `Nie udało się odczytać MX: ${opisAwarii(blad)}.`, przejsciowy: true };
  }
}

// ─────────────────────────────── całość ─────────────────────────────────────

export async function zweryfikujDomene(
  domena: string,
  kontekst: KontekstSerwera,
  resolver: ResolverDns,
): Promise<WynikWeryfikacji> {
  const rodzajSerwera: RodzajSerwera = kontekst.rodzaj ?? "wlasny_serwer";
  // Domena, na której odbiorca sprawdzi SPF: koperta, gdy podana, inaczej domena From.
  const domenaSpf = kontekst.domenaKoperty ?? domena;
  const [spf, dkim, mx] = await Promise.all([
    rodzajSerwera === "przekaznik" ? sprawdzSpfPrzekaznika(kontekst, resolver) : sprawdzSpf(domenaSpf, kontekst, resolver),
    sprawdzDkim(domena, kontekst, resolver),
    sprawdzMx(domena, resolver),
  ]);
  const { wyrownanie, ...dmarc } = await sprawdzDmarc(domena, dkim.status === "ok", resolver, { spfOk: spf.status === "ok", domenaSpf });
  const trzy = [spf, dkim, dmarc];
  const okCount = trzy.filter((r) => r.status === "ok").length;
  const status: StatusDomeny = okCount === 3 ? "verified" : okCount === 0 ? "failed" : "partial";
  return { spf, dkim, dmarc, mx, status, awariaDns: trzy.some((r) => r.przejsciowy), wyrownanie, rodzajSerwera };
}

/** Rekord do wklejenia u rejestratora — tabela Host / Typ / Wartość (wzorzec Klaviyo). */
export interface RekordDoUstawienia {
  rodzaj: "spf" | "dkim" | "dmarc";
  /** nazwa względna, tak jak wpisuje się ją u większości rejestratorów */
  host: string;
  /** pełna nazwa, gdy rejestrator nie dopisuje domeny sam */
  pelnaNazwa: string;
  typ: "TXT";
  wartosc: string;
  /** wartość do skopiowania czy opis, skąd ją wziąć */
  doSkopiowania: boolean;
}

export function rekordyDoUstawienia(domena: string, kontekst: KontekstSerwera): RekordDoUstawienia[] {
  const selektor = kontekst.selektorDkim ?? "<selektor>";
  // SPF stoi na domenie KOPERTY, gdy jest podana (przekaźnik zawsze): host względny
  // wobec domeny From, np. „bounce" dla bounce.news.midrev.pl
  const domenaSpf = kontekst.domenaKoperty ?? domena;
  const hostSpf = domenaSpf === domena ? "@" : domenaSpf.endsWith(`.${domena}`) ? domenaSpf.slice(0, -(domena.length + 1)) : domenaSpf;
  const wartoscSpf =
    kontekst.rodzaj === "przekaznik"
      ? `v=spf1 ${kontekst.mechanizmSpf ?? "include:<SPF dostawcy>"} ~all`
      : propozycjaSpf(kontekst);
  return [
    { rodzaj: "spf", host: hostSpf, pelnaNazwa: domenaSpf, typ: "TXT", wartosc: wartoscSpf, doSkopiowania: Boolean(kontekst.mechanizmSpf || (kontekst.rodzaj !== "przekaznik" && kontekst.ipSerwera?.length)) },
    {
      rodzaj: "dkim",
      host: `${selektor}._domainkey`,
      pelnaNazwa: `${selektor}._domainkey.${domena}`,
      typ: "TXT",
      wartosc: "klucz publiczny z panelu Twojego serwera pocztowego (v=DKIM1; k=rsa; p=…)",
      doSkopiowania: false,
    },
    { rodzaj: "dmarc", host: "_dmarc", pelnaNazwa: `_dmarc.${domena}`, typ: "TXT", wartosc: `v=DMARC1; p=none; rua=mailto:dmarc@${domena}`, doSkopiowania: true },
  ];
}
