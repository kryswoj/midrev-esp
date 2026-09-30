/**
 * Port dostawcy wysyłki (AD-7). Rdzeń nie zna nazwy dostawcy: dziś za portem stoi
 * lokalny Mailpit przez SMTP, docelowo Amazon SES, a wymiana jest konfiguracją.
 *
 * `idempotencyKey` jest obowiązkowy (AD-23): to identyfikator wiadomości, po którym
 * przy wznowieniu po awarii można spytać dostawcę, czy mail już wyszedł.
 */
export interface Wiadomosc {
  do: string;
  od: string;
  odNazwa?: string;
  /** adres odpowiedzi (Reply-To), gdy inny niż nadawca */
  odpowiedzDo?: string;
  temat: string;
  html: string;
  /** absolutny adres wypisania jednym kliknięciem (RFC 8058) */
  adresWypisania: string;
  idempotencyKey: string;
}

/**
 * Wynik przyjęcia wiadomości przez dostawcę.
 *
 * Poza identyfikatorem wracają stąd POLA DIAGNOSTYCZNE (Blok A, A3). Są opcjonalne,
 * bo nie każdy dostawca je podaje (Mailpit nie podaje żadnego), ale nie są ozdobą:
 * przy wspólnej puli IP to jedyny sposób, żeby po fakcie powiedzieć, czy problem
 * z dostarczalnością dotyczy naszego nadawcy, czy sąsiada z tej samej puli.
 * Odpowiedniki pól `$internal` z Klaviyo (KLAVIYO-MODULY 4.7).
 */
export interface WynikWysylki {
  providerId: string;
  /**
   * Identyfikator nadany przez DOSTAWCĘ w odpowiedzi SMTP („250 Ok <id>"), gdy inny niż
   * nasz Message-ID. SES nadpisuje Message-ID swoim — przekazane odbicie niesie właśnie
   * ten identyfikator (messages.provider_message_id, 0029).
   */
  providerMessageId?: string;
  /** pula IP, z której dostawca wziął adres nadania (Klaviyo: `IpPool`) */
  ipPool?: string;
  /** konkretne IP użyte do wysyłki (Klaviyo: `Sending Ip Address`) */
  sendingIp?: string;
  /** moment przekazania do dostawcy, osobny od daty zdarzenia `sent` (Klaviyo: `Handoff Time`) */
  handedOffAt?: Date;
}

export interface DostawcaWysylki {
  readonly nazwa: string;
  wyslij(wiadomosc: Wiadomosc): Promise<WynikWysylki>;
  /**
   * Zwolnienie zasobów po partii (pula połączeń SMTP). Opcjonalne: dostawca bez stanu
   * (atrapa, API) nie ma czego zamykać. Silnik woła to po KAŻDEJ partii, także po błędzie.
   */
  zamknij?(): Promise<void> | void;
}
