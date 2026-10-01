/**
 * Porty usług AWS używanych przez wysyłkę platformową (AD-7: rdzeń nie zna dostawcy po
 * nazwie operacji HTTP). Implementacje: `adapters/aws/ses.ts`, `adapters/aws/sns.ts`;
 * w testach atrapy z tabelą stanów. Testy NIGDY nie wołają prawdziwego AWS.
 *
 * Słownik SES zostaje w tym pliku i w adapterach. Klient w panelu nie widzi słów SES,
 * SMTP, IMAP ani MAIL FROM (wymóg produktu 01.10).
 */

/** Stany weryfikacji w SESv2 (`VerificationStatus`, `DkimAttributes.Status`, `MailFromDomainStatus`). */
export type StatusSes = "PENDING" | "SUCCESS" | "FAILED" | "TEMPORARY_FAILURE" | "NOT_STARTED";

export interface TozsamoscSes {
  domena: string;
  /** bramka wysyłki po stronie SES */
  gotowaDoWysylki: boolean;
  status: StatusSes | null;
  dkimStatus: StatusSes | null;
  dkimTokeny: string[];
  /** `SigningHostedZone`, np. dkim.amazonses.com (regionalnie bywa inna; nie zgadujemy) */
  strefaPodpisu: string | null;
  dkimDlugoscKlucza: string | null;
  mailFromDomena: string | null;
  mailFromStatus: StatusSes | null;
  configurationSet: string | null;
  /** `VerificationInfo.ErrorType`, np. DNS_SERVER_ERROR, HOST_NOT_FOUND */
  typBledu: string | null;
  tagi: Record<string, string>;
}

/** Błąd wywołania AWS w kształcie do decyzji (bez treści zapytania, bez kluczy). */
export class BladAws extends Error {
  constructor(
    /** nazwa wyjątku bez sufiksu, np. AccessDenied, AlreadyExists, NotFound, TooManyRequests */
    public readonly kod: string,
    public readonly status: number,
    wiadomosc: string,
  ) {
    super(wiadomosc);
    this.name = "BladAws";
  }
  get brakUprawnien(): boolean {
    return this.kod === "AccessDenied" || this.kod === "AuthorizationError" || this.status === 403;
  }
  get juzIstnieje(): boolean {
    return this.kod === "AlreadyExists";
  }
  get nieIstnieje(): boolean {
    return this.kod === "NotFound" || this.status === 404;
  }
}

export interface PortSes {
  readonly region: string;
  utworzTozsamosc(domena: string, opcje: { configurationSet: string | null; tagi: Record<string, string> }): Promise<TozsamoscSes>;
  /** null = tożsamości nie ma na koncie */
  odczytajTozsamosc(domena: string): Promise<TozsamoscSes | null>;
  ustawMailFrom(domena: string, mailFromDomena: string): Promise<void>;
  /** idempotentne: istniejący zestaw = sukces */
  utworzConfigurationSet(nazwa: string, tagi: Record<string, string>): Promise<void>;
  ustawConfigurationSetTozsamosci(domena: string, nazwa: string): Promise<void>;
  /** cele zdarzeń zestawu (nazwy i ARN tematów) */
  celeZdarzen(configurationSet: string): Promise<{ nazwa: string; topicArn: string | null; wlaczony: boolean; typy: string[] }[]>;
  /** idempotentne: istniejący cel o tej nazwie jest NADPISYWANY pełną definicją */
  dodajCelZdarzen(configurationSet: string, nazwa: string, topicArn: string): Promise<void>;
  /** SES Tenants (opcjonalne, flaga SES_TENANTS); idempotentne */
  utworzTenanta(nazwa: string, tagi: Record<string, string>): Promise<void>;
  powiazZasobZTenantem(tenant: string, arn: string): Promise<void>;
}

export interface PortSns {
  /** CreateTopic jest idempotentne po nazwie; zwraca ARN */
  utworzTemat(nazwa: string, atrybuty: Record<string, string>): Promise<string>;
  ustawAtrybutTematu(topicArn: string, nazwa: string, wartosc: string): Promise<void>;
  subskrybujHttps(topicArn: string, endpoint: string): Promise<string>;
}

/** Nazwa configuration setu tenanta: deterministyczna, ≤ 64 znaki, [A-Za-z0-9_-]. */
export function nazwaConfigurationSetu(tenantId: string): string {
  return `midrev-t-${tenantId.replace(/-/g, "")}`;
}

/** Nazwa tenanta SES (≤ 64, [A-Za-z0-9_-]). */
export function nazwaTenantaSes(tenantId: string): string {
  return `midrev-${tenantId.replace(/-/g, "")}`;
}

/** Typy zdarzeń, które MUSZĄ dochodzić, żeby wysyłka była „widząca" (odbicia, skargi). */
export const WYMAGANE_TYPY_ZDARZEN = ["BOUNCE", "COMPLAINT", "DELIVERY"] as const;
export const TYPY_ZDARZEN = ["SEND", "REJECT", "BOUNCE", "COMPLAINT", "DELIVERY", "DELIVERY_DELAY", "RENDERING_FAILURE"] as const;

/** Czy cel zdarzeń jest kompletny: włączony, nasz temat, wszystkie wymagane typy. */
export function celKompletny(c: { wlaczony: boolean; topicArn: string | null; typy: string[] }, topicArn: string): boolean {
  return c.wlaczony && c.topicArn === topicArn && WYMAGANE_TYPY_ZDARZEN.every((t) => c.typy.includes(t));
}
