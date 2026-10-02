import { BladAws } from "../../domain/email/ses";
import {
  nazwaBezKropki,
  normalizujIdStrefy,
  normalizujIdZmiany,
  type PortRoute53,
  type RekordRoute53,
  type StanZmianyR53,
  type StrefaRoute53,
  type ZmianaRoute53,
} from "../../domain/email/route53";
import type { FunkcjaFetch } from "./ses";
import { podpiszZadanie, type KluczeAws } from "./sigv4";

/**
 * Klient Amazon Route 53 (REST/XML, API 2013-04-01) na `fetch` + własny SigV4, jak SES i
 * SNS (sigv4.ts: bez @aws-sdk, kilka operacji). Route 53 jest usługą globalną: endpoint
 * route53.amazonaws.com, podpis zawsze w regionie us-east-1.
 *
 * Bezpieczeństwo:
 *   - identyfikatory stref i zmian walidowane przed wstawieniem do ścieżki URL,
 *   - wartości w XML escapowane, ciało zapytania nie trafia do błędu ani do logu,
 *   - przekierowania wyłączone, twardy limit czasu,
 *   - AccessDenied → BladAws.brakUprawnien; wołający robi z tego alert OPERATORA.
 *   - nie ma tu DeleteHostedZone: platforma nie usuwa stref (polityka IAM też go nie daje).
 */

const ENDPOINT = "https://route53.amazonaws.com/2013-04-01";
const REGION_PODPISU = "us-east-1";

function odXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function doXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Wnętrze pierwszego <tag>…</tag> (tag bez atrybutów i bez zagnieżdżeń samego siebie). */
function pole(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1] : null;
}

function wszystkie(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
}

/** Route 53 zapisuje w nazwach znaki spoza [a-z0-9-_.] jako \ooo (np. \052 = „*"). */
function nazwaZRoute53(n: string): string {
  return nazwaBezKropki(odXml(n).replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))));
}

const KODY: Record<string, string> = {
  HostedZoneAlreadyExists: "AlreadyExists",
  NoSuchHostedZone: "NotFound",
  NoSuchChange: "NotFound",
  Throttling: "TooManyRequests",
  PriorRequestNotComplete: "TooManyRequests",
};

export class KlientRoute53 implements PortRoute53 {
  #klucze: KluczeAws;
  #fetch: FunkcjaFetch;
  #limitMs: number;

  constructor(o: { klucze: KluczeAws; fetch?: FunkcjaFetch; limitMs?: number }) {
    this.#klucze = o.klucze;
    this.#fetch = o.fetch ?? fetch;
    this.#limitMs = o.limitMs ?? 10_000;
  }

  async #wolaj(metoda: "GET" | "POST", sciezka: string, cialo?: string): Promise<string> {
    const url = `${ENDPOINT}${sciezka}`;
    const naglowki = podpiszZadanie({
      metoda,
      url,
      naglowki: cialo ? { "content-type": "application/xml" } : {},
      cialo: cialo ?? "",
      region: REGION_PODPISU,
      usluga: "route53",
      klucze: this.#klucze,
    });
    const odp = await this.#fetch(url, { method: metoda, headers: naglowki, body: cialo, redirect: "error", signal: AbortSignal.timeout(this.#limitMs) });
    const xml = await odp.text();
    if (!odp.ok) {
      const surowy = pole(xml, "Code") ?? (odp.status === 403 ? "AccessDenied" : "Nieznany");
      const kod = KODY[surowy] ?? surowy.replace(/Exception$/, "");
      const opis = pole(xml, "Message");
      throw new BladAws(kod, odp.status, `Route53 ${metoda} ${sciezka.split("?")[0].replace(/Z[A-Z0-9]+/g, "<id>")}: ${surowy}${opis ? ` (${odXml(opis).slice(0, 300)})` : ""}`);
    }
    return xml;
  }

  #id(id: string): string {
    const n = normalizujIdStrefy(id);
    if (!n) throw new BladAws("ZlyIdentyfikator", 400, "Route53: niepoprawny identyfikator strefy");
    return n;
  }

  #strefa(xml: string): StrefaRoute53 {
    const hz = pole(xml, "HostedZone") ?? "";
    const id = normalizujIdStrefy(odXml(pole(hz, "Id") ?? ""));
    if (!id) throw new BladAws("ZlaOdpowiedz", 200, "Route53: brak identyfikatora strefy w odpowiedzi");
    const ds = pole(xml, "DelegationSet") ?? "";
    return {
      id,
      nazwa: nazwaZRoute53(pole(hz, "Name") ?? ""),
      callerReference: odXml(pole(hz, "CallerReference") ?? ""),
      serweryNs: wszystkie(ds, "NameServer").map((n) => nazwaBezKropki(odXml(n))),
    };
  }

  async utworzStrefe(nazwa: string, o: { callerReference: string; komentarz: string }): Promise<StrefaRoute53> {
    const cialo =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<CreateHostedZoneRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">` +
      `<Name>${doXml(nazwaBezKropki(nazwa))}.</Name>` +
      `<CallerReference>${doXml(o.callerReference)}</CallerReference>` +
      `<HostedZoneConfig><Comment>${doXml(o.komentarz.slice(0, 256))}</Comment><PrivateZone>false</PrivateZone></HostedZoneConfig>` +
      `</CreateHostedZoneRequest>`;
    return this.#strefa(await this.#wolaj("POST", "/hostedzone", cialo));
  }

  async strefyONazwie(nazwa: string): Promise<StrefaRoute53[]> {
    const n = nazwaBezKropki(nazwa);
    const xml = await this.#wolaj("GET", `/hostedzonesbyname?dnsname=${encodeURIComponent(`${n}.`)}&maxitems=100`);
    return wszystkie(xml, "HostedZone")
      .map((hz) => ({
        id: normalizujIdStrefy(odXml(pole(hz, "Id") ?? "")) ?? "",
        nazwa: nazwaZRoute53(pole(hz, "Name") ?? ""),
        callerReference: odXml(pole(hz, "CallerReference") ?? ""),
        serweryNs: [],
      }))
      .filter((s) => s.id && s.nazwa === n);
  }

  async odczytajStrefe(id: string): Promise<StrefaRoute53 | null> {
    try {
      return this.#strefa(await this.#wolaj("GET", `/hostedzone/${this.#id(id)}`));
    } catch (b) {
      if (b instanceof BladAws && b.kod === "NotFound") return null;
      throw b;
    }
  }

  async tagiStrefy(id: string): Promise<Record<string, string>> {
    const xml = await this.#wolaj("GET", `/tags/hostedzone/${this.#id(id)}`);
    const tagi: Record<string, string> = {};
    for (const t of wszystkie(xml, "Tag")) {
      const k = pole(t, "Key");
      if (k !== null) tagi[odXml(k)] = odXml(pole(t, "Value") ?? "");
    }
    return tagi;
  }

  async ustawTagiStrefy(id: string, tagi: Record<string, string>): Promise<void> {
    const cialo =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ChangeTagsForResourceRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><AddTags>` +
      Object.entries(tagi)
        .map(([k, v]) => `<Tag><Key>${doXml(k)}</Key><Value>${doXml(v)}</Value></Tag>`)
        .join("") +
      `</AddTags></ChangeTagsForResourceRequest>`;
    await this.#wolaj("POST", `/tags/hostedzone/${this.#id(id)}`, cialo);
  }

  async rekordy(id: string): Promise<RekordRoute53[]> {
    const wynik: RekordRoute53[] = [];
    let dalej = "";
    // strefa wysyłkowa ma kilka rekordów; sufit stron chroni przed pętlą przy dziwnej odpowiedzi
    for (let strona = 0; strona < 20; strona++) {
      const xml = await this.#wolaj("GET", `/hostedzone/${this.#id(id)}/rrset?maxitems=300${dalej}`);
      for (const rs of wszystkie(xml, "ResourceRecordSet")) {
        wynik.push({
          nazwa: nazwaZRoute53(pole(rs, "Name") ?? ""),
          typ: odXml(pole(rs, "Type") ?? ""),
          ttl: Number(pole(rs, "TTL") ?? 0),
          wartosci: wszystkie(pole(rs, "ResourceRecords") ?? "", "Value").map(odXml),
        });
      }
      if (pole(xml, "IsTruncated") !== "true") return wynik;
      const nn = pole(xml, "NextRecordName");
      const nt = pole(xml, "NextRecordType");
      if (!nn || !nt) return wynik;
      dalej = `&name=${encodeURIComponent(odXml(nn))}&type=${encodeURIComponent(odXml(nt))}`;
    }
    return wynik;
  }

  async zmienRekordy(id: string, zmiany: ZmianaRoute53[], komentarz: string): Promise<{ changeId: string; stan: StanZmianyR53 }> {
    const cialo =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch>` +
      `<Comment>${doXml(komentarz.slice(0, 256))}</Comment><Changes>` +
      zmiany
        .map(
          (z) =>
            `<Change><Action>${z.akcja}</Action><ResourceRecordSet>` +
            `<Name>${doXml(nazwaBezKropki(z.rekord.nazwa))}.</Name><Type>${doXml(String(z.rekord.typ))}</Type><TTL>${Math.trunc(z.rekord.ttl)}</TTL>` +
            `<ResourceRecords>${z.rekord.wartosci.map((w) => `<ResourceRecord><Value>${doXml(w)}</Value></ResourceRecord>`).join("")}</ResourceRecords>` +
            `</ResourceRecordSet></Change>`,
        )
        .join("") +
      `</Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
    const xml = await this.#wolaj("POST", `/hostedzone/${this.#id(id)}/rrset`, cialo);
    const ci = pole(xml, "ChangeInfo") ?? "";
    const changeId = normalizujIdZmiany(odXml(pole(ci, "Id") ?? ""));
    if (!changeId) throw new BladAws("ZlaOdpowiedz", 200, "Route53: brak identyfikatora zmiany w odpowiedzi");
    return { changeId, stan: pole(ci, "Status") === "INSYNC" ? "INSYNC" : "PENDING" };
  }

  async stanZmiany(changeId: string): Promise<StanZmianyR53> {
    const id = normalizujIdZmiany(changeId);
    if (!id) throw new BladAws("ZlyIdentyfikator", 400, "Route53: niepoprawny identyfikator zmiany");
    const xml = await this.#wolaj("GET", `/change/${id}`);
    return pole(pole(xml, "ChangeInfo") ?? "", "Status") === "INSYNC" ? "INSYNC" : "PENDING";
  }
}
