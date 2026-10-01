import { createVerify, X509Certificate, type KeyObject } from "node:crypto";

/**
 * Weryfikacja wiadomości SNS (HTTP/S) wg dokumentacji „Verifying the signatures of
 * Amazon SNS messages". Bez tego endpoint zdarzeń SES przyjąłby od każdego spreparowane
 * „odbicie" i wykluczył dowolny adres dowolnego sklepu.
 *
 * Zasady (każda ma test w tests/ses-zdarzenia.test.ts):
 *   1. Certyfikat WYŁĄCZNIE z `https://sns.<nasz region>.amazonaws.com/SimpleNotificationService-*.pem`.
 *      Adres z wiadomości to dane atakującego: inny host, http, port, ścieżka, @ w URL,
 *      przekierowanie = odmowa BEZ pobierania (SSRF).
 *   2. Pobranie: HTTPS z weryfikacją TLS (domyślny fetch), bez przekierowań, limit czasu,
 *      limit rozmiaru, cache w pamięci procesu (najwyżej 16 adresów, 24 h).
 *   3. SignatureVersion 1 (SHA1withRSA) i 2 (SHA256withRSA); inne = odmowa.
 *   4. Tekst do podpisu: pola w kolejności bajtowej, „Nazwa\nWartość\n", Subject tylko
 *      gdy jest (Notification), SubscribeURL+Token dla potwierdzeń.
 *   5. Region tematu = region konfiguracji = region certyfikatu.
 *   6. Znacznik czasu: nie starszy niż OKNO_WAZNOSCI_MS i nie z przyszłości > 15 min.
 * Allowlista TopicArn i idempotencja po MessageId są wyżej (trasa / use-case).
 */

export type TypWiadomosciSns = "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";

export interface WiadomoscSns {
  Type: TypWiadomosciSns;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: "1" | "2";
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

/** Wiadomość potwierdzona może iść dalej najwyżej tyle po swoim znaczniku czasu. */
export const OKNO_WAZNOSCI_MS = 24 * 3600_000;
const TOLERANCJA_PRZYSZLOSCI_MS = 15 * 60_000;
const MAKS_CERTYFIKAT_B = 16_384;

const ARN_TEMATU = /^arn:aws:sns:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):([A-Za-z0-9_-]{1,256})$/;

function napis(w: unknown, maks = 300_000): w is string {
  return typeof w === "string" && w.length > 0 && w.length <= maks;
}

/** Kształt wiadomości SNS; `null` = to nie jest wiadomość SNS, którą umiemy przyjąć. */
export function parsujWiadomoscSns(surowa: unknown): WiadomoscSns | null {
  if (!surowa || typeof surowa !== "object" || Array.isArray(surowa)) return null;
  const w = surowa as Record<string, unknown>;
  if (w.Type !== "Notification" && w.Type !== "SubscriptionConfirmation" && w.Type !== "UnsubscribeConfirmation") return null;
  for (const p of ["MessageId", "TopicArn", "Message", "Timestamp", "Signature", "SigningCertURL"]) {
    if (!napis(w[p], p === "Message" ? 262_144 : 4096)) return null;
  }
  if (w.SignatureVersion !== "1" && w.SignatureVersion !== "2") return null;
  if (w.Type !== "Notification" && (!napis(w.SubscribeURL, 4096) || !napis(w.Token, 4096))) return null;
  for (const p of ["Subject", "UnsubscribeURL"]) if (w[p] !== undefined && w[p] !== null && typeof w[p] !== "string") return null;
  return {
    Type: w.Type,
    MessageId: w.MessageId as string,
    TopicArn: w.TopicArn as string,
    Message: w.Message as string,
    Timestamp: w.Timestamp as string,
    SignatureVersion: w.SignatureVersion,
    Signature: w.Signature as string,
    SigningCertURL: w.SigningCertURL as string,
    ...(typeof w.Subject === "string" ? { Subject: w.Subject } : {}),
    ...(typeof w.SubscribeURL === "string" ? { SubscribeURL: w.SubscribeURL } : {}),
    ...(typeof w.Token === "string" ? { Token: w.Token } : {}),
    ...(typeof w.UnsubscribeURL === "string" ? { UnsubscribeURL: w.UnsubscribeURL } : {}),
  };
}

export function tekstDoPodpisuSns(w: WiadomoscSns): string {
  const pola: [string, string | undefined][] =
    w.Type === "Notification"
      ? [
          ["Message", w.Message],
          ["MessageId", w.MessageId],
          ["Subject", w.Subject],
          ["Timestamp", w.Timestamp],
          ["TopicArn", w.TopicArn],
          ["Type", w.Type],
        ]
      : [
          ["Message", w.Message],
          ["MessageId", w.MessageId],
          ["SubscribeURL", w.SubscribeURL],
          ["Timestamp", w.Timestamp],
          ["Token", w.Token],
          ["TopicArn", w.TopicArn],
          ["Type", w.Type],
        ];
  return pola
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}\n${v}\n`)
    .join("");
}

/** Region i konto z ARN tematu; null = to nie jest ARN tematu SNS. */
export function rozbierzArnTematu(arn: string): { region: string; konto: string; nazwa: string } | null {
  const m = ARN_TEMATU.exec(arn);
  return m ? { region: m[1], konto: m[2], nazwa: m[3] } : null;
}

/**
 * Adres certyfikatu: dokładnie https, host sns.<region>.amazonaws.com, domyślny port,
 * bez danych logowania, ścieżka /SimpleNotificationService-<hex>.pem, bez zapytania.
 */
export function poprawnyAdresCertyfikatu(adres: string, region: string): boolean {
  let u: URL;
  try {
    u = new URL(adres);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.hostname === `sns.${region}.amazonaws.com` &&
    u.port === "" &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash &&
    /^\/SimpleNotificationService-[A-Za-z0-9]{1,64}\.pem$/.test(u.pathname)
  );
}

/** SubscribeURL: ten sam host co certyfikat, akcja ConfirmSubscription TEGO tematu. */
export function poprawnyAdresPotwierdzenia(adres: string, region: string, topicArn: string): boolean {
  let u: URL;
  try {
    u = new URL(adres);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.hostname === `sns.${region}.amazonaws.com` &&
    u.port === "" &&
    !u.username &&
    !u.password &&
    (u.pathname === "/" || u.pathname === "") &&
    u.searchParams.get("Action") === "ConfirmSubscription" &&
    u.searchParams.get("TopicArn") === topicArn &&
    Boolean(u.searchParams.get("Token"))
  );
}

export type PobierzCertyfikat = (adres: string) => Promise<string>;

/** Domyślne pobranie: HTTPS z weryfikacją TLS, bez przekierowań, 5 s, ≤ 16 KB. */
export const pobierzCertyfikatHttps: PobierzCertyfikat = async (adres) => {
  const odp = await fetch(adres, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  if (!odp.ok) throw new Error(`certyfikat SNS: HTTP ${odp.status}`);
  const dl = Number(odp.headers.get("content-length") ?? "0");
  if (dl > MAKS_CERTYFIKAT_B) throw new Error("certyfikat SNS: za duży");
  const tekst = await odp.text();
  if (tekst.length > MAKS_CERTYFIKAT_B) throw new Error("certyfikat SNS: za duży");
  return tekst;
};

const pamiec = new Map<string, { klucz: KeyObject; wygasa: number }>();

/** Tylko testy: czyszczenie pamięci certyfikatów między przypadkami. */
export function wyczyscPamiecCertyfikatow() {
  pamiec.clear();
}

async function kluczPubliczny(adres: string, pobierz: PobierzCertyfikat, teraz: number): Promise<KeyObject> {
  const z = pamiec.get(adres);
  if (z && z.wygasa > teraz) return z.klucz;
  const pem = await pobierz(adres);
  if (!/^-----BEGIN CERTIFICATE-----/.test(pem.trim())) throw new Error("certyfikat SNS: to nie jest PEM");
  const cert = new X509Certificate(pem);
  if (Date.parse(cert.validTo) < teraz || Date.parse(cert.validFrom) > teraz) throw new Error("certyfikat SNS: poza okresem ważności");
  if (pamiec.size >= 16) pamiec.delete(pamiec.keys().next().value as string);
  pamiec.set(adres, { klucz: cert.publicKey, wygasa: teraz + 24 * 3600_000 });
  return cert.publicKey;
}

export type WynikWeryfikacjiSns = { ok: true } | { ok: false; powod: string };

export async function zweryfikujWiadomoscSns(
  w: WiadomoscSns,
  o: { region: string; pobierz?: PobierzCertyfikat; teraz?: Date },
): Promise<WynikWeryfikacjiSns> {
  const teraz = (o.teraz ?? new Date()).getTime();
  const arn = rozbierzArnTematu(w.TopicArn);
  if (!arn) return { ok: false, powod: "TopicArn nie jest ARN tematu SNS" };
  if (arn.region !== o.region) return { ok: false, powod: "temat z innego regionu" };
  if (!poprawnyAdresCertyfikatu(w.SigningCertURL, o.region)) return { ok: false, powod: "niedozwolony adres certyfikatu" };
  const czas = Date.parse(w.Timestamp);
  if (!Number.isFinite(czas)) return { ok: false, powod: "zły znacznik czasu" };
  if (teraz - czas > OKNO_WAZNOSCI_MS) return { ok: false, powod: "wiadomość przeterminowana" };
  if (czas - teraz > TOLERANCJA_PRZYSZLOSCI_MS) return { ok: false, powod: "znacznik czasu z przyszłości" };
  let klucz: KeyObject;
  try {
    klucz = await kluczPubliczny(w.SigningCertURL, o.pobierz ?? pobierzCertyfikatHttps, teraz);
  } catch (b) {
    return { ok: false, powod: `certyfikat niedostępny: ${String((b as Error)?.message ?? b).slice(0, 120)}` };
  }
  let poprawny = false;
  try {
    poprawny = createVerify(w.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256")
      .update(tekstDoPodpisuSns(w), "utf8")
      .verify(klucz, w.Signature, "base64");
  } catch {
    poprawny = false;
  }
  return poprawny ? { ok: true } : { ok: false, powod: "zły podpis" };
}
