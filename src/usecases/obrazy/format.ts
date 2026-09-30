/**
 * Rozpoznanie obrazu po MAGICZNYCH BAJTACH, nie po rozszerzeniu ani Content-Type.
 *
 * Plik od użytkownika to niezaufany plik: nazwa „baner.png" i nagłówek `image/png`
 * to deklaracje przeglądarki, które da się podrobić jednym poleceniem curl. Typ, pod
 * którym obraz będzie potem serwowany (i otwierany w skrzynce odbiorcy), wynika
 * WYŁĄCZNIE z tego, co leży w pierwszych bajtach pliku.
 *
 * Przyjmujemy cztery formaty rastrowe: PNG, JPEG, GIF, WebP. SVG NIE — to dokument XML
 * ze skryptami, czyli XSS na naszej domenie, a Gmail i Outlook i tak go nie pokażą.
 * SVG nie ma magicznej sygnatury, więc odpada tu naturalnie, razem z HTML-em i każdym
 * innym tekstem przebranym za obraz.
 *
 * Wymiary czytamy z nagłówka formatu. Plik, z którego nie da się ich odczytać, jest
 * uszkodzony albo tylko udaje obraz (sama sygnatura + śmieci) i też odpada: skrzynka
 * odbiorcy i tak pokazałaby w jego miejscu ikonę zepsutego obrazka.
 */

export type FormatObrazu = "png" | "jpg" | "gif" | "webp";

export const TYPY_MIME: Record<FormatObrazu, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export interface RozpoznanyObraz {
  format: FormatObrazu;
  mime: string;
  szerokosc: number;
  wysokosc: number;
}

/** Granica sensu: obraz szerszy niż 20 000 px to nie grafika do maila, tylko bomba pamięciowa. */
const MAKS_WYMIAR = 20000;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function zaczynaSieOd(b: Uint8Array, sygnatura: number[], od = 0): boolean {
  if (b.length < od + sygnatura.length) return false;
  return sygnatura.every((bajt, i) => b[od + i] === bajt);
}

function ascii(b: Uint8Array, od: number, dlugosc: number): string {
  if (b.length < od + dlugosc) return "";
  return String.fromCharCode(...b.subarray(od, od + dlugosc));
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

function wymiaryPng(b: Uint8Array): [number, number] | null {
  // sygnatura (8) + długość chunka (4) + "IHDR" (4) + szerokość (4) + wysokość (4)
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  return [be32(b, 16), be32(b, 20)];
}

function wymiaryGif(b: Uint8Array): [number, number] | null {
  if (b.length < 10) return null;
  return [le16(b, 6), le16(b, 8)];
}

function wymiaryWebp(b: Uint8Array): [number, number] | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    // ramka kluczowa: 3 bajty nagłówka ramki + kod startu 9d 01 2a, potem 14-bitowe wymiary
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return [le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff];
  }
  if (chunk === "VP8L") {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24];
    return [1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))];
  }
  if (chunk === "VP8X") {
    if (b.length < 30) return null;
    return [1 + le24(b, 24), 1 + le24(b, 27)];
  }
  return null;
}

function wymiaryJpeg(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let znacznik = b[i + 1];
    // bajty wypełnienia 0xFF przed znacznikiem są dozwolone
    while (znacznik === 0xff && i + 2 < b.length) {
      i += 1;
      znacznik = b[i + 1];
    }
    // znaczniki bez długości: RST0-7, SOI, TEM
    if ((znacznik >= 0xd0 && znacznik <= 0xd8) || znacznik === 0x01) {
      i += 2;
      continue;
    }
    if (znacznik === 0xd9 || znacznik === 0xda) return null; // koniec obrazu / dane skanu przed SOF
    if (i + 3 >= b.length) return null;
    const dlugosc = be16(b, i + 2);
    if (dlugosc < 2) return null;
    const sof = znacznik >= 0xc0 && znacznik <= 0xcf && znacznik !== 0xc4 && znacznik !== 0xc8 && znacznik !== 0xcc;
    if (sof) {
      if (i + 8 >= b.length) return null;
      return [be16(b, i + 7), be16(b, i + 5)];
    }
    i += 2 + dlugosc;
  }
  return null;
}

/** Format i wymiary albo `null`, gdy plik nie jest obsługiwanym, zdrowym obrazem. */
export function rozpoznajObraz(bajty: Uint8Array): RozpoznanyObraz | null {
  let format: FormatObrazu | null = null;
  let wymiary: [number, number] | null = null;

  if (zaczynaSieOd(bajty, PNG)) {
    format = "png";
    wymiary = wymiaryPng(bajty);
  } else if (zaczynaSieOd(bajty, [0xff, 0xd8, 0xff])) {
    format = "jpg";
    wymiary = wymiaryJpeg(bajty);
  } else if (ascii(bajty, 0, 6) === "GIF87a" || ascii(bajty, 0, 6) === "GIF89a") {
    format = "gif";
    wymiary = wymiaryGif(bajty);
  } else if (ascii(bajty, 0, 4) === "RIFF" && ascii(bajty, 8, 4) === "WEBP") {
    format = "webp";
    wymiary = wymiaryWebp(bajty);
  }

  if (!format || !wymiary) return null;
  const [szerokosc, wysokosc] = wymiary;
  if (!(szerokosc >= 1 && wysokosc >= 1 && szerokosc <= MAKS_WYMIAR && wysokosc <= MAKS_WYMIAR)) return null;
  return { format, mime: TYPY_MIME[format], szerokosc, wysokosc };
}
