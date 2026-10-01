import { createHash, createHmac } from "node:crypto";
import type { Sekret } from "../crypto";

/**
 * Podpis AWS Signature Version 4 dla zapytań HTTP (SESv2 REST/JSON, SNS query).
 *
 * Własna implementacja zamiast @aws-sdk: dwa serwisy, kilka operacji, a SDK to kilka MB
 * zależności. Algorytm wg dokumentacji „Create a signed AWS API request"; test
 * `tests/aws-sigv4.test.ts` sprawdza go na wektorze z dokumentacji AWS.
 *
 * Sekret klucza przychodzi jako `Sekret` i jest odsłaniany wyłącznie do HMAC. Funkcja
 * nie loguje niczego, a zwracane nagłówki zawierają tylko identyfikator klucza (publiczny
 * z natury) i podpis.
 */

export interface KluczeAws {
  accessKeyId: string;
  secretAccessKey: Sekret;
}

export interface ZadanieDoPodpisu {
  metoda: string;
  url: string;
  /** nagłówki poza host i x-amz-date (te dokłada podpis) */
  naglowki?: Record<string, string>;
  cialo?: string;
  region: string;
  usluga: string;
  klucze: KluczeAws;
  /** wstrzykiwany w testach; domyślnie teraz */
  teraz?: Date;
}

function sha256Hex(dane: string | Buffer): string {
  return createHash("sha256").update(dane).digest("hex");
}

function hmac(klucz: Buffer | string, dane: string): Buffer {
  return createHmac("sha256", klucz).update(dane, "utf8").digest();
}

/** RFC 3986: wszystko poza A-Z a-z 0-9 - _ . ~ kodowane, spacja jako %20. */
export function kodujUri(tekst: string): string {
  return encodeURIComponent(tekst).replace(/[!'()*]/g, (z) => `%${z.charCodeAt(0).toString(16).toUpperCase()}`);
}

function kanonicznaSciezka(sciezka: string): string {
  // każdy segment kodowany raz (SES/SNS: nie S3, więc bez podwójnego kodowania wyjątków)
  return (
    sciezka
      .split("/")
      .map((s) => kodujUri(decodeURIComponent(s)))
      .join("/") || "/"
  );
}

function kanoniczneZapytanie(params: URLSearchParams): string {
  const pary: [string, string][] = [];
  params.forEach((v, k) => pary.push([kodujUri(k), kodujUri(v)]));
  pary.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pary.map(([k, v]) => `${k}=${v}`).join("&");
}

export function znacznikCzasu(d: Date): { amzDate: string; dzien: string } {
  const iso = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dzien: iso.slice(0, 8) };
}

/** Zwraca komplet nagłówków do wysłania (z Authorization). */
export function podpiszZadanie(z: ZadanieDoPodpisu): Record<string, string> {
  const url = new URL(z.url);
  const { amzDate, dzien } = znacznikCzasu(z.teraz ?? new Date());
  const cialo = z.cialo ?? "";
  const naglowki: Record<string, string> = {};
  for (const [k, v] of Object.entries(z.naglowki ?? {})) naglowki[k.toLowerCase()] = v;
  naglowki.host = url.host;
  naglowki["x-amz-date"] = amzDate;

  const nazwy = Object.keys(naglowki).sort();
  const kanoniczneNaglowki = nazwy.map((n) => `${n}:${naglowki[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const podpisaneNaglowki = nazwy.join(";");
  const kanoniczne = [
    z.metoda.toUpperCase(),
    kanonicznaSciezka(url.pathname),
    kanoniczneZapytanie(url.searchParams),
    kanoniczneNaglowki,
    podpisaneNaglowki,
    sha256Hex(cialo),
  ].join("\n");
  const zakres = `${dzien}/${z.region}/${z.usluga}/aws4_request`;
  const doPodpisu = ["AWS4-HMAC-SHA256", amzDate, zakres, sha256Hex(kanoniczne)].join("\n");

  const kDate = hmac(`AWS4${z.klucze.secretAccessKey.ujawnij()}`, dzien);
  const kRegion = hmac(kDate, z.region);
  const kService = hmac(kRegion, z.usluga);
  const kSigning = hmac(kService, "aws4_request");
  const podpis = createHmac("sha256", kSigning).update(doPodpisu, "utf8").digest("hex");

  const wynik: Record<string, string> = {};
  for (const n of nazwy) if (n !== "host") wynik[n] = naglowki[n];
  wynik.authorization = `AWS4-HMAC-SHA256 Credential=${z.klucze.accessKeyId}/${zakres}, SignedHeaders=${podpisaneNaglowki}, Signature=${podpis}`;
  return wynik;
}
