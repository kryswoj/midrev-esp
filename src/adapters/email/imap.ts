import { createConnection, isIP, type Socket } from "node:net";
import { connect as polaczTls, type TLSSocket } from "node:tls";
import type { Sekret } from "../crypto";
import { BladHostaSmtp, DOZWOLONE_PORTY_IMAP, rozwiazHostSmtp, type CelPolaczenia, type FunkcjaLookup } from "./bezpieczny-host";

/**
 * Minimalny klient IMAP (RFC 3501) do skrzynki zwrotnej klienta — bez nowej zależności.
 *
 * Potrzebujemy pięciu komend: LOGIN, SELECT, UID SEARCH, UID FETCH, UID STORE (+LOGOUT
 * i STARTTLS). To jest za mało, żeby dokładać bibliotekę z własnym parserem całego
 * protokołu; jest za dużo, żeby robić to „na piechotę" w use-case. Stąd ten adapter.
 *
 * Bezpieczeństwo:
 *  - łączymy się WYŁĄCZNIE z adresem sprawdzonym przez `rozwiazHostSmtp` (ta sama bramka
 *    SSRF co SMTP; porty 993/143), nazwa idzie tylko do SNI i certyfikatu,
 *  - TLS z weryfikacją certyfikatu (poza jawnym serwerem deweloperskim), min. TLS 1.2,
 *  - hasło przychodzi jako `Sekret`, wysyłane jako literal IMAP (nie trafia do żadnego
 *    komunikatu błędu ani logu; klient nie loguje rozmowy),
 *  - limity: rozmiar pobieranego maila (512 KiB), liczba wiadomości na przebieg, czas.
 *
 * Nie obsługujemy: IDLE, wielu skrzynek naraz, CONDSTORE, kompresji. Nie są potrzebne.
 */

export type BezpieczenstwoImap = "none" | "starttls" | "tls";

export interface KonfiguracjaImap {
  host: string;
  port: number;
  bezpieczenstwo: BezpieczenstwoImap;
  uzytkownik: string;
  haslo: Sekret;
  skrzynka: string;
}

export interface OpcjeImap {
  hostyDeweloperskie: readonly string[];
  lookup?: FunkcjaLookup;
  /** ms na pojedynczą komendę; domyślnie 30 s */
  limitCzasuMs?: number;
}

/** Maksymalny rozmiar pobieranego raportu: DSN i ARF to kilka KB, reszta to załączniki. */
export const MAKS_ROZMIAR_RAPORTU = 512 * 1024;

export interface PobranaWiadomosc {
  uid: number;
  /** INTERNALDATE serwera — data zapasowa, gdy raport nie ma nagłówka Date */
  dataSerwera: Date | null;
  surowy: string;
  /** true, gdy mail był większy niż limit i został obcięty */
  obciety: boolean;
}

/** Port skrzynki zwrotnej — use-case odbić zna tylko to. Atrapa w testach implementuje to samo. */
export interface SkrzynkaZwrotna {
  /** Otwiera skrzynkę; zwraca UIDVALIDITY (zmiana = kursor UID nieważny). */
  otworz(): Promise<{ uidvalidity: number; wiadomosci: number }>;
  /** UID-y nieprzeczytanych wiadomości o UID > `odUid` (rosnąco). */
  nieprzeczytaneOd(odUid: number): Promise<number[]>;
  pobierz(uid: number): Promise<PobranaWiadomosc | null>;
  oznaczPrzeczytane(uid: number): Promise<void>;
  zamknij(): Promise<void>;
}

export class BladImap extends Error {
  constructor(
    readonly kod: "polaczenie" | "tls" | "logowanie" | "skrzynka" | "protokol" | "timeout" | "host",
    komunikat: string,
  ) {
    super(komunikat);
    this.name = "BladImap";
  }
}

interface Odpowiedz {
  /** linie nieotagowane (`* …`) z doklejonymi literałami */
  linie: string[];
  status: "OK" | "NO" | "BAD";
  tekst: string;
}

function bezNowychLinii(t: string): string {
  return t.replace(/[\r\n\x00]+/g, " ").trim();
}

/** Nazwa skrzynki jako quoted string IMAP (bez CRLF; cudzysłów i backslash escapowane). */
function quoted(t: string): string {
  return `"${t.replace(/[\\"]/g, (z) => `\\${z}`)}"`;
}

export class KlientImap implements SkrzynkaZwrotna {
  #k: KonfiguracjaImap;
  #o: OpcjeImap;
  #socket: Socket | TLSSocket | null = null;
  #bufor = "";
  #licznik = 0;
  #cel: CelPolaczenia | null = null;
  #uidvalidity = 0;
  /** kolejka oczekujących na dane: jedna komenda naraz */
  #oczekujacy: ((blad?: Error) => void) | null = null;

  constructor(konfiguracja: KonfiguracjaImap, opcje: OpcjeImap) {
    this.#k = konfiguracja;
    this.#o = opcje;
  }

  get cel(): CelPolaczenia | null {
    return this.#cel;
  }

  // --- warstwa transportu ---------------------------------------------------

  async #polacz(): Promise<void> {
    let cel: CelPolaczenia;
    try {
      cel = await rozwiazHostSmtp(this.#k.host, this.#k.port, {
        hostyDeweloperskie: this.#o.hostyDeweloperskie,
        lookup: this.#o.lookup,
        dozwolonePorty: DOZWOLONE_PORTY_IMAP,
        usluga: "imap",
      });
    } catch (blad) {
      if (blad instanceof BladHostaSmtp) throw new BladImap("host", blad.message);
      throw blad;
    }
    this.#cel = cel;
    if (this.#k.bezpieczenstwo === "none" && !cel.deweloperski) {
      throw new BladImap("tls", "Połączenie IMAP z logowaniem musi być szyfrowane: wybierz TLS (port 993) albo STARTTLS (port 143).");
    }
    const limit = this.#o.limitCzasuMs ?? 30_000;
    const opcjeTls = {
      host: cel.adres,
      port: cel.port,
      servername: isIP(cel.host) ? undefined : cel.host,
      rejectUnauthorized: !cel.deweloperski,
      minVersion: "TLSv1.2" as const,
    };
    const socket: Socket | TLSSocket = await new Promise((resolve, reject) => {
      const s: Socket | TLSSocket =
        this.#k.bezpieczenstwo === "tls"
          ? polaczTls(opcjeTls, () => resolve(s))
          : createConnection({ host: cel.adres, port: cel.port }, () => resolve(s));
      s.setTimeout(limit, () => {
        s.destroy();
        reject(new BladImap("timeout", `${cel.host}:${cel.port} nie odpowiedział w czasie.`));
      });
      s.once("error", (b) => reject(this.#opiszBladSocketu(b, cel)));
    });
    this.#podepnij(socket);
    // powitanie serwera
    await this.#czekajNaLinie(/^\* (OK|PREAUTH|BYE)/, limit);
    if (this.#k.bezpieczenstwo === "starttls") {
      const odp = await this.#komenda("STARTTLS");
      if (odp.status !== "OK") throw new BladImap("tls", `Serwer nie obsługuje STARTTLS: ${bezNowychLinii(odp.tekst).slice(0, 200)}`);
      const goly = this.#socket as Socket;
      goly.removeAllListeners("data");
      goly.removeAllListeners("error");
      const szyfrowany: TLSSocket = await new Promise((resolve, reject) => {
        const t = polaczTls({ ...opcjeTls, socket: goly }, () => resolve(t));
        t.once("error", (b) => reject(this.#opiszBladSocketu(b, cel)));
      });
      this.#podepnij(szyfrowany);
    }
  }

  #opiszBladSocketu(b: unknown, cel: CelPolaczenia): BladImap {
    const tresc = String((b as { message?: string })?.message ?? b);
    if (/ECONNREFUSED/.test(tresc)) return new BladImap("polaczenie", `${cel.host}:${cel.port} odmówił połączenia. Sprawdź port (993 dla TLS, 143 dla STARTTLS).`);
    if (/certificate|CERT_|self[- ]signed|altnames|does not match/i.test(tresc)) {
      return new BladImap("tls", `Certyfikat serwera ${cel.host} nie przeszedł weryfikacji (${bezNowychLinii(tresc).slice(0, 160)}).`);
    }
    if (/wrong version number|packet length too long|unknown protocol/i.test(tresc)) {
      return new BladImap("tls", "Tryb szyfrowania nie pasuje do portu: na 993 wybierz TLS, na 143 STARTTLS.");
    }
    return new BladImap("polaczenie", `Połączenie z ${cel.host}:${cel.port} nie powiodło się: ${bezNowychLinii(tresc).slice(0, 200)}`);
  }

  #podepnij(socket: Socket | TLSSocket) {
    this.#socket = socket;
    socket.on("data", (d: Buffer) => {
      this.#bufor += d.toString("latin1");
      this.#oczekujacy?.();
    });
    socket.on("error", (b) => this.#oczekujacy?.(this.#cel ? this.#opiszBladSocketu(b, this.#cel) : (b as Error)));
    socket.on("close", () => this.#oczekujacy?.(new BladImap("polaczenie", "Serwer zamknął połączenie.")));
  }

  /** Czeka, aż bufor spełni predykat; predykat dostaje bufor i mówi, ile znaków zjeść. */
  #czekaj<T>(sprawdz: () => T | null, limit: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const zegar = setTimeout(() => {
        this.#oczekujacy = null;
        reject(new BladImap("timeout", "Serwer IMAP nie odpowiedział w czasie."));
      }, limit);
      const probuj = (blad?: Error) => {
        if (blad) {
          clearTimeout(zegar);
          this.#oczekujacy = null;
          reject(blad);
          return;
        }
        let w: T | null;
        try {
          w = sprawdz();
        } catch (b) {
          // błąd protokołu wykryty w środku handlera `data`: ma odrzucić obietnicę,
          // a nie wylecieć jako nieobsłużony wyjątek z emitera socketu
          clearTimeout(zegar);
          this.#oczekujacy = null;
          reject(b as Error);
          return;
        }
        if (w !== null) {
          clearTimeout(zegar);
          this.#oczekujacy = null;
          resolve(w);
        }
      };
      this.#oczekujacy = probuj;
      probuj();
    });
  }

  #czekajNaLinie(wzor: RegExp, limit: number): Promise<string> {
    return this.#czekaj(() => {
      const i = this.#bufor.indexOf("\r\n");
      if (i < 0) return null;
      const linia = this.#bufor.slice(0, i);
      this.#bufor = this.#bufor.slice(i + 2);
      if (!wzor.test(linia)) throw new BladImap("protokol", `Nieoczekiwana odpowiedź serwera: ${linia.slice(0, 120)}`);
      return linia;
    }, limit);
  }

  /**
   * Wysyła komendę i zbiera odpowiedź do linii otagowanej. Literały `{n}` (RFC 3501 §4.3)
   * są doklejane do linii, która je zapowiada, jako surowe bajty (latin1, dekodowane
   * wyżej). Argumenty-literały (login, hasło) idą po kontynuacji `+`.
   */
  async #komenda(tekst: string, literaly: string[] = []): Promise<Odpowiedz> {
    const socket = this.#socket;
    if (!socket) throw new BladImap("polaczenie", "Brak połączenia.");
    const limit = this.#o.limitCzasuMs ?? 30_000;
    const tag = `A${++this.#licznik}`;
    const linie: string[] = [];
    let zapowiedzLiteralu = 0;
    let biezaca = "";
    let doWyslania = [...literaly];

    // pierwsza linia komendy; przy literałach kończy się `{n}` i czeka na `+`
    const pierwszy = doWyslania.length ? `{${Buffer.byteLength(doWyslania[0], "utf8")}}` : "";
    socket.write(`${tag} ${tekst}${pierwszy}\r\n`);

    return this.#czekaj<Odpowiedz>(() => {
      // pętla po kompletnych liniach w buforze
      for (;;) {
        if (zapowiedzLiteralu > 0) {
          if (Buffer.byteLength(this.#bufor, "latin1") < zapowiedzLiteralu) return null;
          biezaca += this.#bufor.slice(0, zapowiedzLiteralu);
          this.#bufor = this.#bufor.slice(zapowiedzLiteralu);
          zapowiedzLiteralu = 0;
          continue;
        }
        const i = this.#bufor.indexOf("\r\n");
        if (i < 0) return null;
        const linia = this.#bufor.slice(0, i);
        this.#bufor = this.#bufor.slice(i + 2);

        if (linia.startsWith("+") && doWyslania.length) {
          // kontynuacja: wysyłamy literał i ewentualną zapowiedź następnego
          const [pierwszyLit, ...reszta] = doWyslania;
          doWyslania = reszta;
          const nastepny = reszta.length ? ` {${Buffer.byteLength(reszta[0], "utf8")}}` : "";
          socket.write(Buffer.concat([Buffer.from(pierwszyLit, "utf8"), Buffer.from(`${nastepny}\r\n`)]));
          continue;
        }
        biezaca += linia;
        const lit = /\{(\d+)\}$/.exec(linia);
        if (lit) {
          zapowiedzLiteralu = Number(lit[1]);
          biezaca += "\r\n";
          continue;
        }
        if (biezaca.startsWith(`${tag} `)) {
          const m = /^A\d+ (OK|NO|BAD)\b\s*(.*)$/s.exec(biezaca);
          if (!m) throw new BladImap("protokol", `Niezrozumiała odpowiedź: ${biezaca.slice(0, 120)}`);
          return { linie, status: m[1] as Odpowiedz["status"], tekst: m[2] };
        }
        if (biezaca.startsWith("* ") || biezaca.startsWith("+")) linie.push(biezaca);
        biezaca = "";
      }
    }, limit);
  }

  // --- port SkrzynkaZwrotna ---------------------------------------------------

  async otworz(): Promise<{ uidvalidity: number; wiadomosci: number }> {
    await this.#polacz();
    // LOGIN z obydwoma argumentami jako literały: hasło ze spacją, cudzysłowem albo
    // znakiem spoza ASCII nie ma jak rozbić składni komendy
    const login = await this.#komenda("LOGIN ", [this.#k.uzytkownik, this.#k.haslo.ujawnij()]);
    if (login.status !== "OK") {
      throw new BladImap("logowanie", `Serwer odrzucił login lub hasło do skrzynki zwrotnej.${login.tekst ? ` Serwer odpowiedział: „${bezNowychLinii(login.tekst).slice(0, 200)}”.` : ""}`);
    }
    const sel = await this.#komenda(`SELECT ${quoted(this.#k.skrzynka)}`);
    if (sel.status !== "OK") {
      throw new BladImap("skrzynka", `Nie udało się otworzyć skrzynki „${this.#k.skrzynka}”: ${bezNowychLinii(sel.tekst).slice(0, 200)}`);
    }
    let uidvalidity = 0;
    let wiadomosci = 0;
    for (const l of sel.linie) {
      const uv = /\[UIDVALIDITY (\d+)\]/.exec(l);
      if (uv) uidvalidity = Number(uv[1]);
      const ex = /^\* (\d+) EXISTS/.exec(l);
      if (ex) wiadomosci = Number(ex[1]);
    }
    const uvTag = /\[UIDVALIDITY (\d+)\]/.exec(sel.tekst);
    if (uvTag) uidvalidity = Number(uvTag[1]);
    if (!uidvalidity) throw new BladImap("protokol", "Serwer nie podał UIDVALIDITY skrzynki.");
    this.#uidvalidity = uidvalidity;
    return { uidvalidity, wiadomosci };
  }

  async nieprzeczytaneOd(odUid: number): Promise<number[]> {
    const od = Math.max(1, Math.floor(odUid) + 1);
    const odp = await this.#komenda(`UID SEARCH UNSEEN UID ${od}:*`);
    if (odp.status !== "OK") throw new BladImap("protokol", `UID SEARCH: ${bezNowychLinii(odp.tekst).slice(0, 200)}`);
    const uidy: number[] = [];
    for (const l of odp.linie) {
      const m = /^\* SEARCH\b(.*)$/.exec(l);
      if (!m) continue;
      for (const x of m[1].trim().split(/\s+/)) {
        const n = Number(x);
        // `n:*` przy pustym zakresie potrafi zwrócić ostatni UID mniejszy od `od` (RFC 3501 §6.4.8)
        if (Number.isInteger(n) && n >= od) uidy.push(n);
      }
    }
    return uidy.sort((a, b) => a - b);
  }

  async pobierz(uid: number): Promise<PobranaWiadomosc | null> {
    const odp = await this.#komenda(`UID FETCH ${Math.floor(uid)} (UID INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.${MAKS_ROZMIAR_RAPORTU}>)`);
    if (odp.status !== "OK") throw new BladImap("protokol", `UID FETCH: ${bezNowychLinii(odp.tekst).slice(0, 200)}`);
    for (const l of odp.linie) {
      if (!/^\* \d+ FETCH /.test(l)) continue;
      const m = /\bUID (\d+)/.exec(l);
      if (!m || Number(m[1]) !== Math.floor(uid)) continue;
      const rozmiar = Number(/\bRFC822\.SIZE (\d+)/.exec(l)?.[1] ?? 0);
      const data = /\bINTERNALDATE "([^"]+)"/.exec(l)?.[1] ?? null;
      const lit = /BODY\[\](?:<\d+>)? \{(\d+)\}\r\n/.exec(l);
      if (!lit) continue;
      const start = lit.index + lit[0].length;
      const surowyLatin1 = l.slice(start, start + Number(lit[1]));
      const surowy = Buffer.from(surowyLatin1, "latin1").toString("utf8");
      const d = data ? new Date(data.replace(/^\s*(\d)-/, "0$1-")) : null;
      return {
        uid: Math.floor(uid),
        dataSerwera: d && !Number.isNaN(d.getTime()) ? d : null,
        surowy,
        obciety: rozmiar > MAKS_ROZMIAR_RAPORTU,
      };
    }
    return null;
  }

  async oznaczPrzeczytane(uid: number): Promise<void> {
    const odp = await this.#komenda(`UID STORE ${Math.floor(uid)} +FLAGS.SILENT (\\Seen)`);
    if (odp.status !== "OK") throw new BladImap("protokol", `UID STORE: ${bezNowychLinii(odp.tekst).slice(0, 200)}`);
  }

  async zamknij(): Promise<void> {
    const s = this.#socket;
    if (!s) return;
    try {
      await Promise.race([this.#komenda("LOGOUT"), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      // zamykamy i tak
    }
    this.#socket = null;
    s.destroy();
  }

  get uidvalidity(): number {
    return this.#uidvalidity;
  }
}
