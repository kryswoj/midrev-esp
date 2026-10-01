import { BladAws, type PortSns } from "../../domain/email/ses";
import { podpiszZadanie, type KluczeAws } from "./sigv4";
import type { FunkcjaFetch } from "./ses";

/**
 * Klient SNS (protokół query: form-urlencoded, odpowiedź XML). Trzy operacje potrzebne
 * do podpięcia zdarzeń SES: CreateTopic, SetTopicAttributes, Subscribe. Potwierdzenie
 * subskrypcji idzie przez GET na zweryfikowany SubscribeURL (podpis-sns.ts), bez kluczy.
 *
 * Używany WYŁĄCZNIE przez konfigurację operatora (zdarzenia-ses-konfiguracja.ts). AccessDenied wraca jako BladAws z `brakUprawnien`,
 * a wołający zamienia go na komunikat dla OPERATORA (nie klienta).
 */

function pole(xml: string, nazwa: string): string | null {
  const m = new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`).exec(xml);
  return m ? m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'") : null;
}

export class KlientSns implements PortSns {
  readonly region: string;
  #klucze: KluczeAws;
  #fetch: FunkcjaFetch;

  constructor(o: { region: string; klucze: KluczeAws; fetch?: FunkcjaFetch }) {
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(o.region)) throw new Error("niepoprawny region AWS");
    this.region = o.region;
    this.#klucze = o.klucze;
    this.#fetch = o.fetch ?? fetch;
  }

  async #wolaj(akcja: string, parametry: Record<string, string>): Promise<string> {
    const url = `https://sns.${this.region}.amazonaws.com/`;
    const cialo = new URLSearchParams({ Action: akcja, Version: "2010-03-31", ...parametry }).toString();
    const naglowki = podpiszZadanie({
      metoda: "POST",
      url,
      naglowki: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      cialo,
      region: this.region,
      usluga: "sns",
      klucze: this.#klucze,
    });
    const odp = await this.#fetch(url, { method: "POST", headers: naglowki, body: cialo, redirect: "error", signal: AbortSignal.timeout(10_000) });
    const xml = await odp.text();
    if (!odp.ok) {
      const kod = (pole(xml, "Code") ?? "Nieznany").replace(/Exception$/, "");
      throw new BladAws(kod, odp.status, `SNS ${akcja}: ${kod}${pole(xml, "Message") ? ` (${String(pole(xml, "Message")).slice(0, 300)})` : ""}`);
    }
    return xml;
  }

  async utworzTemat(nazwa: string, atrybuty: Record<string, string>): Promise<string> {
    const p: Record<string, string> = { Name: nazwa };
    Object.entries(atrybuty).forEach(([k, v], i) => {
      p[`Attributes.entry.${i + 1}.key`] = k;
      p[`Attributes.entry.${i + 1}.value`] = v;
    });
    const arn = pole(await this.#wolaj("CreateTopic", p), "TopicArn");
    if (!arn) throw new BladAws("ZlaOdpowiedz", 200, "SNS CreateTopic: brak TopicArn w odpowiedzi");
    return arn;
  }

  async ustawAtrybutTematu(topicArn: string, nazwa: string, wartosc: string): Promise<void> {
    await this.#wolaj("SetTopicAttributes", { TopicArn: topicArn, AttributeName: nazwa, AttributeValue: wartosc });
  }

  async subskrybujHttps(topicArn: string, endpoint: string): Promise<string> {
    const xml = await this.#wolaj("Subscribe", { TopicArn: topicArn, Protocol: "https", Endpoint: endpoint, ReturnSubscriptionArn: "true" });
    return pole(xml, "SubscriptionArn") ?? "pending confirmation";
  }

}
