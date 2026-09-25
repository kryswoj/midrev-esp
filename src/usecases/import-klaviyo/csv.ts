/**
 * Strumieniowy parser CSV zgodny z RFC 4180, bez zaleznosci.
 *
 * Czyta plik kawalkami (Buffer albo string) i oddaje rekord po rekordzie, wiec plik
 * 50 MB nigdy nie laduje w pamieci w calosci. Obsluguje: BOM na poczatku, pola w
 * cudzyslowach z przecinkami i lamaniem linii w srodku, podwojony cudzyslow jako
 * literalny cudzyslow, konce linii CRLF, LF i samotny CR. Separator domyslnie przecinek,
 * a gdy naglowek ma wiecej srednikow niz przecinkow - srednik (eksport z polskiego Excela).
 *
 * Kazdy rekord niesie numer LINII, w ktorej sie zaczyna: to numer, ktory operator
 * zobaczy w raporcie bledow i ktory znajdzie w swoim pliku.
 *
 * Limity sa twarde, bo plik przychodzi od uzytkownika: pole dluzsze niz MAKS_POLE albo
 * rekord z wieksza liczba kolumn niz MAKS_KOLUMN konczy sie bledem tego rekordu, nie
 * zjedzeniem pamieci procesu.
 */

export const MAKS_POLE = 4096;
export const MAKS_KOLUMN = 500;

export interface RekordCsv {
  /** numer linii pliku (1 = pierwsza), w ktorej rekord sie zaczyna */
  linia: number;
  pola: string[];
  /** blad strukturalny rekordu; pola sa wtedy niekompletne i rekord nalezy pominac */
  blad?: string;
}

export interface OpcjeCsv {
  separator?: "," | ";" | "\t";
}

function wykryjSeparator(pierwszaLinia: string): "," | ";" | "\t" {
  const przecinki = (pierwszaLinia.match(/,/g) ?? []).length;
  const sredniki = (pierwszaLinia.match(/;/g) ?? []).length;
  const tabulatory = (pierwszaLinia.match(/\t/g) ?? []).length;
  if (tabulatory > przecinki && tabulatory > sredniki) return "\t";
  return sredniki > przecinki ? ";" : ",";
}

/**
 * Generator rekordow. `zrodlo` to dowolne AsyncIterable kawalkow (fs.createReadStream,
 * Readable.from, cialo zadania HTTP). Dekodowanie UTF-8 idzie przez TextDecoder w
 * trybie strumieniowym, wiec znak wielobajtowy przeciety granica kawalka nie psuje sie.
 */
export async function* czytajCsv(
  zrodlo: AsyncIterable<Uint8Array | string>,
  opcje: OpcjeCsv = {},
): AsyncGenerator<RekordCsv> {
  const dekoder = new TextDecoder("utf-8");
  let separator: string | null = opcje.separator ?? null;

  let pola: string[] = [];
  let pole = "";
  let wCudzyslowie = false;
  // czy poprzedni znak w cudzyslowie byl cudzyslowem (kandydat na "" albo koniec pola)
  let poCudzyslowie = false;
  let liniaBiezaca = 1;
  let liniaRekordu = 1;
  let rekordPusty = true; // rekord bez zadnego znaku poza koncem linii = pusta linia
  let bladRekordu: string | undefined;
  let poprzedniCR = false;
  let pierwszyKawalek = true;
  // bufor pierwszej linii do wykrycia separatora, gdy nie podano go jawnie
  let buforNaglowka = "";
  let naglowekRozstrzygniety = separator !== null;

  const domknijPole = () => {
    if (pola.length < MAKS_KOLUMN) {
      pola.push(pole);
    } else if (!bladRekordu) {
      bladRekordu = `za dużo kolumn (limit ${MAKS_KOLUMN})`;
    }
    pole = "";
  };

  const domknijRekord = (): RekordCsv | null => {
    domknijPole();
    const gotowy: RekordCsv | null = rekordPusty
      ? null
      : { linia: liniaRekordu, pola, ...(bladRekordu ? { blad: bladRekordu } : {}) };
    pola = [];
    bladRekordu = undefined;
    rekordPusty = true;
    liniaRekordu = liniaBiezaca;
    return gotowy;
  };

  const przetworzTekst = function* (tekst: string): Generator<RekordCsv> {
    for (let i = 0; i < tekst.length; i += 1) {
      const z = tekst[i];

      if (poprzedniCR && z === "\n") {
        // CRLF: LF domyka to, co CR juz zaczal - bez drugiego rekordu
        poprzedniCR = false;
        continue;
      }
      poprzedniCR = false;

      if (wCudzyslowie) {
        if (poCudzyslowie) {
          poCudzyslowie = false;
          if (z === '"') {
            // "" wewnatrz pola = literalny cudzyslow
            if (pole.length < MAKS_POLE) pole += '"';
            else if (!bladRekordu) bladRekordu = `pole dłuższe niż ${MAKS_POLE} znaków`;
            continue;
          }
          // cudzyslow zamykajacy pole; znak biezacy obslugujemy juz jako zwykly tekst
          wCudzyslowie = false;
        } else {
          if (z === '"') {
            poCudzyslowie = true;
            continue;
          }
          if (z === "\n" || z === "\r") {
            liniaBiezaca += z === "\n" || tekst[i + 1] !== "\n" ? 1 : 0;
            if (z === "\r") poprzedniCR = true;
          }
          if (pole.length < MAKS_POLE) pole += z;
          else if (!bladRekordu) bladRekordu = `pole dłuższe niż ${MAKS_POLE} znaków`;
          continue;
        }
      }

      // poza cudzyslowem
      if (z === '"') {
        if (pole.length === 0) {
          wCudzyslowie = true;
          rekordPusty = false;
          continue;
        }
        // cudzyslow w srodku niecytowanego pola: RFC tego nie dopuszcza, ale eksporty
        // z arkuszy tak robia; traktujemy jak zwykly znak, zamiast wywalac plik
        if (pole.length < MAKS_POLE) pole += z;
        continue;
      }
      if (z === separator) {
        rekordPusty = false;
        domknijPole();
        continue;
      }
      if (z === "\r" || z === "\n") {
        if (z === "\r") poprzedniCR = true;
        liniaBiezaca += 1;
        const rekord = domknijRekord();
        if (rekord) yield rekord;
        continue;
      }
      rekordPusty = false;
      if (pole.length < MAKS_POLE) pole += z;
      else if (!bladRekordu) bladRekordu = `pole dłuższe niż ${MAKS_POLE} znaków`;
    }
  };

  for await (const kawalek of zrodlo) {
    let tekst = typeof kawalek === "string" ? kawalek : dekoder.decode(kawalek, { stream: true });
    if (pierwszyKawalek) {
      pierwszyKawalek = false;
      if (tekst.charCodeAt(0) === 0xfeff) tekst = tekst.slice(1);
    }
    if (!naglowekRozstrzygniety) {
      buforNaglowka += tekst;
      const koniec = buforNaglowka.search(/\r|\n/);
      if (koniec === -1 && buforNaglowka.length < 65_536) continue;
      separator = wykryjSeparator(koniec === -1 ? buforNaglowka : buforNaglowka.slice(0, koniec));
      naglowekRozstrzygniety = true;
      tekst = buforNaglowka;
      buforNaglowka = "";
    }
    yield* przetworzTekst(tekst);
  }

  // koncowka: reszta dekodera i ostatni rekord bez konca linii
  let ogon = dekoder.decode();
  if (!naglowekRozstrzygniety) {
    ogon = buforNaglowka + ogon;
    separator = wykryjSeparator(ogon);
    naglowekRozstrzygniety = true;
  }
  if (ogon) yield* przetworzTekst(ogon);
  if (wCudzyslowie && !poCudzyslowie && !bladRekordu) bladRekordu = "niedomknięty cudzysłów na końcu pliku";
  if (!rekordPusty || pole.length > 0 || pola.length > 0) {
    const rekord = domknijRekord();
    if (rekord) yield rekord;
  }
}

/**
 * Pole do eksportu CSV. Cudzyslowy i separatory wg RFC 4180, a do tego ochrona przed
 * wstrzyknieciem formuly: wartosc zaczynajaca sie od = + - @ albo znaku sterujacego
 * dostaje apostrof z przodu, bo Excel i LibreOffice wykonalyby ja jako formule
 * (CSV injection). Adres "-anna@x.pl" jest poprawnym adresem, wiec ochrona jest
 * prefiksem, nie odrzuceniem.
 */
export function poleCsv(wartosc: string | number | null | undefined): string {
  if (wartosc === null || wartosc === undefined) return "";
  let tekst = String(wartosc);
  if (/^[=+\-@\t\r]/.test(tekst)) tekst = `'${tekst}`;
  if (/[",\r\n;]/.test(tekst)) tekst = `"${tekst.replace(/"/g, '""')}"`;
  return tekst;
}

export function wierszCsv(pola: (string | number | null | undefined)[]): string {
  return pola.map(poleCsv).join(",") + "\r\n";
}
