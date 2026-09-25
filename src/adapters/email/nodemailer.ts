import { isIP } from "node:net";
import nodemailer from "nodemailer";
import type { Sekret } from "../crypto";
import type { DostawcaWysylki, Wiadomosc, WynikWysylki } from "../../domain/email/port";
import { BladHostaSmtp, rozwiazHostSmtp, type CelPolaczenia, type FunkcjaLookup } from "./bezpieczny-host";

/**
 * Adapter wysyłki przez WŁASNY serwer SMTP klienta (nodemailer, licencja MIT-0).
 *
 * Różnica wobec `smtp.ts`: tamten jest ręcznym klientem pod lokalnego Mailpita (bez TLS,
 * bez logowania). Ten mówi z prawdziwym serwerem: STARTTLS albo TLS z weryfikacją
 * certyfikatu, logowanie, limity czasu na każdym etapie. Łączy się WYŁĄCZNIE z adresem
 * sprawdzonym przez `rozwiazHostSmtp` (SSRF, patrz bezpieczny-host.ts).
 *
 * Hasło przychodzi jako `Sekret` i jest odsłaniane dopiero przy budowie transportu.
 * Żaden komunikat błędu z tego pliku go nie zawiera.
 */

export type Bezpieczenstwo = "none" | "starttls" | "tls";

export interface KonfiguracjaSerwera {
  host: string;
  port: number;
  bezpieczenstwo: Bezpieczenstwo;
  uzytkownik: string | null;
  haslo: Sekret | null;
}

export interface OpcjeAdaptera {
  hostyDeweloperskie: readonly string[];
  /** wstrzykiwany w testach; domyślnie systemowy resolver */
  lookup?: FunkcjaLookup;
}

const LIMITY_CZASU = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
  dnsTimeout: 5_000,
};

/** Wynik testu połączenia w postaci do pokazania człowiekowi. */
export type WynikTestu =
  | { ok: true; cel: CelPolaczenia }
  | { ok: false; kod: string; komunikat: string };

/** Jeden adres, bez CRLF i bez listy: `to` z przecinkiem wysłałby maila do kilku osób. */
function sprawdzAdres(adres: string): string {
  const czysty = adres.trim();
  if (!czysty || /[\r\n<>,;"\x00-\x1f\s]/.test(czysty) || czysty.split("@").length !== 2) {
    throw new Error("SMTP: adres odrzucony jako niebezpieczny lub niepoprawny");
  }
  return czysty;
}

function bezNowychLinii(tekst: string): string {
  return tekst.replace(/[\r\n\x00]+/g, " ").trim();
}

interface BladNodemailera {
  message?: string;
  code?: string;
  responseCode?: number;
  response?: string;
  command?: string;
}

/**
 * Błąd nodemailera w słowach operatora. Rozróżniamy to, co człowiek naprawia inaczej:
 * zły login, timeout, certyfikat, odmowa połączenia, brak TLS. `response` serwera
 * dokładamy, bo tam bywa jedyna konkretna wskazówka ("535 5.7.8 Username and Password
 * not accepted"). Hasła w nim nie ma — serwer SMTP go nie odsyła.
 */
export function opisBleduSmtp(blad: unknown, cel?: { host: string; port: number }): { kod: string; komunikat: string } {
  if (blad instanceof BladHostaSmtp) return { kod: blad.kod, komunikat: blad.message };
  const b = (blad ?? {}) as BladNodemailera;
  const tresc = String(b.message ?? blad);
  const gdzie = cel ? `${cel.host}:${cel.port}` : "serwer";
  const odpowiedz = b.response ? ` Serwer odpowiedział: „${bezNowychLinii(b.response).slice(0, 300)}”.` : "";

  if (b.code === "EAUTH") {
    return { kod: "logowanie", komunikat: `Serwer odrzucił login lub hasło.${odpowiedz}` };
  }
  if (/ECONNREFUSED/.test(tresc)) {
    return { kod: "odmowa", komunikat: `${gdzie} odmówił połączenia. Sprawdź port i czy serwer przyjmuje połączenia z zewnątrz.` };
  }
  if (b.code === "ETIMEDOUT" || /timeout|timed out/i.test(tresc)) {
    return {
      kod: "timeout",
      komunikat: `${gdzie} nie odpowiedział w czasie. Najczęściej zły port albo zapora blokuje ruch (wielu dostawców blokuje port 25).`,
    };
  }
  if (/certificate|self[- ]signed|CERT_|unable to verify|altnames|hostname\/IP does not match/i.test(tresc)) {
    return {
      kod: "certyfikat",
      komunikat: `Certyfikat serwera ${gdzie} nie przeszedł weryfikacji (${bezNowychLinii(tresc).slice(0, 160)}). Podaj nazwę, na którą wystawiony jest certyfikat, np. smtp.dostawca.pl zamiast adresu IP.`,
    };
  }
  if (/wrong version number|packet length too long|unknown protocol/i.test(tresc)) {
    return {
      kod: "tryb_tls",
      komunikat: `Tryb bezpieczeństwa nie pasuje do portu: na porcie 465 wybierz TLS, na 587 i 25 STARTTLS.`,
    };
  }
  if (b.code === "ETLS" || b.command === "STARTTLS") {
    return { kod: "starttls", komunikat: `Serwer nie obsługuje STARTTLS na tym porcie.${odpowiedz}` };
  }
  if (b.responseCode) {
    return { kod: "odpowiedz_serwera", komunikat: `Serwer odmówił przy ${b.command ?? "rozmowie"}.${odpowiedz}` };
  }
  return { kod: "inny", komunikat: `Połączenie z ${gdzie} nie powiodło się: ${bezNowychLinii(tresc).slice(0, 200)}` };
}

/**
 * Błąd wysyłki w kształcie, który rozumie `klasaBledu` w wyslij-kampanie.ts (ten plik
 * nie zmienia tamtej klasyfikacji, tylko mówi jej językiem):
 *   - odmowa połączenia -> `code` z listy socketu (ECONNREFUSED/...) => przejściowy,
 *   - odpowiedź serwera przy RCPT TO / DATA -> "dostano: NNN ..." => 4xx przejściowy,
 *     5xx trwały i klasyfikacja odbicia z kodu,
 *   - wszystko inne (logowanie, TLS, odmowa przy MAIL FROM, timeout) -> bez kodu
 *     odpowiedzi => "nieznany", wiadomość zostaje w sending i rozstrzyga ją rekoncyliacja.
 *     Świadomie: odmowa logowania albo nadawcy to problem KONFIGURACJI serwera, a nie
 *     adresu odbiorcy. Przepuszczenie "535 5.7.8" jako trwałej odmowy wykluczyłoby
 *     odbiorcę za błąd w haśle klienta.
 */
function bladWysylki(blad: unknown): Error {
  const b = (blad ?? {}) as BladNodemailera & { errno?: number; syscall?: string };
  const tresc = String(b.message ?? blad);
  const socket = tresc.match(/\b(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)\b/);
  if (b.command === "CONN" && socket) {
    const e = new Error(`SMTP: ${bezNowychLinii(tresc)}`) as Error & { code?: string };
    e.code = socket[1];
    return e;
  }
  const komenda = String(b.command ?? "").toUpperCase();
  // TYLKO odpowiedź na RCPT TO albo DATA mówi coś o odbiorcy/treści. Odpowiedź bez znanej
  // komendy (albo przy AUTH/MAIL FROM) to sprawa konfiguracji serwera — idzie jako „nieznany".
  if (b.responseCode && b.response && (komenda.startsWith("RCPT") || komenda.startsWith("DATA"))) {
    return new Error(`SMTP: odmowa przy ${komenda}, dostano: ${bezNowychLinii(b.response)}`);
  }
  return new Error(`SMTP: ${opisBleduSmtp(blad).komunikat}`);
}

export class AdapterNodemailer implements DostawcaWysylki {
  readonly nazwa: string;
  #konfiguracja: KonfiguracjaSerwera;
  #opcje: OpcjeAdaptera;
  #cel: Promise<CelPolaczenia> | null = null;

  constructor(konfiguracja: KonfiguracjaSerwera, opcje: OpcjeAdaptera) {
    this.#konfiguracja = konfiguracja;
    this.#opcje = opcje;
    // nazwa trafia do messages.provider (A3): historia ma mówić, KTÓRYM serwerem mail wyszedł
    this.nazwa = `smtp:${konfiguracja.host.trim().toLowerCase()}`;
  }

  /** Cel sprawdzany raz na instancję (partię): jedna odpowiedź DNS dla całej partii. */
  #rozwiaz(): Promise<CelPolaczenia> {
    this.#cel ??= rozwiazHostSmtp(this.#konfiguracja.host, this.#konfiguracja.port, this.#opcje);
    return this.#cel;
  }

  /**
   * Jedna PULA połączeń na instancję adaptera, czyli na partię wysyłki: dotąd każda
   * wiadomość otwierała własne TCP + TLS + AUTH (audyt 24.09, #5: ~70 ms/mail, a Google
   * Workspace i Microsoft 365 odrzucają tysiące krótkich połączeń). Pula trzyma
   * połączenie między wiadomościami i zamyka się w `zamknij()` po partii.
   * Idempotencja NIE zależy od puli: stan wiadomości i tak przechodzi queued → sending
   * → sent per wiadomość, w osobnych transakcjach, przed i po `sendMail`.
   */
  #pula: ReturnType<typeof nodemailer.createTransport> | null = null;

  #transport(cel: CelPolaczenia, pula = false) {
    const k = this.#konfiguracja;
    return nodemailer.createTransport({
      ...(pula
        ? {
            pool: true,
            // dwa równoległe połączenia: więcej nie przyspiesza przy limitach dostawców
            // skrzynek, a jedno robi z pętli wysyłki ścisłą kolejkę
            maxConnections: 2,
            // po stu wiadomościach połączenie jest odnawiane (część serwerów zamyka
            // sesję po N wiadomościach bez ostrzeżenia)
            maxMessages: 100,
          }
        : {}),
      // łączymy się z SPRAWDZONYM adresem IP; nazwa idzie tylko do SNI i certyfikatu
      host: cel.adres,
      port: cel.port,
      secure: k.bezpieczenstwo === "tls",
      requireTLS: k.bezpieczenstwo === "starttls",
      ignoreTLS: k.bezpieczenstwo === "none",
      auth: k.uzytkownik ? { user: k.uzytkownik, pass: k.haslo?.ujawnij() ?? "" } : undefined,
      // nazwa do SNI i do weryfikacji certyfikatu; przy hoście podanym jako IP nodemailer
      // sprawdza certyfikat względem samego IP (SNI z adresem IP jest niedozwolone)
      servername: isIP(cel.host) ? undefined : cel.host,
      tls: {
        // certyfikat sprawdzany zawsze poza jawnym serwerem deweloperskim
        rejectUnauthorized: !cel.deweloperski,
        minVersion: "TLSv1.2",
      },
      ...LIMITY_CZASU,
      // bez logów nodemailera: logger z debug potrafi wypisać rozmowę AUTH
      logger: false,
      debug: false,
    });
  }

  /**
   * Test połączenia: rozwiązanie z bramką SSRF, TLS i logowanie (nodemailer `verify`).
   * Nie rzuca — wynik ma iść prosto do człowieka.
   */
  async testujPolaczenie(): Promise<WynikTestu> {
    let cel: CelPolaczenia;
    try {
      cel = await this.#rozwiaz();
    } catch (blad) {
      return { ok: false, ...opisBleduSmtp(blad) };
    }
    const transport = this.#transport(cel);
    try {
      await transport.verify();
      return { ok: true, cel };
    } catch (blad) {
      return { ok: false, ...opisBleduSmtp(blad, cel) };
    } finally {
      transport.close();
    }
  }

  async wyslij(w: Wiadomosc): Promise<WynikWysylki> {
    return this.#nadaj(w);
  }

  /** Zamyka pulę połączeń po partii. Bezpieczne wielokrotnie i bez otwartej puli. */
  async zamknij(): Promise<void> {
    const pula = this.#pula;
    this.#pula = null;
    if (pula) pula.close();
  }

  /** Wiadomość testowa z ekranu ustawień: bez nagłówków wypisania, bo nie idzie do listy. */
  async wyslijTestowa(w: Omit<Wiadomosc, "adresWypisania">): Promise<WynikWysylki> {
    return this.#nadaj(w);
  }

  async #nadaj(w: Omit<Wiadomosc, "adresWypisania"> & { adresWypisania?: string }): Promise<WynikWysylki> {
    const od = sprawdzAdres(w.od);
    const doAdres = sprawdzAdres(w.do);
    const odpowiedzDo = w.odpowiedzDo ? sprawdzAdres(w.odpowiedzDo) : undefined;
    let cel: CelPolaczenia;
    try {
      cel = await this.#rozwiaz();
    } catch (blad) {
      throw bladWysylki(blad);
    }
    // pula budowana leniwie, przy pierwszej wiadomości partii; test połączenia (verify)
    // nie korzysta z puli, żeby nie zostawiać otwartego połączenia po samym teście
    this.#pula ??= this.#transport(cel, true);
    const transport = this.#pula;
    // Message-ID kontrolowany przez nas i UNIKALNY: lewa strona to idempotencyKey (id
    // wiadomości), prawa domena nadawcy — RFC 5322 chce po prawej nazwy domenowej, a po
    // tym identyfikatorze skrzynka zwrotna dopasowuje odbicia (DSN) do wiadomości.
    const messageId = `<${w.idempotencyKey}@${od.split("@")[1]}>`;
    const naglowki: Record<string, string> = {};
    if (w.adresWypisania) {
      // RFC 8058: wypisanie jednym kliknięciem
      naglowki["List-Unsubscribe"] = `<${bezNowychLinii(w.adresWypisania)}>`;
      naglowki["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
    try {
      const info = await transport.sendMail({
        from: { name: bezNowychLinii(w.odNazwa ?? ""), address: od },
        to: doAdres,
        replyTo: odpowiedzDo,
        // koperta podana jawnie: dokładnie jeden odbiorca i MAIL FROM = adres nadawcy,
        // dzięki czemu SPF sprawdzany jest na domenie z From (wyrównanie DMARC)
        envelope: { from: od, to: [doAdres] },
        subject: bezNowychLinii(w.temat),
        html: w.html,
        messageId,
        headers: naglowki,
      });
      if (!info.accepted?.length) {
        throw bladWysylki({ command: "RCPT TO", responseCode: 550, response: String(info.response ?? "odbiorca odrzucony") });
      }
      // identyfikatorem u dostawcy jest Message-ID, który kontrolujemy przez idempotencyKey
      // (ten sam kontrakt co w smtp.ts) — po nim da się spytać serwer, czy mail wyszedł.
      // `sendingIp` celowo puste: znamy tylko adres serwera, KTÓREMU oddaliśmy maila, a nie
      // IP, z którego jego serwer wyśle go dalej. Wpisanie tu adresu przyjmującego
      // skłamałoby w diagnostyce dostarczalności (A3).
      return { providerId: info.messageId ?? messageId, handedOffAt: new Date() };
    } catch (blad) {
      if (blad instanceof Error && blad.message.startsWith("SMTP: ")) throw blad;
      throw bladWysylki(blad);
    }
  }
}
