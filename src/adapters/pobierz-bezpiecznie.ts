import { lookup as lookupSystemowy } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import type { Readable } from "node:stream";
import { czyAdresPubliczny } from "./email/bezpieczny-host";

/**
 * Pobranie zasobu spod adresu PODANEGO PRZEZ KLIENTA (feed produktów) z obroną przed SSRF.
 * Ta sama bramka adresów co serwer SMTP (bezpieczny-host.ts), z regułami jak tam:
 *   1. sprawdzamy ADRES PO ROZWIĄZANIU NAZWY (wszystkie adresy z odpowiedzi muszą być publiczne),
 *   2. łączymy się z adresem, który sprawdziliśmy: własny `lookup` agenta HTTP zwraca tylko
 *      zweryfikowane adresy, więc DNS rebinding między sprawdzeniem a połączeniem nie działa,
 *   3. każde przekierowanie przechodzi bramkę od nowa (najwyżej 3), tylko http(s),
 *   4. tylko porty 80 i 443, limit czasu całości, limit bajtów PO dekompresji (gzip bomb),
 *   5. komunikaty nie mówią, co stoi pod zablokowanym adresem.
 */

export class BladPobierania extends Error {
  constructor(
    readonly kod: "adres" | "adres_prywatny" | "port" | "dns" | "http" | "rozmiar" | "czas" | "przekierowania" | "siec",
    komunikat: string,
  ) {
    super(komunikat);
    this.name = "BladPobierania";
  }
}

export interface OpcjePobierania {
  maksBajtow: number;
  limitCzasuMs?: number;
  naglowki?: Record<string, string>;
  maksPrzekierowan?: number;
  /** testy: zastępczy resolver DNS */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** testy: adresy dopuszczone mimo blokady (np. lokalny serwer testowy); domyślnie żadne */
  dopuscAdres?: (adres: string, port: number) => boolean;
}

export interface WynikPobierania {
  status: number;
  naglowki: Record<string, string | string[] | undefined>;
  tresc: Buffer;
  url: string;
}

const lookupDomyslny = (host: string) =>
  new Promise<{ address: string; family: number }[]>((ok, nie) =>
    lookupSystemowy(host, { all: true, verbatim: true }, (b, adresy) => (b ? nie(b) : ok(adresy))),
  );

async function sprawdzonyCel(url: URL, o: OpcjePobierania): Promise<{ adresy: { address: string; family: number }[]; port: number }> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BladPobierania("adres", "Adres musi zaczynać się od http:// albo https://.");
  if (url.username || url.password) throw new BladPobierania("adres", "Adres nie może zawierać loginu ani hasła.");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const dopusc = o.dopuscAdres ?? (() => false);
  if (![80, 443].includes(port) && !dopusc(host, port)) {
    throw new BladPobierania("port", "Dozwolone są tylko standardowe porty (80 i 443).");
  }
  let adresy: { address: string; family: number }[];
  if (isIP(host)) adresy = [{ address: host, family: isIP(host) }];
  else {
    try {
      adresy = await (o.lookup ?? lookupDomyslny)(host);
    } catch {
      throw new BladPobierania("dns", `Nazwa ${host.slice(0, 100)} nie istnieje w DNS albo DNS nie odpowiada.`);
    }
  }
  if (!adresy.length) throw new BladPobierania("dns", `Nazwa ${host.slice(0, 100)} nie ma adresu IP.`);
  if (adresy.some((a) => !czyAdresPubliczny(a.address) && !dopusc(a.address, port))) {
    throw new BladPobierania("adres_prywatny", "Adres wskazuje na sieć prywatną, lokalną albo zarezerwowaną. Podaj publiczny adres feedu.");
  }
  return { adresy, port };
}

function rozpakuj(strumien: Readable, kodowanie: string | undefined): Readable {
  const k = (kodowanie ?? "").toLowerCase().trim();
  if (k === "gzip" || k === "x-gzip") return strumien.pipe(createGunzip());
  if (k === "deflate") return strumien.pipe(createInflate());
  if (k === "br") return strumien.pipe(createBrotliDecompress());
  return strumien;
}

function jednoZadanie(url: URL, cel: { adresy: { address: string; family: number }[] }, o: OpcjePobierania, sygnal: AbortSignal) {
  return new Promise<{ status: number; naglowki: http.IncomingHttpHeaders; tresc: Buffer }>((ok, nie) => {
    const modul = url.protocol === "https:" ? https : http;
    const zadanie = modul.request(
      url,
      {
        method: "GET",
        signal: sygnal,
        headers: { "Accept-Encoding": "gzip, deflate, br", "User-Agent": "MidRev-Feed/1.0 (+https://midrev.pl)", ...(o.naglowki ?? {}) },
        // połączenie WYŁĄCZNIE ze sprawdzonymi adresami (bez drugiego zapytania DNS)
        lookup: ((_h: string, opcje: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (opcje?.all) cb(null, cel.adresy);
          else cb(null, cel.adresy[0].address, cel.adresy[0].family);
        }) as unknown as typeof import("node:dns").lookup,
      },
      (odp) => {
        const status = odp.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          odp.resume();
          ok({ status, naglowki: odp.headers, tresc: Buffer.alloc(0) });
          return;
        }
        const deklarowany = Number(odp.headers["content-length"] ?? "0");
        if (!odp.headers["content-encoding"] && deklarowany > o.maksBajtow) {
          odp.destroy();
          nie(new BladPobierania("rozmiar", `Plik ma ${Math.round(deklarowany / 1024 / 1024)} MB, limit to ${Math.round(o.maksBajtow / 1024 / 1024)} MB.`));
          return;
        }
        let strumien: Readable;
        try {
          strumien = rozpakuj(odp, odp.headers["content-encoding"] as string | undefined);
        } catch {
          nie(new BladPobierania("http", "Nieobsługiwane kodowanie odpowiedzi."));
          return;
        }
        const kawalki: Buffer[] = [];
        let rozmiar = 0;
        strumien.on("data", (k: Buffer) => {
          rozmiar += k.length;
          if (rozmiar > o.maksBajtow) {
            strumien.destroy();
            odp.destroy();
            nie(new BladPobierania("rozmiar", `Plik po rozpakowaniu przekracza ${Math.round(o.maksBajtow / 1024 / 1024)} MB.`));
            return;
          }
          kawalki.push(k);
        });
        strumien.on("end", () => ok({ status, naglowki: odp.headers, tresc: Buffer.concat(kawalki) }));
        strumien.on("error", () => nie(new BladPobierania("http", "Uszkodzona odpowiedź serwera (kompresja).")));
      },
    );
    zadanie.on("error", (b) => {
      if (sygnal.aborted) nie(new BladPobierania("czas", "Serwer feedu nie odpowiedział w wyznaczonym czasie."));
      else nie(b instanceof BladPobierania ? b : new BladPobierania("siec", "Nie udało się połączyć z serwerem feedu."));
    });
    zadanie.end();
  });
}

export async function pobierzBezpiecznie(adres: string, o: OpcjePobierania): Promise<WynikPobierania> {
  let url: URL;
  try {
    url = new URL(adres);
  } catch {
    throw new BladPobierania("adres", "To nie jest poprawny adres URL.");
  }
  const kontroler = new AbortController();
  const zegar = setTimeout(() => kontroler.abort(), o.limitCzasuMs ?? 30_000);
  try {
    for (let skok = 0; skok <= (o.maksPrzekierowan ?? 3); skok++) {
      const cel = await sprawdzonyCel(url, o);
      const w = await jednoZadanie(url, cel, o, kontroler.signal);
      if (w.status >= 300 && w.status < 400 && w.status !== 304) {
        if (skok >= (o.maksPrzekierowan ?? 3)) break;
        const dalej = w.naglowki.location;
        if (!dalej || typeof dalej !== "string") throw new BladPobierania("http", `Serwer odpowiedział ${w.status} bez adresu przekierowania.`);
        url = new URL(dalej, url);
        continue;
      }
      let tresc = w.tresc;
      // plik .gz serwowany jako application/octet-stream (bez Content-Encoding)
      if (tresc.length > 2 && tresc[0] === 0x1f && tresc[1] === 0x8b) {
        const { gunzipSync } = await import("node:zlib");
        try {
          tresc = gunzipSync(tresc, { maxOutputLength: o.maksBajtow });
        } catch {
          throw new BladPobierania("rozmiar", "Plik .gz jest uszkodzony albo po rozpakowaniu przekracza limit.");
        }
      }
      return { status: w.status, naglowki: w.naglowki, tresc, url: url.toString() };
    }
    throw new BladPobierania("przekierowania", "Za dużo przekierowań (najwyżej 3).");
  } finally {
    clearTimeout(zegar);
  }
}
