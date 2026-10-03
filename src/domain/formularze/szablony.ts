import {
  domyslnaZgoda,
  noweId,
  STYL_DOMYSLNY,
  WERSJA_MODELU,
  type Blok,
  type DefinicjaFormularza,
  type StylFormularza,
  type TypFormularza,
} from "./model";
import { REGULY_DOMYSLNE } from "./wyswietlanie";

/**
 * Szablony startowe (galeria „Nowy formularz”, jak w Klaviyo). Każdy jest gotowy do
 * publikacji po wpisaniu linku do polityki prywatności: ma pole e-mail, zgodę w tym samym
 * kroku, przycisk „Wyślij” i krok sukcesu. Identyfikatory są losowe przy każdym użyciu.
 */

export type IdSzablonu = "rabat" | "newsletter" | "email-telefon" | "zainteresowania" | "pusty";

export interface Szablon {
  id: IdSzablonu;
  nazwa: string;
  opis: string;
  /** krótko, co jest w środku: „2 kroki · e-mail → telefon” */
  sklad: string;
  typ: TypFormularza;
  zbuduj: (firma: string, styl: StylFormularza) => DefinicjaFormularza;
}

const b = {
  naglowek: (tekst: string, rozmiar = 28): Blok => ({ id: noweId("b"), typ: "naglowek", tekst, rozmiar }),
  tekst: (tekst: string): Blok => ({ id: noweId("b"), typ: "tekst", tekst }),
  email: (): Blok => ({ id: noweId("b"), typ: "email", etykieta: "Adres e-mail", placeholder: "Twój adres e-mail" }),
  imie: (): Blok => ({ id: noweId("b"), typ: "imie", etykieta: "Imię", placeholder: "Imię (opcjonalnie)", wymagane: false }),
  telefon: (): Blok => ({ id: noweId("b"), typ: "telefon", etykieta: "Telefon", placeholder: "Numer telefonu", wymagane: true }),
  zgoda: (firma: string): Blok => ({ id: noweId("b"), typ: "zgoda", tekst: domyslnaZgoda(firma), adresPolityki: "" }),
  przycisk: (tekst: string, akcja: "wyslij" | "dalej" | "zamknij" = "wyslij"): Blok => ({ id: noweId("b"), typ: "przycisk", tekst, akcja, url: "" }),
  nie: (tekst = "Nie, dziękuję"): Blok => ({ id: noweId("b"), typ: "nie_dziekuje", tekst }),
  kod: (kod: string): Blok => ({ id: noweId("b"), typ: "kod", kod, opis: "Skopiuj kod i użyj go w koszyku" }),
};

function definicja(typ: TypFormularza, styl: StylFormularza, kroki: { nazwa: string; bloki: Blok[] }[], sukces: Blok[], teaser = ""): DefinicjaFormularza {
  return {
    wersjaModelu: WERSJA_MODELU,
    typ,
    styl,
    kroki: kroki.map((k) => ({ id: noweId("k"), nazwa: k.nazwa, bloki: k.bloki })),
    sukces: { id: noweId("k"), nazwa: "Sukces", bloki: sukces },
    teaser: { wlaczony: Boolean(teaser) && typ !== "embed", tekst: teaser },
    wyswietlanie: { ...REGULY_DOMYSLNE },
    listaId: null,
  };
}

export const SZABLONY: Szablon[] = [
  {
    id: "rabat",
    nazwa: "Rabat za zapis",
    opis: "Klasyk: -10% na pierwsze zakupy w zamian za adres. Kod pokazujemy dopiero po zapisie.",
    sklad: "1 krok · kod na sukcesie · teaser",
    typ: "popup",
    zbuduj: (firma, styl) =>
      definicja(
        "popup",
        styl,
        [{ nazwa: "Zapis", bloki: [b.naglowek("-10% na pierwsze zakupy", 32), b.tekst("Zapisz się na newsletter i odbierz kod rabatowy. Raz w tygodniu nowości i promocje tylko dla subskrybentów."), b.email(), b.zgoda(firma), b.przycisk("Odbieram rabat"), b.nie()] }],
        [b.naglowek("Gotowe! Oto Twój kod", 26), b.kod("WITAJ10"), b.tekst("Kod działa przy pierwszym zamówieniu."), b.przycisk("Wracam do zakupów", "zamknij")],
        "-10% na start",
      ),
  },
  {
    id: "newsletter",
    nazwa: "Newsletter",
    opis: "Spokojny zapis na nowości, bez rabatu. Dobrze działa jako formularz osadzony w stopce.",
    sklad: "1 krok · imię i e-mail",
    typ: "flyout",
    zbuduj: (firma, styl) =>
      definicja(
        "flyout",
        { ...styl, szerokosc: 380 },
        [{ nazwa: "Zapis", bloki: [b.naglowek("Bądź na bieżąco", 24), b.tekst("Nowości, porady i zapowiedzi promocji. Bez spamu, wypiszesz się jednym kliknięciem."), b.imie(), b.email(), b.zgoda(firma), b.przycisk("Zapisuję się")] }],
        [b.naglowek("Dziękujemy!", 24), b.tekst("Pierwszy mail już do Ciebie leci."), b.przycisk("Zamknij", "zamknij")],
      ),
  },
  {
    id: "email-telefon",
    nazwa: "Dwa kroki: e-mail → telefon",
    opis: "Najpierw e-mail i zgoda, potem prośba o telefon. Adres zapisujemy od razu, nawet gdy ktoś pominie drugi krok.",
    sklad: "2 kroki · zapis cząstkowy",
    typ: "popup",
    zbuduj: (firma, styl) =>
      definicja(
        "popup",
        { ...styl, obrazPozycja: "brak" },
        [
          { nazwa: "E-mail", bloki: [b.naglowek("-15% na pierwsze zamówienie", 30), b.tekst("Zostaw adres, a kod rabatowy pokażemy od razu."), b.email(), b.zgoda(firma), b.przycisk("Dalej"), b.nie()] },
          { nazwa: "Telefon", bloki: [b.naglowek("Jeszcze jedno", 26), b.tekst("Podaj telefon, a damy znać o dostawie i wyprzedażach przed innymi."), b.telefon(), b.przycisk("Odbieram kod"), b.przycisk("Pomiń", "dalej")] },
        ],
        [b.naglowek("Twój kod: -15%", 26), b.kod("START15"), b.przycisk("Wracam do zakupów", "zamknij")],
        "-15% na start",
      ),
  },
  {
    id: "zainteresowania",
    nazwa: "Pytanie o zainteresowania",
    opis: "Najpierw jedno pytanie, potem e-mail. Odpowiedź trafia do właściwości profilu, po której zrobisz segment.",
    sklad: "2 kroki · pytanie → e-mail",
    typ: "popup",
    zbuduj: (firma, styl) =>
      definicja(
        "popup",
        styl,
        [
          {
            nazwa: "Pytanie",
            bloki: [
              b.naglowek("Czego szukasz?", 28),
              b.tekst("Dopasujemy maile do tego, co Cię interesuje."),
              { id: noweId("b"), typ: "pytanie", pytanie: "Wybierz, co lubisz", wlasciwosc: "Zainteresowania", opcje: ["Nowości", "Promocje", "Porady", "Zestawy prezentowe"], wielokrotny: true, wymagane: true },
              b.przycisk("Dalej"),
              b.nie(),
            ],
          },
          { nazwa: "E-mail", bloki: [b.naglowek("Gdzie wysłać?", 28), b.email(), b.zgoda(firma), b.przycisk("Zapisuję się")] },
        ],
        [b.naglowek("Dziękujemy!", 26), b.tekst("Pierwsze propozycje już wkrótce w Twojej skrzynce."), b.przycisk("Zamknij", "zamknij")],
      ),
  },
  {
    id: "pusty",
    nazwa: "Pusty formularz",
    opis: "Sam e-mail, zgoda i przycisk. Resztę ułożysz z bloków.",
    sklad: "1 krok",
    typ: "popup",
    zbuduj: (firma, styl) =>
      definicja("popup", styl, [{ nazwa: "Zapis", bloki: [b.naglowek("Zapisz się", 28), b.email(), b.zgoda(firma), b.przycisk("Zapisz się")] }], [b.naglowek("Dziękujemy!", 26), b.przycisk("Zamknij", "zamknij")]),
  },
];

export function szablon(id: string): Szablon | null {
  return SZABLONY.find((s) => s.id === id) ?? null;
}

export { STYL_DOMYSLNY };
