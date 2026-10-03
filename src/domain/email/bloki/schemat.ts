import { z } from "zod";

/**
 * Dokument edytora bloków: model treści kampanii (AD-32 — `campaigns.content` to
 * dokument edytora; moduł wysyłki czyta z niego wyłącznie `html`).
 *
 * Zapis w `campaigns.content`:
 *   { html: "<wyrenderowane bloki>", wersjaSchematu: 1, style: {...}, bloki: [...] }
 *
 * `html` jest WYNIKIEM, bloki są ŹRÓDŁEM. Silnik wysyłki, akceptacja klienta i wysyłka
 * testowa czytają `html` tak jak dotąd, więc edytor nie wymaga żadnej zmiany w silniku.
 *
 * Każde pole ma górny limit długości: dokument przychodzi z przeglądarki i ląduje w bazie,
 * więc nie może być dowolnie duży.
 */
export const WERSJA_SCHEMATU = 1;

const kolor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "kolor w postaci #rrggbb");
const kolorLubBrak = z.union([kolor, z.literal("")]);
const url = z.string().max(2000);
const krotki = z.string().max(300);
const wyrownanie = z.enum(["left", "center", "right"]);
const px = (min: number, maks: number) => z.number().int().min(min).max(maks);

export const KROJE = {
  systemowy: { etykieta: "Systemowy (jak w telefonie)", stos: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" },
  arial: { etykieta: "Arial", stos: "Arial,Helvetica,sans-serif" },
  helvetica: { etykieta: "Helvetica", stos: "'Helvetica Neue',Helvetica,Arial,sans-serif" },
  verdana: { etykieta: "Verdana", stos: "Verdana,Geneva,sans-serif" },
  trebuchet: { etykieta: "Trebuchet MS", stos: "'Trebuchet MS',Tahoma,sans-serif" },
  georgia: { etykieta: "Georgia (szeryfowy)", stos: "Georgia,'Times New Roman',serif" },
  times: { etykieta: "Times New Roman", stos: "'Times New Roman',Times,serif" },
} as const;
export type Kroj = keyof typeof KROJE;

export const schematStyli = z.object({
  tlo: kolor,
  tloTresci: kolor,
  kolorTekstu: kolor,
  kolorMarki: kolor,
  kroj: z.enum(Object.keys(KROJE) as [Kroj, ...Kroj[]]),
  szerokosc: px(480, 700),
});
export type StyleMaila = z.infer<typeof schematStyli>;

/** Wypełnienie i tło — wspólne dla każdego bloku (w panelu: „Marginesy i tło"). */
const oprawa = {
  id: z.string().regex(/^[a-z0-9]{4,24}$/),
  gora: px(0, 120),
  dol: px(0, 120),
  boki: px(0, 80),
  tlo: kolorLubBrak,
};

const blokNaglowek = z.object({
  ...oprawa,
  typ: z.literal("naglowek"),
  logoUrl: url,
  logoAlt: krotki,
  logoSzerokosc: px(40, 400),
  nazwa: krotki,
  link: url,
  wyrownanie,
});

const blokTekst = z.object({
  ...oprawa,
  typ: z.literal("tekst"),
  /** tekst sformatowany po `sanityzujTekst` */
  html: z.string().max(40000),
  wariant: z.enum(["akapit", "h1", "h2", "h3", "maly"]),
  kolor: kolorLubBrak,
  wyrownanie,
});

const blokObraz = z.object({
  ...oprawa,
  typ: z.literal("obraz"),
  src: url,
  alt: krotki,
  link: url,
  /** szerokość w procentach szerokości treści */
  szerokosc: px(10, 100),
  zaokraglenie: px(0, 40),
  wyrownanie,
});

const blokPrzycisk = z.object({
  ...oprawa,
  typ: z.literal("przycisk"),
  tekst: krotki,
  link: url,
  kolorTla: kolorLubBrak,
  kolorTekstu: kolor,
  zaokraglenie: px(0, 40),
  rozmiar: z.enum(["maly", "sredni", "duzy"]),
  pelnaSzerokosc: z.boolean(),
  wyrownanie,
});

const blokSeparator = z.object({
  ...oprawa,
  typ: z.literal("separator"),
  kolor,
  grubosc: px(1, 8),
  styl: z.enum(["solid", "dashed", "dotted"]),
  szerokosc: px(10, 100),
});

const blokOdstep = z.object({
  ...oprawa,
  typ: z.literal("odstep"),
  wysokosc: px(4, 160),
});

export const schematKolumny = z.object({
  obrazUrl: url,
  obrazAlt: krotki,
  html: z.string().max(20000),
  przyciskTekst: krotki,
  przyciskLink: url,
});
export type Kolumna = z.infer<typeof schematKolumny>;

const blokKolumny = z.object({
  ...oprawa,
  typ: z.literal("kolumny"),
  proporcja: z.enum(["50-50", "33-67", "67-33"]),
  odstepKolumn: px(0, 48),
  wyrownanie,
  lewa: schematKolumny,
  prawa: schematKolumny,
});

const blokProdukt = z.object({
  ...oprawa,
  typ: z.literal("produkt"),
  obrazUrl: url,
  obrazAlt: krotki,
  nazwa: krotki,
  opis: z.string().max(2000),
  cena: z.string().max(60),
  cenaPrzed: z.string().max(60),
  przyciskTekst: krotki,
  link: url,
  wyrownanie,
});

/**
 * Produkty DYNAMICZNE (plan integracji E.5, R6): lista wstawiana przy wysyłce z koszyka osoby
 * (`carts`, porzucony koszyk/checkout) albo z produktu ze zdarzenia, które wprowadziło osobę do
 * automatyzacji (przeglądany produkt). Przycisk „wróć do koszyka” prowadzi pod link powrotu
 * koszyka (sklep z wtyczką: odtwarza koszyk na każdym urządzeniu). W kampanii (bez zdarzenia
 * i koszyka) blok się nie pokazuje.
 */
const blokKoszyk = z.object({
  ...oprawa,
  typ: z.literal("koszyk"),
  zrodlo: z.enum(["koszyk", "zdarzenie"]),
  tytul: krotki,
  przyciskTekst: krotki,
  maks: px(1, 10),
  pokazCeny: z.boolean(),
  wyrownanie,
});

const blokKod = z.object({
  ...oprawa,
  typ: z.literal("kod"),
  tytul: krotki,
  kod: z.string().max(80),
  opis: z.string().max(1000),
  kolorRamki: kolor,
  tloKodu: kolor,
});

export const SIECI = {
  facebook: { etykieta: "Facebook", kolor: "#1877f2" },
  instagram: { etykieta: "Instagram", kolor: "#e1306c" },
  tiktok: { etykieta: "TikTok", kolor: "#111111" },
  youtube: { etykieta: "YouTube", kolor: "#ff0000" },
  linkedin: { etykieta: "LinkedIn", kolor: "#0a66c2" },
  x: { etykieta: "X", kolor: "#111111" },
  pinterest: { etykieta: "Pinterest", kolor: "#e60023" },
  www: { etykieta: "Strona", kolor: "#5b616b" },
} as const;
export type Siec = keyof typeof SIECI;

const blokSocial = z.object({
  ...oprawa,
  typ: z.literal("social"),
  linki: z
    .array(z.object({ siec: z.enum(Object.keys(SIECI) as [Siec, ...Siec[]]), url }))
    .max(8),
  styl: z.enum(["kolor", "ciemny", "jasny"]),
  wyrownanie,
});

const blokStopka = z.object({
  ...oprawa,
  typ: z.literal("stopka"),
  html: z.string().max(10000),
  kolor: kolorLubBrak,
  wyrownanie,
});

/** Własny HTML: także postać, w której otwiera się kampania sprzed edytora bloków. */
const blokHtml = z.object({
  ...oprawa,
  typ: z.literal("html"),
  html: z.string().max(200000),
});

export const schematBloku = z.discriminatedUnion("typ", [
  blokNaglowek,
  blokTekst,
  blokObraz,
  blokPrzycisk,
  blokSeparator,
  blokOdstep,
  blokKolumny,
  blokProdukt,
  blokKoszyk,
  blokKod,
  blokSocial,
  blokStopka,
  blokHtml,
]);
export type Blok = z.infer<typeof schematBloku>;
export type TypBloku = Blok["typ"];
export type BlokTypu<T extends TypBloku> = Extract<Blok, { typ: T }>;

export const schematDokumentu = z.object({
  wersjaSchematu: z.literal(WERSJA_SCHEMATU),
  style: schematStyli,
  bloki: z.array(schematBloku).max(120),
});
export type DokumentMaila = z.infer<typeof schematDokumentu>;

export const STYLE_DOMYSLNE: StyleMaila = {
  tlo: "#f4f5f7",
  tloTresci: "#ffffff",
  kolorTekstu: "#1f2328",
  kolorMarki: "#814ac8",
  kroj: "systemowy",
  szerokosc: 600,
};
