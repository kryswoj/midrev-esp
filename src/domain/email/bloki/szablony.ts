import { nowyBlok, pustyDokument, type DaneKonta } from "./fabryka";
import { odkodujEncje } from "./bezpieczenstwo";
import type { Blok, BlokTypu, DokumentMaila, TypBloku } from "./schemat";

/**
 * Szablony startowe. To są zwykłe dokumenty bloków — po wybraniu operator edytuje je
 * dokładnie tak samo jak treść zbudowaną od zera. Obrazy są celowo puste: płótno pokazuje
 * w ich miejscu „wstaw adres obrazu", a render pomija obraz bez adresu, więc szablon
 * nie wyśle nikomu cudzego zdjęcia ani obrazka z zewnętrznego serwisu zastępczego.
 *
 * Nagłówek bierze nazwę sklepu z konta (`DaneKonta`), stopka nie zawiera adresu: dane
 * firmy dokleja silnik wysyłki z ustawień konta pod każdym mailem. Szablon nigdy nie
 * wstawia przykładowej nazwy firmy ani adresu (audyt UX 02.10, P0-2).
 */
export type IdSzablonu = "pusty" | "newsletter" | "promocja" | "powitanie";

export interface Szablon {
  id: IdSzablonu;
  nazwa: string;
  opis: string;
  /** struktura do miniatury: kolejność typów bloków; `konto` wypełnia nagłówek nazwą sklepu */
  zbuduj: (konto?: DaneKonta) => DokumentMaila;
}

function b<T extends TypBloku>(typ: T, zmiany: Partial<BlokTypu<T>> = {}, konto?: DaneKonta): Blok {
  return { ...nowyBlok(typ, konto), ...zmiany } as Blok;
}

function dokument(bloki: Blok[], style: Partial<DokumentMaila["style"]> = {}): DokumentMaila {
  const d = pustyDokument();
  d.bloki = bloki;
  d.style = { ...d.style, ...style };
  return d;
}

export const SZABLONY: Szablon[] = [
  {
    id: "pusty",
    nazwa: "Pusty",
    opis: "Zaczynasz od zera i układasz bloki sam.",
    zbuduj: () => pustyDokument(),
  },
  {
    id: "newsletter",
    nazwa: "Newsletter",
    opis: "Logo, główny artykuł, dwie zapowiedzi i stopka.",
    zbuduj: (konto) =>
      dokument([
        b("naglowek", {}, konto),
        b("obraz", { alt: "Zdjęcie główne" }),
        b("tekst", { wariant: "h1", html: "Co nowego w tym miesiącu", gora: 28, dol: 4 }),
        b("tekst", { html: "Krótko o tym, co przygotowaliśmy. Dwa, trzy zdania, które zachęcą do czytania dalej — bez lania wody." }),
        b("przycisk", { tekst: "Czytaj dalej" }),
        b("separator", { gora: 20, dol: 20 }),
        b("kolumny", {
          lewa: { obrazUrl: "", obrazAlt: "", html: "<b>Poradnik</b><br>Jak dobrać produkt do swoich potrzeb.", przyciskTekst: "Przeczytaj", przyciskLink: "" },
          prawa: { obrazUrl: "", obrazAlt: "", html: "<b>Nowość</b><br>Poznaj produkt, o który pytaliście.", przyciskTekst: "Zobacz", przyciskLink: "" },
        }),
        b("social", { gora: 28 }),
        b("stopka"),
      ]),
  },
  {
    id: "promocja",
    nazwa: "Promocja / wyprzedaż",
    opis: "Mocny nagłówek, kod rabatowy, produkty i jeden przycisk.",
    zbuduj: (konto) =>
      dokument(
        [
          b("naglowek", { tlo: "#111111", boki: 24 }, konto),
          b("tekst", { wariant: "h1", html: "−30% na wszystko. Tylko do niedzieli.", wyrownanie: "center", gora: 36, dol: 4 }),
          b("tekst", { html: "Największa wyprzedaż sezonu. Rabat naliczy się w koszyku po wpisaniu kodu.", wyrownanie: "center", dol: 8 }),
          b("kod", { kod: "WYPRZEDAZ30", tytul: "Kod na −30%", opis: "Ważny do niedzieli do północy." }),
          b("przycisk", { tekst: "Idę na zakupy", rozmiar: "duzy" }),
          b("separator", { gora: 24, dol: 8 }),
          b("produkt", { nazwa: "Bestseller", cena: "89,00 zł", cenaPrzed: "129,00 zł" }),
          b("produkt", { nazwa: "Nowość sezonu", cena: "139,00 zł", cenaPrzed: "199,00 zł" }),
          b("stopka"),
        ],
        { kolorMarki: "#d92d20" },
      ),
  },
  {
    id: "powitanie",
    nazwa: "Powitanie",
    opis: "Pierwszy mail po zapisie: kim jesteście i kod na start.",
    zbuduj: (konto) =>
      dokument([
        b("naglowek", {}, konto),
        b("obraz", { alt: "Witamy" }),
        b("tekst", { wariant: "h1", html: "Dzień dobry, cieszymy się, że jesteś", wyrownanie: "center", gora: 28, dol: 4 }),
        b("tekst", { html: "Dziękujemy za zapis. Będziemy pisać rzadko i konkretnie: nowości, porady i oferty tylko dla subskrybentów.", wyrownanie: "center" }),
        b("kod", { tytul: "Na dobry początek −10%", kod: "WITAJ10", opis: "Kod działa na pierwsze zamówienie." }),
        b("przycisk", { tekst: "Zacznij zakupy" }),
        b("social", { gora: 24 }),
        b("stopka"),
      ]),
  },
];

export function szablon(id: string): Szablon | undefined {
  return SZABLONY.find((s) => s.id === id);
}

/**
 * Przykładowe dane firmy z dawnych szablonów (przed 02.10.2026): szkice zbudowane wtedy
 * dalej je mają. Mail z „ul. Przykładowa 1" podaje odbiorcy fałszywy adres nadawcy, więc
 * lista kontrolna traktuje to jako brak do poprawy, a płótno pokazuje ostrzeżenie w bloku.
 */
const WZORY_PRZYKLADOW: { wzor: RegExp; opis: string }[] = [
  { wzor: /ul\.\s*Przyk(?:ł|l)adowa\s*1/i, opis: "przykładowy adres „ul. Przykładowa 1”" },
  { wzor: /00-001\s+Warszawa/i, opis: "przykładowy kod i miasto „00-001 Warszawa”" },
  { wzor: /Tw(?:ó|o)j sklep sp\. z o\.o\./i, opis: "przykładowa firma „Twój sklep sp. z o.o.”" },
];

/** Opisy przykładowych danych w bloku (pusta tablica = blok czysty). */
export function przykladyWBloku(blok: Blok): string[] {
  const teksty: string[] = [];
  if (blok.typ === "naglowek") {
    if (!blok.logoUrl.trim() && /^tw(?:ó|o)j sklep$/i.test(blok.nazwa.trim())) teksty.push("przykładowa nazwa „Twój sklep” w nagłówku");
    return teksty;
  }
  const html = blok.typ === "stopka" || blok.typ === "tekst" || blok.typ === "html" ? blok.html : blok.typ === "kolumny" ? `${blok.lewa.html} ${blok.prawa.html}` : "";
  return przykladyWHtml(html);
}

// Polskie litery zapisane encjami nazwanymi (stare edytory i wklejki z Worda): odkodujEncje
// zna tylko podstawowe, a „Tw&oacute;j sklep" odbiorca i tak przeczyta jako „Twój sklep".
const ENCJE_PL: Record<string, string> = { oacute: "ó", Oacute: "Ó", lstrok: "ł", Lstrok: "Ł" };

/** Tekst widoczny dla odbiorcy: bez znaczników, z odkodowanymi encjami, spacje zwinięte. */
function tekstWidoczny(html: string): string {
  // treść <style>, <script>, <head> i komentarzy nie trafia do oczu odbiorcy
  const bezNiewidocznych = html
    // niedomknięty komentarz albo <style> pochłania w przeglądarce resztę dokumentu: też niewidoczne
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(style|script|head|title)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  return odkodujEncje(bezNiewidocznych.replace(/<[^>]*>/g, " ").replace(/&(oacute|Oacute|lstrok|Lstrok);/g, (_c, n: string) => ENCJE_PL[n] ?? ""))
    .replace(/\s+/g, " ");
}

/**
 * Przykładowe dane w dowolnym HTML-u (także w kampanii zapisanej jako sam `content.html`,
 * bez bloków): lista kontrolna serwera sprawdza tak każdą kampanię, nie tylko blokową.
 */
export function przykladyWHtml(html: string): string[] {
  const tekst = tekstWidoczny(html);
  return WZORY_PRZYKLADOW.filter((p) => p.wzor.test(tekst)).map((p) => p.opis);
}

/** Wszystkie przykładowe dane w dokumencie, bez powtórzeń. */
export function przykladoweDane(dokument: DokumentMaila): string[] {
  return [...new Set(dokument.bloki.flatMap(przykladyWBloku))];
}
