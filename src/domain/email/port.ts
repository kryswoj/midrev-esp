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
  temat: string;
  html: string;
  /** absolutny adres wypisania jednym kliknięciem (RFC 8058) */
  adresWypisania: string;
  idempotencyKey: string;
}

export interface WynikWysylki {
  providerId: string;
}

export interface DostawcaWysylki {
  readonly nazwa: string;
  wyslij(wiadomosc: Wiadomosc): Promise<WynikWysylki>;
}
