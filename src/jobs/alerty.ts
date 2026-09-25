import { config } from "../config";

/**
 * Alert do czlowieka (NFR38). `console.error` w logu workera nikogo nie budzi,
 * wiec kazdy alert idzie tez POST-em na ALERT_WEBHOOK_URL, jesli jest ustawiony.
 * Awaria webhooka nie moze przewrocic wysylki: alert jest efektem ubocznym,
 * nie czescia transakcji, dlatego blad wysylki alertu jest tylko logowany,
 * a zawieszony odbiorca dostaje 5 s i koniec.
 *
 * Payload niesie poziom i tenanta osobno (do filtrowania po stronie odbiorcy),
 * a do tego `content` (Discord) i `text` (Slack/Mattermost) z ta sama trescia,
 * zeby goly webhook komunikatora dzialal bez posrednika.
 */
export type PoziomAlertu = "info" | "uwaga" | "krytyczny";

export interface OpcjeAlertu {
  /** Domyslnie "uwaga": tak byly traktowane wszystkie alerty przed wprowadzeniem poziomow. */
  poziom?: PoziomAlertu;
  tenantId?: string | null;
}

export interface PayloadAlertu {
  poziom: PoziomAlertu;
  tenant: string | null;
  tresc: string;
  kiedy: string;
  content: string;
  text: string;
}

const CZAS_NA_WEBHOOK_MS = 5_000;

export function zbudujPayloadAlertu(tresc: string, opcje: OpcjeAlertu = {}, kiedy = new Date()): PayloadAlertu {
  const poziom = opcje.poziom ?? "uwaga";
  const tenant = opcje.tenantId ?? null;
  const linia = `[${poziom.toUpperCase()}]${tenant ? ` tenant ${tenant}:` : ""} ${tresc}`;
  return { poziom, tenant, tresc, kiedy: kiedy.toISOString(), content: linia, text: linia };
}

export async function wyslijAlert(tresc: string, opcje: OpcjeAlertu = {}): Promise<void> {
  const payload = zbudujPayloadAlertu(tresc, opcje);
  if (payload.poziom === "info") console.log(`[alert] ${payload.content}`);
  else console.error(`[alert] ${payload.content}`);

  const url = config().ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const odpowiedz = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CZAS_NA_WEBHOOK_MS),
    });
    if (!odpowiedz.ok) {
      console.error(`[alert] webhook odpowiedzial HTTP ${odpowiedz.status}`);
    }
  } catch (blad) {
    console.error(`[alert] webhook nie przyjal alertu:`, blad);
  }
}
