import { createHash } from "node:crypto";
import { BladAws } from "../../domain/email/ses";
import {
  nazwaBezKropki,
  normalizujIdStrefy,
  type PortRoute53,
  type RekordRoute53,
  type StanZmianyR53,
  type StrefaRoute53,
  type ZmianaRoute53,
} from "../../domain/email/route53";

/**
 * Atrapa Route 53 w pamięci (testy zawsze, sandbox przy SES_ATRAPA + ROUTE53_DELEGACJA).
 * Odwzorowuje to, co ważne dla logiki: CallerReference jednorazowy (drugi raz =
 * AlreadyExists), kilka stref o tej samej nazwie, NS ze zbioru deterministycznego, zmiany
 * PENDING → INSYNC przy drugim odczycie, walidacja partii jak w AWS (DELETE wymaga
 * dokładnego dopasowania, rekord spoza strefy = InvalidChangeBatch).
 */

export function serweryAtrapy(id: string): string[] {
  const h = createHash("sha256").update(id).digest();
  return [
    `ns-${h[0] * 4 + 1}.awsdns-${String(h[1] % 64).padStart(2, "0")}.com`,
    `ns-${h[2] * 4 + 512}.awsdns-${String(h[3] % 64).padStart(2, "0")}.net`,
    `ns-${h[4] * 4 + 1024}.awsdns-${String(h[5] % 64).padStart(2, "0")}.org`,
    `ns-${h[6] * 4 + 1536}.awsdns-${String(h[7] % 64).padStart(2, "0")}.co.uk`,
  ];
}

interface StrefaAtrapy extends StrefaRoute53 {
  tagi: Record<string, string>;
  rekordy: RekordRoute53[];
}

export class AtrapaRoute53 implements PortRoute53 {
  readonly strefy = new Map<string, StrefaAtrapy>();
  readonly uzyteReferencje = new Set<string>();
  readonly zmiany = new Map<string, { odczyty: number }>();
  readonly wywolania: string[] = [];
  /** następne wywołanie danej operacji rzuci tym błędem (raz) */
  readonly bledy = new Map<string, BladAws>();
  /** utworzStrefe tworzy strefę, ale „gubi" odpowiedź (symulacja przerwanego połączenia) */
  zgubOdpowiedzUtworzenia = false;
  #licznik = 0;

  #sprawdz(op: string) {
    this.wywolania.push(op);
    const b = this.bledy.get(op);
    if (b) {
      this.bledy.delete(op);
      throw b;
    }
  }

  #strefa(id: string): StrefaAtrapy {
    const s = this.strefy.get(normalizujIdStrefy(id) ?? "");
    if (!s) throw new BladAws("NotFound", 404, "Route53: NoSuchHostedZone");
    return s;
  }

  #kopia(s: StrefaAtrapy): StrefaRoute53 {
    return { id: s.id, nazwa: s.nazwa, callerReference: s.callerReference, serweryNs: [...s.serweryNs] };
  }

  async utworzStrefe(nazwa: string, o: { callerReference: string; komentarz: string }): Promise<StrefaRoute53> {
    this.#sprawdz("utworzStrefe");
    if (this.uzyteReferencje.has(o.callerReference)) throw new BladAws("AlreadyExists", 409, "Route53: HostedZoneAlreadyExists");
    this.uzyteReferencje.add(o.callerReference);
    const id = `Z${String(++this.#licznik).padStart(4, "0")}${createHash("sha256").update(o.callerReference).digest("hex").slice(0, 12).toUpperCase()}`;
    const n = nazwaBezKropki(nazwa);
    const ns = serweryAtrapy(id);
    const s: StrefaAtrapy = {
      id,
      nazwa: n,
      callerReference: o.callerReference,
      serweryNs: ns,
      tagi: {},
      rekordy: [
        { nazwa: n, typ: "NS", ttl: 172800, wartosci: ns.map((x) => `${x}.`) },
        { nazwa: n, typ: "SOA", ttl: 900, wartosci: [`${ns[0]}. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400`] },
      ],
    };
    this.strefy.set(id, s);
    if (this.zgubOdpowiedzUtworzenia) {
      this.zgubOdpowiedzUtworzenia = false;
      throw new Error("socket hang up");
    }
    return this.#kopia(s);
  }

  async strefyONazwie(nazwa: string): Promise<StrefaRoute53[]> {
    this.#sprawdz("strefyONazwie");
    const n = nazwaBezKropki(nazwa);
    return [...this.strefy.values()].filter((s) => s.nazwa === n).map((s) => ({ ...this.#kopia(s), serweryNs: [] }));
  }

  async odczytajStrefe(id: string): Promise<StrefaRoute53 | null> {
    this.#sprawdz("odczytajStrefe");
    const s = this.strefy.get(normalizujIdStrefy(id) ?? "");
    return s ? this.#kopia(s) : null;
  }

  async tagiStrefy(id: string): Promise<Record<string, string>> {
    this.#sprawdz("tagiStrefy");
    return { ...this.#strefa(id).tagi };
  }

  async ustawTagiStrefy(id: string, tagi: Record<string, string>): Promise<void> {
    this.#sprawdz("ustawTagiStrefy");
    Object.assign(this.#strefa(id).tagi, tagi);
  }

  async rekordy(id: string): Promise<RekordRoute53[]> {
    this.#sprawdz("rekordy");
    return this.#strefa(id).rekordy.map((r) => ({ ...r, wartosci: [...r.wartosci] }));
  }

  async zmienRekordy(id: string, zmiany: ZmianaRoute53[]): Promise<{ changeId: string; stan: StanZmianyR53 }> {
    this.#sprawdz("zmienRekordy");
    const s = this.#strefa(id);
    const nowe = s.rekordy.map((r) => ({ ...r, wartosci: [...r.wartosci] }));
    for (const z of zmiany) {
      const n = nazwaBezKropki(z.rekord.nazwa);
      if (n !== s.nazwa && !n.endsWith(`.${s.nazwa}`)) throw new BladAws("InvalidChangeBatch", 400, "Route53: InvalidChangeBatch (poza strefą)");
      const i = nowe.findIndex((r) => r.nazwa === n && r.typ === z.rekord.typ);
      if (z.akcja === "DELETE") {
        if (i < 0 || nowe[i].wartosci.join("|") !== z.rekord.wartosci.join("|")) throw new BladAws("InvalidChangeBatch", 400, "Route53: InvalidChangeBatch (DELETE bez dopasowania)");
        nowe.splice(i, 1);
      } else {
        const r = { nazwa: n, typ: z.rekord.typ, ttl: z.rekord.ttl, wartosci: [...z.rekord.wartosci] };
        if (i < 0) nowe.push(r);
        else nowe[i] = r;
      }
    }
    s.rekordy = nowe;
    const changeId = `C${String(this.zmiany.size + 1).padStart(6, "0")}ATRAPA`;
    this.zmiany.set(changeId, { odczyty: 0 });
    return { changeId, stan: "PENDING" };
  }

  async stanZmiany(changeId: string): Promise<StanZmianyR53> {
    this.#sprawdz("stanZmiany");
    const z = this.zmiany.get(changeId);
    if (!z) throw new BladAws("NotFound", 404, "Route53: NoSuchChange");
    z.odczyty++;
    return z.odczyty >= 1 ? "INSYNC" : "PENDING";
  }
}
