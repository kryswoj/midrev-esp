import { naMinor } from "../zdarzenia/limity";

/**
 * Parser feedu produktów Google Merchant (plan integracji D.1 klocek 3, E.4):
 *   - XML RSS 2.0 (`<rss><channel><item><g:id>…`) i Atom (`<feed><entry><g:id>…`),
 *   - CSV / TSV z nagłówkiem (`id`, `title`, `link`, `image_link`, `price`…; także „image link”).
 *
 * Czysta funkcja, bez zależności. Wejście jest obce (adres podał klient, treść serwuje
 * dowolny serwer), więc:
 *   - XML z `<!DOCTYPE`/`<!ENTITY` jest odrzucany w całości (XXE, „billion laughs”); encji
 *     nazwanych nie rozwijamy poza pięcioma standardowymi i numerycznymi,
 *   - twarde limity: liczba pozycji, długość pól, rozmiar jednej pozycji,
 *   - adresy (link, image_link) tylko http(s); reszta pola = null,
 *   - tekst trafia do bazy jako tekst (bez HTML: znaczniki są usuwane z opisu), a każde
 *     miejsce wyświetlenia i tak escapuje (React, autoescape szablonów AD-43).
 */

export const MAKS_POZYCJI_FEEDU = 50_000;
const MAKS_ROZMIAR_POZYCJI = 100_000;

export interface Cena {
  minor: bigint;
  waluta: string;
}

export interface PozycjaFeedu {
  id: string;
  grupa: string | null;
  tytul: string;
  opis: string | null;
  link: string | null;
  obraz: string | null;
  cena: Cena | null;
  cenaPromocyjna: Cena | null;
  dostepnosc: "in_stock" | "out_of_stock" | "preorder" | "backorder" | null;
  marka: string | null;
  kategorie: string[];
  gtin: string | null;
  sku: string | null;
}

export interface WynikParsowania {
  format: "rss" | "atom" | "csv" | "tsv";
  pozycje: PozycjaFeedu[];
  /** pozycje pominięte (brak id/tytułu, za duże, powtórzone id) */
  pominiete: number;
  /** true = feed miał więcej pozycji niż limit; reszta odcięta */
  obciety: boolean;
}

export class BladFeedu extends Error {}

function przytnij(v: string | null | undefined, maks: number): string | null {
  if (v === null || v === undefined) return null;
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return t ? t.slice(0, maks) : null;
}

export function adresHttp(v: string | null | undefined): string | null {
  const t = przytnij(v, 2000);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** „12.99 PLN”, „12,99 PLN”, „PLN 12.99”, „1 299,00 zł”. Brak waluty = domyślna. */
export function parsujCene(v: string | null | undefined, walutaDomyslna = "PLN"): Cena | null {
  const t = przytnij(v, 64);
  if (!t) return null;
  const kod = t.match(/\b([A-Za-z]{3})\b/)?.[1]?.toUpperCase() ?? (/zł/i.test(t) ? "PLN" : walutaDomyslna);
  let liczba = t.replace(/[A-Za-z]{3}|zł/gi, "").replace(/[\s\u00a0]/g, "");
  if (!/^\d[\d.,]*$/.test(liczba)) return null;
  // separator dziesiętny = ostatni z [.,] z 1–2 cyframi po nim; reszta to separatory tysięcy
  const m = liczba.match(/^(.*?)[.,](\d{1,2})$/);
  liczba = m ? `${m[1].replace(/[.,]/g, "")}.${m[2]}` : liczba.replace(/[.,]/g, "");
  const kwota = Number(liczba);
  if (!Number.isFinite(kwota) || kwota < 0 || kwota > 1e10) return null;
  const minor = naMinor(kwota, kod);
  return minor === null ? null : { minor, waluta: kod };
}

function dostepnosc(v: string | null): PozycjaFeedu["dostepnosc"] {
  if (!v) return null;
  const t = v.toLowerCase().replace(/[\s-]+/g, "_");
  if (t === "in_stock" || t === "instock" || t === "available" || t === "dostepny") return "in_stock";
  if (t === "out_of_stock" || t === "outofstock" || t === "niedostepny") return "out_of_stock";
  if (t === "preorder") return "preorder";
  if (t === "backorder") return "backorder";
  return null;
}

const ENCJE: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: "\u00a0" };

function dekodujEncje(t: string): string {
  return t.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (cale, k: string) => {
    if (k[0] === "#") {
      const kod = k[1] === "x" || k[1] === "X" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(kod) && kod > 0 && kod <= 0x10ffff && !(kod >= 0xd800 && kod <= 0xdfff) ? String.fromCodePoint(kod) : "";
    }
    return ENCJE[k.toLowerCase()] ?? cale;
  });
}

function tekstXml(surowy: string): string {
  // CDATA dosłownie, poza nim encje
  let wynik = "";
  let reszta = surowy;
  for (;;) {
    const i = reszta.indexOf("<![CDATA[");
    if (i < 0) break;
    const j = reszta.indexOf("]]>", i + 9);
    if (j < 0) break;
    wynik += dekodujEncje(reszta.slice(0, i).replace(/<[^>]*>/g, "")) + reszta.slice(i + 9, j);
    reszta = reszta.slice(j + 3);
  }
  return wynik + dekodujEncje(reszta.replace(/<[^>]*>/g, ""));
}

function bezHtml(t: string | null): string | null {
  if (!t) return null;
  return t.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || null;
}

type Pola = Map<string, string>;

/** Dzieci jednej pozycji XML: nazwa bez prefiksu przestrzeni nazw → pierwsza wartość. */
function polaXml(blok: string): Pola {
  const pola: Pola = new Map();
  const re = /<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:\s+[^<>]*?)?)(\/>|>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blok))) {
    const prefiks = m[1] ?? "";
    const nazwa = m[2].toLowerCase();
    const atrybuty = m[3] ?? "";
    let wartosc = "";
    if (m[4] === ">") {
      const zamkniecie = `</${prefiks}${m[2]}>`;
      const koniec = blok.indexOf(zamkniecie, re.lastIndex);
      if (koniec < 0) continue;
      wartosc = blok.slice(re.lastIndex, koniec);
      re.lastIndex = koniec + zamkniecie.length;
    }
    // Atom: <link href="..."/>
    if (!wartosc && nazwa === "link") {
      const href = atrybuty.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/);
      if (href) wartosc = href[2] ?? href[3] ?? "";
    }
    if (!pola.has(nazwa)) pola.set(nazwa, tekstXml(wartosc));
    else if (nazwa === "product_type" || nazwa === "google_product_category") {
      pola.set(nazwa, `${pola.get(nazwa)}\u0001${tekstXml(wartosc)}`);
    }
  }
  return pola;
}

function pozycjaZPol(p: Pola, walutaDomyslna: string): PozycjaFeedu | null {
  const id = przytnij(p.get("id") ?? p.get("item_id") ?? null, 255);
  const tytul = przytnij(bezHtml(p.get("title") ?? null), 500);
  if (!id || !tytul) return null;
  const kategorie = [p.get("product_type"), p.get("google_product_category")]
    .filter((x): x is string => Boolean(x))
    .flatMap((x) => x.split("\u0001"))
    .flatMap((x) => x.split(/\s*>\s*/))
    .map((x) => przytnij(x, 120))
    .filter((x): x is string => Boolean(x) && !/^\d+$/.test(x!));
  return {
    id,
    grupa: przytnij(p.get("item_group_id") ?? null, 255),
    tytul,
    opis: przytnij(bezHtml(p.get("description") ?? null), 5000),
    link: adresHttp(p.get("link") ?? null),
    obraz: adresHttp(p.get("image_link") ?? null),
    cena: parsujCene(p.get("price"), walutaDomyslna),
    cenaPromocyjna: parsujCene(p.get("sale_price"), walutaDomyslna),
    dostepnosc: dostepnosc(przytnij(p.get("availability") ?? null, 40)),
    marka: przytnij(p.get("brand") ?? null, 255),
    kategorie: [...new Set(kategorie)].slice(0, 20),
    gtin: przytnij(p.get("gtin") ?? null, 64),
    sku: przytnij(p.get("mpn") ?? p.get("sku") ?? null, 255),
  };
}

function parsujXml(tekst: string, walutaDomyslna: string): WynikParsowania {
  if (/<!DOCTYPE|<!ENTITY/i.test(tekst)) {
    throw new BladFeedu("Feed XML zawiera deklarację DOCTYPE/ENTITY. Takiego pliku nie wczytujemy (bezpieczeństwo).");
  }
  const atom = /<feed[\s>]/.test(tekst) && !/<rss[\s>]/.test(tekst);
  const znacznik = atom ? "entry" : "item";
  const re = new RegExp(`<${znacznik}(?:\\s[^>]*)?>`, "g");
  const pozycje: PozycjaFeedu[] = [];
  const widziane = new Set<string>();
  let pominiete = 0;
  let obciety = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tekst))) {
    const koniec = tekst.indexOf(`</${znacznik}>`, re.lastIndex);
    if (koniec < 0) break;
    const blok = tekst.slice(re.lastIndex, koniec);
    re.lastIndex = koniec + znacznik.length + 3;
    if (blok.length > MAKS_ROZMIAR_POZYCJI) {
      pominiete++;
      continue;
    }
    const p = pozycjaZPol(polaXml(blok), walutaDomyslna);
    if (!p || widziane.has(p.id)) {
      pominiete++;
      continue;
    }
    if (pozycje.length >= MAKS_POZYCJI_FEEDU) {
      obciety = true;
      break;
    }
    widziane.add(p.id);
    pozycje.push(p);
  }
  if (pozycje.length === 0 && pominiete === 0) {
    throw new BladFeedu(atom ? "Feed Atom bez elementów <entry>." : "Feed XML bez elementów <item>. To nie wygląda na feed Google Merchant.");
  }
  return { format: atom ? "atom" : "rss", pozycje, pominiete, obciety };
}

/** Wiersze CSV/TSV (RFC 4180: cudzysłowy, podwojony cudzysłów, nowe linie w polu). */
export function wierszeCsv(tekst: string, separator: string, maksWierszy: number): string[][] {
  const wiersze: string[][] = [];
  let pole = "";
  let wiersz: string[] = [];
  let wCudzyslowie = false;
  for (let i = 0; i < tekst.length; i++) {
    const c = tekst[i];
    if (wCudzyslowie) {
      if (c === '"') {
        if (tekst[i + 1] === '"') {
          pole += '"';
          i++;
        } else wCudzyslowie = false;
      } else pole += c;
      continue;
    }
    if (c === '"' && pole === "") wCudzyslowie = true;
    else if (c === separator) {
      wiersz.push(pole);
      pole = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && tekst[i + 1] === "\n") i++;
      wiersz.push(pole);
      pole = "";
      if (wiersz.length > 1 || wiersz[0] !== "") wiersze.push(wiersz);
      wiersz = [];
      if (wiersze.length > maksWierszy) return wiersze;
    } else pole += c;
    if (pole.length > MAKS_ROZMIAR_POZYCJI) throw new BladFeedu("Pole CSV dłuższe niż 100 KB. To nie wygląda na feed produktów.");
  }
  if (pole !== "" || wiersz.length) {
    wiersz.push(pole);
    wiersze.push(wiersz);
  }
  return wiersze;
}

function parsujCsv(tekst: string, walutaDomyslna: string): WynikParsowania {
  const pierwsza = tekst.slice(0, tekst.search(/\r?\n/) >= 0 ? tekst.search(/\r?\n/) : tekst.length);
  const separator = pierwsza.includes("\t")
    ? "\t"
    : (pierwsza.match(/;/g)?.length ?? 0) > (pierwsza.match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  const wiersze = wierszeCsv(tekst, separator, MAKS_POZYCJI_FEEDU + 1);
  if (wiersze.length < 1) throw new BladFeedu("Pusty plik CSV.");
  const naglowek = wiersze[0].map((h) =>
    h.trim().toLowerCase().replace(/^g:/, "").replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, ""),
  );
  if (!naglowek.includes("id") || !naglowek.includes("title")) {
    throw new BladFeedu("Plik CSV/TSV musi mieć w nagłówku kolumny „id” i „title” (format Google Merchant).");
  }
  const pozycje: PozycjaFeedu[] = [];
  const widziane = new Set<string>();
  let pominiete = 0;
  const obciety = wiersze.length - 1 > MAKS_POZYCJI_FEEDU;
  for (const w of wiersze.slice(1, MAKS_POZYCJI_FEEDU + 1)) {
    const pola: Pola = new Map();
    naglowek.forEach((n, i) => {
      if (n && !pola.has(n) && w[i] !== undefined) pola.set(n, w[i]);
    });
    const p = pozycjaZPol(pola, walutaDomyslna);
    if (!p || widziane.has(p.id)) {
      pominiete++;
      continue;
    }
    widziane.add(p.id);
    pozycje.push(p);
  }
  return { format: separator === "\t" ? "tsv" : "csv", pozycje, pominiete, obciety };
}

export function parsujFeed(tekst: string, walutaDomyslna = "PLN"): WynikParsowania {
  const t = tekst.replace(/^\uFEFF/, "");
  const start = t.trimStart();
  if (!start) throw new BladFeedu("Feed jest pusty.");
  if (start.startsWith("<")) return parsujXml(start, walutaDomyslna);
  if (/^\s*[{[]/.test(start)) throw new BladFeedu("To jest JSON, a nie feed Google Merchant (XML albo CSV/TSV).");
  return parsujCsv(start, walutaDomyslna);
}

// ── Grupowanie w produkty z wariantami ────────────────────────────────────────────

export interface ProduktZFeedu {
  externalId: string;
  tytul: string;
  opis: string | null;
  link: string | null;
  obraz: string | null;
  cenaMinor: bigint | null;
  cenaPorownawczaMinor: bigint | null;
  waluta: string | null;
  kategorie: string[];
  marka: string | null;
  dostepny: boolean | null;
  warianty: {
    externalId: string;
    sku: string | null;
    ean: string | null;
    tytul: string;
    link: string | null;
    obraz: string | null;
    cenaMinor: bigint | null;
    cenaPorownawczaMinor: bigint | null;
    waluta: string | null;
    dostepny: boolean | null;
  }[];
}

/** item_group_id → produkt; pozycje bez grupy = produkt z jednym wariantem o tym samym id. */
export function produktyZPozycji(pozycje: PozycjaFeedu[]): ProduktZFeedu[] {
  const grupy = new Map<string, PozycjaFeedu[]>();
  for (const p of pozycje) {
    const k = p.grupa ?? p.id;
    const lista = grupy.get(k);
    if (lista) lista.push(p);
    else grupy.set(k, [p]);
  }
  const wynik: ProduktZFeedu[] = [];
  for (const [klucz, lista] of grupy) {
    const warianty = lista.map((p) => {
      const promo = p.cenaPromocyjna && p.cena && p.cenaPromocyjna.waluta === p.cena.waluta && p.cenaPromocyjna.minor < p.cena.minor;
      return {
        externalId: p.id,
        sku: p.sku,
        ean: p.gtin,
        tytul: p.tytul,
        link: p.link,
        obraz: p.obraz,
        cenaMinor: promo ? p.cenaPromocyjna!.minor : (p.cena?.minor ?? null),
        cenaPorownawczaMinor: promo ? p.cena!.minor : null,
        waluta: p.cena?.waluta ?? null,
        dostepny: p.dostepnosc === null ? null : p.dostepnosc === "in_stock" || p.dostepnosc === "backorder" || p.dostepnosc === "preorder",
      };
    });
    const pierwszy = lista[0];
    const zCena = warianty.filter((w) => w.cenaMinor !== null);
    const najtanszy = zCena.sort((a, b) => (a.cenaMinor! < b.cenaMinor! ? -1 : a.cenaMinor! > b.cenaMinor! ? 1 : 0))[0];
    wynik.push({
      externalId: klucz,
      tytul: pierwszy.tytul,
      opis: pierwszy.opis,
      link: pierwszy.link,
      obraz: pierwszy.obraz,
      cenaMinor: najtanszy?.cenaMinor ?? null,
      cenaPorownawczaMinor: najtanszy?.cenaPorownawczaMinor ?? null,
      waluta: najtanszy?.waluta ?? null,
      kategorie: pierwszy.kategorie,
      marka: pierwszy.marka,
      dostepny: warianty.some((w) => w.dostepny === true) ? true : warianty.every((w) => w.dostepny === false) ? false : null,
      warianty,
    });
  }
  return wynik;
}
