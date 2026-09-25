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

export interface WynikWeryfikacji {
  spf: WynikRekordu;
  dkim: WynikRekordu;
  dmarc: WynikRekordu & { polityka: PolitykaDmarc | null };
  mx: { rekordy: string[]; uwaga: string | null; przejsciowy: boolean };
  status: StatusDomeny;
  /** czy którykolwiek wynik jest niepewny przez awarię DNS — wtedy nie wolno obniżać statusu */
  awariaDns: boolean;
}

export interface KontekstSerwera {
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

async function sprawdzDmarc(
  domena: string,
  dkimOk: boolean,
  resolver: ResolverDns,
): Promise<WynikRekordu & { polityka: PolitykaDmarc | null }> {
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
    return { ...wynik("niesprawdzony", { problem: `Nie udało się odczytać DMARC: ${opisAwarii(blad)}.`, poprawka: "Spróbuj ponownie za kilka minut.", przejsciowy: true }), polityka: null };
  }
  if (znalezione.length === 0) {
    return {
      ...wynik("brak", {
        problem: "Domena nie ma rekordu DMARC. Gmail i Yahoo wymagają go od nadawców masowych — bez niego poczta trafia do spamu albo jest odrzucana.",
        poprawka: `Dodaj rekord TXT na _dmarc.${domena}: ${propozycja}`,
      }),
      polityka: null,
    };
  }
  if (znalezione.length > 1) {
    return {
      ...wynik("bledny", { znaleziono: znalezione.join("  |  "), problem: `Pod _dmarc.${zrodlo} są ${znalezione.length} rekordy DMARC — odbiorcy ignorują wtedy wszystkie.`, poprawka: "Zostaw jeden rekord." }),
      polityka: null,
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
    uwagi.push(`aspf=s: SPF da wyrównanie tylko wtedy, gdy adres zwrotny (Return-Path) jest dokładnie w ${domena}. Wysyłamy z kopertą równą adresowi nadawcy, ale część dostawców przepisuje ją na własną domenę — wtedy DMARC stoi wyłącznie na DKIM.`);
  }
  if (polityka !== "none" && !dkimOk) {
    uwagi.push(`Polityka ${polityka} przy niezweryfikowanym DKIM: każdy mail, który nie przejdzie SPF z wyrównaniem, trafi do spamu albo zostanie odrzucony.`);
  }
  return { ...wynik("ok", { znaleziono: rekord, uwagi }), polityka };
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
  const [spf, dkim, mx] = await Promise.all([
    sprawdzSpf(domena, kontekst, resolver),
    sprawdzDkim(domena, kontekst, resolver),
    sprawdzMx(domena, resolver),
  ]);
  const dmarc = await sprawdzDmarc(domena, dkim.status === "ok", resolver);
  const trzy = [spf, dkim, dmarc];
  const okCount = trzy.filter((r) => r.status === "ok").length;
  const status: StatusDomeny = okCount === 3 ? "verified" : okCount === 0 ? "failed" : "partial";
  return { spf, dkim, dmarc, mx, status, awariaDns: trzy.some((r) => r.przejsciowy) };
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
  return [
    { rodzaj: "spf", host: "@", pelnaNazwa: domena, typ: "TXT", wartosc: propozycjaSpf(kontekst), doSkopiowania: Boolean(kontekst.mechanizmSpf || kontekst.ipSerwera?.length) },
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
