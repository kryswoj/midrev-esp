import { getPool } from "../../adapters/db/pool";
import {
  poprawnyAdresPotwierdzenia,
  rozbierzArnTematu,
  type WiadomoscSns,
} from "../../adapters/aws/podpis-sns";
import { config } from "../../config";
import { zapiszZgloszenieDostawcy, type ZgloszenieDostawcy } from "./zdarzenia-dostawcy";

/**
 * Zdarzenia SES dostarczone przez SNS (wiadomość JUŻ z poprawnym podpisem — sprawdza go
 * trasa, podpis-sns.ts). Tu: allowlista tematu, potwierdzenie subskrypcji, przypisanie
 * tenanta, idempotencja i zapis tym samym torem co każdy dostawca (zapiszZgloszenieDostawcy:
 * klasyfikacja, wykluczenie adresu, metryki).
 *
 * TENANT NIGDY Z TREŚCI BEZ SPRAWDZENIA. Łańcuch, który musi się zgadzać w całości:
 *   1. temat SNS na allowliście (SES_SNS_TOPIC_ARN), konto z ARN = konto zdarzenia
 *      (`mail.sendingAccountId`) = AWS_ACCOUNT_ID, jeśli ustawione,
 *   2. configuration set z tagu `ses:configuration-set` → tenant z NASZEJ bazy
 *      (`tenants.ses_configuration_set`, unikalne),
 *   3. domena nadawcy (`mail.source`) = domena platformowa TEGO tenanta,
 *   4. wiadomość odnaleziona po `mail.messageId` = provider_message_id W OBRĘBIE tenanta.
 * Zerwanie dowolnego ogniwa = zdarzenie odłożone z wynikiem, bez zapisu, z alertem przy (3).
 *
 * Idempotencja: dwie warstwy. `ses_sns_messages` (MessageId SNS) odcina powtórkę od razu;
 * unikalność (message_id, event_type) w message_events chroni przed wyścigiem dwóch
 * równoległych dostarczeń (wykluczenie i metryka powstają tylko przy NOWYM zdarzeniu).
 */

export interface WynikSns {
  /** kod HTTP dla SNS: 2xx = nie ponawiaj, 5xx = ponów */
  status: number;
  wynik: string;
}

export interface OpcjeSns {
  /** GET na SubscribeURL; wstrzykiwany w testach */
  potwierdz?: (adres: string) => Promise<void>;
  alert?: (tresc: string, poziom: "info" | "uwaga" | "krytyczny") => Promise<void>;
}

async function alert(o: OpcjeSns, tresc: string, poziom: "info" | "uwaga" | "krytyczny") {
  if (o.alert) return o.alert(tresc, poziom);
  const { wyslijAlert } = await import("../../jobs/alerty");
  await wyslijAlert(tresc, { poziom });
}

async function potwierdzDomyslnie(adres: string): Promise<void> {
  const odp = await fetch(adres, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  if (!odp.ok) throw new Error(`potwierdzenie subskrypcji: HTTP ${odp.status}`);
}

/**
 * Zajęcie MessageId PRZED przetwarzaniem (review r1, P2): dwa równoległe dostarczenia tej
 * samej wiadomości SNS — tylko jedno dostaje wiersz i robi cokolwiek. Błąd w trakcie
 * zwalnia zajęcie (zwolnij), żeby ponowienie SNS przetworzyło wiadomość od nowa.
 */
async function zajmij(w: WiadomoscSns): Promise<boolean> {
  const { rowCount } = await getPool().query(
    // Wiersz 'w_toku' starszy niż 5 minut = proces padł w trakcie (review r2, P1): przejmujemy
    // go, inaczej każde ponowienie SNS dostałoby „duplikat" i zdarzenie przepadłoby na zawsze.
    `insert into ses_sns_messages (sns_message_id, topic_arn, type, outcome, sns_timestamp)
     values ($1, $2, $3, 'w_toku', $4)
     on conflict (sns_message_id) do update set received_at = now()
       where ses_sns_messages.outcome = 'w_toku' and ses_sns_messages.received_at < now() - interval '5 minutes'`,
    [w.MessageId, w.TopicArn, w.Type, new Date(w.Timestamp)],
  );
  return Boolean(rowCount);
}

async function zwolnij(w: WiadomoscSns): Promise<void> {
  await getPool().query("delete from ses_sns_messages where sns_message_id = $1 and outcome = 'w_toku'", [w.MessageId]);
}

async function zapiszWynik(w: WiadomoscSns, p: {
  outcome: string;
  eventType?: string | null;
  sesMessageId?: string | null;
  tenantId?: string | null;
  messageId?: string | null;
}): Promise<void> {
  await getPool().query(
    `update ses_sns_messages set outcome = $2, event_type = $3, ses_message_id = $4, tenant_id = $5, message_id = $6
      where sns_message_id = $1`,
    [w.MessageId, p.outcome, p.eventType ?? null, p.sesMessageId?.slice(0, 500) ?? null, p.tenantId ?? null, p.messageId ?? null],
  );
}

function data(w: unknown): Date | null {
  if (typeof w !== "string") return null;
  const d = new Date(w);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Zgłoszenie dostawcy ze zdarzenia SES; null = typ, którego nie zapisujemy (Send, DeliveryDelay, Open...). */
export function zgloszenieZeZdarzeniaSes(ev: Record<string, any>): ZgloszenieDostawcy | null | "zly_ksztalt" {
  const typ = String(ev.eventType ?? ev.notificationType ?? "");
  switch (typ) {
    case "Delivery": {
      const kiedy = data(ev.delivery?.timestamp);
      return kiedy ? { rodzaj: "delivered", kiedy, smtpResponse: typeof ev.delivery?.smtpResponse === "string" ? ev.delivery.smtpResponse.slice(0, 1000) : undefined } : "zly_ksztalt";
    }
    case "Bounce": {
      const kiedy = data(ev.bounce?.timestamp);
      if (!kiedy || typeof ev.bounce?.bounceType !== "string") return "zly_ksztalt";
      const odbiorca = Array.isArray(ev.bounce.bouncedRecipients) ? ev.bounce.bouncedRecipients[0] : null;
      return {
        rodzaj: "bounce",
        kiedy,
        bounceType: ev.bounce.bounceType,
        bounceSubType: String(ev.bounce.bounceSubType ?? ""),
        diagnosticCode: typeof odbiorca?.diagnosticCode === "string" ? odbiorca.diagnosticCode : undefined,
      };
    }
    case "Complaint": {
      const kiedy = data(ev.complaint?.timestamp);
      if (!kiedy) return "zly_ksztalt";
      return {
        rodzaj: "complaint",
        kiedy,
        complaintFeedbackType: typeof ev.complaint?.complaintFeedbackType === "string" ? ev.complaint.complaintFeedbackType : undefined,
        complaintSubType: typeof ev.complaint?.complaintSubType === "string" ? ev.complaint.complaintSubType : undefined,
      };
    }
    case "Reject": {
      const kiedy = data(ev.mail?.timestamp);
      return kiedy ? { rodzaj: "reject", kiedy, powod: String(ev.reject?.reason ?? "Bad content").slice(0, 200) } : "zly_ksztalt";
    }
    default:
      return null;
  }
}

export async function przetworzWiadomoscSns(w: WiadomoscSns, o: OpcjeSns = {}): Promise<WynikSns> {
  const k = config();
  // 1. Allowlista tematu: obcy temat nigdy nie jest potwierdzany ani przetwarzany.
  if (!k.SES_SNS_TOPIC_ARN.includes(w.TopicArn)) return { status: 403, wynik: "nieznany_temat" };
  const arn = rozbierzArnTematu(w.TopicArn);
  if (!arn) return { status: 403, wynik: "nieznany_temat" };

  // 2. Powtórka po MessageId SNS: od razu 200, bez ponownego przetwarzania. Wiadomość
  //    zajęta przez równoległe dostarczenie, które jeszcze trwa, też jest duplikatem.
  if (!(await zajmij(w))) return { status: 200, wynik: "duplikat" };
  try {
    return await przetworzZajeta(w, k, arn, o);
  } catch (b) {
    await zwolnij(w).catch(() => {});
    throw b;
  }
}

async function przetworzZajeta(
  w: WiadomoscSns,
  k: ReturnType<typeof config>,
  arn: NonNullable<ReturnType<typeof rozbierzArnTematu>>,
  o: OpcjeSns,
): Promise<WynikSns> {

  if (w.Type === "SubscriptionConfirmation") {
    if (!w.SubscribeURL || !poprawnyAdresPotwierdzenia(w.SubscribeURL, k.AWS_REGION, w.TopicArn)) {
      await zwolnij(w);
      return { status: 400, wynik: "zly_adres_potwierdzenia" };
    }
    await (o.potwierdz ?? potwierdzDomyslnie)(w.SubscribeURL);
    await zapiszWynik(w, { outcome: "potwierdzono" });
    await alert(o, `zdarzenia SES: potwierdzono subskrypcję tematu ${w.TopicArn}`, "info");
    return { status: 200, wynik: "potwierdzono" };
  }
  if (w.Type === "UnsubscribeConfirmation") {
    await zapiszWynik(w, { outcome: "wypisano" });
    await alert(o, `zdarzenia SES: endpoint został WYPISANY z tematu ${w.TopicArn}. Odbicia i skargi przestały docierać — subskrybuj ponownie (scripts/ses-zdarzenia.ts).`, "krytyczny");
    return { status: 200, wynik: "wypisano" };
  }

  // 3. Notification ze zdarzeniem SES
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(w.Message);
  } catch {
    await zapiszWynik(w, { outcome: "zly_ksztalt" });
    return { status: 200, wynik: "zly_ksztalt" };
  }
  const typ = String(ev?.eventType ?? ev?.notificationType ?? "");
  const sesId = typeof ev?.mail?.messageId === "string" ? ev.mail.messageId : null;
  const konto = String(ev?.mail?.sendingAccountId ?? "");
  if (!sesId || konto !== arn.konto || (k.AWS_ACCOUNT_ID && konto !== k.AWS_ACCOUNT_ID)) {
    await zapiszWynik(w, { outcome: "zle_konto", eventType: typ.slice(0, 40), sesMessageId: sesId });
    return { status: 200, wynik: "zle_konto" };
  }

  const zgloszenie = zgloszenieZeZdarzeniaSes(ev);
  if (zgloszenie === null) {
    await zapiszWynik(w, { outcome: "pominiete", eventType: typ.slice(0, 40), sesMessageId: sesId });
    return { status: 200, wynik: "pominiete" };
  }
  if (zgloszenie === "zly_ksztalt") {
    await zapiszWynik(w, { outcome: "zly_ksztalt", eventType: typ.slice(0, 40), sesMessageId: sesId });
    return { status: 200, wynik: "zly_ksztalt" };
  }

  // 4. Tenant z configuration setu → z NASZEJ bazy
  const tagi = (ev.mail?.tags ?? {}) as Record<string, unknown>;
  const cs = Array.isArray(tagi["ses:configuration-set"]) ? String(tagi["ses:configuration-set"][0] ?? "") : "";
  const { rows: tenanci } = cs
    ? await getPool().query<{ id: string }>("select id from tenants where ses_configuration_set = $1", [cs])
    : { rows: [] as { id: string }[] };
  const tenantId = tenanci[0]?.id ?? null;
  if (!tenantId) {
    await zapiszWynik(w, { outcome: "nieznany_zestaw", eventType: typ, sesMessageId: sesId });
    return { status: 200, wynik: "nieznany_zestaw" };
  }

  // 5. Nadawca zdarzenia musi być z domeny platformowej TEGO tenanta
  const zrodlo = String(ev.mail?.source ?? "").toLowerCase();
  const domenaZrodla = zrodlo.includes("@") ? zrodlo.slice(zrodlo.lastIndexOf("@") + 1).replace(/>.*$/, "") : "";
  const { rows: domeny } = await getPool().query<{ domain: string; ses_mail_from_domain: string | null }>(
    "select domain, ses_mail_from_domain from sending_domains where tenant_id = $1 and managed_by = 'platforma'",
    [tenantId],
  );
  const zgodna = domeny.some((d) => domenaZrodla === d.domain || domenaZrodla === d.ses_mail_from_domain);
  if (!zgodna) {
    await zapiszWynik(w, { outcome: "tenant_niezgodny", eventType: typ, sesMessageId: sesId, tenantId });
    await alert(o, `zdarzenia SES: zdarzenie ${typ} z zestawu ${cs} (tenant ${tenantId}) ma nadawcę spoza domen tego tenanta (${domenaZrodla || "brak"}). Odłożone bez zapisu.`, "uwaga");
    return { status: 200, wynik: "tenant_niezgodny" };
  }

  // 6. Zapis tym samym torem co każdy dostawca (wyszukanie wiadomości w obrębie tenanta)
  const zapis = await zapiszZgloszenieDostawcy(tenantId, { providerMessageId: sesId }, zgloszenie, { zrodloMetryki: "webhook" });
  const outcome = zapis.zapisane ? "zapisane" : (zapis.powodOdrzucenia ?? "pominiete");
  await zapiszWynik(w, { outcome, eventType: typ, sesMessageId: sesId, tenantId, messageId: zapis.messageId ?? null });
  return { status: 200, wynik: outcome };
}
