import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { ResolverDns } from "./dns";

/**
 * Zapytanie DNS wprost do serwerów nazw DOSTAWCY klienta (bez rekursji, RD=0).
 *
 * Po co: zwykły resolver po delegacji widzi już naszą strefę (dziecko), więc nie powie,
 * co klient wpisał u siebie: ile serwerów NS, czy z doklejoną domeną, czy obok NS został
 * stary CNAME/MX. Serwer dostawcy odpowiada na to wprost (odesłanie z NS w sekcji
 * „authority" albo odpowiedź z autorytetem, gdy delegacji nie ma).
 *
 * Mały klient UDP (RFC 1035) zamiast `dig` (na VPS nie ma) i bez zależności. Tylko
 * odczyt, jeden pakiet, 3 s na serwer. Adresy serwerów pochodzą z publicznego DNS klienta,
 * więc ODMAWIAMY wysyłki na adresy prywatne/pętli (SSRF przez rekord NS → 127.0.0.1).
 */

export type TypZapytania = "A" | "AAAA" | "NS" | "CNAME" | "MX" | "TXT";

const KODY_TYPOW: Record<TypZapytania, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
const NAZWY_TYPOW = new Map(Object.entries(KODY_TYPOW).map(([k, v]) => [v, k]));

export interface RekordDns {
  nazwa: string;
  typ: string;
  /** NS/CNAME: nazwa celu; MX: „priorytet host"; TXT: sklejone fragmenty; A/AAAA: adres */
  dane: string;
}

export interface OdpowiedzAutorytatywna {
  /** bit AA: serwer jest autorytatywny dla tej nazwy (brak delegacji niżej) */
  autorytatywna: boolean;
  rcode: number;
  odpowiedzi: RekordDns[];
  autorytet: RekordDns[];
}

export interface ResolverAutorytatywny {
  /** zapytanie do pierwszego odpowiadającego serwera z listy (nazwy hostów NS) */
  zapytaj(nazwa: string, typ: TypZapytania, serwery: readonly string[]): Promise<OdpowiedzAutorytatywna>;
}

// ── Kodowanie i dekodowanie pakietu ────────────────────────────────────────────

export function zbudujZapytanie(id: number, nazwa: string, typ: TypZapytania): Buffer {
  const naglowek = Buffer.alloc(12);
  naglowek.writeUInt16BE(id, 0);
  naglowek.writeUInt16BE(0x0000, 2); // RD=0: bez rekursji
  naglowek.writeUInt16BE(1, 4);
  const etykiety = nazwa.replace(/\.$/, "").split(".").filter(Boolean);
  const czesci: Buffer[] = [];
  for (const e of etykiety) {
    const b = Buffer.from(e, "ascii");
    if (b.length === 0 || b.length > 63) throw new Error("niepoprawna etykieta DNS");
    czesci.push(Buffer.from([b.length]), b);
  }
  czesci.push(Buffer.from([0]));
  const koniec = Buffer.alloc(4);
  koniec.writeUInt16BE(KODY_TYPOW[typ], 0);
  koniec.writeUInt16BE(1, 2); // IN
  return Buffer.concat([naglowek, ...czesci, koniec]);
}

function czytajNazwe(buf: Buffer, start: number): { nazwa: string; dalej: number } {
  const etykiety: string[] = [];
  let poz = start;
  let dalej = -1;
  for (let skoki = 0; skoki < 64; skoki++) {
    if (poz >= buf.length) throw new Error("ucięty pakiet DNS");
    const dl = buf[poz];
    if (dl === 0) {
      return { nazwa: etykiety.join(".").toLowerCase(), dalej: dalej < 0 ? poz + 1 : dalej };
    }
    if ((dl & 0xc0) === 0xc0) {
      if (poz + 1 >= buf.length) throw new Error("ucięty pakiet DNS");
      if (dalej < 0) dalej = poz + 2;
      poz = ((dl & 0x3f) << 8) | buf[poz + 1];
      continue;
    }
    if (poz + 1 + dl > buf.length) throw new Error("ucięty pakiet DNS");
    etykiety.push(buf.toString("latin1", poz + 1, poz + 1 + dl));
    poz += 1 + dl;
  }
  throw new Error("pętla kompresji w pakiecie DNS");
}

export function rozbierzOdpowiedz(buf: Buffer, oczekiwaneId?: number): OdpowiedzAutorytatywna {
  if (buf.length < 12) throw new Error("za krótki pakiet DNS");
  if (oczekiwaneId !== undefined && buf.readUInt16BE(0) !== oczekiwaneId) throw new Error("obcy identyfikator odpowiedzi DNS");
  const flagi = buf.readUInt16BE(2);
  if (!(flagi & 0x8000)) throw new Error("to nie jest odpowiedź DNS");
  const [qd, an, ns] = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8)];
  let poz = 12;
  for (let i = 0; i < qd; i++) poz = czytajNazwe(buf, poz).dalej + 4;
  const czytajRR = (): RekordDns | null => {
    const { nazwa, dalej } = czytajNazwe(buf, poz);
    if (dalej + 10 > buf.length) throw new Error("ucięty pakiet DNS");
    const typ = buf.readUInt16BE(dalej);
    const dl = buf.readUInt16BE(dalej + 8);
    const dane = dalej + 10;
    if (dane + dl > buf.length) throw new Error("ucięty pakiet DNS");
    poz = dane + dl;
    const nazwaTypu = NAZWY_TYPOW.get(typ);
    if (!nazwaTypu) return { nazwa, typ: String(typ), dane: "" };
    if (nazwaTypu === "NS" || nazwaTypu === "CNAME") return { nazwa, typ: nazwaTypu, dane: czytajNazwe(buf, dane).nazwa };
    if (nazwaTypu === "MX") return { nazwa, typ: "MX", dane: `${buf.readUInt16BE(dane)} ${czytajNazwe(buf, dane + 2).nazwa}` };
    if (nazwaTypu === "TXT") {
      const kawalki: string[] = [];
      for (let p = dane; p < dane + dl; ) {
        const k = buf[p];
        kawalki.push(buf.toString("utf8", p + 1, p + 1 + k));
        p += 1 + k;
      }
      return { nazwa, typ: "TXT", dane: kawalki.join("") };
    }
    if (nazwaTypu === "A" && dl === 4) return { nazwa, typ: "A", dane: [...buf.subarray(dane, dane + 4)].join(".") };
    return { nazwa, typ: nazwaTypu, dane: buf.subarray(dane, dane + dl).toString("hex") };
  };
  const odpowiedzi: RekordDns[] = [];
  const autorytet: RekordDns[] = [];
  for (let i = 0; i < an; i++) {
    const r = czytajRR();
    if (r) odpowiedzi.push(r);
  }
  for (let i = 0; i < ns; i++) {
    const r = czytajRR();
    if (r) autorytet.push(r);
  }
  return { autorytatywna: Boolean(flagi & 0x0400), rcode: flagi & 0x000f, odpowiedzi, autorytet };
}

// ── Sieć ───────────────────────────────────────────────────────────────────────

/** Adres prywatny, pętli, link-local albo zarezerwowany: na taki nie wysyłamy pakietów. */
export function adresNiepubliczny(ip: string): boolean {
  if (isIP(ip) !== 4) return true; // IPv6 pomijamy: serwery dostawców mają IPv4
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function wyslijUdp(ip: string, pakiet: Buffer, id: number, limitMs: number): Promise<OdpowiedzAutorytatywna> {
  return new Promise((ok, blad) => {
    const gniazdo = createSocket("udp4");
    const zegar = setTimeout(() => {
      gniazdo.close();
      blad(Object.assign(new Error("DNS: brak odpowiedzi serwera dostawcy"), { code: "ETIMEOUT" }));
    }, limitMs);
    gniazdo.on("error", (e) => {
      clearTimeout(zegar);
      gniazdo.close();
      blad(e);
    });
    gniazdo.on("message", (wiadomosc, nadawca) => {
      if (nadawca.address !== ip || nadawca.port !== 53) return; // podszyte pakiety ignorujemy
      try {
        const o = rozbierzOdpowiedz(wiadomosc, id);
        clearTimeout(zegar);
        gniazdo.close();
        ok(o);
      } catch {
        // obcy albo popsuty pakiet: czekamy dalej na właściwy do limitu czasu
      }
    });
    gniazdo.send(pakiet, 53, ip);
  });
}

export function resolverAutorytatywnySystemowy(rekursywny: ResolverDns, limitMs = 3_000): ResolverAutorytatywny {
  return {
    async zapytaj(nazwa, typ, serwery) {
      let ostatni: unknown = Object.assign(new Error("DNS: brak serwerów dostawcy"), { code: "ESERVFAIL" });
      for (const host of serwery.slice(0, 4)) {
        let adresy: string[] = [];
        try {
          adresy = isIP(host) ? [host] : await rekursywny.a(host);
        } catch (b) {
          ostatni = b;
          continue;
        }
        for (const ip of adresy.filter((a) => !adresNiepubliczny(a)).slice(0, 2)) {
          const id = randomBytes(2).readUInt16BE(0);
          try {
            return await wyslijUdp(ip, zbudujZapytanie(id, nazwa, typ), id, limitMs);
          } catch (b) {
            ostatni = b;
          }
        }
      }
      throw ostatni;
    },
  };
}
