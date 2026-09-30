import { Liquid } from "liquidjs";

/**
 * Zmienne w tresci maila: `{{ event.ProductName }}`, `{{ person.first_name|default:'Cześć' }}`,
 * `{% if event.product_slug == 'longevity' %}` (plan 3.6, AD-43).
 *
 * Silnik: liquidjs (MIT; bez eval, dostep tylko do WLASNYCH pol obiektu). Skladnia Klaviyo
 * (Django) jest z nim w duzej czesci zgodna; dopisane filtry Klaviyo: lookup, default,
 * floatformat, date (format Django, strefa tenanta).
 *
 * Bezpieczenstwo (dane zdarzenia moze przyslac obca przegladarka przez /client/*):
 *  - kazde `{{ }}` w HTML jest escapowane (autoescape). Oprocz & < > " ' escapujemy tez
 *    ` i =, wiec zmienna w atrybucie BEZ cudzyslowu nie dopisze nowego atrybutu (onclick=...);
 *  - nie ma `|safe`, a `|raw` jest zwyklym filtrem (NIE omija escapowania);
 *  - tagi, ktore wypisuja wartosc z pominieciem escapowania (`echo`, `cycle`) albo czytaja
 *    pliki (`include`, `render`, `layout`, `block`) sa zablokowane: blad parsowania;
 *  - po renderze kazdy href/src ze schematem spoza http(s)/mailto/tel jest usuwany
 *    (`sanityzujAdresy`), bo `javascript:` z wlasciwosci zdarzenia przechodzi przez escapowanie;
 *  - temat: bez escapowania HTML (to naglowek, nie HTML), bez znakow sterujacych i CR/LF,
 *    maks. 255 znakow;
 *  - limit czasu renderu 50 ms, pamieci i dlugosci wyniku 1 MB.
 */

export const LIMIT_RENDERU_MS = 50;
export const LIMIT_WYNIKU = 1_000_000;
export const LIMIT_TEMATU = 255;

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "=": "&#61;",
};

function naTekst(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(naTekst).join(", ");
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return String(v);
}

export function escapujZmienna(v: unknown): string {
  return naTekst(v).replace(/[&<>"'`=]/g, (z) => ESCAPE[z]);
}

// ── Filtry Klaviyo ──────────────────────────────────────────────────────────

function lookup(obj: unknown, klucz: unknown): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const k = String(klucz);
  return Object.prototype.hasOwnProperty.call(obj, k) ? (obj as Record<string, unknown>)[k] : undefined;
}

/** Django floatformat: bez argumentu 1 miejsce tylko gdy potrzebne; n > 0 zawsze n; n < 0 do |n| gdy potrzebne. */
export function floatformat(v: unknown, arg?: unknown): string {
  const x = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(x)) return "";
  const n = arg === undefined || arg === null || arg === "" ? -1 : Math.trunc(Number(arg));
  if (!Number.isFinite(n)) return "";
  const miejsca = Math.min(Math.abs(n), 20);
  const staly = x.toFixed(miejsca);
  if (n < 0 && Number(staly) === Math.trunc(Number(staly))) return Math.trunc(Number(staly)).toString();
  return staly;
}

function czesciDaty(d: Date, strefa: string): Record<string, string> {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: strefa, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
}

/** Django `date` (d j m n Y y H G i s, `\\` escapuje znak). Format z `%` = strftime liquid. */
export function dataDjango(v: unknown, format: string, strefa: string): string {
  let d: Date;
  if (v instanceof Date) d = v;
  else if (typeof v === "number") d = new Date(Math.abs(v) < 1e11 ? v * 1000 : v);
  else if (typeof v === "string" && v.trim()) d = new Date(v.trim());
  else return "";
  if (Number.isNaN(d.getTime())) return "";
  const c = czesciDaty(d, strefa);
  let wynik = "";
  for (let i = 0; i < format.length; i++) {
    const z = format[i];
    if (z === "\\" && i + 1 < format.length) {
      wynik += format[++i];
      continue;
    }
    switch (z) {
      case "d": wynik += c.day; break;
      case "j": wynik += String(Number(c.day)); break;
      case "m": wynik += c.month; break;
      case "n": wynik += String(Number(c.month)); break;
      case "Y": wynik += c.year; break;
      case "y": wynik += c.year.slice(-2); break;
      case "H": wynik += c.hour; break;
      case "G": wynik += String(Number(c.hour)); break;
      case "i": wynik += c.minute; break;
      case "s": wynik += c.second; break;
      default: wynik += z;
    }
  }
  return wynik;
}

// ── Silnik ──────────────────────────────────────────────────────────────────

const TAGI_ZABLOKOWANE = ["echo", "cycle", "include", "render", "layout", "block", "tablerow"] as const;

function zbudujSilnik(html: boolean, strefa: string): Liquid {
  const silnik = new Liquid({
    ...(html ? { outputEscape: escapujZmienna } : {}),
    ownPropertyOnly: true,
    strictFilters: true,
    strictVariables: false,
    lenientIf: true,
    renderLimit: LIMIT_RENDERU_MS,
    parseLimit: LIMIT_WYNIKU,
    memoryLimit: 10_000_000,
    relativeReference: false,
    // brak systemu plikow: include/render i tak sa zablokowane, to drugi zamek
    fs: {
      exists: async () => false, existsSync: () => false,
      readFile: async () => { throw new Error("pliki niedostępne"); },
      readFileSync: () => { throw new Error("pliki niedostępne"); },
      resolve: () => { throw new Error("pliki niedostępne"); },
    },
    timezoneOffset: strefa,
  });
  for (const t of TAGI_ZABLOKOWANE) {
    silnik.registerTag(t, {
      parse() {
        throw new Error(`znacznik {% ${t} %} jest niedostępny w treści maila`);
      },
      render() {
        return "";
      },
    });
  }
  const dataLiquid = silnik.filters.date;
  silnik.registerFilter("raw", (v: unknown) => v);
  silnik.registerFilter("safe", (v: unknown) => v);
  silnik.registerFilter("lookup", lookup);
  silnik.registerFilter("floatformat", floatformat);
  const dataDjangoLubLiquid = function (this: unknown, v: unknown, format?: unknown, ...reszta: unknown[]) {
    const f = format === undefined ? "Y-m-d" : String(format);
    if (f.includes("%")) {
      const impl = typeof dataLiquid === "function" ? dataLiquid : (dataLiquid as unknown as { handler: (...a: unknown[]) => unknown }).handler;
      return (impl as (...a: unknown[]) => unknown).call(this, v, f, ...reszta);
    }
    return dataDjango(v, f, strefa);
  };
  silnik.registerFilter("date", dataDjangoLubLiquid as unknown as Parameters<Liquid["registerFilter"]>[1]);
  return silnik;
}

const silniki = new Map<string, Liquid>();
function silnik(html: boolean, strefa: string): Liquid {
  const klucz = `${html ? "h" : "t"}|${strefa}`;
  let s = silniki.get(klucz);
  if (!s) {
    s = zbudujSilnik(html, strefa);
    silniki.set(klucz, s);
  }
  return s;
}

// Sparsowane szablony: ten sam mail renderuje sie dla setek osob w jednym tiku
// Sparsowane szablony (LRU po Map): ten sam mail renderuje sie dla setek osob w tiku.
// Limit laczny ~20 mln znakow zrodel, pojedyncze zrodlo > 200 kB nie trafia do pamieci.
const sparsowane = new Map<string, ReturnType<Liquid["parse"]>>();
let znakowWPamieci = 0;
const LIMIT_ZNAKOW_PAMIECI = 20_000_000;
const MAX_ZRODLA_W_PAMIECI = 200_000;
function parsuj(s: Liquid, klucz: string, zrodlo: string) {
  const k = `${klucz}|${zrodlo}`;
  const t = sparsowane.get(k);
  if (t) {
    sparsowane.delete(k);
    sparsowane.set(k, t);
    return t;
  }
  const nowy = s.parse(zrodlo);
  if (zrodlo.length > MAX_ZRODLA_W_PAMIECI) return nowy;
  sparsowane.set(k, nowy);
  znakowWPamieci += k.length;
  for (const [stary] of sparsowane) {
    if (znakowWPamieci <= LIMIT_ZNAKOW_PAMIECI && sparsowane.size <= 200) break;
    sparsowane.delete(stary);
    znakowWPamieci -= stary.length;
  }
  return nowy;
}

const ENCJE_W_ZNACZNIKU: Record<string, string> = {
  "&#39;": "'", "&#x27;": "'", "&apos;": "'", "&quot;": '"', "&#34;": '"',
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&#160;": " ",
};

/**
 * Edytor blokow zapisuje tekst jako HTML: apostrof w `default:'Cześć'` staje sie `&#39;`,
 * a link `https://sklep.pl/{{ event.slug }}` przechodzi przez URL i ma `%7B%7B`. Oddajemy
 * znacznikom liquid ich pierwotny zapis; reszta HTML zostaje nietknieta.
 */
export function przygotujZrodlo(html: string): string {
  const bezUrl = html.replace(/%7B(%7B|%25)([\s\S]*?)(%7D|%25)%7D/gi, (calosc, otw: string, srodek: string, zam: string) => {
    try {
      return `{${otw === "%25" ? "%" : "{"}${decodeURIComponent(srodek)}${zam === "%25" ? "%" : "}"}}`;
    } catch {
      return calosc;
    }
  });
  return bezUrl.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, (znacznik) =>
    znacznik.replace(/&(#39|#x27|apos|quot|#34|amp|lt|gt|nbsp|#160);/gi, (e) => ENCJE_W_ZNACZNIKU[e.toLowerCase()] ?? e),
  );
}

/** Czy tekst w ogole uzywa skladni szablonu (bez niej render = tekst bez zmian). */
export function maZmienne(tekst: string): boolean {
  return /\{\{|\{%|%7B%7B|%7B%25/i.test(tekst);
}

export interface KontekstSzablonu {
  event: Record<string, unknown>;
  person: Record<string, unknown>;
  organization: { name: string };
  /** skroty Klaviyo na najwyzszym poziomie */
  first_name?: unknown;
  last_name?: unknown;
  email?: unknown;
}

export function zbudujKontekst(dane: {
  zdarzenie: Record<string, unknown> | null;
  profil: { email?: string | null; first_name?: string | null; last_name?: string | null; phone?: string | null; properties?: Record<string, unknown> | null };
  organizacja: string;
}): KontekstSzablonu {
  const wl = dane.zdarzenie && typeof dane.zdarzenie === "object" ? dane.zdarzenie : {};
  const event: Record<string, unknown> = { ...wl };
  if (Object.prototype.hasOwnProperty.call(wl, "$extra")) event.extra = wl.$extra;
  const props = dane.profil.properties && typeof dane.profil.properties === "object" ? dane.profil.properties : {};
  const person: Record<string, unknown> = {
    ...props,
    email: dane.profil.email ?? null,
    first_name: dane.profil.first_name ?? null,
    last_name: dane.profil.last_name ?? null,
    phone_number: dane.profil.phone ?? null,
  };
  return { event, person, organization: { name: dane.organizacja }, first_name: person.first_name, last_name: person.last_name, email: person.email };
}

export class BladSzablonu extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BladSzablonu";
  }
}

function opisBledu(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0].slice(0, 300);
}

/** Render HTML treści: autoescape + sanityzacja adresow. Rzuca BladSzablonu. */
export function renderujHtml(zrodlo: string, ctx: KontekstSzablonu, strefa = "Europe/Warsaw"): string {
  if (!maZmienne(zrodlo)) return sanityzujAdresy(zrodlo);
  const s = silnik(true, strefa);
  let wynik: string;
  try {
    wynik = s.renderSync(parsuj(s, `h|${strefa}`, przygotujZrodlo(zrodlo)), ctx) as string;
  } catch (e) {
    throw new BladSzablonu(`treść: ${opisBledu(e)}`);
  }
  if (wynik.length > LIMIT_WYNIKU) throw new BladSzablonu("treść po podstawieniu zmiennych przekracza 1 MB");
  return sanityzujAdresy(wynik);
}

/** Temat po renderze: bez znakow sterujacych, CR/LF i separatorow linii, maks. 255 znakow. */
export function oczyscTemat(t: string): string {
  const jeden = t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(jeden).slice(0, LIMIT_TEMATU).join("").trim();
}

export function renderujTemat(zrodlo: string, ctx: KontekstSzablonu, strefa = "Europe/Warsaw"): string {
  if (!maZmienne(zrodlo)) return oczyscTemat(zrodlo);
  const s = silnik(false, strefa);
  let wynik: string;
  try {
    wynik = s.renderSync(parsuj(s, `t|${strefa}`, przygotujZrodlo(zrodlo)), ctx) as string;
  } catch (e) {
    throw new BladSzablonu(`temat: ${opisBledu(e)}`);
  }
  return oczyscTemat(wynik);
}

/**
 * Walidacja przy publikacji: parsowanie i probny render na pustym kontekscie (nieznany filtr,
 * zablokowany znacznik, niedomkniety `{% if %}`). null = poprawny.
 */
export function sprawdzSzablon(temat: string, html: string): string | null {
  const pusty = zbudujKontekst({ zdarzenie: {}, profil: {}, organizacja: "" });
  try {
    renderujTemat(temat, pusty);
    renderujHtml(html, pusty);
    return null;
  } catch (e) {
    return e instanceof BladSzablonu ? e.message : opisBledu(e);
  }
}

// ── Sanityzacja adresow ─────────────────────────────────────────────────────

const ENCJE_NAZWANE: Record<string, string> = {
  colon: ":", tab: "\t", newline: "\n", sol: "/", period: ".", plus: "+", lpar: "(", rpar: ")",
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", excl: "!", num: "#", dollar: "$",
  percnt: "%", comma: ",", semi: ";", equals: "=", quest: "?", commat: "@", lsqb: "[", rsqb: "]",
  lowbar: "_", grave: "`", lcub: "{", rcub: "}", verbar: "|", bsol: "\\",
};

function dekodujAtrybut(v: string): string {
  return v.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (calosc, kod: string) => {
    if (kod[0] === "#") {
      const n = kod[1] === "x" || kod[1] === "X" ? parseInt(kod.slice(2), 16) : parseInt(kod.slice(1), 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
      try {
        return String.fromCodePoint(n);
      } catch {
        return "";
      }
    }
    return ENCJE_NAZWANE[kod.toLowerCase()] ?? calosc;
  });
}

const SCHEMATY_LINKOW = new Set(["http", "https", "mailto", "tel"]);

/** Adres po zdekodowaniu encji i usunieciu bialych i sterujacych znakow (tak czyta go przegladarka). */
function normalnyAdres(surowy: string): string {
  return dekodujAtrybut(surowy).replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, "").toLowerCase();
}

function schemat(v: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/.exec(v);
  return m ? m[1] : null;
}

/**
 * Czy wartosc atrybutu NAWIGACYJNEGO (href, action, formaction, xlink:href) jest dozwolona
 * (AD-43): wylacznie jawny schemat http, https, mailto, tel albo kotwica `#...`. Adres
 * wzgledny i `//host` odpadaja: w mailu nie maja bazy, a omijaja sledzenie klikniec.
 */
export function adresBezpieczny(surowy: string): boolean {
  const v = normalnyAdres(surowy);
  if (v.startsWith("#")) return true;
  const s = schemat(v);
  return s !== null && SCHEMATY_LINKOW.has(s);
}

/** Zrodlo obrazka/tla: http(s), zalacznik `cid:` albo rastrowy `data:image/...` (bez SVG). */
export function zrodloBezpieczne(surowy: string): boolean {
  const v = normalnyAdres(surowy);
  const s = schemat(v);
  if (s === "http" || s === "https" || s === "cid") return true;
  return /^data:image\/(png|jpe?g|gif|webp);/.test(v);
}

/** srcset: kazdy kandydat (URL [deskryptor]) musi byc bezpiecznym zrodlem. */
function srcsetBezpieczny(surowy: string): boolean {
  const kandydaci = dekodujAtrybut(surowy).split(",").map((k) => k.trim()).filter(Boolean);
  return kandydaci.length > 0 && kandydaci.every((k) => zrodloBezpieczne(k.split(/\s+/)[0]));
}

const ATRYBUTY_NAWIGACJI = new Set(["href", "xlink:href", "action", "formaction"]);

/**
 * Usuwa atrybuty adresowe z niedozwolona wartoscia: nawigacja tylko http(s)/mailto/tel/#,
 * zrodla (src, srcset, background, poster) tylko http(s)/cid/raster data:. Wszystkie trzy
 * zapisy atrybutu (podwojny, pojedynczy cudzyslow, bez cudzyslowu), separator spacja albo `/`.
 * Zmienne szablonu nie moga dopisac nowego atrybutu (`"` i `=` sa escapowane), wiec to
 * zamyka jedyna droge z danych zdarzenia do adresu: wartosc istniejacego atrybutu.
 */
export function sanityzujAdresy(html: string): string {
  return html.replace(
    /([\s/])(href|xlink:href|action|formaction|src|srcset|background|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    (calosc, odstep: string, nazwa: string, a?: string, b?: string, c?: string) => {
      const wartosc = a ?? b ?? c ?? "";
      const n = nazwa.toLowerCase();
      const ok = ATRYBUTY_NAWIGACJI.has(n) ? adresBezpieczny(wartosc) : n === "srcset" ? srcsetBezpieczny(wartosc) : zrodloBezpieczne(wartosc);
      return ok ? calosc : odstep.trimEnd() + " ";
    },
  );
}
