import { z } from "zod";

/**
 * Reguły wyświetlania formularza (zakładka „Wyświetlanie” w builderze), wzorowane na
 * Klaviyo „Targeting & Behaviors”: KIEDY (wyzwalacze, dowolny z zaznaczonych), KOMU,
 * GDZIE (adres strony), NA JAKICH URZĄDZENIACH i JAK CZĘSTO.
 *
 * `czyPokazac` to czysta funkcja i jedyne źródło tej logiki: skrypt na stronie sklepu
 * (/s/{tenant}) dostaje jej tekst przez `Function.prototype.toString()`, więc builder,
 * testy i przeglądarka klienta liczą to samo. Dlatego funkcja nie może sięgać do niczego
 * spoza własnego ciała (żadnych importów, stałych modułu, helperów).
 */

export type KomuPokazac = "wszyscy" | "nie_subskrybenci" | "nowi";
export type Urzadzenia = "wszystkie" | "komputer" | "telefon";

export interface RegulyWyswietlania {
  /** pokaż po tylu sekundach od wejścia na stronę; null = wyzwalacz wyłączony */
  poSekundach: number | null;
  /** pokaż po przewinięciu tylu procent strony; null = wyłączony */
  poPrzewinieciu: number | null;
  /** pokaż przy próbie wyjścia (kursor wyjeżdża nad pasek przeglądarki; tylko komputer) */
  przyWyjsciu: boolean;
  /** pokaż po kliknięciu elementu pasującego do selektora (np. a[href="#newsletter"]); null = wyłączony */
  poKliknieciu: string | null;
  komu: KomuPokazac;
  /** adres strony zawiera którykolwiek z napisów (pusta lista = wszystkie strony) */
  adresZawiera: string[];
  /** adres strony zawiera którykolwiek z napisów = nie pokazuj */
  adresWyklucz: string[];
  urzadzenia: Urzadzenia;
  /** po zamknięciu nie pokazuj ponownie przez tyle dni (0 = przy następnej odsłonie strony) */
  poZamknieciuDni: number;
  /** po zapisie przez ten formularz nie pokazuj go już nigdy */
  poZapisieNigdy: boolean;
}

/** Stan przeglądarki, który skrypt zbiera sam (localStorage, matchMedia, location). */
export interface KontekstWyswietlania {
  /** pełny adres bieżącej strony */
  adres: string;
  telefon: boolean;
  /** osoba zapisała się przez DOWOLNY formularz tego sklepu (znacznik w localStorage) */
  zapisany: boolean;
  /** osoba zapisała się przez TEN formularz */
  zapisanyTutaj: boolean;
  /** pierwsza wizyta: pierwsze wejście na stronę sklepu w ciągu ostatnich 30 minut */
  nowy: boolean;
  /** kiedy osoba zamknęła ten formularz (ms od epoki); null = nie zamykała */
  zamknietoMs: number | null;
  terazMs: number;
}

export const REGULY_DOMYSLNE: RegulyWyswietlania = {
  poSekundach: 5,
  poPrzewinieciu: null,
  przyWyjsciu: false,
  poKliknieciu: null,
  komu: "nie_subskrybenci",
  adresZawiera: [],
  adresWyklucz: [],
  urzadzenia: "wszystkie",
  poZamknieciuDni: 7,
  poZapisieNigdy: true,
};

const fraza = z.string().trim().min(1).max(200);

export const schematRegul = z.object({
  poSekundach: z.number().int().min(0).max(600).nullable(),
  poPrzewinieciu: z.number().int().min(1).max(100).nullable(),
  przyWyjsciu: z.boolean(),
  poKliknieciu: z.string().trim().min(1).max(200).nullable(),
  komu: z.enum(["wszyscy", "nie_subskrybenci", "nowi"]),
  adresZawiera: z.array(fraza).max(20),
  adresWyklucz: z.array(fraza).max(20),
  urzadzenia: z.enum(["wszystkie", "komputer", "telefon"]),
  poZamknieciuDni: z.number().int().min(0).max(365),
  poZapisieNigdy: z.boolean(),
});

/**
 * Czy formularz może się pokazać tej osobie na tej stronie (bez wyzwalacza: wyzwalacz
 * decyduje KIEDY, ta funkcja CZY w ogóle). Samowystarczalna: patrz komentarz na górze.
 */
export function czyPokazac(r: RegulyWyswietlania, k: KontekstWyswietlania): boolean {
  if (r.urzadzenia === "komputer" && k.telefon) return false;
  if (r.urzadzenia === "telefon" && !k.telefon) return false;
  if (r.komu === "nie_subskrybenci" && k.zapisany) return false;
  if (r.komu === "nowi" && (!k.nowy || k.zapisany)) return false;
  if (r.poZapisieNigdy && k.zapisanyTutaj) return false;
  if (k.zamknietoMs !== null && k.zamknietoMs > 0) {
    var dni = r.poZamknieciuDni;
    if (dni > 0 && k.terazMs - k.zamknietoMs < dni * 86400000) return false;
  }
  var adres = String(k.adres || "").toLowerCase();
  var i;
  for (i = 0; i < r.adresWyklucz.length; i++) {
    if (r.adresWyklucz[i] && adres.indexOf(String(r.adresWyklucz[i]).toLowerCase()) !== -1) return false;
  }
  if (r.adresZawiera.length) {
    var pasuje = false;
    for (i = 0; i < r.adresZawiera.length; i++) {
      if (r.adresZawiera[i] && adres.indexOf(String(r.adresZawiera[i]).toLowerCase()) !== -1) pasuje = true;
    }
    if (!pasuje) return false;
  }
  return true;
}

/** Czy jest choć jeden wyzwalacz (dla popupu i wysuwanego; osadzony nie potrzebuje). */
export function maWyzwalacz(r: RegulyWyswietlania): boolean {
  return r.poSekundach !== null || r.poPrzewinieciu !== null || r.przyWyjsciu || r.poKliknieciu !== null;
}

function lista(slowa: string[]): string {
  const w = slowa.map((s) => `„${s}”`);
  if (w.length <= 1) return w.join("");
  return `${w.slice(0, -1).join(", ")} lub ${w[w.length - 1]}`;
}

/** Jedno zdanie po polsku, jak w podsumowaniu Klaviyo: „Pokaż nowym osobom na telefonie, po 5 s…”. */
export function opisRegul(r: RegulyWyswietlania, typ: "popup" | "flyout" | "embed"): string {
  if (typ === "embed") {
    const gdzie = r.adresZawiera.length ? `na stronach z ${lista(r.adresZawiera)} w adresie` : "wszędzie tam, gdzie wkleisz znacznik formularza";
    return `Formularz osadzony jest zawsze widoczny ${gdzie}.`;
  }
  const komu = r.komu === "wszyscy" ? "wszystkim" : r.komu === "nowi" ? "osobom przy pierwszej wizycie" : "osobom, które jeszcze się nie zapisały";
  const urz = r.urzadzenia === "komputer" ? " na komputerze" : r.urzadzenia === "telefon" ? " na telefonie" : "";
  const kiedy: string[] = [];
  if (r.poSekundach !== null) kiedy.push(r.poSekundach === 0 ? "od razu" : `po ${r.poSekundach} s`);
  if (r.poPrzewinieciu !== null) kiedy.push(`po przewinięciu ${r.poPrzewinieciu}% strony`);
  if (r.przyWyjsciu) kiedy.push("przy próbie wyjścia");
  if (r.poKliknieciu !== null) kiedy.push("po kliknięciu przycisku na stronie");
  const kiedyTekst = kiedy.length ? kiedy.join(" albo ") : "nigdy (wybierz, kiedy ma się pojawić)";
  const gdzie = r.adresZawiera.length ? `, na stronach z ${lista(r.adresZawiera)} w adresie` : "";
  const bez = r.adresWyklucz.length ? `, poza stronami z ${lista(r.adresWyklucz)}` : "";
  const czesto = r.poZamknieciuDni > 0 ? `Po zamknięciu wróci za ${r.poZamknieciuDni} ${r.poZamknieciuDni === 1 ? "dzień" : "dni"}` : "Po zamknięciu wróci przy kolejnej odsłonie";
  const zapis = r.poZapisieNigdy ? ", po zapisie już nigdy." : ".";
  return `Pokaż ${komu}${urz}${gdzie}${bez}: ${kiedyTekst}. ${czesto}${zapis}`;
}
