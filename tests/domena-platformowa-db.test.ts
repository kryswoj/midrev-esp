import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AtrapaSes, tokenyAtrapy } from "../src/adapters/aws/atrapa-ses";
import { ustawPortyAws } from "../src/adapters/aws/fabryka";
import { closePool, getPool } from "../src/adapters/db/pool";
import type { ResolverDns } from "../src/adapters/email/dns";
import type { DostawcaWysylki, Wiadomosc, WynikWysylki } from "../src/domain/email/port";
import { BladAws, nazwaConfigurationSetu } from "../src/domain/email/ses";
import { powiadomOGotowosci, tikDomen } from "../src/jobs/handlery-domeny";
import { stanOnboardingu } from "../src/usecases/onboarding";
import {
  domenaPlatformowa,
  odlaczDomenePlatformowa,
  podlaczDomene,
  przygotujPropozycje,
  sprawdzDomenePlatformowa,
  zapiszNadawcePlatformy,
} from "../src/usecases/wysylka-konfiguracja/domena-platformowa";
import { odczytajInstrukcje, utworzLinkInstrukcji } from "../src/usecases/wysylka-konfiguracja/instrukcja-dns";
import { wybierzWysylke } from "../src/usecases/wysylka-konfiguracja/nadawca";
import { wyslijTestPlatformy } from "../src/usecases/wysylka-konfiguracja/wysylka-platformowa";

/**
 * Kreator „Podłącz domenę" na prawdziwej bazie, z atrapą SES i atrapą DNS (testy nie
 * wołają AWS ani internetu). Każda asercja czyta ZAPISANY stan.
 */

type Rekordy = Record<string, { txt?: string[]; mx?: { exchange: string; priority: number }[]; cname?: string[]; ns?: string[] }>;

function brak(): Error {
  return Object.assign(new Error("ENODATA"), { code: "ENODATA" });
}

/** Resolver z tabelą rekordów; `awaria` = każde zapytanie kończy się SERVFAIL. */
function resolver(r: Rekordy, opcje: { awaria?: boolean } = {}): ResolverDns {
  const pobierz = <K extends keyof Rekordy[string]>(nazwa: string, typ: K) => {
    if (opcje.awaria) return Promise.reject(Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" }));
    const w = r[nazwa.toLowerCase().replace(/\.$/, "")]?.[typ];
    return w && (w as unknown[]).length ? Promise.resolve(w as NonNullable<Rekordy[string][K]>) : Promise.reject(brak());
  };
  return {
    txt: (n) => pobierz(n, "txt"),
    mx: (n) => pobierz(n, "mx"),
    cname: (n) => pobierz(n, "cname"),
    ns: (n) => pobierz(n, "ns"),
    a: () => Promise.reject(brak()),
    aaaa: () => Promise.reject(brak()),
  };
}

/** Strefa sklepu: NS Hostido, ścisły DMARC na domenie głównej (jak midrev.pl), poczta Google. */
function strefaSklepu(domena: string): Rekordy {
  return {
    [domena]: { ns: ["ns1.hostido.net.pl", "ns2.hostido.net.pl"], mx: [{ exchange: "smtp.google.com", priority: 1 }] },
    [`_dmarc.${domena}`]: { txt: [`v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:dmarc@${domena}`] },
  };
}

/** Komplet poprawnie wpisanych rekordów dla news.<domena> (tokeny atrapy). */
function wpisaneRekordy(domena: string): Rekordy {
  const d = `news.${domena}`;
  const r: Rekordy = {};
  for (const t of tokenyAtrapy(d)) r[`${t}._domainkey.${d}`] = { cname: [`${t}.dkim.amazonses.com`] };
  r[`bounce.${d}`] = { mx: [{ exchange: "feedback-smtp.eu-north-1.amazonses.com", priority: 10 }], txt: ["v=spf1 include:amazonses.com ~all"] };
  r[`_dmarc.${d}`] = { txt: ["v=DMARC1; p=quarantine; aspf=r"] };
  return r;
}

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  readonly wyslane: Wiadomosc[] = [];
  async wyslij(w: Wiadomosc): Promise<WynikWysylki> {
    this.wyslane.push(w);
    return { providerId: `<${w.idempotencyKey}@x>` };
  }
}

const NIC = async () => {};

describe("Wysyłka platformowa: kreator domeny", () => {
  let tenantA: string;
  let tenantB: string;
  let tenantC: string;
  let ses: AtrapaSes;
  const alerty: string[] = [];
  const alert = async (t: string) => {
    alerty.push(t);
  };

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'DOM %'");
    tenantA = (await pool.query("insert into tenants (name) values ('DOM Sklep A') returning id")).rows[0].id;
    tenantB = (await pool.query("insert into tenants (name) values ('DOM Sklep B') returning id")).rows[0].id;
    tenantC = (await pool.query("insert into tenants (name) values ('DOM Sklep C') returning id")).rows[0].id;
    ses = new AtrapaSes();
    ustawPortyAws({ ses, sns: null });
  });

  afterEach(() => {
    alerty.length = 0;
  });

  afterAll(async () => {
    ustawPortyAws();
    await getPool().query("delete from tenants where name like 'DOM %'");
    await closePool();
  });

  it("propozycja: news.<domena>, adres z części przed @, strefa i dostawca po NS, DMARC dobrany sam", async () => {
    const p = await przygotujPropozycje("Kontakt@Dom-a.test", { resolver: resolver(strefaSklepu("dom-a.test")) });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.propozycja.uklad.adresNadawcy).toBe("kontakt@news.dom-a.test");
    expect(p.propozycja.strefa).toBe("dom-a.test");
    expect(p.propozycja.dostawca.klucz).toBe("hostido");
    // ścisłe aspf=s na domenie głównej → własny rekord z aspf=r
    expect(p.propozycja.dmarc.propozycja).toBe("v=DMARC1; p=quarantine; aspf=r; rua=mailto:dmarc@dom-a.test");
  });

  it("domena, której nie ma w DNS, i awaria DNS dają zdanie po ludzku, bez żargonu", async () => {
    const p1 = await przygotujPropozycje("nie-ma.test", { resolver: resolver({}) });
    expect(p1).toEqual({ ok: false, blad: expect.stringContaining("Nie znaleźliśmy domeny") });
    const p2 = await przygotujPropozycje("dom-a.test", { resolver: resolver({}, { awaria: true }) });
    expect(p2.ok).toBe(false);
    if (!p2.ok) expect(p2.blad).not.toMatch(/SERVFAIL|SES|SMTP/);
  });

  it("podłączenie: rezerwacja w bazie, configuration set tenanta, tożsamość z tagiem tenanta, adres zwrotny", async () => {
    const w = await podlaczDomene(
      tenantA,
      { wpis: "dom-a.test", nazwaNadawcy: "Sklep A", odpowiedzDo: "wlasciciel@dom-a.test" },
      { resolver: resolver(strefaSklepu("dom-a.test")), alert },
    );
    expect(w.ok).toBe(true);
    const d = await domenaPlatformowa(tenantA);
    expect(d).toMatchObject({ domena: "news.dom-a.test", strefa: "dom-a.test", status: "pending", mailFrom: "bounce.news.dom-a.test" });
    expect(d?.nadawca).toEqual({ nazwa: "Sklep A", adres: "newsletter@news.dom-a.test", odpowiedzDo: "wlasciciel@dom-a.test" });
    expect(d?.rekordy.map((r) => r.nazwa)).toEqual([...tokenyAtrapy("news.dom-a.test").map((t) => `${t}._domainkey.news`), "bounce.news", "bounce.news", "_dmarc.news"]);
    // Hostido: wartości z kropką
    expect(d?.rekordy[0].wartosc.endsWith(".")).toBe(true);
    const t = ses.tozsamosci.get("news.dom-a.test")!;
    expect(t.tagi.midrev_tenant).toBe(tenantA);
    expect(t.configurationSet).toBe(nazwaConfigurationSetu(tenantA));
    expect(t.mailFromDomena).toBe("bounce.news.dom-a.test");
    const { rows } = await getPool().query("select ses_configuration_set from tenants where id = $1", [tenantA]);
    expect(rows[0].ses_configuration_set).toBe(nazwaConfigurationSetu(tenantA));
  });

  it("izolacja: inny tenant nie podłączy tej samej domeny ani jej sub/nadrzędnej (wspólne poświadczenia SES)", async () => {
    for (const wpis of ["news.dom-a.test", "dom-a.test"]) {
      const prefiks = wpis === "dom-a.test" ? "" : undefined;
      const r = resolver({ ...strefaSklepu("dom-a.test") });
      const w = await podlaczDomene(tenantB, { wpis, prefiks, nazwaNadawcy: "B", odpowiedzDo: "" }, { resolver: r, alert });
      expect(w).toEqual({ ok: false, blad: expect.stringContaining("innym koncie") });
    }
    expect(await domenaPlatformowa(tenantB)).toBeNull();
  });

  it("tożsamość już w SES z tagiem INNEGO tenanta = odmowa, rezerwacja cofnięta, alert operatora", async () => {
    await ses.utworzTozsamosc("news.dom-obca.test", { configurationSet: null, tagi: { midrev_tenant: "00000000-0000-0000-0000-000000000000" } });
    const w = await podlaczDomene(tenantB, { wpis: "dom-obca.test", nazwaNadawcy: "B", odpowiedzDo: "" }, { resolver: resolver(strefaSklepu("dom-obca.test")), alert });
    expect(w.ok).toBe(false);
    expect(await domenaPlatformowa(tenantB)).toBeNull();
    expect(alerty.join(" ")).toContain("nie należy do tenanta");
  });

  it("błąd AWS (brak uprawnień) = rezerwacja cofnięta, klient dostaje zdanie bez kodów, operator dostaje kod", async () => {
    ses.bledy.set("utworzTozsamosc", new BladAws("AccessDenied", 403, "SES: AccessDenied"));
    const w = await podlaczDomene(tenantB, { wpis: "dom-b.test", nazwaNadawcy: "B", odpowiedzDo: "" }, { resolver: resolver(strefaSklepu("dom-b.test")), alert });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.blad).not.toMatch(/AccessDenied|SES|IAM/);
    expect(alerty.join(" ")).toContain("brak uprawnień IAM");
    expect(await domenaPlatformowa(tenantB)).toBeNull();
  });

  it("drugiej domeny platformowej to samo konto nie podłączy (jeden nadawca na konto)", async () => {
    const druga = await podlaczDomene(tenantA, { wpis: "inna-a.test", nazwaNadawcy: "A", odpowiedzDo: "" }, { resolver: resolver(strefaSklepu("inna-a.test")), alert });
    expect(druga).toEqual({ ok: false, blad: expect.stringContaining("Masz już podłączoną domenę news.dom-a.test") });
  });

  it("sprawdzenie bez rekordów: pending, każdy rekord „do dodania”, wysyłka zablokowana", async () => {
    const d = (await domenaPlatformowa(tenantA))!;
    const w = await sprawdzDomenePlatformowa(tenantA, d.id, { resolver: resolver(strefaSklepu("dom-a.test")), alert });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.domena.status).toBe("pending");
    expect(Object.values(w.domena.raport!.rekordy).every((r) => r?.stan === "brak")).toBe(true);
    await getPool().query("update tenants set sender_postal_address = 'ul. Testowa 1, 00-001 Warszawa' where id = $1", [tenantA]);
    const wybor = await wybierzWysylke(tenantA, { dostawca: new DostawcaAtrapa() });
    expect(wybor.rodzaj).toBe("blokada");
  });

  it("typowe pomyłki: doklejona domena w wartości, domena dwa razy w nazwie, MX pod domeną główną", async () => {
    const d = (await domenaPlatformowa(tenantA))!;
    const [t1, t2] = tokenyAtrapy("news.dom-a.test");
    const r = resolver({
      ...strefaSklepu("dom-a.test"),
      // panel bez kropki na końcu: wartość z doklejoną strefą
      [`${t1}._domainkey.news.dom-a.test`]: { cname: [`${t1}.dkim.amazonses.com.dom-a.test`] },
      // pełna nazwa wpisana w panelu, który sam dopisuje domenę
      [`${t2}._domainkey.news.dom-a.test.dom-a.test`]: { cname: [`${t2}.dkim.amazonses.com`] },
      // rekord zwrotów wpisany pod domenę główną: poczta firmy nie działa
      "dom-a.test": { ns: ["ns1.hostido.net.pl"], mx: [{ exchange: "feedback-smtp.eu-north-1.amazonses.com", priority: 10 }] },
    });
    const w = await sprawdzDomenePlatformowa(tenantA, d.id, { resolver: r, alert });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    const o = w.domena.raport!;
    expect(o.rekordy.podpis1).toEqual({ stan: "zle", komunikat: expect.stringContaining("z dopisanym .dom-a.test na końcu") });
    expect(o.rekordy.podpis2).toEqual({ stan: "zle", komunikat: expect.stringContaining("W polu Nazwa wpisz tylko") });
    expect(o.ostrzezenia.some((x) => x.startsWith("PILNE") && x.includes("zwykłą pocztę firmy"))).toBe(true);
  });

  it("rekordy w DNS, SES jeszcze czeka → „sprawdzamy”, nie „gotowe”; SES potwierdza → verified", async () => {
    const d = (await domenaPlatformowa(tenantA))!;
    const r = resolver({ ...strefaSklepu("dom-a.test"), ...wpisaneRekordy("dom-a.test") });
    const w1 = await sprawdzDomenePlatformowa(tenantA, d.id, { resolver: r, alert });
    expect(w1.ok && w1.domena.status).toBe("partial");
    if (w1.ok) expect(w1.domena.raport!.rekordy.podpis1?.stan).toBe("czeka");

    ses.ustaw("news.dom-a.test", { gotowaDoWysylki: true, status: "SUCCESS", dkimStatus: "SUCCESS", mailFromStatus: "SUCCESS" });
    const w2 = await sprawdzDomenePlatformowa(tenantA, d.id, { resolver: r, alert });
    expect(w2.ok).toBe(true);
    if (!w2.ok) return;
    expect(w2.domena.status).toBe("verified");
    expect(w2.domena.gotowa).toBe(true);
    expect(w2.wlasnieGotowa).toBe(true);
    expect(w2.domena.zweryfikowanoAt).not.toBeNull();
  });

  it("chwilowa awaria DNS nie zdejmuje gotowości (wynik zostaje, bez obniżania)", async () => {
    const d = (await domenaPlatformowa(tenantA))!;
    const w = await sprawdzDomenePlatformowa(tenantA, d.id, { resolver: resolver({}, { awaria: true }), alert });
    expect(w.ok && w.domena.status).toBe("verified");
  });

  it("gotowa domena: nadawca Z BAZY tenanta, nie z żądania; adres zawsze w jego domenie", async () => {
    const dost = new DostawcaAtrapa();
    const wybor = await wybierzWysylke(tenantA, { dostawca: dost });
    expect(wybor.rodzaj).toBe("platforma");
    if (wybor.rodzaj === "blokada") return;
    expect(wybor.nadawca).toEqual({ od: "newsletter@news.dom-a.test", odNazwa: "Sklep A", odpowiedzDo: "wlasciciel@dom-a.test" });
    // zmiana nadawcy: domeny z formularza nie bierzemy, tylko część przed @
    expect((await zapiszNadawcePlatformy(tenantA, { nazwaNadawcy: "Sklep A", lokalna: "promo", odpowiedzDo: "" })).ok).toBe(true);
    expect((await domenaPlatformowa(tenantA))?.nadawca?.adres).toBe("promo@news.dom-a.test");
    expect((await zapiszNadawcePlatformy(tenantA, { nazwaNadawcy: "X", lokalna: "a@evil.test", odpowiedzDo: "" })).ok).toBe(false);
    // ręcznie podmieniony adres spoza domeny = blokada w bramce, nie wysyłka
    await getPool().query("update tenant_platform_senders set from_email = 'promo@obca.test' where tenant_id = $1", [tenantA]);
    expect((await wybierzWysylke(tenantA, { dostawca: dost })).rodzaj).toBe("blokada");
    await getPool().query("update tenant_platform_senders set from_email = 'newsletter@news.dom-a.test' where tenant_id = $1", [tenantA]);
  });

  it("mail testowy: idzie z adresu tenanta i odhacza krok onboardingu", async () => {
    const dost = new DostawcaAtrapa();
    const w = await wyslijTestPlatformy(tenantA, "ja@example.test", { dostawca: dost });
    expect(w).toEqual({ ok: true, od: "newsletter@news.dom-a.test" });
    expect(dost.wyslane[0].od).toBe("newsletter@news.dom-a.test");
    const s = await stanOnboardingu(tenantA);
    expect(s.kroki.find((k) => k.klucz === "test")?.zrobiony).toBe(true);
    expect(s.kroki.find((k) => k.klucz === "domena_gotowa")?.zrobiony).toBe(true);
  });

  it("powiadomienie o gotowości idzie RAZ (także przy dwóch tikach naraz)", async () => {
    const d = (await domenaPlatformowa(tenantA))!;
    const user = await getPool().query("insert into users (email, password_hash, display_name, role) values ('dom-a-wlasciciel@example.test', 'x', 'A', 'client') returning id");
    await getPool().query("insert into memberships (user_id, tenant_id, role) values ($1, $2, 'client')", [user.rows[0].id, tenantA]);
    const wyslane: string[][] = [];
    const wyslij = async (p: { do: string[] }) => {
      wyslane.push(p.do);
    };
    const [a, b] = await Promise.all([powiadomOGotowosci(tenantA, d.id, wyslij), powiadomOGotowosci(tenantA, d.id, wyslij)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(wyslane).toEqual([["dom-a-wlasciciel@example.test"]]);
    expect(await powiadomOGotowosci(tenantA, d.id, wyslij)).toBe(false);
    await getPool().query("delete from users where email = 'dom-a-wlasciciel@example.test'");
  });

  it("tik workera bierze tylko domeny z minionym terminem i sprawdza je po kolei", async () => {
    const w = await podlaczDomene(tenantC, { wpis: "dom-c.test", nazwaNadawcy: "C", odpowiedzDo: "" }, { resolver: resolver(strefaSklepu("dom-c.test")), alert });
    expect(w.ok).toBe(true);
    const r = resolver({ ...strefaSklepu("dom-c.test"), ...strefaSklepu("dom-a.test"), ...wpisaneRekordy("dom-a.test") });
    // termin domeny C jeszcze nie minął (podłączona przed chwilą: +1 min)
    const sprawdzonaC = async () =>
      (await getPool().query("select last_checked_at from sending_domains where tenant_id = $1 and managed_by = 'platforma'", [tenantC])).rows[0].last_checked_at;
    await tikDomen({ resolver: r, alert, przerwaMs: 0, wyslij: NIC });
    expect(await sprawdzonaC()).toBeNull();
    const t2 = await tikDomen({ resolver: r, alert, przerwaMs: 0, wyslij: NIC, teraz: new Date(Date.now() + 5 * 60_000) });
    expect(t2.sprawdzone).toBeGreaterThanOrEqual(1);
    expect(await sprawdzonaC()).not.toBeNull();
  });

  it("link dla informatyka: tylko domena i rekordy, 14 dni, nowy link unieważnia stary", async () => {
    const d = (await domenaPlatformowa(tenantC))!;
    const l1 = await utworzLinkInstrukcji(tenantC, d.id);
    expect(l1.ok).toBe(true);
    if (!l1.ok) return;
    const token1 = l1.url.split("/dns/")[1];
    const i = await odczytajInstrukcje(token1);
    expect(i?.domena).toBe("news.dom-c.test");
    // brak danych konta w widoku publicznym
    const widok = JSON.stringify(i);
    expect(widok).not.toMatch(/DOM Sklep|wlasciciel|newsletter@|tenant/);
    expect(widok).not.toContain(tenantC);
    expect(Math.round((l1.wygasa.getTime() - Date.now()) / 86_400_000)).toBe(14);
    // w bazie tylko hash
    const { rows } = await getPool().query("select token_hash from dns_instruction_links where tenant_id = $1", [tenantC]);
    expect(rows.every((r) => r.token_hash !== token1 && /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
    const l2 = await utworzLinkInstrukcji(tenantC, d.id);
    expect(await odczytajInstrukcje(token1)).toBeNull();
    if (l2.ok) {
      const token2 = l2.url.split("/dns/")[1];
      expect(await odczytajInstrukcje(token2)).not.toBeNull();
      expect(await odczytajInstrukcje(token2, new Date(Date.now() + 15 * 86_400_000))).toBeNull();
      // obcy tenant nie utworzy linku do cudzej domeny
      expect((await utworzLinkInstrukcji(tenantB, d.id)).ok).toBe(false);
      // odłączenie domeny zabiera link
      await odlaczDomenePlatformowa(tenantC);
      expect(await odczytajInstrukcje(token2)).toBeNull();
    }
    expect(await odczytajInstrukcje("za-krotki")).toBeNull();
  });
});
