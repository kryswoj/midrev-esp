import { z } from "zod";
import { KROJE, type Kroj } from "../email/bloki/schemat";
import { REGULY_DOMYSLNE, maWyzwalacz, schematRegul, type RegulyWyswietlania } from "./wyswietlanie";

/**
 * Model formularza zapisu (builder jak w Klaviyo). Czysta domena: zero bazy, zero DOM.
 *
 * Formularz = typ (popup / wysuwany w rogu / osadzony na stronie), styl, KROKI (dowolna
 * liczba, każdy krok to lista bloków), krok SUKCESU, opcjonalny TEASER i reguły wyświetlania.
 *
 * Zapis cząstkowy (jak w Klaviyo): dokładnie jeden krok ma pole e-mail i w nim musi stać
 * blok zgody. Kroki PRZED nim zbierają odpowiedzi w przeglądarce i wysyłają je razem
 * z e-mailem (bez e-maila i zgody nic nie trafia do bazy). Krok z e-mailem tworzy profil,
 * zgodę i wpis na listę. Kroki PO nim tylko uzupełniają profil (imię, telefon, właściwości).
 *
 * Bezpieczeństwo treści: wszystko tu jest czystym tekstem. Skrypt na stronie wstawia go
 * przez textContent, a adresy (obraz, link, polityka) przechodzą przez `bezpiecznyAdres`.
 */

export type TypFormularza = "popup" | "flyout" | "embed";
export type AkcjaPrzycisku = "wyslij" | "dalej" | "zamknij" | "url";
export type PozycjaObrazu = "brak" | "lewo" | "prawo" | "gora" | "tlo";
export type KrojFormularza = "strona" | Kroj;

export const NAZWY_TYPOW: Record<TypFormularza, { nazwa: string; opis: string }> = {
  popup: { nazwa: "Popup", opis: "Okno na środku strony z przyciemnionym tłem." },
  flyout: { nazwa: "Wysuwany w rogu", opis: "Mniejsza karta w rogu ekranu, nie zasłania strony." },
  embed: { nazwa: "Osadzony na stronie", opis: "Wklejony w treść strony, np. w stopce. Zawsze widoczny." },
};

export const NAZWY_AKCJI: Record<AkcjaPrzycisku, string> = {
  wyslij: "Wyślij i przejdź dalej",
  dalej: "Przejdź dalej bez zapisu",
  zamknij: "Zamknij formularz",
  url: "Otwórz adres strony",
};

const id = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const kolor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const tekst = (maks: number) => z.string().max(maks);

/** Klucz właściwości profilu z pytania: litera na początku, bez znaków specjalnych. */
export const WZOR_WLASCIWOSCI = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Klucze zarezerwowane (pola profilu i metadane Klaviyo): pytanie ich nie nadpisze. */
const ZAREZERWOWANE = new Set(["email", "phone", "phone_number", "first_name", "last_name", "id", "external_id", "anonymous_id", "organization", "title", "locale", "location"]);

export const schematBloku = z.discriminatedUnion("typ", [
  z.object({ id, typ: z.literal("naglowek"), tekst: tekst(200), rozmiar: z.number().int().min(16).max(48) }),
  z.object({ id, typ: z.literal("tekst"), tekst: tekst(1000) }),
  z.object({ id, typ: z.literal("obraz"), url: tekst(2000), alt: tekst(200), szerokosc: z.number().int().min(20).max(100) }),
  z.object({ id, typ: z.literal("email"), etykieta: tekst(120), placeholder: tekst(120) }),
  z.object({ id, typ: z.literal("imie"), etykieta: tekst(120), placeholder: tekst(120), wymagane: z.boolean() }),
  z.object({ id, typ: z.literal("telefon"), etykieta: tekst(120), placeholder: tekst(120), wymagane: z.boolean() }),
  z.object({
    id,
    typ: z.literal("pytanie"),
    pytanie: tekst(200),
    wlasciwosc: tekst(64),
    opcje: z.array(tekst(80)).max(12),
    wielokrotny: z.boolean(),
    wymagane: z.boolean(),
  }),
  z.object({ id, typ: z.literal("przycisk"), tekst: tekst(80), akcja: z.enum(["wyslij", "dalej", "zamknij", "url"]), url: tekst(2000) }),
  z.object({ id, typ: z.literal("zgoda"), tekst: tekst(2000), adresPolityki: tekst(500) }),
  z.object({ id, typ: z.literal("kod"), kod: tekst(60), opis: tekst(120) }),
  z.object({ id, typ: z.literal("nie_dziekuje"), tekst: tekst(80) }),
]);
export type Blok = z.infer<typeof schematBloku>;
export type TypBloku = Blok["typ"];
export type BlokTypu<T extends TypBloku> = Extract<Blok, { typ: T }>;

export const schematKroku = z.object({ id, nazwa: tekst(60), bloki: z.array(schematBloku).max(24) });
export type Krok = z.infer<typeof schematKroku>;

export const schematStylu = z.object({
  szerokosc: z.number().int().min(280).max(760),
  tlo: kolor,
  kolorTekstu: kolor,
  kolorPrzycisku: kolor,
  kolorTekstuPrzycisku: kolor,
  kroj: z.enum(["strona", ...(Object.keys(KROJE) as Kroj[])] as [KrojFormularza, ...KrojFormularza[]]),
  zaokraglenie: z.number().int().min(0).max(32),
  wyrownanie: z.enum(["lewo", "srodek"]),
  obraz: tekst(2000),
  obrazPozycja: z.enum(["brak", "lewo", "prawo", "gora", "tlo"]),
  /** przyciemnienie tła strony pod popupem, w procentach */
  nakladka: z.number().int().min(0).max(90),
  /** róg dla wysuwanego i teasera */
  rog: z.enum(["prawo", "lewo"]),
});
export type StylFormularza = z.infer<typeof schematStylu>;

export const schematTeasera = z.object({ wlaczony: z.boolean(), tekst: tekst(60) });
export type Teaser = z.infer<typeof schematTeasera>;

export const MAKS_KROKOW = 8;
export const WERSJA_MODELU = 1;

export const schematDefinicji = z.object({
  wersjaModelu: z.literal(WERSJA_MODELU),
  typ: z.enum(["popup", "flyout", "embed"]),
  styl: schematStylu,
  kroki: z.array(schematKroku).min(1).max(MAKS_KROKOW),
  sukces: schematKroku,
  teaser: schematTeasera,
  wyswietlanie: schematRegul,
  /** lista docelowa (uuid) albo null; wchodzi w życie przy publikacji */
  listaId: z.string().uuid().nullable(),
});
export type DefinicjaFormularza = z.infer<typeof schematDefinicji>;

export const STYL_DOMYSLNY: StylFormularza = {
  szerokosc: 440,
  tlo: "#ffffff",
  kolorTekstu: "#1d1d1f",
  kolorPrzycisku: "#111111",
  kolorTekstuPrzycisku: "#ffffff",
  kroj: "strona",
  zaokraglenie: 12,
  wyrownanie: "srodek",
  obraz: "",
  obrazPozycja: "brak",
  nakladka: 55,
  rog: "prawo",
};

/** Stosy krojów do CSS (wspólne z edytorem maili + „krój strony sklepu”). */
export function stosKroju(k: KrojFormularza): string {
  return k === "strona" ? "inherit" : KROJE[k].stos;
}

// ── Fabryka ────────────────────────────────────────────────────────────────

let licznik = 0;
/** Krótki identyfikator bloku/kroku. Unikalny w obrębie dokumentu (losowy + licznik). */
export function noweId(przedrostek: "b" | "k"): string {
  licznik = (licznik + 1) % 1296;
  return `${przedrostek}${Math.random().toString(36).slice(2, 8)}${licznik.toString(36)}`;
}

export const NAZWY_BLOKOW: Record<TypBloku, string> = {
  naglowek: "Nagłówek",
  tekst: "Tekst",
  obraz: "Obraz",
  email: "Pole e-mail",
  imie: "Pole imię",
  telefon: "Pole telefon",
  pytanie: "Pytanie z opcjami",
  przycisk: "Przycisk",
  zgoda: "Zgoda na marketing",
  kod: "Kod rabatowy",
  nie_dziekuje: "Link „Nie, dziękuję”",
};

export function nowyBlok(typ: TypBloku, firma = "naszego sklepu"): Blok {
  const b = { id: noweId("b") };
  switch (typ) {
    case "naglowek":
      return { ...b, typ, tekst: "Nagłówek", rozmiar: 28 };
    case "tekst":
      return { ...b, typ, tekst: "Krótki tekst, który zachęca do zapisu." };
    case "obraz":
      return { ...b, typ, url: "", alt: "", szerokosc: 100 };
    case "email":
      return { ...b, typ, etykieta: "Adres e-mail", placeholder: "Twój adres e-mail" };
    case "imie":
      return { ...b, typ, etykieta: "Imię", placeholder: "Imię", wymagane: false };
    case "telefon":
      return { ...b, typ, etykieta: "Telefon", placeholder: "Numer telefonu", wymagane: false };
    case "pytanie":
      return { ...b, typ, pytanie: "Co Cię najbardziej interesuje?", wlasciwosc: "Zainteresowania", opcje: ["Nowości", "Promocje", "Porady"], wielokrotny: true, wymagane: false };
    case "przycisk":
      return { ...b, typ, tekst: "Zapisz się", akcja: "wyslij", url: "" };
    case "zgoda":
      return { ...b, typ, tekst: domyslnaZgoda(firma), adresPolityki: "" };
    case "kod":
      return { ...b, typ, kod: "WITAJ10", opis: "Twój kod rabatowy" };
    case "nie_dziekuje":
      return { ...b, typ, tekst: "Nie, dziękuję" };
  }
}

/** Domyślna klauzula: ta sama treść co w 0041 (`domyslnaKlauzula`), żeby nie mnożyć wariantów. */
export function domyslnaZgoda(firma: string): string {
  const nazwa = firma.trim() || "tego sklepu";
  return `Zapisuję się na newsletter ${nazwa} i zgadzam się na otrzymywanie wiadomości e-mail z ofertami i nowościami. Zgodę mogę wycofać w każdej chwili, klikając link w stopce wiadomości.`;
}

export function nowyKrok(nazwa: string, bloki: Blok[] = []): Krok {
  return { id: noweId("k"), nazwa, bloki };
}

/** Kopia z NOWYMI identyfikatorami (duplikat kroku albo bloku). */
export function kopiaBloku(b: Blok): Blok {
  return { ...structuredClone(b), id: noweId("b") };
}
export function kopiaKroku(k: Krok): Krok {
  return { id: noweId("k"), nazwa: `${k.nazwa} (kopia)`.slice(0, 60), bloki: k.bloki.map(kopiaBloku) };
}

// ── Operacje (niemutujące; builder trzyma historię cofnij/ponów) ─────────────

/** Krok po id: zwykły albo sukces. */
export function krokPoId(d: DefinicjaFormularza, krokId: string): Krok | null {
  if (d.sukces.id === krokId) return d.sukces;
  return d.kroki.find((k) => k.id === krokId) ?? null;
}

function zmienKrokWDef(d: DefinicjaFormularza, krokId: string, f: (k: Krok) => Krok): DefinicjaFormularza {
  if (d.sukces.id === krokId) return { ...d, sukces: f(d.sukces) };
  return { ...d, kroki: d.kroki.map((k) => (k.id === krokId ? f(k) : k)) };
}

export function dodajKrok(d: DefinicjaFormularza, po?: string): { def: DefinicjaFormularza; krokId: string } {
  if (d.kroki.length >= MAKS_KROKOW) return { def: d, krokId: po ?? d.kroki[d.kroki.length - 1].id };
  const k = nowyKrok(`Krok ${d.kroki.length + 1}`, [
    { ...(nowyBlok("naglowek") as BlokTypu<"naglowek">), tekst: "Jeszcze jedno" },
    nowyBlok("przycisk"),
  ]);
  const i = po ? d.kroki.findIndex((x) => x.id === po) : d.kroki.length - 1;
  const kroki = [...d.kroki];
  kroki.splice(i + 1, 0, k);
  return { def: { ...d, kroki }, krokId: k.id };
}

export function duplikujKrok(d: DefinicjaFormularza, krokId: string): { def: DefinicjaFormularza; krokId: string } {
  const i = d.kroki.findIndex((k) => k.id === krokId);
  if (i < 0 || d.kroki.length >= MAKS_KROKOW) return { def: d, krokId };
  // kopia kroku z e-mailem nie może dublować pola e-mail ani zgody (to byłby drugi zapis)
  const zrodlo = d.kroki[i];
  const kopia = kopiaKroku({ ...zrodlo, bloki: zrodlo.bloki.filter((b) => b.typ !== "email" && b.typ !== "zgoda") });
  const kroki = [...d.kroki];
  kroki.splice(i + 1, 0, kopia);
  return { def: { ...d, kroki }, krokId: kopia.id };
}

export function usunKrok(d: DefinicjaFormularza, krokId: string): DefinicjaFormularza {
  if (d.kroki.length <= 1) return d;
  return { ...d, kroki: d.kroki.filter((k) => k.id !== krokId) };
}

export function przeniesKrok(d: DefinicjaFormularza, z: number, na: number): DefinicjaFormularza {
  if (z === na || z < 0 || na < 0 || z >= d.kroki.length || na >= d.kroki.length) return d;
  const kroki = [...d.kroki];
  const [k] = kroki.splice(z, 1);
  kroki.splice(na, 0, k);
  return { ...d, kroki };
}

export function zmienNazweKroku(d: DefinicjaFormularza, krokId: string, nazwa: string): DefinicjaFormularza {
  return zmienKrokWDef(d, krokId, (k) => ({ ...k, nazwa: nazwa.slice(0, 60) }));
}

export function wstawBlok(d: DefinicjaFormularza, krokId: string, blok: Blok, indeks?: number): DefinicjaFormularza {
  return zmienKrokWDef(d, krokId, (k) => {
    if (k.bloki.length >= 24) return k;
    const bloki = [...k.bloki];
    bloki.splice(indeks ?? bloki.length, 0, blok);
    return { ...k, bloki };
  });
}

export function usunBlok(d: DefinicjaFormularza, krokId: string, blokId: string): DefinicjaFormularza {
  return zmienKrokWDef(d, krokId, (k) => ({ ...k, bloki: k.bloki.filter((b) => b.id !== blokId) }));
}

export function duplikujBlok(d: DefinicjaFormularza, krokId: string, blokId: string): DefinicjaFormularza {
  return zmienKrokWDef(d, krokId, (k) => {
    const i = k.bloki.findIndex((b) => b.id === blokId);
    if (i < 0 || k.bloki.length >= 24) return k;
    // pole e-mail i zgoda są jedne na formularz: ich nie powielamy
    if (k.bloki[i].typ === "email" || k.bloki[i].typ === "zgoda") return k;
    const bloki = [...k.bloki];
    bloki.splice(i + 1, 0, kopiaBloku(k.bloki[i]));
    return { ...k, bloki };
  });
}

export function przeniesBlok(d: DefinicjaFormularza, krokId: string, z: number, na: number): DefinicjaFormularza {
  return zmienKrokWDef(d, krokId, (k) => {
    if (z === na || z < 0 || na < 0 || z >= k.bloki.length || na >= k.bloki.length) return k;
    const bloki = [...k.bloki];
    const [b] = bloki.splice(z, 1);
    bloki.splice(na, 0, b);
    return { ...k, bloki };
  });
}

export function zmienBlok(d: DefinicjaFormularza, krokId: string, blokId: string, zmiana: Partial<Blok>): DefinicjaFormularza {
  return zmienKrokWDef(d, krokId, (k) => ({
    ...k,
    bloki: k.bloki.map((b) => (b.id === blokId ? ({ ...b, ...zmiana, id: b.id, typ: b.typ } as Blok) : b)),
  }));
}

/** Indeks kroku z polem e-mail (pierwszy) albo -1. */
export function indeksKrokuEmail(d: Pick<DefinicjaFormularza, "kroki">): number {
  return d.kroki.findIndex((k) => k.bloki.some((b) => b.typ === "email"));
}

/** Blok zgody formularza (w kroku z e-mailem) albo null. */
export function blokZgody(d: Pick<DefinicjaFormularza, "kroki">): BlokTypu<"zgoda"> | null {
  for (const k of d.kroki) for (const b of k.bloki) if (b.typ === "zgoda") return b;
  return null;
}

/** Które typy bloków wolno wstawić do danego kroku (biblioteka wyszarza resztę). */
export function dozwolonyBlok(d: DefinicjaFormularza, krokId: string, typ: TypBloku): { ok: boolean; powod?: string } {
  const sukces = d.sukces.id === krokId;
  if (typ === "kod" && !sukces) return { ok: false, powod: "Kod rabatowy pokazujemy dopiero po zapisie, w kroku sukcesu." };
  if (sukces && ["email", "imie", "telefon", "pytanie", "zgoda"].includes(typ)) return { ok: false, powod: "Krok sukcesu jest po zapisie: pola tu nie pasują." };
  if (typ === "email") {
    const i = indeksKrokuEmail(d);
    if (i >= 0) return { ok: false, powod: `Pole e-mail jest już w kroku ${i + 1}. Formularz ma jedno pole e-mail.` };
  }
  if (typ === "zgoda") {
    const i = indeksKrokuEmail(d);
    if (blokZgody(d)) return { ok: false, powod: "Zgoda jest już w formularzu. Edytuj istniejący blok." };
    if (i >= 0 && d.kroki[i].id !== krokId) return { ok: false, powod: `Zgoda musi stać w kroku z polem e-mail (krok ${i + 1}).` };
  }
  return { ok: true };
}

// ── Bezpieczeństwo adresów ───────────────────────────────────────────────────

/** Adres http(s) bez spacji i znaków sterujących; inaczej null. Ten sam test co w skrypcie. */
export function bezpiecznyAdres(surowy: string): string | null {
  const s = String(surowy ?? "").trim();
  if (!s || s.length > 2000 || /[\u0000- \u007f<>"]/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

// ── Walidacja przed publikacją ───────────────────────────────────────────────

export interface Problem {
  tekst: string;
  /** czerwone blokuje publikację, pomarańczowe to zalecenie */
  wymagane: boolean;
  krokId?: string;
  blokId?: string;
}

export function nazwaKroku(d: DefinicjaFormularza, krokId: string): string {
  if (d.sukces.id === krokId) return "Sukces";
  const i = d.kroki.findIndex((k) => k.id === krokId);
  return i >= 0 ? `Krok ${i + 1}` : "Krok";
}

/** Lista rzeczy do poprawy przed publikacją, po polsku, z odnośnikiem do kroku i bloku. */
export function problemyPublikacji(d: DefinicjaFormularza): Problem[] {
  const p: Problem[] = [];
  const kroki = d.kroki;
  const zEmailem = kroki.filter((k) => k.bloki.some((b) => b.typ === "email"));
  if (zEmailem.length === 0) p.push({ tekst: "Dodaj pole e-mail do jednego z kroków. Bez niego formularz niczego nie zapisze.", wymagane: true, krokId: kroki[0].id });
  if (zEmailem.length > 1) p.push({ tekst: "Pole e-mail może być tylko w jednym kroku.", wymagane: true, krokId: zEmailem[1].id });
  const wlasciwosci = new Map<string, string>();

  kroki.forEach((k, i) => {
    const nazwa = `Krok ${i + 1}`;
    const maEmail = k.bloki.some((b) => b.typ === "email");
    if (k.bloki.filter((b) => b.typ === "email").length > 1) p.push({ tekst: `${nazwa}: dwa pola e-mail. Zostaw jedno.`, wymagane: true, krokId: k.id });
    const zgody = k.bloki.filter((b) => b.typ === "zgoda");
    if (maEmail && zgody.length === 0) p.push({ tekst: `${nazwa}: dodaj blok zgody. Bez zaznaczonej zgody nie zapiszemy adresu.`, wymagane: true, krokId: k.id });
    if (zgody.length > 1) p.push({ tekst: `${nazwa}: zgoda może być tylko jedna.`, wymagane: true, krokId: k.id, blokId: zgody[1].id });
    if (!maEmail && zgody.length) p.push({ tekst: `${nazwa}: zgoda musi stać w tym samym kroku co pole e-mail.`, wymagane: true, krokId: k.id, blokId: zgody[0].id });
    const przyciski = k.bloki.filter((b): b is BlokTypu<"przycisk"> => b.typ === "przycisk");
    const naprzod = przyciski.filter((b) => b.akcja === "wyslij" || b.akcja === "dalej");
    if (naprzod.length === 0) p.push({ tekst: `${nazwa}: dodaj przycisk, którym osoba przejdzie dalej.`, wymagane: true, krokId: k.id });
    if (maEmail && przyciski.some((b) => b.akcja === "dalej")) p.push({ tekst: `${nazwa}: w kroku z e-mailem nie ma „Przejdź dalej bez zapisu”. Zamiast pomijania daj link „Nie, dziękuję”.`, wymagane: true, krokId: k.id });
    if (maEmail && !przyciski.some((b) => b.akcja === "wyslij")) p.push({ tekst: `${nazwa}: przycisk w kroku z e-mailem musi mieć akcję „Wyślij i przejdź dalej”.`, wymagane: true, krokId: k.id });
    if (k.bloki.length === 0) p.push({ tekst: `${nazwa} jest pusty.`, wymagane: true, krokId: k.id });
    for (const b of k.bloki) problemyBloku(b, k.id, nazwa, p, wlasciwosci);
  });

  for (const b of d.sukces.bloki) problemyBloku(b, d.sukces.id, "Sukces", p, wlasciwosci);
  if (d.sukces.bloki.length === 0) p.push({ tekst: "Krok sukcesu jest pusty. Podziękuj za zapis.", wymagane: false, krokId: d.sukces.id });
  for (const b of d.sukces.bloki) {
    if (["email", "imie", "telefon", "pytanie", "zgoda"].includes(b.typ)) p.push({ tekst: "Sukces: pola nie mogą być w kroku po zapisie.", wymagane: true, krokId: d.sukces.id, blokId: b.id });
  }
  for (const k of kroki) for (const b of k.bloki) if (b.typ === "kod") p.push({ tekst: "Kod rabatowy może być tylko w kroku sukcesu (pokazujemy go po zapisie).", wymagane: true, krokId: k.id, blokId: b.id });

  if (d.typ !== "embed" && !maWyzwalacz(d.wyswietlanie)) p.push({ tekst: "Wyświetlanie: wybierz, kiedy formularz ma się pojawić.", wymagane: true });
  if (d.teaser.wlaczony && !d.teaser.tekst.trim()) p.push({ tekst: "Teaser: wpisz tekst zakładki.", wymagane: true });
  if (d.styl.obrazPozycja !== "brak" && !bezpiecznyAdres(d.styl.obraz)) p.push({ tekst: "Styl: wybierz obraz albo ustaw „bez obrazu”.", wymagane: true });
  if (!d.listaId) p.push({ tekst: "Nie wybrano listy. Osoby z formularza nie trafią na żadną listę ani do automatyzacji z wyzwalaczem „dołączenie do listy”.", wymagane: false });
  return p;
}

function problemyBloku(b: Blok, krokId: string, nazwa: string, p: Problem[], wlasciwosci: Map<string, string>): void {
  const ref = { krokId, blokId: b.id };
  switch (b.typ) {
    case "naglowek":
    case "tekst":
      if (!b.tekst.trim()) p.push({ tekst: `${nazwa}: pusty blok „${NAZWY_BLOKOW[b.typ]}”.`, wymagane: false, ...ref });
      break;
    case "obraz":
      if (!bezpiecznyAdres(b.url)) p.push({ tekst: `${nazwa}: obraz bez pliku. Wgraj obraz albo usuń blok.`, wymagane: true, ...ref });
      break;
    case "przycisk":
      if (!b.tekst.trim()) p.push({ tekst: `${nazwa}: przycisk bez tekstu.`, wymagane: true, ...ref });
      if (b.akcja === "url" && !bezpiecznyAdres(b.url)) p.push({ tekst: `${nazwa}: przycisk otwiera stronę, ale adres jest pusty albo niepoprawny.`, wymagane: true, ...ref });
      break;
    case "zgoda": {
      const t = b.tekst.trim();
      if (t.length < 20 || t.length > 2000) p.push({ tekst: `${nazwa}: treść zgody musi mieć od 20 do 2000 znaków.`, wymagane: true, ...ref });
      if (b.adresPolityki.trim() && !/^https?:\/\/[^\s<>"]+$/.test(b.adresPolityki.trim())) p.push({ tekst: `${nazwa}: adres polityki prywatności musi zaczynać się od https:// albo http://.`, wymagane: true, ...ref });
      if (!b.adresPolityki.trim()) p.push({ tekst: `${nazwa}: dodaj link do polityki prywatności sklepu.`, wymagane: false, ...ref });
      break;
    }
    case "pytanie": {
      if (!b.pytanie.trim()) p.push({ tekst: `${nazwa}: pytanie bez treści.`, wymagane: true, ...ref });
      const opcje = b.opcje.map((o) => o.trim()).filter(Boolean);
      if (opcje.length < 2) p.push({ tekst: `${nazwa}: pytanie potrzebuje co najmniej dwóch odpowiedzi.`, wymagane: true, ...ref });
      if (new Set(opcje.map((o) => o.toLowerCase())).size !== opcje.length) p.push({ tekst: `${nazwa}: odpowiedzi w pytaniu się powtarzają.`, wymagane: true, ...ref });
      if (!WZOR_WLASCIWOSCI.test(b.wlasciwosc) || ZAREZERWOWANE.has(b.wlasciwosc.toLowerCase())) {
        p.push({ tekst: `${nazwa}: nazwa właściwości profilu może mieć litery, cyfry i podkreślenie, zaczyna się od litery (np. Zainteresowania).`, wymagane: true, ...ref });
      } else if (wlasciwosci.has(b.wlasciwosc.toLowerCase())) {
        p.push({ tekst: `${nazwa}: właściwość „${b.wlasciwosc}” jest już w innym pytaniu.`, wymagane: true, ...ref });
      } else wlasciwosci.set(b.wlasciwosc.toLowerCase(), b.id);
      break;
    }
    case "kod":
      if (!b.kod.trim()) p.push({ tekst: `${nazwa}: wpisz kod rabatowy.`, wymagane: true, ...ref });
      break;
    case "nie_dziekuje":
      if (!b.tekst.trim()) p.push({ tekst: `${nazwa}: link zamknięcia bez tekstu.`, wymagane: true, ...ref });
      break;
    default:
      break;
  }
}

// ── Konwersja starego popupu (sprzed 0043) ───────────────────────────────────

export interface PopupStary {
  headline: string;
  body_text: string;
  button_text: string;
  discount_code: string | null;
  rules: { delay_seconds?: number } | null;
  consent_wording: string | null;
  consent_privacy_url: string | null;
  list_id: string | null;
}

/**
 * Stary popup jako formularz jednokrokowy. Identyfikatory są STAŁE (nie losowe), bo
 * skrypt buduje tę definicję przy każdym żądaniu, a zgłoszenie odsyła identyfikator kroku.
 * Wygląd jak dotąd (ciemna karta 380 px), żeby po wdrożeniu nic się u klienta nie zmieniło.
 */
export function zPopupuStarego(p: PopupStary): DefinicjaFormularza {
  const delay = Math.min(Math.max(Math.round(Number(p.rules?.delay_seconds ?? 0)) || 0, 0), 600);
  const sukces: Blok[] = [
    { id: "s-naglowek", typ: "naglowek", tekst: "Dziękujemy!", rozmiar: 20 },
    { id: "s-tekst", typ: "tekst", tekst: p.discount_code ? "Twój kod rabatowy:" : "Zapisano Twój adres." },
  ];
  if (p.discount_code) sukces.push({ id: "s-kod", typ: "kod", kod: p.discount_code, opis: "" });
  return {
    wersjaModelu: WERSJA_MODELU,
    typ: "popup",
    styl: { ...STYL_DOMYSLNY, szerokosc: 380, tlo: "#101218", kolorTekstu: "#e7e9f0", kolorPrzycisku: "#3d55a8", kolorTekstuPrzycisku: "#ffffff", kroj: "strona", zaokraglenie: 12, wyrownanie: "lewo", nakladka: 66 },
    kroki: [
      {
        id: "k-1",
        nazwa: "Zapis",
        bloki: [
          { id: "b-naglowek", typ: "naglowek", tekst: p.headline, rozmiar: 20 },
          { id: "b-tekst", typ: "tekst", tekst: p.body_text },
          { id: "b-email", typ: "email", etykieta: "Adres e-mail", placeholder: "Twój adres e-mail" },
          { id: "b-zgoda", typ: "zgoda", tekst: p.consent_wording ?? "", adresPolityki: p.consent_privacy_url ?? "" },
          { id: "b-przycisk", typ: "przycisk", tekst: p.button_text, akcja: "wyslij", url: "" },
        ],
      },
    ],
    sukces: { id: "k-sukces", nazwa: "Sukces", bloki: sukces },
    teaser: { wlaczony: false, tekst: "" },
    wyswietlanie: { ...REGULY_DOMYSLNE, poSekundach: delay, komu: "wszyscy", poZamknieciuDni: 7, poZapisieNigdy: true },
    listaId: p.list_id,
  };
}

/**
 * Stare kolumny popupu wyliczone z definicji: publikacja wypełnia je, żeby stary kod po
 * rollbacku dalej pokazał sensowny jednokrokowy popup (nagłówek, tekst, przycisk, kod).
 */
export function kolumnyZgodnosci(d: DefinicjaFormularza): { headline: string; body_text: string; button_text: string; discount_code: string | null; delay_seconds: number } {
  const wszystkie = d.kroki.flatMap((k) => k.bloki);
  const kEmail = d.kroki[Math.max(indeksKrokuEmail(d), 0)].bloki;
  const tekstBloku = (bl: Blok[], typ: "naglowek" | "tekst") => (bl.find((b) => b.typ === typ) as { tekst: string } | undefined)?.tekst?.trim();
  const przycisk = (kEmail.find((b) => b.typ === "przycisk" && b.akcja === "wyslij") as BlokTypu<"przycisk"> | undefined)?.tekst?.trim();
  const kod = (d.sukces.bloki.find((b) => b.typ === "kod") as BlokTypu<"kod"> | undefined)?.kod?.trim();
  return {
    headline: (tekstBloku(kEmail, "naglowek") || tekstBloku(wszystkie, "naglowek") || "Zapisz się").slice(0, 200),
    body_text: (tekstBloku(kEmail, "tekst") || tekstBloku(wszystkie, "tekst") || "Zostaw adres e-mail.").slice(0, 1000),
    button_text: (przycisk || "Zapisz się").slice(0, 80),
    discount_code: kod ? kod.slice(0, 60) : null,
    delay_seconds: d.wyswietlanie.poSekundach ?? 0,
  };
}

/**
 * Wersja definicji, która idzie do przeglądarki: bez kodów rabatowych (dostaje się je
 * dopiero w odpowiedzi na zapis), bez listy docelowej, z tekstem zgody podmienionym na
 * tekst BIEŻĄCEJ wersji klauzuli z bazy (dowód = to, co pokazano).
 */
export function definicjaPubliczna(d: DefinicjaFormularza, zgoda: { tekst: string; adres: string | null }): Omit<DefinicjaFormularza, "listaId"> {
  const kroki = d.kroki.map((k) => ({
    ...k,
    bloki: k.bloki.map((b): Blok => (b.typ === "zgoda" ? { ...b, tekst: zgoda.tekst, adresPolityki: zgoda.adres ?? "" } : b)),
  }));
  const sukces = { ...d.sukces, bloki: d.sukces.bloki.map((b): Blok => (b.typ === "kod" ? { ...b, kod: "" } : b)) };
  const { listaId: _pominieta, ...reszta } = d;
  void _pominieta;
  return { ...reszta, kroki, sukces };
}

/** Kody rabatowe z kroku sukcesu: oddawane w odpowiedzi na zapis (id bloku → kod). */
export function kodyZDefinicji(d: DefinicjaFormularza): Record<string, string> {
  const w: Record<string, string> = {};
  for (const b of d.sukces.bloki) if (b.typ === "kod" && b.kod.trim()) w[b.id] = b.kod.trim();
  return w;
}

/** Klucze właściwości i dozwolone odpowiedzi z pytań: serwer przyjmuje TYLKO je. */
export function pytaniaDefinicji(d: DefinicjaFormularza): Map<string, { opcje: Set<string>; wielokrotny: boolean }> {
  const m = new Map<string, { opcje: Set<string>; wielokrotny: boolean }>();
  for (const k of d.kroki) for (const b of k.bloki) {
    if (b.typ === "pytanie" && WZOR_WLASCIWOSCI.test(b.wlasciwosc)) {
      m.set(b.wlasciwosc, { opcje: new Set(b.opcje.map((o) => o.trim()).filter(Boolean)), wielokrotny: b.wielokrotny });
    }
  }
  return m;
}

/** Wczytanie z bazy: poprawna definicja albo null (uszkodzony JSON nie wywraca strony). */
export function wczytajDefinicje(surowa: unknown): DefinicjaFormularza | null {
  const w = schematDefinicji.safeParse(surowa);
  return w.success ? w.data : null;
}

/** Czy builder ma coś niepublikowanego (porównanie kanoniczne JSON). */
export function rozneDefinicje(a: DefinicjaFormularza | null, b: DefinicjaFormularza | null): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export type { RegulyWyswietlania };
