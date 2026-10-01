import { BladAws, TYPY_ZDARZEN, type PortSes, type StatusSes, type TozsamoscSes } from "../../domain/email/ses";
import { kodujUri, podpiszZadanie, type KluczeAws } from "./sigv4";

/**
 * Klient SESv2 (REST/JSON) na `fetch` + własny SigV4. Tylko operacje, których używa
 * wysyłka platformowa. Limit API SES poza wysyłką to 1 zapytanie/s na konto, dlatego
 * wołający (poller) chodzi sekwencyjnie, a ten klient przy 429 rzuca BladAws
 * `TooManyRequests` i NIE ponawia sam (ponowienie to decyzja harmonogramu).
 *
 * Komunikaty błędów: kod wyjątku AWS i jego `message` (AWS nie odsyła w nim kluczy).
 * Ciało zapytania nie trafia do błędu ani do logu.
 */

export type FunkcjaFetch = typeof fetch;

export interface OpcjeKlientaSes {
  region: string;
  klucze: KluczeAws;
  fetch?: FunkcjaFetch;
  /** twardy limit czasu jednego zapytania */
  limitMs?: number;
}

/** Kod wyjątku z nagłówka `x-amzn-ErrorType` albo z ciała, bez sufiksu „Exception". */
export function kodBleduAws(naglowek: string | null, cialo: unknown): string {
  const surowy =
    (naglowek ?? "").split(":")[0] ||
    String((cialo as { __type?: string; code?: string; Code?: string } | null)?.__type ?? (cialo as { code?: string })?.code ?? "")
      .split("#")
      .pop() ||
    "";
  return surowy.replace(/Exception$/, "") || "Nieznany";
}

function status(w: unknown): StatusSes | null {
  const s = String(w ?? "");
  return ["PENDING", "SUCCESS", "FAILED", "TEMPORARY_FAILURE", "NOT_STARTED"].includes(s) ? (s as StatusSes) : null;
}

/** Odpowiedź GetEmailIdentity / CreateEmailIdentity → kształt portu. */
export function tozsamoscZOdpowiedzi(domena: string, j: Record<string, any>): TozsamoscSes {
  const dkim = (j.DkimAttributes ?? {}) as Record<string, any>;
  const mf = (j.MailFromAttributes ?? {}) as Record<string, any>;
  const tagi: Record<string, string> = {};
  for (const t of Array.isArray(j.Tags) ? j.Tags : []) {
    if (t && typeof t.Key === "string") tagi[t.Key] = String(t.Value ?? "");
  }
  return {
    domena,
    gotowaDoWysylki: j.VerifiedForSendingStatus === true,
    status: status(j.VerificationStatus),
    dkimStatus: status(dkim.Status),
    dkimTokeny: Array.isArray(dkim.Tokens) ? dkim.Tokens.map(String) : [],
    strefaPodpisu: typeof dkim.SigningHostedZone === "string" ? dkim.SigningHostedZone : null,
    dkimDlugoscKlucza: typeof dkim.CurrentSigningKeyLength === "string" ? dkim.CurrentSigningKeyLength : typeof dkim.NextSigningKeyLength === "string" ? dkim.NextSigningKeyLength : null,
    mailFromDomena: typeof mf.MailFromDomain === "string" && mf.MailFromDomain ? mf.MailFromDomain : null,
    mailFromStatus: status(mf.MailFromDomainStatus),
    configurationSet: typeof j.ConfigurationSetName === "string" ? j.ConfigurationSetName : null,
    typBledu: typeof j.VerificationInfo?.ErrorType === "string" ? j.VerificationInfo.ErrorType : null,
    tagi,
  };
}

export class KlientSes implements PortSes {
  readonly region: string;
  #klucze: KluczeAws;
  #fetch: FunkcjaFetch;
  #limitMs: number;

  constructor(o: OpcjeKlientaSes) {
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(o.region)) throw new Error("niepoprawny region AWS");
    this.region = o.region;
    this.#klucze = o.klucze;
    this.#fetch = o.fetch ?? fetch;
    this.#limitMs = o.limitMs ?? 10_000;
  }

  async #wolaj(metoda: string, sciezka: string, cialo?: unknown): Promise<Record<string, any> | null> {
    const url = `https://email.${this.region}.amazonaws.com${sciezka}`;
    const tresc = cialo === undefined ? "" : JSON.stringify(cialo);
    const naglowki = podpiszZadanie({
      metoda,
      url,
      naglowki: cialo === undefined ? {} : { "content-type": "application/json" },
      cialo: tresc,
      region: this.region,
      usluga: "ses",
      klucze: this.#klucze,
    });
    const odp = await this.#fetch(url, {
      method: metoda,
      headers: naglowki,
      body: cialo === undefined ? undefined : tresc,
      redirect: "error",
      signal: AbortSignal.timeout(this.#limitMs),
    });
    const tekst = await odp.text();
    let json: unknown = null;
    try {
      json = tekst ? JSON.parse(tekst) : null;
    } catch {
      json = null;
    }
    if (!odp.ok) {
      const kod = kodBleduAws(odp.headers.get("x-amzn-errortype"), json);
      const opis = String((json as { message?: string; Message?: string } | null)?.message ?? (json as { Message?: string } | null)?.Message ?? "").slice(0, 300);
      throw new BladAws(kod, odp.status, `SES ${metoda} ${sciezka.split("/").slice(0, 4).join("/")}: ${kod}${opis ? ` (${opis})` : ""}`);
    }
    return (json as Record<string, any>) ?? null;
  }

  async utworzTozsamosc(domena: string, o: { configurationSet: string | null; tagi: Record<string, string> }): Promise<TozsamoscSes> {
    const j = await this.#wolaj("POST", "/v2/email/identities", {
      EmailIdentity: domena,
      ...(o.configurationSet ? { ConfigurationSetName: o.configurationSet } : {}),
      // Easy DKIM: tylko długość klucza, bez klucza prywatnego i selektora (to byłby BYODKIM)
      DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
      Tags: Object.entries(o.tagi).map(([Key, Value]) => ({ Key, Value })),
    });
    // Create zwraca IdentityType, VerifiedForSendingStatus i DkimAttributes; reszta = brak
    return tozsamoscZOdpowiedzi(domena, { ...(j ?? {}), Tags: Object.entries(o.tagi).map(([Key, Value]) => ({ Key, Value })), ConfigurationSetName: o.configurationSet });
  }

  async odczytajTozsamosc(domena: string): Promise<TozsamoscSes | null> {
    try {
      const j = await this.#wolaj("GET", `/v2/email/identities/${kodujUri(domena)}`);
      return tozsamoscZOdpowiedzi(domena, j ?? {});
    } catch (b) {
      if (b instanceof BladAws && b.nieIstnieje) return null;
      throw b;
    }
  }

  async ustawMailFrom(domena: string, mailFromDomena: string): Promise<void> {
    // USE_DEFAULT_VALUE: usunięty rekord MX u klienta nie zatrzymuje kampanii w trakcie
    // (SES wraca do koperty amazonses.com, DMARC stoi wtedy na DKIM). Uzasadnienie: SPEC 2.
    await this.#wolaj("PUT", `/v2/email/identities/${kodujUri(domena)}/mail-from`, {
      MailFromDomain: mailFromDomena,
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    });
  }

  async utworzConfigurationSet(nazwa: string, tagi: Record<string, string>): Promise<void> {
    try {
      await this.#wolaj("POST", "/v2/email/configuration-sets", {
        ConfigurationSetName: nazwa,
        SendingOptions: { SendingEnabled: true },
        ReputationOptions: { ReputationMetricsEnabled: true },
        Tags: Object.entries(tagi).map(([Key, Value]) => ({ Key, Value })),
      });
    } catch (b) {
      if (b instanceof BladAws && b.juzIstnieje) return;
      throw b;
    }
  }

  async ustawConfigurationSetTozsamosci(domena: string, nazwa: string): Promise<void> {
    await this.#wolaj("PUT", `/v2/email/identities/${kodujUri(domena)}/configuration-set`, { ConfigurationSetName: nazwa });
  }

  async celeZdarzen(configurationSet: string) {
    const j = await this.#wolaj("GET", `/v2/email/configuration-sets/${kodujUri(configurationSet)}/event-destinations`);
    const lista = Array.isArray(j?.EventDestinations) ? j.EventDestinations : [];
    return lista.map((d: Record<string, any>) => ({
      nazwa: String(d.Name ?? ""),
      topicArn: typeof d.SnsDestination?.TopicArn === "string" ? d.SnsDestination.TopicArn : null,
      wlaczony: d.Enabled === true,
      typy: Array.isArray(d.MatchingEventTypes) ? d.MatchingEventTypes.map(String) : [],
    }));
  }

  async dodajCelZdarzen(configurationSet: string, nazwa: string, topicArn: string): Promise<void> {
    // otwarcia i kliknięcia liczy nasz pixel i nasz redirect, nie SES
    const definicja = { Enabled: true, MatchingEventTypes: [...TYPY_ZDARZEN], SnsDestination: { TopicArn: topicArn } };
    try {
      await this.#wolaj("POST", `/v2/email/configuration-sets/${kodujUri(configurationSet)}/event-destinations`, {
        EventDestinationName: nazwa,
        EventDestination: definicja,
      });
    } catch (b) {
      if (!(b instanceof BladAws && b.juzIstnieje)) throw b;
      // istniejący cel (np. stary, bez skarg) nadpisujemy pełną definicją, nie zakładamy, że jest dobry
      await this.#wolaj("PUT", `/v2/email/configuration-sets/${kodujUri(configurationSet)}/event-destinations/${kodujUri(nazwa)}`, {
        EventDestination: definicja,
      });
    }
  }

  async utworzTenanta(nazwa: string, tagi: Record<string, string>): Promise<void> {
    try {
      await this.#wolaj("POST", "/v2/email/tenants", {
        TenantName: nazwa,
        Tags: Object.entries(tagi).map(([Key, Value]) => ({ Key, Value })),
      });
    } catch (b) {
      if (b instanceof BladAws && b.juzIstnieje) return;
      throw b;
    }
  }

  async powiazZasobZTenantem(tenant: string, arn: string): Promise<void> {
    try {
      await this.#wolaj("POST", "/v2/email/tenants/resources", { TenantName: tenant, ResourceArn: arn });
    } catch (b) {
      if (b instanceof BladAws && b.juzIstnieje) return;
      throw b;
    }
  }

  /** Tylko do diagnostyki operatora (GetAccount): limity i stan produkcyjny. */
  async konto(): Promise<{ produkcja: boolean; limitDobowy: number | null; naSekunde: number | null; wysylkaWlaczona: boolean }> {
    const j = (await this.#wolaj("GET", "/v2/email/account")) ?? {};
    return {
      produkcja: j.ProductionAccessEnabled === true,
      limitDobowy: typeof j.SendQuota?.Max24HourSend === "number" ? j.SendQuota.Max24HourSend : null,
      naSekunde: typeof j.SendQuota?.MaxSendRate === "number" ? j.SendQuota.MaxSendRate : null,
      wysylkaWlaczona: j.SendingEnabled === true,
    };
  }
}
