import { config } from "../../config";
import type { PortSes, PortSns } from "../../domain/email/ses";
import { Sekret } from "../crypto";
import type { PortRoute53 } from "../../domain/email/route53";
import { AtrapaRoute53 } from "./atrapa-route53";
import { AtrapaSes, AtrapaSns } from "./atrapa-ses";
import { KlientRoute53 } from "./route53";
import { KlientSes } from "./ses";
import { KlientSns } from "./sns";

/**
 * Jedno miejsce, które z konfiguracji składa klientów AWS wysyłki platformowej.
 * Testy podmieniają porty przez `ustawPortyAws` (bez sieci). Klucze zawijane w `Sekret`
 * natychmiast; żadna funkcja stąd nie zwraca ani nie loguje ich wartości.
 */

let wstrzykniete: { ses?: PortSes | null; sns?: PortSns | null; route53?: PortRoute53 | null } | null = null;
let atrapaSes: AtrapaSes | null = null;
let atrapaSns: AtrapaSns | null = null;
let atrapaRoute53: AtrapaRoute53 | null = null;

/** Tylko testy: podmiana portów (null = brak konfiguracji). Wywołanie bez argumentu przywraca konfigurację. */
export function ustawPortyAws(porty?: { ses?: PortSes | null; sns?: PortSns | null; route53?: PortRoute53 | null }) {
  wstrzykniete = porty ?? null;
}

function klucze() {
  const k = config();
  if (!k.AWS_SES_ACCESS_KEY_ID || !k.AWS_SES_SECRET_ACCESS_KEY) return null;
  return { accessKeyId: k.AWS_SES_ACCESS_KEY_ID, secretAccessKey: new Sekret(k.AWS_SES_SECRET_ACCESS_KEY) };
}

/** Klient SES API albo null, gdy platforma nie ma kluczy (wtedy kreator mówi „jeszcze nie działa"). */
export function portSes(): PortSes | null {
  if (wstrzykniete && "ses" in wstrzykniete) return wstrzykniete.ses ?? null;
  const k = config();
  if (k.SES_ATRAPA && k.MIDREV_SANDBOX) return (atrapaSes ??= new AtrapaSes(k.AWS_REGION));
  const kl = klucze();
  return kl ? new KlientSes({ region: k.AWS_REGION, klucze: kl }) : null;
}

export function portSns(): PortSns | null {
  if (wstrzykniete && "sns" in wstrzykniete) return wstrzykniete.sns ?? null;
  const k = config();
  if (k.SES_ATRAPA && k.MIDREV_SANDBOX) return (atrapaSns ??= new AtrapaSns(k.AWS_REGION, k.AWS_ACCOUNT_ID ?? "000000000000"));
  const kl = klucze();
  return kl ? new KlientSns({ region: k.AWS_REGION, klucze: kl }) : null;
}

/**
 * Klient Route 53 albo null, gdy delegacja jest wyłączona (flaga ROUTE53_DELEGACJA) albo
 * brak kluczy. null = kreator nie pokazuje opcji „jeden wpis" i działa jak dotąd.
 * Testy bez wstrzyknięcia dostają null (nie ma ścieżki do prawdziwego AWS).
 */
export function portRoute53(): PortRoute53 | null {
  if (wstrzykniete && "route53" in wstrzykniete) return wstrzykniete.route53 ?? null;
  if (wstrzykniete) return null;
  const k = config();
  if (!k.ROUTE53_DELEGACJA) return null;
  if (k.SES_ATRAPA && k.MIDREV_SANDBOX) return (atrapaRoute53 ??= new AtrapaRoute53());
  const kl = klucze();
  return kl ? new KlientRoute53({ klucze: kl }) : null;
}

export interface SmtpPlatformy {
  host: string;
  port: number;
  uzytkownik: string;
  haslo: Sekret;
}

/** Poświadczenia SMTP platformy albo null. */
export function smtpPlatformy(): SmtpPlatformy | null {
  const k = config();
  if (!k.SES_SMTP_USER || !k.SES_SMTP_PASSWORD) return null;
  return {
    host: k.SES_SMTP_HOST ?? `email-smtp.${k.AWS_REGION}.amazonaws.com`,
    port: k.SES_SMTP_PORT,
    uzytkownik: k.SES_SMTP_USER,
    haslo: new Sekret(k.SES_SMTP_PASSWORD),
  };
}
