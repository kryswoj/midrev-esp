/**
 * Klasyfikacja wyniku wysyłki i detekcja zdarzeń maszynowych (Blok A, A1 i A2).
 *
 * Czysta domena: żadnego dostępu do bazy ani do sieci. Wejściem jest to, co powiedział
 * dostawca, wyjściem decyzja, którą zapisujemy W SAMYM ZDARZENIU. Powód, dla którego
 * to musi być tutaj, a nie w handlerze webhooka: klasyfikacja dokleta po fakcie nie
 * istnieje — surowej odpowiedzi serwera odbiorcy nikt nie przechowuje drugi raz.
 */

/** Twarde kontra miękkie. `nieustalone` NIE jest synonimem `soft` — patrz komentarz w 0014. */
export type KlasaOdbicia = "hard" | "soft" | "undetermined";

/**
 * Kategorie w brzmieniu, które ma sens dla człowieka czytającego raport.
 * Zestaw wzięty z żywego Klaviyo (KLAVIYO-MODULY 3.2, próbka 50 odrzuceń):
 * Invalid Address 22, Content 13, Unclassified 6, External Error 5, Mailbox Unavailable 4.
 */
export type KategoriaOdbicia =
  | "invalid_address"
  | "mailbox_unavailable"
  | "mailbox_full"
  | "message_too_large"
  | "content"
  | "spam_block"
  | "external_error"
  | "suppressed_by_provider"
  | "unclassified";

/** Typy zdarzeń o negatywnym wyniku. Rozdział `dropped` od `bounced` to cała istota A2. */
export type TypNiepowodzenia = "bounced" | "dropped" | "complained" | "failed";

export interface Klasyfikacja {
  /**
   * `dropped` — nie wyszło z naszej strony (dostawca odmówił przy handoffie, adres na
   *   jego liście supresji, odrzucenie treści). To jest problem konfiguracji albo higieny.
   * `bounced` — odbiło się od serwera odbiorcy. Dopiero tu ma sens hard/soft.
   * `complained` — pętla zwrotna od dostawcy skrzynki.
   * `failed` — awaria bez rozstrzygniętej klasy (wyczerpane próby, wynik nieznany).
   */
  typZdarzenia: TypNiepowodzenia;
  klasa: KlasaOdbicia | null;
  kategoria: KategoriaOdbicia | null;
  kodSmtp: string | null;
  powodDostawcy: string | null;
  /** Decyzja: czy adres ma trafić na wykluczenia. Odpowiednik `add_exclusion` z Klaviyo. */
  wykluczAdres: boolean;
  /**
   * Czy to zdarzenie wchodzi do naszego wskaźnika reputacji właściwego dla swojego typu
   * (hard bounce rate przy odbiciach, complaint rate przy skargach). SES wprost wyłącza
   * z bounce rate podtypy `OnAccountSuppressionList` i `OnTenantSuppressionList`, a IANA
   * mówi, że `not-spam` nie jest skargą. Wliczenie ich zawyżyłoby metrykę i wstrzymało
   * tenanta bez powodu.
   */
  liczySieDoWskaznika: boolean;
}

/**
 * Wyciąga kod z odpowiedzi SMTP. Najpierw kod rozszerzony (RFC 3463, np. `5.1.1`),
 * bo niesie przyczynę; dopiero potem podstawowy trzycyfrowy (np. `550`), bo ten mówi
 * wyłącznie "stałe albo chwilowe". Zwracamy tekst, nie liczbę: `5.5.1` i `551` to dwie
 * różne rzeczy, a jako liczba obie zlałyby się w jedno.
 */
export function wyciagnijKodSmtp(tresc: string): string | null {
  const rozszerzony = tresc.match(/\b([45])\.(\d{1,3})\.(\d{1,3})\b/);
  if (rozszerzony) return rozszerzony[0];
  const podstawowy = tresc.match(/\b([45])\d{2}\b/);
  return podstawowy ? podstawowy[0] : null;
}

/** Kategoria wg części "subject.detail" kodu rozszerzonego (RFC 3463). */
function kategoriaZKodu(subject: number, detail: number): KategoriaOdbicia {
  if (subject === 1) {
    // 1.x to status ADRESU: nie istnieje, niepoprawny, nie przyjmuje poczty
    return "invalid_address";
  }
  if (subject === 2) {
    if (detail === 2) return "mailbox_full";
    if (detail === 3) return "message_too_large";
    return "mailbox_unavailable";
  }
  if (subject === 3) {
    if (detail === 4) return "message_too_large";
    return "external_error";
  }
  if (subject === 4 || subject === 5) return "external_error";
  if (subject === 6) return "content";
  if (subject === 7) return "spam_block";
  return "unclassified";
}

/**
 * Kategorie, które przy kodzie 5xx MIMO WSZYSTKO są miękkie. To jest miejsce, w którym
 * najłatwiej zrobić krzywdę: pełna skrzynka i blokada antyspamowa odpowiadają kodem
 * stałym, ale wykluczenie tych adresów skasowałoby z bazy żywych ludzi. Klaviyo ma
 * dokładnie ten sam rozkład — na 50 odrzuceń tylko 30 jest twardych, mimo że prawie
 * wszystkie kody są 5xx.
 */
const MIEKKIE_MIMO_5XX: ReadonlySet<KategoriaOdbicia> = new Set<KategoriaOdbicia>([
  "mailbox_full",
  "message_too_large",
  "content",
  "spam_block",
  "external_error",
  "unclassified",
]);

/**
 * Klasyfikacja odpowiedzi SMTP (nasz adapter i każdy dostawca raportujący surowy kod).
 *
 * `typZdarzenia` decyduje o tym, czy mail w ogóle opuścił naszą stronę, więc jest
 * argumentem wywołania, a nie zgadywanką: odmowa przy handoffie to `dropped`,
 * raport zwrotny od serwera odbiorcy to `bounced`.
 */
export function klasyfikujOdpowiedzSmtp(
  tresc: string,
  typZdarzenia: "bounced" | "dropped" = "bounced",
): Klasyfikacja {
  const kod = wyciagnijKodSmtp(tresc);
  const powodDostawcy = tresc.trim() ? tresc.trim().slice(0, 2000) : null;

  if (!kod) {
    // Brak kodu to brak wiedzy, a nie brak problemu. Nie wykluczamy adresu na podstawie
    // czegoś, czego nie umiemy nazwać.
    return {
      typZdarzenia,
      klasa: "undetermined",
      kategoria: "unclassified",
      kodSmtp: null,
      powodDostawcy,
      wykluczAdres: false,
      liczySieDoWskaznika: false,
    };
  }

  const rozszerzony = kod.includes(".");
  const stale = kod.startsWith("5");
  const [, subject, detail] = rozszerzony
    ? kod.split(".").map(Number)
    : [Number(kod[0]), Number(kod.slice(1, 2)), Number(kod.slice(2))];

  const kategoria = rozszerzony ? kategoriaZKodu(subject, detail) : "unclassified";
  const klasa: KlasaOdbicia = !stale
    ? "soft"
    : MIEKKIE_MIMO_5XX.has(kategoria)
      ? "soft"
      : kategoria === "unclassified"
        ? "undetermined"
        : "hard";

  return {
    typZdarzenia,
    klasa,
    kategoria,
    kodSmtp: kod,
    powodDostawcy,
    // wykluczamy WYŁĄCZNIE przy twardym odbiciu: adres, który nie istnieje, nie zacznie
    // istnieć, a każde inne odbicie bywa chwilowe
    wykluczAdres: klasa === "hard",
    // `dropped` nie wchodzi do bounce rate: mail nigdy nie dotarł do serwera odbiorcy,
    // więc nie mówi nic o naszej reputacji u niego
    liczySieDoWskaznika: typZdarzenia === "bounced" && klasa === "hard",
  };
}

/**
 * Klasyfikacja odbicia z Amazon SES (SES-BYOD-SPEC, sekcja 5, tabela bounceType/bounceSubType).
 * Adaptera SES jeszcze nie ma (Blok D), ale mapowanie należy do domeny i powstaje razem
 * ze schematem — handler webhooka ma je zastać gotowe i przetestowane.
 */
export function klasyfikujOdbicieSes(
  bounceType: string,
  bounceSubType: string,
  diagnosticCode?: string,
): Klasyfikacja {
  const powodDostawcy = diagnosticCode?.trim() ? diagnosticCode.trim().slice(0, 2000) : null;
  const kodSmtp = diagnosticCode ? wyciagnijKodSmtp(diagnosticCode) : null;

  // Adres był na liście supresji (SES globalnej, kontowej albo tenantowej) — SES w ogóle
  // nie próbował wysłać. To `dropped`, nie `bounced`, i SES wprost NIE liczy tego do
  // swojego bounce rate. Nasz wskaźnik musi robić tak samo.
  const naSupresji = [
    "Suppressed",
    "OnAccountSuppressionList",
    "OnTenantSuppressionList",
    "EmailValidationSuppressed",
  ].includes(bounceSubType);
  if (naSupresji) {
    return {
      typZdarzenia: "dropped",
      klasa: "hard",
      kategoria: "suppressed_by_provider",
      kodSmtp,
      powodDostawcy,
      wykluczAdres: true,
      liczySieDoWskaznika: false,
    };
  }

  if (bounceType === "Permanent") {
    return {
      typZdarzenia: "bounced",
      klasa: "hard",
      kategoria: bounceSubType === "NoEmail" ? "invalid_address" : "unclassified",
      kodSmtp,
      powodDostawcy,
      wykluczAdres: true,
      liczySieDoWskaznika: true,
    };
  }

  if (bounceType === "Transient") {
    const kategoria: KategoriaOdbicia =
      bounceSubType === "MailboxFull"
        ? "mailbox_full"
        : bounceSubType === "MessageTooLarge"
          ? "message_too_large"
          : bounceSubType === "ContentRejected"
            ? "content"
            : bounceSubType === "AttachmentRejected"
              ? "content"
              : "external_error";
    return {
      typZdarzenia: "bounced",
      klasa: "soft",
      kategoria,
      kodSmtp,
      powodDostawcy,
      // miękkie odbicie NIE wyklucza adresu po jednym razie; supresja po serii soft
      // bounce'ów to osobna decyzja higieny listy, nie reakcja na pojedyncze zdarzenie
      wykluczAdres: false,
      liczySieDoWskaznika: false,
    };
  }

  // Undetermined/Undetermined: SES nie ustalił przyczyny. Potraktowanie tego jak soft
  // kazałoby nam ponawiać wysyłkę na adres, o którym nie wiemy nic.
  return {
    typZdarzenia: "bounced",
    klasa: "undetermined",
    kategoria: "unclassified",
    kodSmtp,
    powodDostawcy,
    wykluczAdres: false,
    liczySieDoWskaznika: false,
  };
}

/**
 * Skarga z pętli zwrotnej. Zwraca `null`, gdy zgłoszenie NIE jest skargą: `not-spam`
 * wg IANA oznacza "to nie był spam" i podbicie nim licznika skarg jest błędem, który
 * potrafi wstrzymać zdrowego nadawcę.
 */
export function klasyfikujSkarge(
  complaintFeedbackType?: string,
  complaintSubType?: string,
): Klasyfikacja | null {
  if (complaintFeedbackType === "not-spam") return null;
  const naSupresji =
    complaintSubType === "OnAccountSuppressionList" || complaintSubType === "OnTenantSuppressionList";
  return {
    typZdarzenia: "complained",
    klasa: null,
    kategoria: null,
    kodSmtp: null,
    powodDostawcy: complaintFeedbackType ?? null,
    // skarga zawsze wyklucza adres: człowiek powiedział wprost, że nie chce tych maili
    wykluczAdres: true,
    liczySieDoWskaznika: !naSupresji,
  };
}

// ---------------------------------------------------------------------------
// A1. Otwarcia maszynowe i kliknięcia botów.
// ---------------------------------------------------------------------------

export type PowodAutomatu =
  | "apple_mpp"
  | "proxy_obrazkow"
  | "skaner_bezpieczenstwa"
  | "klient_automatyczny"
  | "dostawca_oznaczyl"
  | "brak_przeslanek";

export interface WerdyktAutomatu {
  /** `null` znaczy "nie wiemy", a nie "człowiek". Raport nie ma prawa czytać tego inaczej. */
  automat: boolean | null;
  powod: PowodAutomatu | null;
}

/** Proxy obrazków operatora: pobiera pixel za użytkownika, często zanim ten otworzy mail. */
const PROXY_OBRAZKOW = ["GoogleImageProxy", "YahooMailProxy", "ImageProxy", "Proxy-Image"];

/**
 * Bramki bezpieczeństwa skanujące linki przed dostarczeniem. To jest główne źródło
 * fałszywych kliknięć — Microsoft Safe Links potrafi kliknąć każdy link w mailu.
 */
const SKANERY_BEZPIECZENSTWA = [
  "SafeLinks",
  "Barracuda",
  "Proofpoint",
  "Mimecast",
  "MessageLabs",
  "Symantec",
  "FireEye",
  "Forcepoint",
  "IronPort",
  "Zscaler",
  "Sophos",
  "Bitdefender",
  "TrendMicro",
  "Trend Micro",
  "SpamTitan",
  "MailScanner",
  "Defender",
];

/** Klienci nieinteraktywni: skrypty, headless, crawlery. Nigdy nie są człowiekiem. */
const KLIENCI_AUTOMATYCZNI = [
  "curl/",
  "Wget",
  "python-requests",
  "Go-http-client",
  "okhttp",
  "Java/",
  "HeadlessChrome",
  "PhantomJS",
  "bot",
  "Bot",
  "crawler",
  "Crawler",
  "spider",
  "Spider",
];

function zawiera(igla: readonly string[], siano: string): boolean {
  return igla.some((f) => siano.includes(f));
}

/**
 * Sieć Apple. 17.0.0.0/8 należy w całości do Apple i stamtąd chodzi skaner Mail Privacy
 * Protection. To jest HEURYSTYKA, nie dowód: iCloud Private Relay wychodzi z zakresów
 * spoza tej puli, więc brak trafienia niczego nie przesądza. Sygnałem rozstrzygającym
 * jest flaga od dostawcy (`isBotEvent` w SES), gdy ją mamy.
 */
function apple(ip?: string | null): boolean {
  if (!ip) return false;
  return /^17\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip.trim());
}

/**
 * Wydaje werdykt o tym, czy zdarzenie wygenerowała maszyna. Kolejność jest celowa:
 * najpierw to, co powiedział dostawca (ma dane, których my nie mamy), potem nasze
 * heurystyki, a na końcu uczciwe "sprawdziliśmy i nic nie znaleźliśmy".
 */
export function ocenAutomat(wejscie: {
  kind: "open" | "click" | "delivery_delay";
  userAgent?: string | null;
  ip?: string | null;
  /** `isBotEvent` dostawcy zrzutowane na bool. `undefined` = dostawca nic nie powiedział. */
  flagaDostawcy?: boolean;
}): WerdyktAutomatu {
  // DeliveryDelay nie jest działaniem człowieka ani bota, tylko stanem transportu:
  // wpisanie tam czegokolwiek zafałszowałoby liczniki otwarć i klików.
  if (wejscie.kind === "delivery_delay") return { automat: null, powod: null };

  if (wejscie.flagaDostawcy !== undefined) {
    return { automat: wejscie.flagaDostawcy, powod: "dostawca_oznaczyl" };
  }

  const ua = wejscie.userAgent?.trim();
  // Bez user agenta i bez flagi dostawcy nie mamy CZYM ocenić. Wpisanie tu `false`
  // byłoby zmyślaniem — i dokładnie tym, co psuje statystyki otwarć przy MPP.
  if (!ua) return { automat: null, powod: null };

  if (zawiera(PROXY_OBRAZKOW, ua)) return { automat: true, powod: "proxy_obrazkow" };
  if (zawiera(SKANERY_BEZPIECZENSTWA, ua)) return { automat: true, powod: "skaner_bezpieczenstwa" };
  if (zawiera(KLIENCI_AUTOMATYCZNI, ua)) return { automat: true, powod: "klient_automatyczny" };
  if (wejscie.kind === "open" && apple(wejscie.ip)) return { automat: true, powod: "apple_mpp" };

  // Sprawdziliśmy wszystko, co umiemy, i nic nie wskazuje na maszynę. To jest słabsze
  // niż `Unlikely` od dostawcy, dlatego powód zostaje zapisany i da się go odfiltrować.
  return { automat: false, powod: "brak_przeslanek" };
}
