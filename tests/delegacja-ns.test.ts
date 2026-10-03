import { describe, expect, it } from "vitest";
import { KlientRoute53 } from "../src/adapters/aws/route53";
import { Sekret } from "../src/adapters/crypto";
import { adresNiepubliczny, rozbierzOdpowiedz, zbudujZapytanie } from "../src/adapters/email/dns-autorytatywny";
import { jakWpisacSerwery } from "../src/app/_dns/jeden-wpis";
import { rekordyPlatformowe } from "../src/domain/email/domena-platformowa";
import { DOSTAWCY_DNS, dostawcaPoKluczu } from "../src/domain/email/dostawcy-dns";
import {
  callerReferenceStrefy,
  normalizujIdStrefy,
  ocenDelegacje,
  rekordyStrefyDelegowanej,
  roznicaStrefy,
  wartoscTxt,
  type RekordRoute53,
} from "../src/domain/email/route53";
import { BladAws } from "../src/domain/email/ses";

/**
 * „Jeden wpis NS": czysta logika (rekordy strefy, różnica stanu, ocena delegacji), klient
 * Route 53 na podstawionym fetch (bez sieci, bez AWS) i parser pakietów DNS.
 */

const NASZE = ["ns-1.awsdns-01.com", "ns-600.awsdns-02.net", "ns-1100.awsdns-03.org", "ns-1600.awsdns-04.co.uk"];

function rekordy(dmarc: string | null = "v=DMARC1; p=none") {
  return rekordyPlatformowe({
    domenaWysylkowa: "news.sklep.pl",
    strefa: "sklep.pl",
    tokeny: ["aaa", "bbb", "ccc"],
    strefaPodpisu: "dkim.amazonses.com",
    mailFrom: "bounce.news.sklep.pl",
    region: "eu-north-1",
    dmarcPropozycja: dmarc,
    kropkaNaKoncu: true,
  });
}

describe("Route 53: rekordy strefy i różnica stanu", () => {
  it("CallerReference: deterministyczny, inny dla innego tenanta, bez znaków spoza [A-Za-z0-9-]", () => {
    const a = callerReferenceStrefy("t-1", "News.Sklep.pl.");
    expect(a).toBe(callerReferenceStrefy("t-1", "news.sklep.pl"));
    expect(a).not.toBe(callerReferenceStrefy("t-2", "news.sklep.pl"));
    expect(a).toMatch(/^[A-Za-z0-9-]{1,128}$/);
  });

  it("identyfikator strefy: tylko Z[A-Z0-9]; próba wstrzyknięcia ścieżki = null", () => {
    expect(normalizujIdStrefy("/hostedzone/Z0123ABC")).toBe("Z0123ABC");
    expect(normalizujIdStrefy("Z0123ABC/rrset")).toBeNull();
    expect(normalizujIdStrefy("../tags/Z1")).toBeNull();
    expect(normalizujIdStrefy("z0123")).toBeNull();
  });

  it("TXT: w cudzysłowach, cudzysłów escapowany, długi dzielony na kawałki po 255", () => {
    expect(wartoscTxt("v=spf1 include:amazonses.com ~all")).toBe('"v=spf1 include:amazonses.com ~all"');
    expect(wartoscTxt('a"b')).toBe('"a\\"b"');
    const dlugi = wartoscTxt("x".repeat(300));
    expect(dlugi).toBe(`"${"x".repeat(255)}" "${"x".repeat(45)}"`);
  });

  it("rekordy strefy: pełne nazwy, CNAME i MX z kropką, MX z priorytetem, TXT w cudzysłowach", () => {
    const r = rekordyStrefyDelegowanej(rekordy());
    expect(r).toEqual([
      { nazwa: "aaa._domainkey.news.sklep.pl", typ: "CNAME", ttl: 300, wartosci: ["aaa.dkim.amazonses.com."] },
      { nazwa: "bbb._domainkey.news.sklep.pl", typ: "CNAME", ttl: 300, wartosci: ["bbb.dkim.amazonses.com."] },
      { nazwa: "ccc._domainkey.news.sklep.pl", typ: "CNAME", ttl: 300, wartosci: ["ccc.dkim.amazonses.com."] },
      { nazwa: "bounce.news.sklep.pl", typ: "MX", ttl: 300, wartosci: ["10 feedback-smtp.eu-north-1.amazonses.com."] },
      { nazwa: "bounce.news.sklep.pl", typ: "TXT", ttl: 300, wartosci: ['"v=spf1 include:amazonses.com ~all"'] },
      { nazwa: "_dmarc.news.sklep.pl", typ: "TXT", ttl: 300, wartosci: ['"v=DMARC1; p=none"'] },
    ]);
  });

  it("różnica: pusta strefa = UPSERT wszystkiego; zgodna = nic; NS i SOA strefy nietykalne", () => {
    const chciane = rekordyStrefyDelegowanej(rekordy());
    const bazowe: RekordRoute53[] = [
      { nazwa: "news.sklep.pl", typ: "NS", ttl: 172800, wartosci: NASZE.map((n) => `${n}.`) },
      { nazwa: "news.sklep.pl", typ: "SOA", ttl: 900, wartosci: ["ns-1.awsdns-01.com. x 1 2 3 4 5"] },
    ];
    const z = roznicaStrefy("news.sklep.pl", bazowe, chciane);
    expect(z.map((x) => x.akcja)).toEqual(Array(6).fill("UPSERT"));
    expect(roznicaStrefy("news.sklep.pl", [...bazowe, ...chciane], chciane)).toEqual([]);
  });

  it("różnica: stary podpis i zbędny DMARC → DELETE dokładnie tego, co jest; inna wartość → UPSERT", () => {
    const chciane = rekordyStrefyDelegowanej(rekordy(null));
    const stare: RekordRoute53[] = [
      ...chciane.filter((r) => !r.nazwa.startsWith("aaa")),
      { nazwa: "aaa._domainkey.news.sklep.pl", typ: "CNAME", ttl: 300, wartosci: ["aaa.dkim.amazonses.com.news.sklep.pl."] },
      { nazwa: "old._domainkey.news.sklep.pl", typ: "CNAME", ttl: 300, wartosci: ["old.dkim.amazonses.com."] },
      { nazwa: "_dmarc.news.sklep.pl", typ: "TXT", ttl: 300, wartosci: ['"v=DMARC1; p=none"'] },
    ];
    const z = roznicaStrefy("news.sklep.pl", stare, chciane);
    expect(z).toContainEqual({ akcja: "UPSERT", rekord: chciane[0] });
    expect(z.filter((x) => x.akcja === "DELETE").map((x) => x.rekord.nazwa).sort()).toEqual(["_dmarc.news.sklep.pl", "old._domainkey.news.sklep.pl"]);
  });

  it("różnica: rekordów spoza naszego zestawu (np. dodanych ręcznie przez operatora) NIE kasuje (review r1)", () => {
    const chciane = rekordyStrefyDelegowanej(rekordy());
    const obce: RekordRoute53[] = [
      { nazwa: "www.news.sklep.pl", typ: "CNAME", ttl: 300, wartosci: ["sklep.pl."] },
      { nazwa: "news.sklep.pl", typ: "TXT", ttl: 300, wartosci: ['"google-site-verification=x"'] },
      { nazwa: "news.sklep.pl", typ: "MX", ttl: 300, wartosci: ["10 mx.sklep.pl."] },
      { nazwa: "a.b._domainkey.news.sklep.pl", typ: "CNAME", ttl: 300, wartosci: ["x."] },
    ];
    expect(roznicaStrefy("news.sklep.pl", [...chciane, ...obce], chciane)).toEqual([]);
  });

  it("różnica: rekord spoza strefy albo NS strefy w chcianych = błąd programisty (rzuca)", () => {
    expect(() => roznicaStrefy("news.sklep.pl", [], [{ nazwa: "sklep.pl", typ: "MX", ttl: 300, wartosci: ["10 x."] }])).toThrow(/poza strefą/);
    expect(() => roznicaStrefy("news.sklep.pl", [], [{ nazwa: "evilnews.sklep.pl", typ: "TXT", ttl: 300, wartosci: ['"x"'] }])).toThrow(/poza strefą/);
    expect(() => roznicaStrefy("news.sklep.pl", [], [{ nazwa: "news.sklep.pl", typ: "NS", ttl: 300, wartosci: ["x."] }])).toThrow(/nietykalne/);
  });
});

describe("Ocena delegacji (co klient wpisał u siebie)", () => {
  const baza = { domena: "news.sklep.pl", strefa: "sklep.pl", nasze: NASZE, nazwaWzgledna: "news", podwojona: [], apex: ["ns1.hostido.net.pl"], konflikty: [], publicznie: [] as string[] | null };

  it("brak wpisu = „brak”, bez komunikatu", () => {
    expect(ocenDelegacje({ ...baza, rodzic: [] })).toMatchObject({ stan: "brak", komunikat: null, pilne: null });
  });

  it("komplet u dostawcy, internet jeszcze nie widzi = „czeka” z uspokojeniem; widzi = „dziala”", () => {
    expect(ocenDelegacje({ ...baza, rodzic: NASZE.map((n) => `${n}.`) })).toMatchObject({ stan: "czeka", komunikat: expect.stringContaining("Nic więcej nie trzeba robić") });
    expect(ocenDelegacje({ ...baza, rodzic: NASZE, publicznie: NASZE })).toMatchObject({ stan: "dziala", komunikat: null });
  });

  it("tylko część serwerów = „czesciowa” z listą brakujących", () => {
    const o = ocenDelegacje({ ...baza, rodzic: NASZE.slice(0, 2) });
    expect(o.stan).toBe("czesciowa");
    expect(o.brakujace).toEqual(NASZE.slice(2));
    expect(o.komunikat).toContain("2 z 4");
  });

  it("panel dokleił domenę do serwera (Hostido bez kropki) = „bledna” z instrukcją o kropce", () => {
    const o = ocenDelegacje({ ...baza, rodzic: [...NASZE.slice(1), `${NASZE[0]}.sklep.pl`] });
    expect(o.stan).toBe("bledna");
    expect(o.komunikat).toContain("kropką na końcu");
    expect(o.komunikat).toContain("nie dodawaj drugiego");
  });

  it("NS pod złą nazwą (news.sklep.pl.sklep.pl) = „bledna”, każe zostawić samo news", () => {
    const o = ocenDelegacje({ ...baza, rodzic: [], podwojona: NASZE });
    expect(o.stan).toBe("bledna");
    expect(o.komunikat).toContain("zostaw tylko: news");
  });

  it("obce serwery pod news = „bledna”", () => {
    expect(ocenDelegacje({ ...baza, rodzic: ["ns1.inny.pl", "ns2.inny.pl"] })).toMatchObject({ stan: "bledna", komunikat: expect.stringContaining("inne serwery") });
  });

  it("nasze serwery dopisane do domeny głównej = PILNE (strona i poczta), niezależnie od reszty", () => {
    const o = ocenDelegacje({ ...baza, rodzic: [], apex: ["ns1.hostido.net.pl", NASZE[0]] });
    expect(o.pilne).toContain("wyłączyć stronę i zwykłą pocztę");
  });

  it("stary CNAME/MX pod news obok NS = „konflikt” (usuń go, rekordy pod innymi nazwami zostaw)", () => {
    const o = ocenDelegacje({ ...baza, rodzic: NASZE, konflikty: ["CNAME"] });
    expect(o.stan).toBe("konflikt");
    expect(o.komunikat).toContain("CNAME");
    expect(o.komunikat).toContain("Rekordy pod innymi nazwami zostaw");
    expect(o.komunikat).toContain("tylko wtedy, gdy nic z niego nie korzysta");
  });

  it("„dziala” tylko przy komplecie naszych serwerów widzianym przez internet (review r1)", () => {
    expect(ocenDelegacje({ ...baza, rodzic: NASZE, publicznie: NASZE.slice(0, 2) }).stan).toBe("czeka");
    expect(ocenDelegacje({ ...baza, rodzic: null, publicznie: NASZE.slice(0, 2) }).stan).toBe("czeka");
    expect(ocenDelegacje({ ...baza, rodzic: NASZE, publicznie: [...NASZE, "ns1.obcy.pl"] }).stan).toBe("czeka");
  });

  it("serwery dostawcy nie odpowiadają: decyduje to, co widzi internet; bez tego „czeka”", () => {
    expect(ocenDelegacje({ ...baza, rodzic: null, publicznie: NASZE }).stan).toBe("dziala");
    expect(ocenDelegacje({ ...baza, rodzic: null, publicznie: null }).stan).toBe("czeka");
  });

  it("komunikaty bez żargonu (delegacja, strefa, Route 53, AWS)", () => {
    const przypadki = [
      ocenDelegacje({ ...baza, rodzic: NASZE.slice(0, 1) }),
      ocenDelegacje({ ...baza, rodzic: ["x.y"] }),
      ocenDelegacje({ ...baza, rodzic: [], podwojona: NASZE }),
      ocenDelegacje({ ...baza, rodzic: NASZE, konflikty: ["MX"] }),
      ocenDelegacje({ ...baza, rodzic: NASZE }),
      ocenDelegacje({ ...baza, rodzic: [], apex: NASZE }),
    ];
    // nazwy serwerów (ns-1.awsdns-01.com) to dane do skopiowania, nie żargon
    for (const o of przypadki) expect(`${o.komunikat ?? ""} ${o.pilne ?? ""}`.replace(/ns-\d+\.awsdns-[a-z0-9.-]+/g, "<serwer>")).not.toMatch(/delegac|Route ?53|AWS|hosted|propagac/i);
  });
});

describe("Dostawcy: wpis NS", () => {
  it("każdy znany dostawca ma opis NS; Google przyjmuje 4 serwery w jednym wpisie, reszta po jednym", () => {
    for (const d of DOSTAWCY_DNS) expect(typeof d.nsDlaSubdomeny).toBe("boolean");
    expect(jakWpisacSerwery(dostawcaPoKluczu("google"), 4)).toContain("w jednym wpisie");
    expect(jakWpisacSerwery(dostawcaPoKluczu("hostido"), 4)).toContain("Dodaj ten rekord 4 razy");
    expect(jakWpisacSerwery(dostawcaPoKluczu(null), 4)).toContain("Większość paneli");
    expect(dostawcaPoKluczu("hostido").kropkaNaKoncu).toBe(true);
    expect(dostawcaPoKluczu("cloudflare").kropkaNaKoncu).toBe(false);
  });
});

// ── Klient Route 53 na podstawionym fetch ──────────────────────────────────────

type Wywolanie = { url: string; metoda: string; naglowki: Record<string, string>; cialo: string };

function fetchAtrapa(odpowiedzi: { status: number; xml: string }[]) {
  const wywolania: Wywolanie[] = [];
  const f = (async (url: string, init: RequestInit) => {
    wywolania.push({ url: String(url), metoda: String(init.method), naglowki: init.headers as Record<string, string>, cialo: String(init.body ?? "") });
    const o = odpowiedzi.shift() ?? { status: 500, xml: "" };
    return new Response(o.xml, { status: o.status });
  }) as unknown as typeof fetch;
  return { f, wywolania };
}

const SEKRET = "TAJNY-sekret-klucza-0123456789";
const klucze = { accessKeyId: "AKIATESTOWYKLUCZ01", secretAccessKey: new Sekret(SEKRET) };

describe("Klient Route 53 (REST/XML, SigV4, bez SDK)", () => {
  it("CreateHostedZone: POST z CallerReference, podpis route53/us-east-1, odczyt Id i serwerów NS", async () => {
    const { f, wywolania } = fetchAtrapa([
      {
        status: 201,
        xml: `<?xml version="1.0"?><CreateHostedZoneResponse><HostedZone><Id>/hostedzone/Z07ABC123</Id><Name>news.sklep.pl.</Name><CallerReference>midrev-abc</CallerReference></HostedZone><ChangeInfo><Id>/change/C1</Id><Status>PENDING</Status></ChangeInfo><DelegationSet><NameServers><NameServer>ns-1.awsdns-01.com</NameServer><NameServer>ns-600.awsdns-02.net</NameServer></NameServers></DelegationSet></CreateHostedZoneResponse>`,
      },
    ]);
    const k = new KlientRoute53({ klucze, fetch: f });
    const s = await k.utworzStrefe("News.Sklep.pl", { callerReference: "midrev-abc", komentarz: "midrev tenant <x>" });
    expect(s).toEqual({ id: "Z07ABC123", nazwa: "news.sklep.pl", callerReference: "midrev-abc", serweryNs: ["ns-1.awsdns-01.com", "ns-600.awsdns-02.net"] });
    expect(wywolania[0].url).toBe("https://route53.amazonaws.com/2013-04-01/hostedzone");
    expect(wywolania[0].naglowki.authorization).toMatch(/Credential=AKIATESTOWYKLUCZ01\/\d{8}\/us-east-1\/route53\/aws4_request/);
    expect(wywolania[0].cialo).toContain("<Name>news.sklep.pl.</Name>");
    expect(wywolania[0].cialo).toContain("<Comment>midrev tenant &lt;x&gt;</Comment>");
    expect(JSON.stringify(wywolania)).not.toContain(SEKRET);
  });

  it("błędy: HostedZoneAlreadyExists → juzIstnieje, 403 → brakUprawnien; komunikat bez sekretu i bez ciała", async () => {
    const { f } = fetchAtrapa([
      { status: 409, xml: "<ErrorResponse><Error><Code>HostedZoneAlreadyExists</Code><Message>A hosted zone has already been created with the specified caller reference.</Message></Error></ErrorResponse>" },
      { status: 403, xml: "<ErrorResponse><Error><Code>AccessDenied</Code><Message>User is not authorized to perform: route53:CreateHostedZone</Message></Error></ErrorResponse>" },
    ]);
    const k = new KlientRoute53({ klucze, fetch: f });
    const b1 = await k.utworzStrefe("news.sklep.pl", { callerReference: "x", komentarz: "" }).catch((e) => e);
    expect(b1).toBeInstanceOf(BladAws);
    expect(b1.juzIstnieje).toBe(true);
    const b2 = await k.utworzStrefe("news.sklep.pl", { callerReference: "x", komentarz: "" }).catch((e) => e);
    expect(b2.brakUprawnien).toBe(true);
    expect(String(b2.message)).not.toContain(SEKRET);
  });

  it("zły identyfikator strefy nie idzie do sieci", async () => {
    const { f, wywolania } = fetchAtrapa([]);
    const k = new KlientRoute53({ klucze, fetch: f });
    await expect(k.rekordy("Z1/../../hostedzone")).rejects.toBeInstanceOf(BladAws);
    expect(wywolania).toHaveLength(0);
  });

  it("ListResourceRecordSets: stronicowanie, \\052 w nazwie, wartości odkodowane z XML", async () => {
    const { f, wywolania } = fetchAtrapa([
      {
        status: 200,
        xml: `<ListResourceRecordSetsResponse><ResourceRecordSets><ResourceRecordSet><Name>news.sklep.pl.</Name><Type>NS</Type><TTL>172800</TTL><ResourceRecords><ResourceRecord><Value>ns-1.awsdns-01.com.</Value></ResourceRecord></ResourceRecords></ResourceRecordSet></ResourceRecordSets><IsTruncated>true</IsTruncated><NextRecordName>\\052.news.sklep.pl.</NextRecordName><NextRecordType>TXT</NextRecordType><MaxItems>1</MaxItems></ListResourceRecordSetsResponse>`,
      },
      {
        status: 200,
        xml: `<ListResourceRecordSetsResponse><ResourceRecordSets><ResourceRecordSet><Name>\\052.news.sklep.pl.</Name><Type>TXT</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>"a&amp;b"</Value></ResourceRecord></ResourceRecords></ResourceRecordSet></ResourceRecordSets><IsTruncated>false</IsTruncated></ListResourceRecordSetsResponse>`,
      },
    ]);
    const r = await new KlientRoute53({ klucze, fetch: f }).rekordy("Z07ABC123");
    expect(r).toEqual([
      { nazwa: "news.sklep.pl", typ: "NS", ttl: 172800, wartosci: ["ns-1.awsdns-01.com."] },
      { nazwa: "*.news.sklep.pl", typ: "TXT", ttl: 300, wartosci: ['"a&b"'] },
    ]);
    expect(wywolania[1].url).toContain("type=TXT");
  });

  it("ChangeResourceRecordSets: partia UPSERT z escapowanym XML, zwraca identyfikator zmiany; GetChange", async () => {
    const { f, wywolania } = fetchAtrapa([
      { status: 200, xml: "<ChangeResourceRecordSetsResponse><ChangeInfo><Id>/change/C0123ABC</Id><Status>PENDING</Status></ChangeInfo></ChangeResourceRecordSetsResponse>" },
      { status: 200, xml: "<GetChangeResponse><ChangeInfo><Id>/change/C0123ABC</Id><Status>INSYNC</Status></ChangeInfo></GetChangeResponse>" },
    ]);
    const k = new KlientRoute53({ klucze, fetch: f });
    const w = await k.zmienRekordy("Z07ABC123", [{ akcja: "UPSERT", rekord: { nazwa: "_dmarc.news.sklep.pl", typ: "TXT", ttl: 300, wartosci: ['"v=DMARC1; p=none"'] } }], "midrev");
    expect(w).toEqual({ changeId: "C0123ABC", stan: "PENDING" });
    expect(wywolania[0].url).toBe("https://route53.amazonaws.com/2013-04-01/hostedzone/Z07ABC123/rrset");
    expect(wywolania[0].cialo).toContain("<Value>&quot;v=DMARC1; p=none&quot;</Value>");
    expect(await k.stanZmiany("C0123ABC")).toBe("INSYNC");
  });
});

// ── Pakiety DNS (zapytanie do serwerów dostawcy) ────────────────────────────────

function nazwa(n: string): Buffer {
  return Buffer.concat([...n.split(".").map((e) => Buffer.concat([Buffer.from([e.length]), Buffer.from(e)])), Buffer.from([0])]);
}

describe("Zapytanie wprost do serwera dostawcy (RFC 1035)", () => {
  it("zapytanie bez rekursji (RD=0), typ NS", () => {
    const q = zbudujZapytanie(0x1234, "news.sklep.pl", "NS");
    expect(q.readUInt16BE(0)).toBe(0x1234);
    expect(q.readUInt16BE(2) & 0x0100).toBe(0);
    expect(q.subarray(12, 12 + nazwa("news.sklep.pl").length)).toEqual(nazwa("news.sklep.pl"));
    expect(q.readUInt16BE(q.length - 4)).toBe(2);
  });

  it("odesłanie (referral): NS w sekcji authority, z kompresją nazw, bez bitu AA", () => {
    const pytanie = Buffer.concat([nazwa("news.sklep.pl"), Buffer.from([0, 2, 0, 1])]);
    const rr = (cel: string) => {
      const dane = nazwa(cel);
      const b = Buffer.alloc(12);
      b.writeUInt16BE(0xc00c, 0); // wskaźnik na nazwę z pytania
      b.writeUInt16BE(2, 2);
      b.writeUInt16BE(1, 4);
      b.writeUInt32BE(3600, 6);
      b.writeUInt16BE(dane.length, 10);
      return Buffer.concat([b, dane]);
    };
    const naglowek = Buffer.alloc(12);
    naglowek.writeUInt16BE(7, 0);
    naglowek.writeUInt16BE(0x8000, 2); // odpowiedź, AA=0
    naglowek.writeUInt16BE(1, 4);
    naglowek.writeUInt16BE(0, 6);
    naglowek.writeUInt16BE(2, 8);
    const pakiet = Buffer.concat([naglowek, pytanie, rr("ns-1.awsdns-01.com"), rr("ns-600.awsdns-02.net")]);
    const o = rozbierzOdpowiedz(pakiet, 7);
    expect(o.autorytatywna).toBe(false);
    expect(o.odpowiedzi).toEqual([]);
    expect(o.autorytet).toEqual([
      { nazwa: "news.sklep.pl", typ: "NS", dane: "ns-1.awsdns-01.com" },
      { nazwa: "news.sklep.pl", typ: "NS", dane: "ns-600.awsdns-02.net" },
    ]);
    expect(() => rozbierzOdpowiedz(pakiet, 8)).toThrow(/obcy identyfikator/);
    expect(() => rozbierzOdpowiedz(pakiet.subarray(0, pakiet.length - 3), 7)).toThrow(/ucięty/);
  });

  it("odpowiedź ucięta (bit TC) = brak odpowiedzi, nie niepełna lista serwerów (review r1)", () => {
    const naglowek = Buffer.alloc(12);
    naglowek.writeUInt16BE(0x8200, 2);
    expect(() => rozbierzOdpowiedz(naglowek)).toThrow(/TC/);
  });

  it("pętla kompresji nie zawiesza parsera", () => {
    const naglowek = Buffer.alloc(12);
    naglowek.writeUInt16BE(0x8000, 2);
    naglowek.writeUInt16BE(1, 4);
    const pakiet = Buffer.concat([naglowek, Buffer.from([0xc0, 12, 0, 2, 0, 1])]);
    expect(() => rozbierzOdpowiedz(pakiet)).toThrow();
  });

  it("adresy prywatne i pętli są odrzucane (SSRF przez rekord NS klienta)", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1"]) expect(adresNiepubliczny(ip)).toBe(true);
    expect(adresNiepubliczny("185.243.54.10")).toBe(false);
  });
});
