import { nowyBlok, pustyDokument } from "./fabryka";
import type { Blok, BlokTypu, DokumentMaila, TypBloku } from "./schemat";

/**
 * Szablony startowe. To są zwykłe dokumenty bloków — po wybraniu operator edytuje je
 * dokładnie tak samo jak treść zbudowaną od zera. Obrazy są celowo puste: płótno pokazuje
 * w ich miejscu „wstaw adres obrazu", a render pomija obraz bez adresu, więc szablon
 * nie wyśle nikomu cudzego zdjęcia ani obrazka z zewnętrznego serwisu zastępczego.
 */
export type IdSzablonu = "pusty" | "newsletter" | "promocja" | "powitanie";

export interface Szablon {
  id: IdSzablonu;
  nazwa: string;
  opis: string;
  /** struktura do miniatury: kolejność typów bloków */
  zbuduj: () => DokumentMaila;
}

function b<T extends TypBloku>(typ: T, zmiany: Partial<BlokTypu<T>> = {}): Blok {
  return { ...nowyBlok(typ), ...zmiany } as Blok;
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
    zbuduj: () =>
      dokument([
        b("naglowek"),
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
    zbuduj: () =>
      dokument(
        [
          b("naglowek", { tlo: "#111111", nazwa: "Twój sklep", boki: 24 }),
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
    zbuduj: () =>
      dokument([
        b("naglowek"),
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
