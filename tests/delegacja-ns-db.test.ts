import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AtrapaRoute53 } from "../src/adapters/aws/atrapa-route53";
import { AtrapaSes, tokenyAtrapy } from "../src/adapters/aws/atrapa-ses";
import { ustawPortyAws } from "../src/adapters/aws/fabryka";
import { closePool, getPool } from "../src/adapters/db/pool";
import type { ResolverDns } from "../src/adapters/email/dns";
import type { OdpowiedzAutorytatywna, ResolverAutorytatywny } from "../src/adapters/email/dns-autorytatywny";
import { BladAws } from "../src/domain/email/ses";
import { tikDomen } from "../src/jobs/handlery-domeny";
import { route53Z, wyczyscBlokadeRoute53, zapewnijStrefe } from "../src/usecases/wysylka-konfiguracja/delegacja-dns";
import {
  domenaPlatformowa,
  odlaczDomenePlatformowa,
  podlaczDomene,
  sprawdzDomenePlatformowa,
} from "../src/usecases/wysylka-konfiguracja/domena-platformowa";
import { odczytajInstrukcje, utworzLinkInstrukcji } from "../src/usecases/wysylka-konfiguracja/instrukcja-dns";

/**
 * „Jeden wpis NS" na prawdziwej bazie: atrapa SES, atrapa Route 53 i model DNS w pamięci
 * (testy nie wołają AWS ani internetu). Model ma dwie warstwy jak w życiu:
 *   - strefa RODZICA (u dostawcy klienta): to, co klient wpisał w panelu,
 *   - NASZA strefa w Route 53: widoczna dla internetu tylko wtedy, gdy u rodzica jest NS
 *     z naszymi serwerami (wtedy serwer rodzica odsyła dalej zamiast odpowiadać).
 * Każda asercja czyta ZAPISANY stan z bazy albo z atrapy.
 */

type Wpisy = Record<string, Partial<Record<"NS" | "A" | "CNAME" | "MX" | "TXT", string[]>>>;

function brak(): Error {
  return Object.assign(new Error("ENODATA"), { code: "ENODATA" });
}

class Swiat {
  /** strefa rodzica: nazwa → typ → wartości (MX jako „10 host") */
  rodzic: Wpisy = {};
  awariaRodzica = false;
  constructor(
    readonly strefa: string,
    readonly r53: AtrapaRoute53,
  ) {
    this.rodzic[strefa] = { NS: ["ns1.hostido.net.pl", "ns2.hostido.net.pl"], MX: ["1 smtp.google.com"] };
    this.rodzic[`_dmarc.${strefa}`] = { TXT: [`v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:dmarc@${strefa}`] };
  }

  /** delegacja u rodzica, która wskazuje na którąś z NASZYCH stref (pełny zestaw serwerów) */
  #delegacja(nazwa: string): { punkt: string; ns: string[]; strefaR53: AtrapaRoute53["strefy"] extends Map<string, infer S> ? S : never } | null {
    const etykiety = nazwa.split(".");
    for (let i = 0; i < etykiety.length; i++) {
      const punkt = etykiety.slice(i).join(".");
      if (punkt === this.strefa) return null;
      const ns = this.rodzic[punkt]?.NS?.map((x) => x.replace(/\.$/, ""));
      if (!ns?.length) continue;
      const z = [...this.r53.strefy.values()].find((s) => s.nazwa === punkt && s.serweryNs.every((x) => ns.includes(x)) && ns.every((x) => s.serweryNs.includes(x)));
      return z ? { punkt, ns, strefaR53: z } : null;
    }
    return null;
  }

  /** co odpowiada internet (resolver rekursywny) */
  #rekursywnie(nazwa: string, typ: "NS" | "A" | "CNAME" | "MX" | "TXT"): string[] {
    const n = nazwa.toLowerCase().replace(/\.$/, "");
    const d = this.#delegacja(n);
    if (d) {
      const r = d.strefaR53.rekordy.find((x) => x.nazwa === n && x.typ === typ);
      return (r?.wartosci ?? []).map((w) => w.replace(/^"|"$/g, "").replace(/\.$/, ""));
    }
    // strefa rodzica bez działającej delegacji: rekordy pod delegowaną nazwą są niewidoczne
    return this.rodzic[n]?.[typ] ?? [];
  }

  resolver(): ResolverDns {
    const z = (n: string, t: "NS" | "A" | "CNAME" | "MX" | "TXT") => {
      const w = this.#rekursywnie(n, t);
      return w.length ? Promise.resolve(w) : Promise.reject(brak());
    };
    return {
      txt: (n) => z(n, "TXT"),
      cname: (n) => z(n, "CNAME"),
      ns: (n) => z(n, "NS"),
      a: (n) => z(n, "A"),
      aaaa: () => Promise.reject(brak()),
      mx: async (n) => (await z(n, "MX")).map((m) => ({ priority: Number(m.split(" ")[0]), exchange: m.split(" ")[1].replace(/\.$/, "") })),
    };
  }

  /** serwery dostawcy klienta: odsyłają dalej pod nazwą z NS, inaczej odpowiadają z autorytetem */
  autorytatywny(): ResolverAutorytatywny {
    return {
      zapytaj: async (nazwa, typ): Promise<OdpowiedzAutorytatywna> => {
        if (this.awariaRodzica) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
        const n = nazwa.toLowerCase().replace(/\.$/, "");
        const etykiety = n.split(".");
        for (let i = 0; i < etykiety.length; i++) {
          const punkt = etykiety.slice(i).join(".");
          if (punkt === this.strefa) break;
          const ns = this.rodzic[punkt]?.NS;
          if (ns?.length) return { autorytatywna: false, rcode: 0, odpowiedzi: [], autorytet: ns.map((d) => ({ nazwa: punkt, typ: "NS", dane: d.replace(/\.$/, "") })) };
        }
        const w: string[] = typ === "AAAA" ? [] : (this.rodzic[n]?.[typ] ?? []);
        return { autorytatywna: true, rcode: 0, odpowiedzi: w.map((d: string) => ({ nazwa: n, typ, dane: d.replace(/\.$/, "") })), autorytet: [] };
      },
    };
  }
}

describe("Jeden wpis NS: strefa Route 53, rekordy, ocena delegacji", () => {
  let tenantA: string;
  let tenantB: string;
  let tenantC: string;
  let ses: AtrapaSes;
  let r53: AtrapaRoute53;
  const alerty: string[] = [];
  const alert = async (t: string) => {
    alerty.push(t);
  };
  const opcje = (s: Swiat) => ({ resolver: s.resolver(), autorytatywny: s.autorytatywny(), alert, route53: r53, ses });

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'NS %'");
    tenantA = (await pool.query("insert into tenants (name) values ('NS Sklep A') returning id")).rows[0].id;
    tenantB = (await pool.query("insert into tenants (name) values ('NS Sklep B') returning id")).rows[0].id;
    tenantC = (await pool.query("insert into tenants (name) values ('NS Sklep C') returning id")).rows[0].id;
    ses = new AtrapaSes();
    r53 = new AtrapaRoute53();
    ustawPortyAws({ ses, sns: null, route53: r53 });
  });

  afterEach(() => {
    alerty.length = 0;
    wyczyscBlokadeRoute53();
  });

  afterAll(async () => {
    ustawPortyAws();
    await getPool().query("delete from tenants where name like 'NS %'");
    await closePool();
  });

  const swiatA = () => swiaty.a;
  const swiaty: Record<string, Swiat> = {};

  it("podłączenie: strefa news.<domena> z tagiem tenanta, tryb „delegacja”, sześć rekordów w strefie, cztery serwery", async () => {
    swiaty.a = new Swiat("ns-a.test", r53);
    const w = await podlaczDomene(tenantA, { wpis: "ns-a.test", nazwaNadawcy: "A", odpowiedzDo: "" }, opcje(swiatA()));
    expect(w.ok).toBe(true);
    const d = (await domenaPlatformowa(tenantA))!;
    expect(d.tryb).toBe("delegacja");
    expect(d.delegacja?.nazwa).toBe("news");
    expect(d.delegacja?.serwery).toHaveLength(4);
    const { rows } = await getPool().query("select zone_id, name_servers, tagged_at, caller_reference from dns_hosted_zones where tenant_id = $1", [tenantA]);
    expect(rows).toHaveLength(1);
    const strefa = r53.strefy.get(rows[0].zone_id)!;
    expect(strefa.nazwa).toBe("news.ns-a.test");
    expect(strefa.tagi.midrev_tenant).toBe(tenantA);
    expect(strefa.callerReference).toBe(rows[0].caller_reference);
    expect(rows[0].name_servers).toEqual(strefa.serweryNs);
    const nasze = strefa.rekordy.filter((r) => r.typ !== "NS" && r.typ !== "SOA");
    expect(nasze.map((r) => `${r.nazwa} ${r.typ}`).sort()).toEqual(
      [...tokenyAtrapy("news.ns-a.test").map((t) => `${t}._domainkey.news.ns-a.test CNAME`), "bounce.news.ns-a.test MX", "bounce.news.ns-a.test TXT", "_dmarc.news.ns-a.test TXT"].sort(),
    );
    expect(nasze.find((r) => r.typ === "MX")?.wartosci).toEqual(["10 feedback-smtp.eu-north-1.amazonses.com."]);
    const { rows: sd } = await getPool().query("select r53_synced_at, r53_change_id, delegation_unavailable from sending_domains where tenant_id = $1", [tenantA]);
    expect(sd[0].r53_synced_at).not.toBeNull();
    expect(sd[0].r53_change_id).toMatch(/^C/);
    expect(sd[0].delegation_unavailable).toBeNull();
  });

  it("sprawdzenie bez wpisu NS: „brak”, tryb zostaje „delegacja”", async () => {
    const d = (await domenaPlatformowa(tenantA))!;
    const w = await sprawdzDomenePlatformowa(tenantA, d.id, opcje(swiatA()));
    expect(w.ok).toBe(true);
    const po = (await domenaPlatformowa(tenantA))!;
    expect(po.delegacja?.ocena?.stan).toBe("brak");
    expect(po.tryb).toBe("delegacja");
  });

  it("pomyłki przy wpisie: doklejona domena, dwa z czterech, zła nazwa, NS na domenie głównej (PILNE), stary CNAME obok", async () => {
    const s = swiatA();
    const d = (await domenaPlatformowa(tenantA))!;
    const ns = d.delegacja!.serwery;
    const sprawdz = async () => {
      await sprawdzDomenePlatformowa(tenantA, d.id, opcje(s));
      return (await domenaPlatformowa(tenantA))!;
    };

    s.rodzic["news.ns-a.test"] = { NS: [...ns.slice(1), `${ns[0]}.ns-a.test`] };
    expect((await sprawdz()).delegacja?.ocena).toMatchObject({ stan: "bledna", komunikat: expect.stringContaining("kropką") });

    s.rodzic["news.ns-a.test"] = { NS: ns.slice(0, 2) };
    expect((await sprawdz()).delegacja?.ocena).toMatchObject({ stan: "czesciowa", brakujace: ns.slice(2) });

    delete s.rodzic["news.ns-a.test"];
    s.rodzic["news.ns-a.test.ns-a.test"] = { NS: ns };
    expect((await sprawdz()).delegacja?.ocena).toMatchObject({ stan: "bledna", komunikat: expect.stringContaining("zostaw tylko: news") });
    delete s.rodzic["news.ns-a.test.ns-a.test"];

    s.rodzic["ns-a.test"].NS = ["ns1.hostido.net.pl", "ns2.hostido.net.pl", ns[0]];
    const apex = await sprawdz();
    expect(apex.raport?.ostrzezenia[0]).toMatch(/^PILNE: Serwery z naszego wpisu są dodane do całej domeny/);
    // nasze serwery na domenie głównej I poprawny wpis pod news: nadal PILNE, serwery
    // dostawcy pytane bez naszych (review r1, P1)
    s.rodzic["news.ns-a.test"] = { NS: ns };
    const oba = await sprawdz();
    expect(oba.raport?.ostrzezenia[0]).toMatch(/^PILNE:/);
    delete s.rodzic["news.ns-a.test"];
    s.rodzic["ns-a.test"].NS = ["ns1.hostido.net.pl", "ns2.hostido.net.pl"];

    // panel przyjął CNAME pod news i serwuje go z autorytetem (NS przez to nie działa)
    s.rodzic["news.ns-a.test"] = { CNAME: ["sklep.example.com"] };
    expect((await sprawdz()).delegacja?.ocena).toMatchObject({ stan: "konflikt", komunikat: expect.stringContaining("CNAME") });
    delete s.rodzic["news.ns-a.test"];
  });

  it("poprawny wpis: „dziala”, rekordy z naszej strefy widać w internecie, po potwierdzeniu SES domena gotowa", async () => {
    const s = swiatA();
    const d = (await domenaPlatformowa(tenantA))!;
    s.rodzic["news.ns-a.test"] = { NS: d.delegacja!.serwery.map((x) => `${x}.`) };
    const t = ses.tozsamosci.get("news.ns-a.test")!;
    Object.assign(t, { gotowaDoWysylki: true, status: "SUCCESS", dkimStatus: "SUCCESS", mailFromStatus: "SUCCESS" });
    const w = await sprawdzDomenePlatformowa(tenantA, d.id, opcje(s));
    expect(w.ok).toBe(true);
    const po = (await domenaPlatformowa(tenantA))!;
    expect(po.delegacja?.ocena?.stan).toBe("dziala");
    expect(po.raport!.rekordy).toEqual(Object.fromEntries(po.rekordy.map((r) => [r.klucz, { stan: "ok", komunikat: null }])));
    expect(po.status).toBe("verified");
    expect(po.gotowa).toBe(true);
  });

  it("strefa rozjechana (ktoś usunął rekord, został obcy TXT) → worker przywraca stan, odczyt zwrotny zgodny", async () => {
    const d = (await domenaPlatformowa(tenantA))!;
    const { rows } = await getPool().query("select zone_id from dns_hosted_zones where tenant_id = $1", [tenantA]);
    const strefa = r53.strefy.get(rows[0].zone_id)!;
    strefa.rekordy = strefa.rekordy.filter((r) => r.typ !== "MX");
    strefa.rekordy.push({ nazwa: "stary._domainkey.news.ns-a.test", typ: "CNAME", ttl: 300, wartosci: ["stary.dkim.amazonses.com."] });
    await getPool().query("update sending_domains set next_check_at = now() - interval '1 minute' where tenant_id = $1", [tenantA]);
    const s = swiatA();
    const wynik = await tikDomen({ ...opcje(s), przerwaMs: 0 });
    expect(wynik.sprawdzone).toBeGreaterThanOrEqual(1);
    const po = r53.strefy.get(rows[0].zone_id)!;
    expect(po.rekordy.some((r) => r.typ === "MX" && r.nazwa === "bounce.news.ns-a.test")).toBe(true);
    expect(po.rekordy.some((r) => r.nazwa.startsWith("stary."))).toBe(false);
    expect((await domenaPlatformowa(tenantA))?.id).toBe(d.id);
  });

  it("synchronizacja nie pisze do strefy, której tag w AWS przestawiono na innego tenanta (review r1)", async () => {
    const { rows } = await getPool().query("select zone_id from dns_hosted_zones where tenant_id = $1 and domain = 'news.ns-a.test'", [tenantA]);
    const strefa = r53.strefy.get(rows[0].zone_id)!;
    strefa.tagi.midrev_tenant = tenantB;
    strefa.rekordy = strefa.rekordy.filter((r) => r.typ !== "MX");
    const d = (await domenaPlatformowa(tenantA))!;
    await sprawdzDomenePlatformowa(tenantA, d.id, opcje(swiatA()));
    expect(strefa.rekordy.some((r) => r.typ === "MX")).toBe(false);
    expect(alerty.join(" ")).toContain("Rekordy NIE zostały zmienione");
    strefa.tagi.midrev_tenant = tenantA;
    await sprawdzDomenePlatformowa(tenantA, d.id, opcje(swiatA()));
    expect(strefa.rekordy.some((r) => r.typ === "MX")).toBe(true);
  });

  it("izolacja: inny tenant nie odczyta ani nie sprawdzi cudzej domeny; złożony klucz nie przypnie cudzej strefy", async () => {
    const d = (await domenaPlatformowa(tenantA))!;
    expect(await sprawdzDomenePlatformowa(tenantB, d.id, opcje(swiatA()))).toEqual({ ok: false, blad: "Nie ma takiej domeny na tym koncie." });
    // wolna (nieprzypięta) strefa tenanta A: unikalność nie przeszkadza, zostaje sam klucz złożony
    const { rows } = await getPool().query(
      "insert into dns_hosted_zones (tenant_id, domain, caller_reference) values ($1, 'wolna.ns-a.test', 'midrev-test-wolna') returning id",
      [tenantA],
    );
    // domena tenanta B (ręczna, bez Route 53), potem próba podpięcia strefy A wprost w bazie
    const s = new Swiat("ns-b.test", r53);
    swiaty.b = s;
    const w = await podlaczDomene(tenantB, { wpis: "ns-b.test", nazwaNadawcy: "B", odpowiedzDo: "" }, { ...opcje(s), route53: null });
    expect(w.ok).toBe(true);
    const db = (await domenaPlatformowa(tenantB))!;
    expect(db.tryb).toBe("reczny");
    expect(db.delegacjaNiedostepna).toBe("route53");
    await expect(getPool().query("update sending_domains set hosted_zone_id = $2 where tenant_id = $1 and managed_by = 'platforma'", [tenantB, rows[0].id])).rejects.toThrow(/foreign key/);
  });

  it("idempotencja: zgubiona odpowiedź CreateHostedZone → strefa odnaleziona po CallerReference, kolejne wywołania bez nowej strefy", async () => {
    r53.zgubOdpowiedzUtworzenia = true;
    const o = { route53: r53, alert };
    const pierwsza = await zapewnijStrefe(tenantC, "news.ns-c.test", r53, o);
    expect(r53.wywolania).toContain("strefyONazwie");
    const druga = await zapewnijStrefe(tenantC, "news.ns-c.test", r53, o);
    expect(druga?.zoneId).toBe(pierwsza?.zoneId);
    // druga odpowiedź „już istnieje" (np. równoległa próba, która nie zdążyła zapisać id) też trafia w tę samą strefę
    await getPool().query("update dns_hosted_zones set zone_id = null where tenant_id = $1 and domain = 'news.ns-c.test'", [tenantC]);
    const trzecia = await zapewnijStrefe(tenantC, "news.ns-c.test", r53, o);
    expect(druga?.zoneId).toBeTruthy();
    expect(trzecia?.zoneId).toBe(druga?.zoneId);
    expect([...r53.strefy.values()].filter((s) => s.nazwa === "news.ns-c.test")).toHaveLength(1);
    expect(r53.strefy.get(druga!.zoneId)!.tagi.midrev_tenant).toBe(tenantC);
  });

  it("izolacja w AWS: strefa o tej nazwie z CUDZYM CallerReference nie jest przejmowana; nasza z cudzym tagiem = odmowa", async () => {
    // obca strefa o tej samej nazwie (inny tenant / ręcznie założona)
    const obca = await r53.utworzStrefe("news.ns-d.test", { callerReference: "ktos-inny", komentarz: "" });
    await r53.ustawTagiStrefy(obca.id, { midrev_tenant: tenantA });
    const nasza = await zapewnijStrefe(tenantC, "news.ns-d.test", r53, { route53: r53, alert });
    expect(nasza?.zoneId).toBeTruthy();
    expect(nasza!.zoneId).not.toBe(obca.id);
    expect(r53.strefy.get(obca.id)!.tagi.midrev_tenant).toBe(tenantA);
    // ktoś przestawił tag naszej strefy na innego tenanta → odmowa, alert, bez zapisu
    r53.strefy.get(nasza!.zoneId)!.tagi.midrev_tenant = tenantA;
    expect(await zapewnijStrefe(tenantC, "news.ns-d.test", r53, { route53: r53, alert })).toBeNull();
    expect(alerty.join(" ")).toContain("ma tag innego tenanta");
  });

  it("odłączenie i ponowne podłączenie przez ten sam tenant: ta sama strefa, te same serwery (klient nic nie zmienia)", async () => {
    const przed = (await domenaPlatformowa(tenantA))!;
    const liczbaStref = r53.strefy.size;
    expect((await odlaczDomenePlatformowa(tenantA)).ok).toBe(true);
    const w = await podlaczDomene(tenantA, { wpis: "ns-a.test", nazwaNadawcy: "A", odpowiedzDo: "" }, opcje(swiatA()));
    expect(w.ok).toBe(true);
    const po = (await domenaPlatformowa(tenantA))!;
    expect(po.delegacja?.serwery).toEqual(przed.delegacja?.serwery);
    expect(r53.strefy.size).toBe(liczbaStref);
  });

  it("brak uprawnień Route 53: domena podłączona w trybie ręcznym, klient bez żargonu, operator dostaje alert, opcja ukryta na 15 min", async () => {
    await getPool().query("delete from sending_domains where tenant_id = $1", [tenantC]);
    r53.bledy.set("utworzStrefe", new BladAws("AccessDenied", 403, "Route53 POST /hostedzone: AccessDenied"));
    const s = new Swiat("ns-e.test", r53);
    const w = await podlaczDomene(tenantC, { wpis: "ns-e.test", nazwaNadawcy: "C", odpowiedzDo: "" }, { ...opcje(s), route53: undefined });
    expect(w.ok).toBe(true);
    const d = (await domenaPlatformowa(tenantC))!;
    expect(d.tryb).toBe("reczny");
    expect(d.delegacja).toBeNull();
    expect(d.delegacjaNiedostepna).toBe("route53");
    expect(alerty.join(" ")).toContain("brak uprawnień Route 53");
    expect(alerty.join(" ")).toContain("08-delegacja-ns.md");
    expect(route53Z({})).toBeNull();
  });

  it("nie proponujemy jednego wpisu: domena główna (apex) i nazwa, pod którą coś już działa", async () => {
    await getPool().query("delete from sending_domains where tenant_id = $1", [tenantC]);
    const s = new Swiat("ns-f.test", r53);
    const apex = await podlaczDomene(tenantC, { wpis: "ns-f.test", prefiks: "", nazwaNadawcy: "C", odpowiedzDo: "" }, opcje(s));
    expect(apex.ok).toBe(true);
    expect((await domenaPlatformowa(tenantC))?.delegacjaNiedostepna).toBe("apex");
    await getPool().query("delete from sending_domains where tenant_id = $1", [tenantC]);

    const s2 = new Swiat("ns-g.test", r53);
    s2.rodzic["news.ns-g.test"] = { A: ["203.0.113.7"] };
    const zajeta = await podlaczDomene(tenantC, { wpis: "ns-g.test", nazwaNadawcy: "C", odpowiedzDo: "" }, opcje(s2));
    expect(zajeta.ok).toBe(true);
    const d = (await domenaPlatformowa(tenantC))!;
    expect(d.delegacjaNiedostepna).toBe("zajeta_nazwa");
    expect(d.tryb).toBe("reczny");
    expect([...r53.strefy.values()].some((z) => z.nazwa === "news.ns-g.test")).toBe(false);
  });

  it("DNS nie odpowiada przy podłączeniu: bez „jednego wpisu” (nie wiemy, czy nazwa wolna); worker proponuje go później (review r1)", async () => {
    await getPool().query("delete from sending_domains where tenant_id = $1", [tenantC]);
    const s = new Swiat("ns-j.test", r53);
    const r = s.resolver();
    let awaria = true;
    const zawodny: typeof r = { ...r, a: (n) => (awaria && n === "news.ns-j.test" ? Promise.reject(Object.assign(new Error("x"), { code: "ETIMEOUT" })) : r.a(n)) };
    const w = await podlaczDomene(tenantC, { wpis: "ns-j.test", nazwaNadawcy: "C", odpowiedzDo: "" }, { ...opcje(s), resolver: zawodny });
    expect(w.ok).toBe(true);
    const d = (await domenaPlatformowa(tenantC))!;
    expect(d.delegacjaNiedostepna).toBe("niesprawdzona");
    expect(d.delegacja).toBeNull();
    awaria = false;
    await sprawdzDomenePlatformowa(tenantC, d.id, { ...opcje(s), resolver: zawodny });
    const po = (await domenaPlatformowa(tenantC))!;
    expect(po.delegacja?.serwery).toHaveLength(4);
    expect(po.delegacjaNiedostepna).toBeNull();
  });

  it("klient wpisał rekordy ręcznie zamiast NS → tryb „reczny”; potem dodał NS → wraca „delegacja”", async () => {
    await getPool().query("delete from sending_domains where tenant_id = $1", [tenantC]);
    const s = new Swiat("ns-h.test", r53);
    const w = await podlaczDomene(tenantC, { wpis: "ns-h.test", nazwaNadawcy: "C", odpowiedzDo: "" }, opcje(s));
    expect(w.ok).toBe(true);
    const d = (await domenaPlatformowa(tenantC))!;
    expect(d.tryb).toBe("delegacja");
    for (const r of d.rekordy) {
      const wartosc = r.typ === "MX" ? `10 ${r.oczekiwana}` : r.oczekiwana;
      s.rodzic[r.nazwaPelna] = { ...(s.rodzic[r.nazwaPelna] ?? {}), [r.typ]: [wartosc] };
    }
    await sprawdzDomenePlatformowa(tenantC, d.id, opcje(s));
    expect((await domenaPlatformowa(tenantC))?.tryb).toBe("reczny");
    s.rodzic["news.ns-h.test"] = { NS: d.delegacja!.serwery };
    await sprawdzDomenePlatformowa(tenantC, d.id, opcje(s));
    const po = (await domenaPlatformowa(tenantC))!;
    expect(po.tryb).toBe("delegacja");
    expect(po.delegacja?.ocena?.stan).toBe("dziala");
  });

  it("własny DMARC subdomeny u dostawcy jest przenoszony do naszej strefy (po delegacji byłby niewidoczny)", async () => {
    await getPool().query("delete from sending_domains where tenant_id = $1", [tenantC]);
    const s = new Swiat("ns-i.test", r53);
    s.rodzic["_dmarc.news.ns-i.test"] = { TXT: ["v=DMARC1; p=reject; rua=mailto:x@ns-i.test"] };
    const w = await podlaczDomene(tenantC, { wpis: "ns-i.test", nazwaNadawcy: "C", odpowiedzDo: "" }, opcje(s));
    expect(w.ok).toBe(true);
    const { rows } = await getPool().query(
      "select z.zone_id from dns_hosted_zones z join sending_domains d on d.hosted_zone_id = z.id and d.tenant_id = z.tenant_id where d.tenant_id = $1",
      [tenantC],
    );
    const dmarc = r53.strefy.get(rows[0].zone_id)!.rekordy.find((r) => r.nazwa === "_dmarc.news.ns-i.test");
    expect(dmarc?.wartosci).toEqual(['"v=DMARC1; p=reject; rua=mailto:x@ns-i.test"']);
  });

  it("serwery dostawcy nie odpowiadają: stan „czeka”, bez fałszywego „brak” i bez zmiany trybu", async () => {
    const d = (await domenaPlatformowa(tenantC))!;
    const s = new Swiat("ns-i.test", r53);
    s.awariaRodzica = true;
    await sprawdzDomenePlatformowa(tenantC, d.id, opcje(s));
    const po = (await domenaPlatformowa(tenantC))!;
    expect(po.delegacja?.ocena?.stan).toBe("czeka");
    expect(po.tryb).toBe("delegacja");
  });

  it("link dla informatyka pokazuje jeden wpis (serwery), bez identyfikatora strefy i danych konta", async () => {
    const d = (await domenaPlatformowa(tenantC))!;
    const link = await utworzLinkInstrukcji(tenantC, d.id);
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    const i = await odczytajInstrukcje(link.url.split("/dns/")[1]);
    expect(i?.delegacja?.serwery).toEqual(d.delegacja?.serwery);
    const { rows } = await getPool().query("select zone_id from dns_hosted_zones where tenant_id = $1", [tenantC]);
    const tekst = JSON.stringify(i);
    expect(rows.filter((r) => r.zone_id).length).toBeGreaterThan(0);
    for (const r of rows.filter((r) => r.zone_id)) expect(tekst).not.toContain(r.zone_id);
    expect(tekst).not.toContain(tenantC);
  });

  it("worker: delegacja włączona flagą bez kluczy → jeden alert dla operatora", async () => {
    const { zglosBrakRoute53 } = await import("../src/usecases/wysylka-konfiguracja/delegacja-dns");
    await zglosBrakRoute53(true, null, alert);
    await zglosBrakRoute53(true, null, alert);
    expect(alerty.filter((a) => a.includes("ROUTE53_DELEGACJA"))).toHaveLength(1);
  });
});
