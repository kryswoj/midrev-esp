import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { czyAdresPubliczny, rozwiazHostSmtp, type FunkcjaLookup } from "../src/adapters/email/bezpieczny-host";
import type { ResolverDns } from "../src/adapters/email/dns";
import type { DostawcaWysylki, Wiadomosc } from "../src/domain/email/port";
import { dodajDomene, domena, sprawdzDomene, usunDomene } from "../src/usecases/wysylka-konfiguracja/domeny";
import { odczytajSerwer, zapiszSerwer, type DaneSerwera } from "../src/usecases/wysylka-konfiguracja/serwer";
import { zweryfikujDomene, type KontekstSerwera } from "../src/usecases/wysylka-konfiguracja/weryfikacja-dns";
import { wyslijPartie } from "../src/usecases/wysylka/wyslij-kampanie";

/**
 * Wykonywalna specyfikacja modułu „Wysyłka i domeny".
 *
 * DNS jest wstrzykiwany (tabela rekordów), NIE odpytujemy internetu: wynik zależałby od
 * cudzej strefy i od sieci maszyny. Baza jest prawdziwa (AD-20). Integracja z prawdziwym
 * serwerem SMTP (Mailpit) jest w wysylka-konfiguracja-smtp.test.ts.
 */

// ── atrapa DNS ────────────────────────────────────────────────────────────────

type Strefa = {
  txt?: Record<string, string[]>;
  mx?: Record<string, { exchange: string; priority: number }[]>;
  a?: Record<string, string[]>;
  cname?: Record<string, string[]>;
  awaria?: Record<string, string>;
};

function brak(nazwa: string) {
  const e = new Error(`brak ${nazwa}`) as Error & { code: string };
  e.code = "ENOTFOUND";
  return e;
}

function resolver(strefa: Strefa): ResolverDns & { zapytania: string[] } {
  const zapytania: string[] = [];
  const odpowiedz = <T,>(mapa: Record<string, T> | undefined, nazwa: string): Promise<T> => {
    zapytania.push(nazwa);
    const kod = strefa.awaria?.[nazwa];
    if (kod) {
      const e = new Error(kod) as Error & { code: string };
      e.code = kod;
      return Promise.reject(e);
    }
    const w = mapa?.[nazwa];
    return w === undefined ? Promise.reject(brak(nazwa)) : Promise.resolve(w);
  };
  return {
    zapytania,
    txt: (n) => odpowiedz(strefa.txt, n),
    mx: (n) => odpowiedz(strefa.mx, n),
    a: (n) => odpowiedz(strefa.a, n),
    aaaa: (n) => odpowiedz<string[]>(undefined, n),
    cname: (n) => odpowiedz(strefa.cname, n),
  };
}

function kluczDkim(bity: number): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: bity });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

const KLUCZ_2048 = kluczDkim(2048);
const KLUCZ_1024 = kluczDkim(1024);

/** Poprawnie skonfigurowana domena: SPF przez include dostawcy, DKIM 2048, DMARC quarantine. */
function strefaPoprawna(domena: string): Strefa {
  return {
    txt: {
      [domena]: ["v=spf1 include:_spf.dostawca.test ~all", "google-site-verification=abc"],
      "_spf.dostawca.test": ["v=spf1 ip4:198.51.100.0/24 -all"],
      [`s1._domainkey.${domena}`]: [`v=DKIM1; k=rsa; p=${KLUCZ_2048}`],
      [`_dmarc.${domena}`]: [`v=DMARC1; p=quarantine; rua=mailto:dmarc@${domena}`],
    },
    mx: { [domena]: [{ exchange: `mx.${domena}`, priority: 10 }] },
  };
}

const KONTEKST: KontekstSerwera = { selektorDkim: "s1", mechanizmSpf: null, ipSerwera: ["198.51.100.7"], hostSerwera: "smtp.dostawca.test" };

// ── SSRF ──────────────────────────────────────────────────────────────────────

describe("Bramka SSRF hosta SMTP", () => {
  const bezDev = { hostyDeweloperskie: [] as string[] };
  const lookupNa = (adresy: string[]): FunkcjaLookup => async () => adresy.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it.each([
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["172.16.5.5"],
    ["192.168.1.10"],
    ["169.254.169.254"],
    ["100.64.0.1"],
    ["0.0.0.0"],
    ["::1"],
    ["fe80::1"],
    ["fd00::5"],
    ["::ffff:127.0.0.1"],
    ["::ffff:7f00:1"],
    ["0:0:0:0:0:ffff:7f00:1"],
    ["0:0:0:0:0:ffff:127.0.0.1"],
    ["64:ff9b::a00:1"],
    ["64:ff9b:0:0:0:0:7f00:1"],
    ["2002:c0a8:0101::1"],
    ["::10.0.0.1"],
  ])("odmawia adresu %s podanego wprost", async (adres) => {
    await expect(rozwiazHostSmtp(adres, 587, bezDev)).rejects.toMatchObject({ kod: "adres_prywatny" });
    expect(czyAdresPubliczny(adres)).toBe(false);
  });

  it("odmawia NAZWY, która rozwiązuje się na adres prywatny (sprawdzamy po rozwiązaniu)", async () => {
    await expect(
      rozwiazHostSmtp("smtp.wewnetrzny.example", 587, { ...bezDev, lookup: lookupNa(["10.0.0.5"]) }),
    ).rejects.toMatchObject({ kod: "adres_prywatny" });
  });

  it("odmawia, gdy choć jeden z adresów nazwy jest prywatny (klient TCP może wybrać dowolny)", async () => {
    await expect(
      rozwiazHostSmtp("smtp.mieszany.example", 587, { ...bezDev, lookup: lookupNa(["8.8.8.8", "192.168.0.2"]) }),
    ).rejects.toMatchObject({ kod: "adres_prywatny" });
  });

  it("odmawia portów spoza listy wysyłki poczty (5433 = nasz Postgres)", async () => {
    await expect(rozwiazHostSmtp("8.8.8.8", 5433, bezDev)).rejects.toMatchObject({ kod: "port" });
    await expect(rozwiazHostSmtp("8.8.8.8", 22, bezDev)).rejects.toMatchObject({ kod: "port" });
  });

  it("przepuszcza publiczny serwer na porcie wysyłki i zwraca SPRAWDZONY adres do połączenia", async () => {
    const cel = await rozwiazHostSmtp("SMTP.Dostawca.example.", 587, { ...bezDev, lookup: lookupNa(["8.8.4.4"]) });
    expect(cel).toMatchObject({ host: "smtp.dostawca.example", adres: "8.8.4.4", port: 587, deweloperski: false });
  });

  it("wyjątek deweloperski dotyczy WYŁĄCZNIE dokładnej pary host:port z konfiguracji", async () => {
    const dev = { hostyDeweloperskie: ["127.0.0.1:1025"] };
    await expect(rozwiazHostSmtp("127.0.0.1", 1025, dev)).resolves.toMatchObject({ deweloperski: true });
    await expect(rozwiazHostSmtp("127.0.0.1", 5433, dev)).rejects.toMatchObject({ kod: "port" });
    await expect(rozwiazHostSmtp("127.0.0.1", 587, dev)).rejects.toMatchObject({ kod: "adres_prywatny" });
  });

  it("odrzuca host z protokołem, portem albo spacją", async () => {
    await expect(rozwiazHostSmtp("http://smtp.x.pl", 587, bezDev)).rejects.toMatchObject({ kod: "host" });
    await expect(rozwiazHostSmtp("smtp.x.pl:587", 587, bezDev)).rejects.toMatchObject({ kod: "host" });
  });
});

// ── weryfikacja DNS (czysta logika na atrapie DNS) ───────────────────────────

describe("Weryfikacja SPF / DKIM / DMARC", () => {
  it("poprawnie ustawiona domena jest zweryfikowana, a każdy rekord ma powód", async () => {
    const w = await zweryfikujDomene("sklep.test", KONTEKST, resolver(strefaPoprawna("sklep.test")));
    expect(w.status).toBe("verified");
    expect([w.spf.status, w.dkim.status, w.dmarc.status]).toEqual(["ok", "ok", "ok"]);
    expect(w.dmarc.polityka).toBe("quarantine");
    expect(w.dkim.uwagi.join(" ")).toContain("2048");
    expect(w.mx.rekordy).toEqual(["10 mx.sklep.test"]);
    expect(w.awariaDns).toBe(false);
  });

  it("pusta domena: brak SPF i DMARC z gotowym rekordem do wklejenia, bez selektora DKIM nie zgadujemy", async () => {
    const w = await zweryfikujDomene("pusta.test", { ...KONTEKST, selektorDkim: null }, resolver({}));
    expect(w.status).toBe("failed");
    expect(w.spf.status).toBe("brak");
    expect(w.spf.poprawka).toContain("v=spf1 ip4:198.51.100.7 ~all");
    expect(w.dmarc.status).toBe("brak");
    expect(w.dmarc.poprawka).toContain("_dmarc.pusta.test");
    expect(w.dkim.status).toBe("niesprawdzony");
    expect(w.dkim.przejsciowy).toBe(false);
    expect(w.dkim.poprawka).toContain("selektor");
  });

  it("SPF: IP serwera spoza rekordu to błąd z dokładną poprawką, a nie „prawie ok”", async () => {
    const w = await zweryfikujDomene("sklep.test", { ...KONTEKST, ipSerwera: ["203.0.113.9"] }, resolver(strefaPoprawna("sklep.test")));
    expect(w.spf.status).toBe("bledny");
    expect(w.spf.poprawka).toContain("ip4:203.0.113.9");
    expect(w.spf.poprawka).toContain("Nie zakładaj drugiego rekordu SPF");
    expect(w.status).toBe("partial");
  });

  it("SPF: serwer z kilkoma adresami musi mieć dopuszczone WSZYSTKIE", async () => {
    const w = await zweryfikujDomene("sklep.test", { ...KONTEKST, ipSerwera: ["198.51.100.7", "203.0.113.9"] }, resolver(strefaPoprawna("sklep.test")));
    expect(w.spf.status).toBe("bledny");
    expect(w.spf.problem).toContain("203.0.113.9");
  });

  it("SPF: mechanizm dostawcy podany przez klienta wystarcza, szukany także w include-ach", async () => {
    const strefa = strefaPoprawna("sklep.test");
    strefa.txt!["sklep.test"] = ["v=spf1 include:_spf.posrednik.test -all"];
    strefa.txt!["_spf.posrednik.test"] = ["v=spf1 include:_spf.google.com ~all"];
    const w = await zweryfikujDomene("sklep.test", { ...KONTEKST, ipSerwera: null, mechanizmSpf: "include:_spf.google.com" }, resolver(strefa));
    expect(w.spf.status).toBe("ok");

    // redirect= jest równoważny include (tak ma gmail.com: v=spf1 redirect=_spf.google.com)
    strefa.txt!["sklep.test"] = ["v=spf1 redirect=_spf.google.com"];
    const w2 = await zweryfikujDomene("sklep.test", { ...KONTEKST, ipSerwera: null, mechanizmSpf: "include:_spf.google.com" }, resolver(strefa));
    expect(w2.spf.status).toBe("ok");
  });

  it("SPF: dwa rekordy, +all i przekroczony limit 10 zapytań to rekord błędny", async () => {
    const dwa = strefaPoprawna("sklep.test");
    dwa.txt!["sklep.test"] = ["v=spf1 ip4:198.51.100.7 ~all", "v=spf1 include:x.test ~all"];
    expect((await zweryfikujDomene("sklep.test", KONTEKST, resolver(dwa))).spf.status).toBe("bledny");

    const plus = strefaPoprawna("sklep.test");
    plus.txt!["sklep.test"] = ["v=spf1 ip4:198.51.100.7 +all"];
    const w = await zweryfikujDomene("sklep.test", KONTEKST, resolver(plus));
    expect(w.spf.status).toBe("bledny");
    expect(w.spf.problem).toContain("+all");

    const petla = strefaPoprawna("sklep.test");
    petla.txt!["sklep.test"] = ["v=spf1 include:i0.test ~all"];
    for (let i = 0; i < 12; i++) petla.txt![`i${i}.test`] = [`v=spf1 include:i${i + 1}.test ~all`];
    petla.txt!["i12.test"] = ["v=spf1 ip4:198.51.100.7 -all"];
    expect((await zweryfikujDomene("sklep.test", KONTEKST, resolver(petla))).spf.status).toBe("bledny");
  });

  it("DKIM: brak rekordu, unieważniony klucz, ucięty klucz i klucz 1024", async () => {
    const r = resolver(strefaPoprawna("sklep.test"));
    expect((await zweryfikujDomene("sklep.test", { ...KONTEKST, selektorDkim: "inny" }, r)).dkim.status).toBe("brak");

    const pusty = strefaPoprawna("sklep.test");
    pusty.txt!["s1._domainkey.sklep.test"] = ["v=DKIM1; k=rsa; p="];
    const w1 = await zweryfikujDomene("sklep.test", KONTEKST, resolver(pusty));
    expect(w1.dkim.status).toBe("bledny");
    expect(w1.dkim.problem).toContain("unieważniony");

    const uciety = strefaPoprawna("sklep.test");
    uciety.txt!["s1._domainkey.sklep.test"] = [`v=DKIM1; k=rsa; p=${KLUCZ_2048.slice(0, 200)}`];
    const w2 = await zweryfikujDomene("sklep.test", KONTEKST, resolver(uciety));
    expect(w2.dkim.status).toBe("bledny");
    expect(w2.dkim.problem).toContain("ucięty");

    const krotki = strefaPoprawna("sklep.test");
    krotki.txt!["s1._domainkey.sklep.test"] = [`v=DKIM1; k=rsa; p=${KLUCZ_1024}`];
    const w3 = await zweryfikujDomene("sklep.test", KONTEKST, resolver(krotki));
    expect(w3.dkim.status).toBe("ok");
    expect(w3.dkim.uwagi.join(" ")).toContain("2048");
  });

  it("DMARC: dziedziczony z domeny nadrzędnej, p=none z uwagą, brak p= to błąd", async () => {
    const sub = strefaPoprawna("mail.sklep.test");
    delete sub.txt!["_dmarc.mail.sklep.test"];
    sub.txt!["_dmarc.sklep.test"] = ["v=DMARC1; p=none; sp=reject"];
    const w = await zweryfikujDomene("mail.sklep.test", KONTEKST, resolver(sub));
    expect(w.dmarc.status).toBe("ok");
    // dla subdomeny obowiązuje sp=, nie p=
    expect(w.dmarc.polityka).toBe("reject");
    expect(w.dmarc.uwagi.join(" ")).toContain("sklep.test");

    const none = strefaPoprawna("sklep.test");
    none.txt!["_dmarc.sklep.test"] = ["v=DMARC1; p=none"];
    const w2 = await zweryfikujDomene("sklep.test", KONTEKST, resolver(none));
    expect(w2.dmarc.status).toBe("ok");
    expect(w2.dmarc.uwagi.join(" ")).toContain("obserwacji");
    expect(w2.dmarc.uwagi.join(" ")).toContain("rua");

    const bezP = strefaPoprawna("sklep.test");
    bezP.txt!["_dmarc.sklep.test"] = ["v=DMARC1; rua=mailto:x@sklep.test"];
    expect((await zweryfikujDomene("sklep.test", KONTEKST, resolver(bezP))).dmarc.status).toBe("bledny");
  });

  it("awaria DNS to „nie sprawdzono”, a nie „brak rekordu”", async () => {
    const strefa = strefaPoprawna("sklep.test");
    strefa.awaria = { "_dmarc.sklep.test": "ETIMEOUT" };
    const w = await zweryfikujDomene("sklep.test", KONTEKST, resolver(strefa));
    expect(w.dmarc.status).toBe("niesprawdzony");
    expect(w.dmarc.przejsciowy).toBe(true);
    expect(w.dmarc.problem).toContain("nie odpowiedział");
    expect(w.awariaDns).toBe(true);
    expect(w.status).not.toBe("verified");
  });
});

// ── baza: domeny, serwer, izolacja, FR45 ─────────────────────────────────────

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: Wiadomosc[] = [];
  async wyslij(w: Wiadomosc) {
    this.wyslane.push(w);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

const lookupPubliczny: FunkcjaLookup = async () => [{ address: "8.8.4.4", family: 4 }];

function daneSerwera(pola: Partial<DaneSerwera> = {}): DaneSerwera {
  return {
    host: "smtp.dostawca.test",
    port: "587",
    bezpieczenstwo: "starttls",
    uzytkownik: "sklep@wkf-a.test",
    noweHaslo: "Tajne-Haslo-123!",
    usunHaslo: false,
    nazwaNadawcy: "Sklep WKF",
    adresNadawcy: "sklep@wkf-a.test",
    odpowiedzDo: "kontakt@wkf-a.test",
    ...pola,
  };
}

async function wiadomoscTestowa(tenantId: string): Promise<string> {
  const { rows } = await getPool().query(
    `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
     values ($1, null, 'test', $2, 'odbiorca@example.test', 'WKF temat', '<p>x</p>', $3, $4) returning id`,
    [tenantId, randomUUID(), randomBytes(18).toString("base64url"), randomBytes(18).toString("base64url")],
  );
  return rows[0].id;
}

async function stanWiadomosci(tenantId: string, id: string): Promise<string> {
  const { rows } = await getPool().query("select current_state from messages where tenant_id = $1 and id = $2", [tenantId, id]);
  return rows[0]?.current_state;
}

describe("Domeny i serwer w bazie, FR45 w silniku", () => {
  let tenantA: string;
  let tenantB: string;
  let domenaA: string;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'WKF %'");
    tenantA = (await pool.query("insert into tenants (name) values ('WKF tenant A') returning id")).rows[0].id;
    tenantB = (await pool.query("insert into tenants (name) values ('WKF tenant B') returning id")).rows[0].id;
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like 'WKF %'");
    await closePool();
  });

  it("dodanie domeny normalizuje wpis i zapisuje rekordy do ustawienia", async () => {
    const wynik = await dodajDomene(tenantA, { domena: " https://WKF-A.test/ ", selektorDkim: "S1", mechanizmSpf: "_spf.dostawca.test" });
    expect(wynik.ok).toBe(true);
    if (!wynik.ok) return;
    domenaA = wynik.id;
    const d = await domena(tenantA, domenaA);
    expect(d).toMatchObject({ domena: "wkf-a.test", selektorDkim: "s1", mechanizmSpf: "include:_spf.dostawca.test", status: "pending" });
    expect(d!.rekordy.map((r) => r.pelnaNazwa)).toEqual(["wkf-a.test", "s1._domainkey.wkf-a.test", "_dmarc.wkf-a.test"]);

    const duplikat = await dodajDomene(tenantA, { domena: "wkf-a.test", selektorDkim: "", mechanizmSpf: "" });
    expect(duplikat.ok).toBe(false);
  });

  it("sprawdzenie zapisuje wynik; awaria DNS nie obniża wcześniejszego statusu", async () => {
    const ok = await sprawdzDomene(tenantA, domenaA, { resolver: resolver(strefaPoprawna("wkf-a.test")), lookup: lookupPubliczny });
    expect(ok.ok && ok.domena.status).toBe("verified");
    const zapisana = await domena(tenantA, domenaA);
    expect(zapisana).toMatchObject({ status: "verified", spf: "ok", dkim: "ok", dmarc: "ok", politykaDmarc: "quarantine", bladSprawdzenia: null });
    expect(zapisana!.zweryfikowanoAt).not.toBeNull();
    expect(zapisana!.raport?.spf.status).toBe("ok");

    const zAwaria = strefaPoprawna("wkf-a.test");
    zAwaria.awaria = { "wkf-a.test": "ESERVFAIL" };
    const po = await sprawdzDomene(tenantA, domenaA, { resolver: resolver(zAwaria), lookup: lookupPubliczny });
    expect(po.ok).toBe(true);
    const poAwarii = await domena(tenantA, domenaA);
    expect(poAwarii!.status).toBe("verified");
    expect(poAwarii!.spf).toBe("ok");
    expect(poAwarii!.bladSprawdzenia).toContain("SERVFAIL");
  });

  it("obcy tenant nie widzi, nie sprawdza i nie usuwa cudzej domeny", async () => {
    expect(await domena(tenantB, domenaA)).toBeNull();
    const spr = await sprawdzDomene(tenantB, domenaA, { resolver: resolver({}) });
    expect(spr.ok).toBe(false);
    await usunDomene(tenantB, domenaA);
    expect(await domena(tenantA, domenaA)).not.toBeNull();
  });

  it("serwer: host prywatny odrzucony PRZED zapisem, nic nie ląduje w bazie", async () => {
    const wynik = await zapiszSerwer(tenantA, daneSerwera({ host: "10.0.0.8" }));
    expect(wynik.ok).toBe(false);
    const { rows } = await getPool().query("select 1 from tenant_smtp_configs where tenant_id = $1", [tenantA]);
    expect(rows).toHaveLength(0);

    const nazwa = await zapiszSerwer(tenantA, daneSerwera(), { lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
    expect(nazwa.ok).toBe(false);
  });

  it("serwer: adres nadawcy musi być w domenie TEGO konta", async () => {
    const wynik = await zapiszSerwer(tenantB, daneSerwera(), { lookup: lookupPubliczny });
    expect(wynik.ok).toBe(false);
    if (!wynik.ok) expect(wynik.blad).toContain("wkf-a.test");
  });

  it("serwer: z logowaniem połączenie musi być szyfrowane", async () => {
    const wynik = await zapiszSerwer(tenantA, daneSerwera({ bezpieczenstwo: "none", port: "25" }), { lookup: lookupPubliczny });
    expect(wynik.ok).toBe(false);
  });

  it("hasło: w bazie zaszyfrowane, w widoku formularza nieobecne", async () => {
    const wynik = await zapiszSerwer(tenantA, daneSerwera(), { lookup: lookupPubliczny });
    expect(wynik).toEqual({ ok: true });
    const { rows } = await getPool().query("select password_encrypted, connection_verified_at from tenant_smtp_configs where tenant_id = $1", [tenantA]);
    expect(rows[0].password_encrypted.toString("latin1")).not.toContain("Tajne-Haslo-123!");
    expect(rows[0].connection_verified_at).toBeNull();

    const widok = await odczytajSerwer(tenantA);
    expect(widok).toMatchObject({ host: "smtp.dostawca.test", hasloUstawione: true, adresNadawcy: "sklep@wkf-a.test" });
    expect(JSON.stringify(widok)).not.toContain("Tajne-Haslo-123!");
    expect(Object.keys(widok!).some((k) => /password|haslo$/i.test(k))).toBe(false);
  });

  it("hasło: zmiana hosta bez ponownego wpisania hasła jest odrzucona (hasło nie pójdzie na cudzy serwer)", async () => {
    const wynik = await zapiszSerwer(tenantA, daneSerwera({ host: "smtp.obcy.test", noweHaslo: "" }), { lookup: lookupPubliczny });
    expect(wynik.ok).toBe(false);
    if (!wynik.ok) expect(wynik.blad).toContain("hasło");
    expect((await odczytajSerwer(tenantA))!.host).toBe("smtp.dostawca.test");

    // sama zmiana nazwy nadawcy zostawia hasło i nie wymaga ponownego testu połączenia
    await getPool().query("update tenant_smtp_configs set connection_verified_at = now() where tenant_id = $1", [tenantA]);
    const nazwa = await zapiszSerwer(tenantA, daneSerwera({ noweHaslo: "", nazwaNadawcy: "Sklep WKF 2" }), { lookup: lookupPubliczny });
    expect(nazwa.ok).toBe(true);
    const widok = await odczytajSerwer(tenantA);
    expect(widok).toMatchObject({ nazwaNadawcy: "Sklep WKF 2", hasloUstawione: true });
    expect(widok!.polaczenieSprawdzoneAt).not.toBeNull();
  });

  it("baza odrzuca konfigurację wskazującą domenę innego tenanta (złożony FK)", async () => {
    await expect(
      getPool().query(
        `insert into tenant_smtp_configs (tenant_id, sending_domain_id, host, port, security, from_name, from_email)
         values ($1, $2, 'smtp.x.test', 587, 'starttls', 'X', 'sklep@wkf-a.test')`,
        [tenantB, domenaA],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("FR45: domena niezweryfikowana blokuje wysyłkę, a wiadomość zostaje w kolejce", async () => {
    const pool = getPool();
    await pool.query("update sending_domains set status = 'partial', last_checked_at = now() where tenant_id = $1 and id = $2", [tenantA, domenaA]);
    const id = await wiadomoscTestowa(tenantA);
    const dostawca = new DostawcaAtrapa();

    const wynik = await wyslijPartie(tenantA, { dostawca });
    expect(wynik.powodZatrzymania).toBe("blokada_nadawcy");
    expect(wynik.powodOpis).toContain("wkf-a.test");
    expect(wynik.powodOpis).toContain("FR45");
    expect(dostawca.wyslane).toHaveLength(0);
    // nic nie zostało zajęte: brak claimed/sending, które musiałaby potem sprzątać rekoncyliacja
    expect(await stanWiadomosci(tenantA, id)).toBe("queued");
  });

  it("serwer bez udanego testu połączenia też blokuje wysyłkę", async () => {
    const pool = getPool();
    await pool.query("update sending_domains set status = 'verified', last_checked_at = now() where tenant_id = $1 and id = $2", [tenantA, domenaA]);
    await pool.query("update tenant_smtp_configs set connection_verified_at = null where tenant_id = $1", [tenantA]);
    const wynik = await wyslijPartie(tenantA, { dostawca: new DostawcaAtrapa() });
    expect(wynik.powodZatrzymania).toBe("blokada_nadawcy");
    expect(wynik.powodOpis).toContain("testu połączenia");
  });

  it("przeterminowany wynik + awaria DNS przy ponownym sprawdzeniu = blokada (nie da się potwierdzić)", async () => {
    const pool = getPool();
    await pool.query("update tenant_smtp_configs set connection_verified_at = now() where tenant_id = $1", [tenantA]);
    await pool.query("update sending_domains set status = 'verified', last_checked_at = now() - interval '2 days' where tenant_id = $1 and id = $2", [tenantA, domenaA]);
    const awaria = strefaPoprawna("wkf-a.test");
    awaria.awaria = { "_dmarc.wkf-a.test": "ETIMEOUT" };
    const dostawca = new DostawcaAtrapa();
    const wynik = await wyslijPartie(tenantA, { dostawca, dns: { resolver: resolver(awaria), lookup: lookupPubliczny } });
    expect(wynik.powodZatrzymania).toBe("blokada_nadawcy");
    expect(wynik.powodOpis).toContain("potwierdzić");
    expect(dostawca.wyslane).toHaveLength(0);
    // status w panelu zostaje: chwilowa awaria nie „psuje" domeny
    expect((await domena(tenantA, domenaA))!.status).toBe("verified");
  });

  it("po zmianie serwera SPF liczy się po jego IP: sam include w rekordzie nie przepuszcza FR45", async () => {
    const pool = getPool();
    // serwer 8.8.4.4 nie jest w _spf.dostawca.test (198.51.100.0/24), mimo że include jest w rekordzie
    const dostawca = new DostawcaAtrapa();
    const wynik = await wyslijPartie(tenantA, { dostawca, dns: { resolver: resolver(strefaPoprawna("wkf-a.test")), lookup: lookupPubliczny } });
    expect(wynik.powodZatrzymania).toBe("blokada_nadawcy");
    expect(wynik.powodOpis).toContain("SPF: błędny");
    expect(dostawca.wyslane).toHaveLength(0);
    // przywrócenie stanu dla kolejnych testów: domena zweryfikowana świeżo
    await pool.query("update sending_domains set status = 'verified', last_checked_at = now() where tenant_id = $1 and id = $2", [tenantA, domenaA]);
  });

  it("zweryfikowana domena i sprawdzony serwer: wychodzi z adresem, nazwą i reply-to klienta", async () => {
    const pool = getPool();
    await pool.query("update tenant_smtp_configs set connection_verified_at = now() where tenant_id = $1", [tenantA]);
    const dostawca = new DostawcaAtrapa();
    const wynik = await wyslijPartie(tenantA, { dostawca });
    expect(wynik.powodZatrzymania).toBeNull();
    expect(wynik.wyslane).toBe(1);
    expect(dostawca.wyslane[0]).toMatchObject({ od: "sklep@wkf-a.test", odNazwa: "Sklep WKF 2", odpowiedzDo: "kontakt@wkf-a.test" });
  });

  it("tenant bez własnego serwera: dotychczasowa droga, nazwa konta zamiast zaszytej na sztywno", async () => {
    await wiadomoscTestowa(tenantB);
    const dostawca = new DostawcaAtrapa();
    const wynik = await wyslijPartie(tenantB, { dostawca });
    expect(wynik.wyslane).toBe(1);
    expect(dostawca.wyslane[0].odNazwa).toBe("WKF tenant B");
    expect(dostawca.wyslane[0].odNazwa).not.toBe("Sklep Testowy MidRev");
    expect(dostawca.wyslane[0].odpowiedzDo).toBeUndefined();
  });

  it("domeny używanej przez serwer nie da się usunąć", async () => {
    const wynik = await usunDomene(tenantA, domenaA);
    expect(wynik.ok).toBe(false);
    expect(await domena(tenantA, domenaA)).not.toBeNull();
  });
});
