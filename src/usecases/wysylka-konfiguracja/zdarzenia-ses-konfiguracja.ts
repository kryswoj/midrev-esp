import { getPool } from "../../adapters/db/pool";
import { BladAws, type PortSes, type PortSns } from "../../domain/email/ses";

/**
 * Podpięcie zdarzeń SES → SNS → nasz endpoint (operator, jednorazowo + przy nowych
 * tenantach). Kroki idempotentne: temat (CreateTopic po nazwie), polityka tematu,
 * SignatureVersion 2, subskrypcja HTTPS, cel zdarzeń w configuration secie KAŻDEGO
 * tenanta z wysyłką platformową.
 *
 * Domyślnie TYLKO plan (dry-run). `wykonaj: true` woła AWS. Brak uprawnień (AccessDenied)
 * zatrzymuje dalsze kroki z komunikatem dla OPERATORA — wskazuje brakujące uprawnienie
 * i miejsce, gdzie leży polityka (07-prosta-domena.md). Klient tego nigdy nie widzi.
 */

export const NAZWA_TEMATU = "midrev-esp-ses-zdarzenia";

export interface KrokKonfiguracji {
  krok: string;
  stan: "plan" | "ok" | "brak_uprawnien" | "blad";
  opis: string;
}

/** Polityka tematu: publikować może WYŁĄCZNIE SES z naszego konta (confused deputy). */
export function politykaTematu(topicArn: string, konto: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "SesPublikujeZdarzenia",
        Effect: "Allow",
        Principal: { Service: "ses.amazonaws.com" },
        Action: "sns:Publish",
        Resource: topicArn,
        Condition: { StringEquals: { "AWS:SourceAccount": konto } },
      },
    ],
  });
}

export async function skonfigurujZdarzeniaSes(o: {
  ses: PortSes;
  sns: PortSns;
  konto: string;
  endpoint: string;
  wykonaj: boolean;
}): Promise<{ kroki: KrokKonfiguracji[]; topicArn: string | null }> {
  const kroki: KrokKonfiguracji[] = [];
  if (!/^https:\/\//.test(o.endpoint)) {
    return { kroki: [{ krok: "endpoint", stan: "blad", opis: `Endpoint musi być https:// (jest ${o.endpoint}). SNS nie wyśle zdarzeń na http.` }], topicArn: null };
  }
  const { rows } = await getPool().query<{ id: string; ses_configuration_set: string }>(
    "select id, ses_configuration_set from tenants where ses_configuration_set is not null order by created_at",
  );
  const przewidywanyArn = `arn:aws:sns:${o.ses.region}:${o.konto}:${NAZWA_TEMATU}`;
  if (!o.wykonaj) {
    kroki.push(
      { krok: "temat", stan: "plan", opis: `CreateTopic ${NAZWA_TEMATU} → ${przewidywanyArn}` },
      { krok: "polityka", stan: "plan", opis: "SetTopicAttributes Policy: sns:Publish tylko dla ses.amazonaws.com z konta " + o.konto },
      { krok: "podpis", stan: "plan", opis: "SetTopicAttributes SignatureVersion=2 (SHA256)" },
      { krok: "subskrypcja", stan: "plan", opis: `Subscribe https ${o.endpoint} (potwierdzenie przyjdzie na endpoint)` },
      ...rows.map((r) => ({ krok: `cel:${r.ses_configuration_set}`, stan: "plan" as const, opis: `CreateConfigurationSetEventDestination midrev-sns → temat (tenant ${r.id})` })),
    );
    return { kroki, topicArn: przewidywanyArn };
  }

  const opisBledu = (b: unknown, uprawnienie: string): { stan: KrokKonfiguracji["stan"]; opis: string } =>
    b instanceof BladAws && b.brakUprawnien
      ? { stan: "brak_uprawnien", opis: `Brak uprawnienia ${uprawnienie} dla użytkownika aplikacji (${b.kod}). Dodaj politykę IAM z 07-prosta-domena.md i uruchom ponownie.` }
      : { stan: "blad", opis: String((b as Error)?.message ?? b).slice(0, 300) };

  let topicArn: string;
  try {
    topicArn = await o.sns.utworzTemat(NAZWA_TEMATU, {});
    kroki.push({ krok: "temat", stan: "ok", opis: topicArn });
  } catch (b) {
    kroki.push({ krok: "temat", ...opisBledu(b, "sns:CreateTopic") });
    return { kroki, topicArn: null };
  }
  for (const [krok, nazwa, wartosc, uprawnienie] of [
    ["polityka", "Policy", politykaTematu(topicArn, o.konto), "sns:SetTopicAttributes"],
    ["podpis", "SignatureVersion", "2", "sns:SetTopicAttributes"],
  ] as const) {
    try {
      await o.sns.ustawAtrybutTematu(topicArn, nazwa, wartosc);
      kroki.push({ krok, stan: "ok", opis: nazwa });
    } catch (b) {
      kroki.push({ krok, ...opisBledu(b, uprawnienie) });
      return { kroki, topicArn };
    }
  }
  try {
    const sub = await o.sns.subskrybujHttps(topicArn, o.endpoint);
    kroki.push({ krok: "subskrypcja", stan: "ok", opis: `${sub} — potwierdzenie przyjdzie na endpoint i zostanie przyjęte automatycznie, jeśli temat jest w SES_SNS_TOPIC_ARN` });
  } catch (b) {
    kroki.push({ krok: "subskrypcja", ...opisBledu(b, "sns:Subscribe") });
    return { kroki, topicArn };
  }
  for (const r of rows) {
    try {
      await o.ses.dodajCelZdarzen(r.ses_configuration_set, "midrev-sns", topicArn);
      const cele = await o.ses.celeZdarzen(r.ses_configuration_set);
      if (!cele.some((c) => c.wlaczony && c.topicArn === topicArn)) throw new Error("cel zdarzeń nie widoczny w odczycie zwrotnym");
      await getPool().query("update tenants set ses_events_destination_at = coalesce(ses_events_destination_at, now()) where id = $1 and ses_configuration_set = $2", [r.id, r.ses_configuration_set]);
      kroki.push({ krok: `cel:${r.ses_configuration_set}`, stan: "ok", opis: `tenant ${r.id} (potwierdzone odczytem)` });
    } catch (b) {
      kroki.push({ krok: `cel:${r.ses_configuration_set}`, ...opisBledu(b, "ses:CreateConfigurationSetEventDestination") });
    }
  }
  return { kroki, topicArn };
}
