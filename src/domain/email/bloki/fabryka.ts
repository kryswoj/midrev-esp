import {
  schematDokumentu,
  STYLE_DOMYSLNE,
  WERSJA_SCHEMATU,
  type Blok,
  type BlokTypu,
  type DokumentMaila,
  type TypBloku,
} from "./schemat";

/**
 * Identyfikator bloku. Bez `crypto.randomUUID`: panel chodzi też po zwykłym http,
 * a tam przeglądarka tej funkcji nie udostępnia (tylko w bezpiecznym kontekście).
 */
export function noweId(): string {
  let id = "";
  while (id.length < 10) id += Math.random().toString(36).slice(2);
  return id.slice(0, 10);
}

/**
 * Boki domyślnie 0: silnik wysyłki i tak odsuwa treść od krawędzi karty o 32 px
 * (patrz `silnik.ts`). Wcięcie w bloku przydaje się dopiero przy bloku z własnym tłem.
 */
const OPRAWA = { gora: 12, dol: 12, boki: 0, tlo: "" as const };

/**
 * Dane konta, z których startują nagłówek i stopka (audyt UX 02.10, P0-2). Tylko to, co
 * operator sam wpisał: nazwa sklepu (`tenants.name`) i dane firmy z 0029. Nic nie jest
 * zgadywane ani uzupełniane przykładem — brak danych to pusty blok, który płótno
 * pokazuje jako prośbę o uzupełnienie, a nie „Twój sklep, ul. Przykładowa 1".
 */
export interface DaneKonta {
  nazwaSklepu?: string | null;
  firma?: string | null;
  adres?: string | null;
}

/** Tekst stopki startowej. Adres i NIP dokleja silnik wysyłki z ustawień konta, więc tu ich nie ma. */
export const STOPKA_STARTOWA = "Masz pytanie? Odpisz na tego maila.";

function nazwaZKonta(konto?: DaneKonta): string {
  return (konto?.nazwaSklepu || konto?.firma || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
}

/** Blok z sensownymi wartościami startowymi — taki, jaki ląduje po upuszczeniu z biblioteki. */
export function nowyBlok<T extends TypBloku>(typ: T, konto?: DaneKonta): BlokTypu<T> {
  const id = noweId();
  const bloki: { [K in TypBloku]: BlokTypu<K> } = {
    naglowek: { id, typ: "naglowek", ...OPRAWA, gora: 24, dol: 24, logoUrl: "", logoAlt: "", logoSzerokosc: 140, nazwa: nazwaZKonta(konto), link: "", wyrownanie: "center" },
    tekst: { id, typ: "tekst", ...OPRAWA, html: "Napisz tu, co chcesz powiedzieć klientom. Zaznacz fragment, żeby go pogrubić albo podlinkować.", wariant: "akapit", kolor: "", wyrownanie: "left" },
    obraz: { id, typ: "obraz", ...OPRAWA, boki: 0, src: "", alt: "", link: "", szerokosc: 100, zaokraglenie: 0, wyrownanie: "center" },
    przycisk: { id, typ: "przycisk", ...OPRAWA, gora: 16, dol: 16, tekst: "Zobacz ofertę", link: "", kolorTla: "", kolorTekstu: "#ffffff", zaokraglenie: 8, rozmiar: "sredni", pelnaSzerokosc: false, wyrownanie: "center" },
    separator: { id, typ: "separator", ...OPRAWA, kolor: "#e3e6ea", grubosc: 1, styl: "solid", szerokosc: 100 },
    odstep: { id, typ: "odstep", ...OPRAWA, gora: 0, dol: 0, boki: 0, wysokosc: 32 },
    kolumny: {
      id, typ: "kolumny", ...OPRAWA, proporcja: "50-50", odstepKolumn: 24, wyrownanie: "left",
      lewa: { obrazUrl: "", obrazAlt: "", html: "<b>Lewa kolumna</b><br>Krótki opis.", przyciskTekst: "", przyciskLink: "" },
      prawa: { obrazUrl: "", obrazAlt: "", html: "<b>Prawa kolumna</b><br>Krótki opis.", przyciskTekst: "", przyciskLink: "" },
    },
    produkt: { id, typ: "produkt", ...OPRAWA, gora: 16, dol: 16, obrazUrl: "", obrazAlt: "", nazwa: "Nazwa produktu", opis: "Jedno zdanie o tym, dlaczego warto.", cena: "129,00 zł", cenaPrzed: "", przyciskTekst: "Kup teraz", link: "", wyrownanie: "center" },
    koszyk: { id, typ: "koszyk", ...OPRAWA, gora: 16, dol: 16, zrodlo: "koszyk", tytul: "W Twoim koszyku", przyciskTekst: "Wróć do koszyka", maks: 5, pokazCeny: true, wyrownanie: "center" },
    kod: { id, typ: "kod", ...OPRAWA, gora: 16, dol: 16, tytul: "Twój kod rabatowy", kod: "RABAT10", opis: "Wpisz go w koszyku. Ważny do końca tygodnia.", kolorRamki: "#814ac8", tloKodu: "#f4eefc" },
    social: { id, typ: "social", ...OPRAWA, gora: 16, dol: 16, linki: [{ siec: "instagram", url: "" }, { siec: "facebook", url: "" }], styl: "kolor", wyrownanie: "center" },
    stopka: { id, typ: "stopka", ...OPRAWA, gora: 24, dol: 8, html: STOPKA_STARTOWA, kolor: "#868d97", wyrownanie: "center" },
    html: { id, typ: "html", ...OPRAWA, html: "" },
  };
  return bloki[typ] as BlokTypu<T>;
}

/** Kopia bloku z nowym identyfikatorem (akcja „Duplikuj"). */
export function kopiaBloku(blok: Blok): Blok {
  return { ...structuredClone(blok), id: noweId() };
}

export function pustyDokument(): DokumentMaila {
  return { wersjaSchematu: WERSJA_SCHEMATU, style: { ...STYLE_DOMYSLNE }, bloki: [] };
}

export type ZrodloDokumentu = "bloki" | "html" | "pusty" | "uszkodzony";

/**
 * Dokument z `campaigns.content`, także z kampanii sprzed edytora bloków.
 *
 * Kompatybilność wstecz: kampania, która ma tylko `content.html` (pisany ręcznie
 * w polu tekstowym), otwiera się jako JEDEN blok „Własny HTML". Nic nie ginie
 * i nic się nie wysypuje — operator może dalej pracować na swoim HTML-u albo
 * dokładać bloki wokół niego.
 *
 * Uszkodzony dokument bloków (np. nowsza wersja schematu albo ręczna zmiana w bazie)
 * NIE jest po cichu zastępowany pustym: wraca jako HTML, który faktycznie wychodzi
 * dziś w mailach, z informacją `zrodlo: "uszkodzony"` do pokazania operatorowi.
 */
export function wczytajDokument(content: unknown): { dokument: DokumentMaila; zrodlo: ZrodloDokumentu } {
  const c = (content && typeof content === "object" ? content : {}) as Record<string, unknown>;
  const html = typeof c.html === "string" ? c.html : "";
  if (Array.isArray(c.bloki)) {
    const wynik = schematDokumentu.safeParse({ wersjaSchematu: c.wersjaSchematu, style: c.style, bloki: c.bloki });
    if (wynik.success) return { dokument: wynik.data, zrodlo: "bloki" };
    return { dokument: dokumentZHtml(html), zrodlo: "uszkodzony" };
  }
  if (html.trim()) return { dokument: dokumentZHtml(html), zrodlo: "html" };
  return { dokument: pustyDokument(), zrodlo: "pusty" };
}

function dokumentZHtml(html: string): DokumentMaila {
  const dokument = pustyDokument();
  if (html.trim()) {
    dokument.bloki.push({ ...nowyBlok("html"), html, gora: 0, dol: 0, boki: 0 });
  }
  return dokument;
}
