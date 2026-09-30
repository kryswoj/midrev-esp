import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResolverDns } from "../src/adapters/email/dns";
import type { FunkcjaLookup } from "../src/adapters/email/bezpieczny-host";

/**
 * Tryb przekaźnika (SES) w weryfikacji domeny i konfiguracji serwera (0029).
 *
 * Model pilota MidRev (03-wysylka, 7.1): From newsletter@news.midrev.pl, Easy DKIM
 * d=news.midrev.pl, custom MAIL FROM bounce.news.midrev.pl (MX feedback-smtp, SPF
 * include:amazonses.com), DMARC midrev.pl p=quarantine; adkim=s; aspf=s.
 *
 * Plik mockuje `trybSandbox`, żeby sprawdzić blokadę ścieżki domyślnej POZA sandboksem
 * (P1-7). Reszta konfiguracji zostaje z procesu testów.
 */
const stan = vi.hoisted(() => ({ sandbox: true }));
vi.mock("../src/config", async (oryginal) => {
  const m = await oryginal<typeof import("../src/config")>();
  return { ...m, trybSandbox: () => stan.sandbox };
});

const { closePool, getPool } = await import("../src/adapters/db/pool");
const { zweryfikujDomene } = await import("../src/usecases/wysylka-konfiguracja/weryfikacja-dns");
const { dodajDomene, sprawdzDomene } = await import("../src/usecases/wysylka-konfiguracja/domeny");
const { odczytajSerwer, zapiszSerwer } = await import("../src/usecases/wysylka-konfiguracja/serwer");
const { wybierzWysylke } = await import("../src/usecases/wysylka-konfiguracja/nadawca");

type Strefa = { txt?: Record<string, string[]>; mx?: Record<string, { exchange: string; priority: number }[]>; a?: Record<string, string[]> };

function brak(nazwa: string) {
  return Object.assign(new Error(`brak ${nazwa}`), { code: "ENOTFOUND" });
}
function resolver(strefa: Strefa): ResolverDns {
  const odp = <T,>(mapa: Record<string, T> | undefined, n: string) => (mapa?.[n] === undefined ? Promise.reject(brak(n)) : Promise.resolve(mapa[n] as T));
  return {
    txt: (n) => odp(strefa.txt, n),
    mx: (n) => odp(strefa.mx, n),
    a: (n) => odp(strefa.a, n),
    aaaa: (n) => odp<string[]>(undefined, n),
    cname: (n) => odp<string[]>(undefined, n),
  };
}

const KLUCZ = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");

/** Strefa jak po wdrożeniu SES dla news.midrev.test (bez SPF na samym news.). */
function strefaSes(o: { dmarcSub?: string | null; mxKoperty?: number } = {}): Strefa {
  const s: Strefa = {
    txt: {
      "bounce.news.midrev.test": ["v=spf1 include:amazonses.com ~all"],
      "amazonses.com": ["v=spf1 ip4:199.255.192.0/22 ip4:199.127.232.0/22 -all"],
      "tok1._domainkey.news.midrev.test": [`v=DKIM1; k=rsa; p=${KLUCZ}`],
      "_dmarc.midrev.test": ["v=DMARC1; p=quarantine; adkim=s; aspf=s"],
    },
    mx: {
      "news.midrev.test": [{ exchange: "smtp.google.com", priority: 1 }],
      "bounce.news.midrev.test": Array.from({ length: o.mxKoperty ?? 1 }, (_, i) => ({ exchange: i === 0 ? "feedback-smtp.eu-central-1.amazonses.com" : `mx${i}.inny.test`, priority: 10 })),
    },
  };
  if ((o.mxKoperty ?? 1) === 0) delete s.mx!["bounce.news.midrev.test"];
  if (o.dmarcSub) s.txt!["_dmarc.news.midrev.test"] = [o.dmarcSub];
  return s;
}

const KONTEKST_SES = {
  rodzaj: "przekaznik" as const,
  domenaKoperty: "bounce.news.midrev.test",
  selektorDkim: "tok1",
  mechanizmSpf: "include:amazonses.com",
  // IP hosta email-smtp.eu-central-1.amazonaws.com NIE jest w SPF i nie ma znaczenia
  ipSerwera: ["3.120.0.1"],
  hostSerwera: "email-smtp.eu-central-1.amazonaws.com",
};

describe("Weryfikacja domeny w trybie przekaźnika (SES)", () => {
  it("SES z custom MAIL FROM: SPF na kopercie bez porównania IP hosta SMTP, domena zweryfikowana", async () => {
    const w = await zweryfikujDomene("news.midrev.test", KONTEKST_SES, resolver(strefaSes()));
    expect(w.spf.status).toBe("ok");
    expect(w.spf.uwagi.join(" ")).toContain("bounce.news.midrev.test");
    expect(w.dkim.status).toBe("ok");
    expect(w.dmarc.status).toBe("ok");
    expect(w.status).toBe("verified");
    expect(w.rodzajSerwera).toBe("przekaznik");
  });

  it("ścisły DMARC (aspf=s z apexu): SPF koperty nie wyrównany, jasny komunikat „DMARC stoi wyłącznie na DKIM”", async () => {
    const w = await zweryfikujDomene("news.midrev.test", KONTEKST_SES, resolver(strefaSes()));
    expect(w.wyrownanie).toMatchObject({ aspf: "s", adkim: "s", spf: "niewyrownany", dkim: "wyrownany", dmarcPrzejdzie: true });
    expect(w.wyrownanie?.komunikat).toContain("wyłącznie na DKIM");
    expect(w.wyrownanie?.komunikat).toContain("aspf=r");
  });

  it("własny DMARC subdomeny z aspf=r: obie nogi wyrównane, bez komunikatu", async () => {
    const w = await zweryfikujDomene("news.midrev.test", KONTEKST_SES, resolver(strefaSes({ dmarcSub: "v=DMARC1; p=quarantine; adkim=s; aspf=r" })));
    expect(w.wyrownanie).toMatchObject({ aspf: "r", spf: "wyrownany", dkim: "wyrownany", dmarcPrzejdzie: true, komunikat: null });
  });

  it("DKIM zepsuty przy aspf=s: DMARC NIE przejdzie — komunikat mówi to wprost, domena nie jest zweryfikowana", async () => {
    const strefa = strefaSes();
    delete strefa.txt!["tok1._domainkey.news.midrev.test"];
    const w = await zweryfikujDomene("news.midrev.test", KONTEKST_SES, resolver(strefa));
    expect(w.wyrownanie?.dmarcPrzejdzie).toBe(false);
    expect(w.wyrownanie?.komunikat).toContain("DMARC NIE przejdzie");
    expect(w.status).not.toBe("verified");
  });

  it("SES: MX koperty musi być DOKŁADNIE jeden i wskazywać feedback-smtp.<region>.amazonses.com", async () => {
    const bez = await zweryfikujDomene("news.midrev.test", KONTEKST_SES, resolver(strefaSes({ mxKoperty: 0 })));
    expect(bez.spf.status).toBe("bledny");
    expect(bez.spf.poprawka).toContain("MX");
    const dwa = await zweryfikujDomene("news.midrev.test", KONTEKST_SES, resolver(strefaSes({ mxKoperty: 2 })));
    expect(dwa.spf.status).toBe("bledny");
    expect(dwa.spf.problem).toContain("DOKŁADNIE jednego");
    const zly = strefaSes();
    zly.mx!["bounce.news.midrev.test"] = [{ exchange: "smtp.google.com", priority: 1 }];
    const w = await zweryfikujDomene("news.midrev.test", KONTEKST_SES, resolver(zly));
    expect(w.spf.status).toBe("bledny");
    expect(w.status).not.toBe("verified");
  });

  it("koperta bez include dostawcy albo bez rekordu SPF: błąd z gotowym rekordem na kopercie", async () => {
    const zly = strefaSes();
    zly.txt!["bounce.news.midrev.test"] = ["v=spf1 include:_spf.google.com ~all"];
    zly.txt!["_spf.google.com"] = ["v=spf1 ip4:1.2.3.0/24 ~all"];
    const w = await zweryfikujDomene("news.midrev.test", KONTEKST_SES, resolver(zly));
    expect(w.spf.status).toBe("bledny");
    expect(w.spf.poprawka).toContain("v=spf1 include:amazonses.com ~all");
    const pusty = strefaSes();
    delete pusty.txt!["bounce.news.midrev.test"];
    const w2 = await zweryfikujDomene("news.midrev.test", KONTEKST_SES, resolver(pusty));
    expect(w2.spf.status).toBe("brak");
    expect(w2.spf.poprawka).toContain("bounce.news.midrev.test");
  });

  it("przekaźnik bez domeny koperty albo bez mechanizmu: niesprawdzony, nigdy „ok”", async () => {
    expect((await zweryfikujDomene("news.midrev.test", { ...KONTEKST_SES, domenaKoperty: null }, resolver(strefaSes()))).spf.status).toBe("niesprawdzony");
    expect((await zweryfikujDomene("news.midrev.test", { ...KONTEKST_SES, mechanizmSpf: null }, resolver(strefaSes()))).spf.status).toBe("niesprawdzony");
  });

  it("dla porównania: ten sam SES jako „własny serwer” oceniany po IP hosta nie przechodzi (stary błąd FR45)", async () => {
    const strefa = strefaSes();
    strefa.txt!["news.midrev.test"] = ["v=spf1 include:amazonses.com ~all"];
    const w = await zweryfikujDomene("news.midrev.test", { ...KONTEKST_SES, rodzaj: "wlasny_serwer", domenaKoperty: null }, resolver(strefa));
    expect(w.spf.status).toBe("bledny");
  });
});

describe("Serwer w trybie przekaźnika (baza) i ścieżka domyślna poza sandboksem", () => {
  let tenantId: string;
  let bezSerwera: string;
  const lookup: FunkcjaLookup = async () => [{ address: "8.8.4.4", family: 4 }];
  const dane = (pola: Record<string, string> = {}) => ({
    host: "email-smtp.eu-central-1.amazonaws.com",
    port: "587",
    bezpieczenstwo: "starttls",
    uzytkownik: "AKIAEXAMPLE",
    noweHaslo: "Tajne-Haslo-SES",
    usunHaslo: false,
    nazwaNadawcy: "MidRev",
    adresNadawcy: "newsletter@news.midrev.test",
    odpowiedzDo: "krystian@midrev.test",
    rodzaj: "przekaznik",
    domenaKoperty: "bounce.news.midrev.test",
    ...pola,
  });

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'PRZEKAZNIK %'");
    tenantId = (await pool.query("insert into tenants (name) values ('PRZEKAZNIK tenant') returning id")).rows[0].id;
    bezSerwera = (await pool.query("insert into tenants (name) values ('PRZEKAZNIK bez serwera') returning id")).rows[0].id;
    const d = await dodajDomene(tenantId, { domena: "news.midrev.test", selektorDkim: "tok1", mechanizmSpf: "include:amazonses.com" });
    expect(d.ok).toBe(true);
  });

  afterAll(async () => {
    stan.sandbox = true;
    await getPool().query("delete from tenants where name like 'PRZEKAZNIK %'");
    await closePool();
  });

  it("walidacja: przekaźnik wymaga koperty, koperta musi być w domenie nadawcy", async () => {
    expect(await zapiszSerwer(tenantId, dane({ domenaKoperty: "" }), { lookup })).toMatchObject({ ok: false, blad: expect.stringContaining("domenę koperty") });
    expect(await zapiszSerwer(tenantId, dane({ domenaKoperty: "bounce.obca.test" }), { lookup })).toMatchObject({ ok: false, blad: expect.stringContaining("subdomeną") });
    expect(await zapiszSerwer(tenantId, dane({ rodzaj: "cos" }), { lookup })).toMatchObject({ ok: false });
  });

  it("zapis z odczytem zwrotnym, a sprawdzenie domeny idzie trybem przekaźnika (bez IP hosta)", async () => {
    expect(await zapiszSerwer(tenantId, dane(), { lookup })).toEqual({ ok: true });
    const s = await odczytajSerwer(tenantId);
    expect(s).toMatchObject({ rodzaj: "przekaznik", domenaKoperty: "bounce.news.midrev.test" });
    const spr = await sprawdzDomene(tenantId, s!.domenaId, { resolver: resolver(strefaSes()), lookup });
    expect(spr.ok && spr.domena.status).toBe("verified");
    expect(spr.ok && spr.wynik.rodzajSerwera).toBe("przekaznik");
    // rekord SPF do ustawienia stoi na kopercie (host względny „bounce")
    expect(spr.ok && spr.domena.rekordy.find((r) => r.rodzaj === "spf")).toMatchObject({ host: "bounce", pelnaNazwa: "bounce.news.midrev.test", wartosc: "v=spf1 include:amazonses.com ~all" });
  });

  it("baza pilnuje: przekaźnik bez koperty odrzucony checkiem 0029", async () => {
    await expect(getPool().query("update tenant_smtp_configs set envelope_domain = null where tenant_id = $1", [tenantId])).rejects.toThrow(/przekaznik_koperta/);
  });

  it("poza sandboksem bez adresu pocztowego nadawcy NIC nie wychodzi (kampanie, flowy, testy, dispatcher)", async () => {
    stan.sandbox = false;
    const w = await wybierzWysylke(tenantId);
    expect(w).toMatchObject({ rodzaj: "blokada" });
    expect(w.rodzaj === "blokada" && w.powod).toContain("adresu pocztowego");
    stan.sandbox = true;
  });

  it("P1-7: tenant bez serwera poza sandboksem = blokada z jasnym powodem (kampanie, flowy, testy)", async () => {
    await getPool().query("update tenants set sender_postal_address = 'ul. Prosta 1, 00-001 Warszawa' where id = $1", [bezSerwera]);
    stan.sandbox = false;
    const w = await wybierzWysylke(bezSerwera);
    expect(w).toMatchObject({ rodzaj: "blokada" });
    expect(w.rodzaj === "blokada" && w.powod).toContain("nie ma skonfigurowanego serwera");
    stan.sandbox = true;
    const dev = await wybierzWysylke(bezSerwera);
    expect(dev.rodzaj).toBe("domyslny");
  });
});
