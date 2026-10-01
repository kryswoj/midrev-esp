import type { PoolClient } from "pg";
import type { Klasyfikacja } from "../../domain/email/klasyfikacja";
import type { ZrodloZdarzenia } from "../../domain/zdarzenia/kontrakt";
import { zapiszZdarzenie } from "../zdarzenia/zapisz-zdarzenie";
import type { TypZdarzeniaWiadomosci } from "./wyslij-kampanie";

/**
 * Metryki e-mail w strumieniu `metric_events` (plan metryki-i-profil 1.3) z raportów
 * dostawcy: doręczenie, odbicie, skarga. Nazwy jak w Klaviyo (AD-37).
 *
 * Definicje są TU, a nie w `domain/zdarzenia/kontrakt.ts` (METRYKI_WBUDOWANE): kontrakt
 * A-B zmienia się tylko za zgodą obu strumieni. Przeniesienie = jedna linijka.
 *
 * DECYZJA (01.10): „Received Email" emitujemy przy DORĘCZENIU zgłoszonym przez dostawcę
 * (SES Delivery), a nie przy `sent`. Plan 1.3 przewiduje `sent`; gdy strumień A doda
 * emisję przy `sent`, ta gałąź ma zniknąć (inaczej dwa wiersze na wiadomość). unique_id
 * jest ten sam (`msg:{id}:received`), więc przy źródle zewnętrznym deduplikacja AD-38 i tak
 * zatrzyma drugi wiersz o tym samym kluczu.
 *
 * Bezpieczeństwo zapisu: emisja idzie w SAVEPOINCIE. Limit 200 metryk albo błąd strumienia
 * NIE może cofnąć zapisu odbicia i wykluczenia adresu (to ważniejsze niż wykres).
 */

const METRYKI: Partial<Record<TypZdarzeniaWiadomosci, { nazwa: string; sufiks: string; mozeWyzwalac: boolean }>> = {
  delivered: { nazwa: "Received Email", sufiks: "received", mozeWyzwalac: true },
  bounced: { nazwa: "Bounced Email", sufiks: "bounced", mozeWyzwalac: false },
  complained: { nazwa: "Marked Email as Spam", sufiks: "spam", mozeWyzwalac: false },
};

export async function emitujMetrykeEmail(
  klient: PoolClient,
  z: {
    tenantId: string;
    messageId: string;
    typ: TypZdarzeniaWiadomosci;
    kiedy: Date;
    klasyfikacja?: Klasyfikacja;
    zrodlo: ZrodloZdarzenia;
  },
): Promise<boolean> {
  const def = METRYKI[z.typ];
  if (!def) return false;
  const { rows } = await klient.query(
    "select profile_id, source_type, source_id, subject, email from messages where tenant_id = $1 and id = $2",
    [z.tenantId, z.messageId],
  );
  const m = rows[0];
  if (!m) return false;
  const properties: Record<string, unknown> = {
    $message: z.messageId,
    Subject: m.subject,
    "Message Type": m.source_type === "journey" ? "flow" : m.source_type,
    // tylko domena: adres zostaje w messages (ścieżka RODO), zdarzenie żyje dłużej
    "Email Domain": String(m.email ?? "").split("@")[1] ?? null,
  };
  if (m.source_type === "campaign") properties.$campaign = m.source_id;
  if (m.source_type === "journey") properties.$flow = m.source_id;
  if (z.typ === "bounced") {
    properties["Bounce Type"] = z.klasyfikacja?.klasa === "hard" ? "Hard" : z.klasyfikacja?.klasa === "soft" ? "Soft" : "Undetermined";
    properties.$extra = { $bounce_delivery_info: { code: z.klasyfikacja?.kodSmtp ?? null, reason: z.klasyfikacja?.powodDostawcy?.slice(0, 500) ?? null } };
  }
  await klient.query("savepoint metryka_email");
  try {
    await zapiszZdarzenie(klient, {
      tenantId: z.tenantId,
      metryka: { integracja: "midrev", nazwa: def.nazwa, mozeWyzwalac: def.mozeWyzwalac, wbudowana: true },
      profileId: m.profile_id ?? null,
      occurredAt: z.kiedy,
      uniqueId: `msg:${z.messageId}:${def.sufiks}`,
      properties,
      source: z.zrodlo,
      messageId: z.messageId,
    });
    await klient.query("release savepoint metryka_email");
    return true;
  } catch (b) {
    await klient.query("rollback to savepoint metryka_email");
    // bez adresów i treści: tenant, wiadomość, rodzaj błędu
    console.error(`[metryki-email] tenant ${z.tenantId} wiadomość ${z.messageId} ${def.nazwa}: ${String((b as Error)?.message ?? b).slice(0, 200)}`);
    return false;
  }
}
