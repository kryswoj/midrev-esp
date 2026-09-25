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

/**
 * Jeden adres, bez CRLF i bez listy: `to` z przecinkiem wysłałby maila do kilku osób.
 * Kształt błędu zależy od tego, CZYJ to adres (review A2 #9): zły nadawca albo Reply-To
 * to konfiguracja sklepu (ENADAWCA — partia staje, nic nie wyszło), zły odbiorca to
 * trwała odmowa tej jednej wiadomości (`dropped`), a nie „nieznany" kończący się `held`.
 */
function sprawdzAdres(adres: string, czyj: "nadawca" | "odbiorca"): string {
  const czysty = adres.trim();
  if (!czysty || /[\r\n<>,;"\x00-\x1f\s]/.test(czysty) || czysty.split("@").length !== 2) {
    if (czyj === "nadawca") throw bladNadawcy("adres nadawcy albo odpowiedzi odrzucony jako niebezpieczny lub niepoprawny");
    // kształt odpowiedzi 5xx (klasyfikacja jak odmowy serwera przy RCPT TO), kod własny:
    // silnik nie robi z NASZEJ walidacji dowodu do wykluczenia GLOBALNEGO
    const e = new Error("SMTP: adres odbiorcy odrzucony przed wysyłką jako niepoprawny, dostano: 553 5.1.3 niepoprawna składnia adresu odbiorcy") as Error & { code?: string };
    e.code = "EADRES_ODBIORCY";
    throw e;
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
 * Błąd wysyłki w kształcie, który rozumie `klasaBledu` w wyslij-kampanie.ts:
 *   - odmowa nawiązania TCP (`connect ECONNREFUSED …` przy CONN) -> `code` z listy
 *     socketu => przejściowy,
 *   - błąd ETAPU NADAWCY -> `code: "ENADAWCA"` => partia staje, wiadomości wracają do
 *     kolejki bez zużycia prób (triaż A, P1). Etap nadawcy to wszystko PRZED pierwszym
 *     RCPT TO: rozwiązanie hosta, TLS/STARTTLS, powitanie, EHLO/HELO, AUTH (np. 535),
 *     MAIL FROM (np. 421/432 u Google i M365 przy limicie nadawcy), zniszczone
 *     połączenie zgłoszone przez API przed rozpoczęciem wysyłki. Żaden z nich nie mówi
 *     nic o odbiorcy, a do DATA nie doszło, więc mail na pewno nie wyszedł.
 *     Świadomie POZA tą klasą: EMESSAGE (rozmiar wiadomości — sprawa tej jednej
 *     wiadomości; jako błąd nadawcy zablokowałaby kolejkę sklepu na zawsze).
 *   - odpowiedź serwera przy RCPT TO / DATA -> "dostano: NNN ..." => 4xx przejściowy,
 *     5xx trwały i klasyfikacja odbicia z kodu,
 *   - wszystko inne (zerwane połączenie, timeout gniazda w trakcie rozmowy) -> bez kodu
 *     => "nieznany", wiadomość zostaje w sending i rozstrzyga ją rekoncyliacja.
 *     Przepuszczenie "535 5.7.8" jako trwałej odmowy wykluczyłoby odbiorcę za błąd
 *     w haśle klienta, a jako „nieznany" wysłałoby całą partię do held.
 */
function czyBladNadawcy(b: BladNodemailera, tresc: string): boolean {
  const komenda = String(b.command ?? "").toUpperCase();
  if (b.code === "EMESSAGE") return false;
  if (b.code === "EAUTH" || b.code === "ETLS" || b.code === "EDNS") return true;
  if (/^(AUTH|EHLO|HELO|LHLO|STARTTLS|MAIL)\b/.test(komenda)) return true;
  // API: nodemailer tak oznacza błędy zgłoszone przed rozmową o tej wiadomości
  // (brak danych logowania, połączenie zniszczone przed startem wysyłki)
  if (komenda === "API" && (b.code === "ECONNECTION" || b.code === "EAUTH")) return true;
  // TCP nie zestawione albo serwer nie przywitał się w czasie: rozmowy nie było
  if (komenda === "CONN" && b.code === "ETIMEDOUT" && /^(Connection timeout|Greeting never received)$/.test(tresc)) return true;
  // Dławienie w powitaniu (review A2 #1): „421 4.7.0 Too many connections", „421 4.3.2
  // Service not available" u Google i M365. nodemailer 10 (smtp-connection
  // _actionGreeting) zgłasza każde powitanie inne niż 220 jako EPROTOCOL/CONN
  // „Invalid greeting" — dalej niż do powitania rozmowa nie doszła.
  if (komenda === "CONN" && b.code === "EPROTOCOL" && /^Invalid greeting\b/.test(tresc)) return true;
  if (!b.code && !b.command) {
    // Pula (smtp-pool, maxRequeues 0): serwer zamknął TCP, zanim się przywitał.
    // smtp-connection._onClose zamyka BEZ błędu wyłącznie w stanie oczekiwania na
    // powitanie (albo po QUIT, gdy wiadomość jest już rozliczona); zamknięcie w każdym
    // innym stanie, w tym po DATA, daje ECONNECTION/CONN „Connection closed unexpectedly",
    // które pula oddaje jako błąd i ten komunikat się wtedy nie pojawia.
    if (/^Reached maximum number of retries after connection was closed$/.test(tresc)) return true;
    // pool-resource.connect: zamknięcie przed zalogowaniem, jeszcze bez żadnej wiadomości
    if (/^Unexpected socket close$/.test(tresc)) return true;
  }
  return false;
}

function bladNadawcy(tresc: string): Error {
  const e = new Error(`SMTP: błąd nadawcy: ${bezNowychLinii(tresc).slice(0, 400)}`) as Error & { code?: string };
  e.code = "ENADAWCA";
  return e;
}

export function bladWysylki(blad: unknown): Error {
  if (blad instanceof BladHostaSmtp) return bladNadawcy(blad.message);
  const b = (blad ?? {}) as BladNodemailera & { errno?: number; syscall?: string };
  const tresc = String(b.message ?? blad);
  // Tylko komunikat odmowy zestawienia TCP od Node (`connect ECONNREFUSED 1.2.3.4:25`).
  // Bez kotwicy regex łapał też kod błędu w dowolnym miejscu komunikatu gniazda (CONN
  // to także błąd gniazda PO kropce kończącej DATA), a tam mail mógł już wyjść.
  // Kod gniazda zostaje (ECONNREFUSED/…); silnik traktuje go jak błąd nadawcy: serwer
  // leży, nic nie wyszło, a ta sama odmowa spotka każdą wiadomość partii.
  const socket = tresc.match(/^connect (ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)\b/);
  if (b.command === "CONN" && socket) {
    const e = new Error(`SMTP: ${bezNowychLinii(tresc)}`) as Error & { code?: string };
    e.code = socket[1];
    return e;
  }
  const komenda = String(b.command ?? "").toUpperCase();
  // opis z odpowiedzią serwera (tam bywa jedyna wskazówka, np. „535 5.7.8"); hasła
  // w nim nie ma, bo serwer SMTP go nie odsyła
  if (czyBladNadawcy(b, tresc)) return bladNadawcy(opisBleduSmtp(blad).komunikat);
  // TYLKO odpowiedź na RCPT TO albo DATA mówi coś o odbiorcy/treści.
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
            // jedno połączenie: pętla wysyłki i tak podaje wiadomości po jednej (stan
            // każdej przechodzi przez bazę przed i po `sendMail`), więc drugie połączenie
            // niczego nie przyspiesza, a przy limitach dostawców skrzynek tylko szkodzi
            maxConnections: 1,
            // po stu wiadomościach połączenie jest odnawiane (część serwerów zamyka
            // sesję po N wiadomościach bez ostrzeżenia)
            maxMessages: 100,
            // Pula NIE ponawia sama (triaż A, P2): domyślnie wiadomość z połączenia, które
            // padło, wraca do kolejki puli i idzie drugi raz innym połączeniem — także gdy
            // pierwsze padło już po kropce kończącej DATA. Ponawianie jest wyłącznie
            // nasze, z naszą idempotencją (stan wiadomości w bazie, rekoncyliacja).
            maxRequeues: 0,
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
    const od = sprawdzAdres(w.od, "nadawca");
    const odpowiedzDo = w.odpowiedzDo ? sprawdzAdres(w.odpowiedzDo, "nadawca") : undefined;
    const doAdres = sprawdzAdres(w.do, "odbiorca");
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
