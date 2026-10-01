import { describe, expect, it } from "vitest";
import { podpiszZadanie } from "../src/adapters/aws/sigv4";
import { kodBleduAws, tozsamoscZOdpowiedzi } from "../src/adapters/aws/ses";
import { Sekret } from "../src/adapters/crypto";
import { zbudujKonfiguracje } from "../src/config";
import {
  decyzjaDmarc,
  nazwaWzgledna,
  porownajCel,
  rekordyPlatformowe,
  rozbierzWpis,
  zaproponujUklad,
} from "../src/domain/email/domena-platformowa";
import { rozpoznajDostawce } from "../src/domain/email/dostawcy-dns";
import { nazwaConfigurationSetu } from "../src/domain/email/ses";
import { nastepneSprawdzenie } from "../src/usecases/wysylka-konfiguracja/domena-platformowa";

/**
 * Czysta logika kreatora „Podłącz domenę" (0040): wpis klienta → układ → rekordy.
 * Bez bazy i bez sieci. Część integracyjna: domena-platformowa-db.test.ts.
 */

describe("SigV4 (podpis zapytań AWS)", () => {
  it("daje podpis z wektora testowego z dokumentacji AWS (IAM ListUsers, 20150830)", () => {
    const h = podpiszZadanie({
      metoda: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      naglowki: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      region: "us-east-1",
      usluga: "iam",
      klucze: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: new Sekret("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY") },
      teraz: new Date("2015-08-30T12:36:00Z"),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
    // sekret nie wycieka do nagłówków
    expect(JSON.stringify(h)).not.toContain("wJalrXUtnFEMI");
  });

  it("kod wyjątku AWS bez sufiksu Exception, z nagłówka albo z ciała", () => {
    expect(kodBleduAws("AlreadyExistsException:http://internal.amazon.com/", null)).toBe("AlreadyExists");
    expect(kodBleduAws(null, { __type: "com.amazon#AccessDeniedException" })).toBe("AccessDenied");
  });

  it("odpowiedź GetEmailIdentity w kształcie z prawdziwego konta (odczyt 01.10) mapuje się na port", () => {
    const t = tozsamoscZOdpowiedzi("news.midrev.pl", {
      VerificationStatus: "SUCCESS",
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "SUCCESS", Tokens: ["a", "b", "c"], SigningHostedZone: "dkim.amazonses.com", CurrentSigningKeyLength: "RSA_2048_BIT" },
      MailFromAttributes: { MailFromDomain: "bounce.news.midrev.pl", MailFromDomainStatus: "SUCCESS", BehaviorOnMxFailure: "USE_DEFAULT_VALUE" },
      ConfigurationSetName: null,
      Tags: [{ Key: "midrev_tenant", Value: "x" }],
    });
    expect(t).toMatchObject({ gotowaDoWysylki: true, dkimStatus: "SUCCESS", mailFromStatus: "SUCCESS", strefaPodpisu: "dkim.amazonses.com", tagi: { midrev_tenant: "x" } });
    expect(t.dkimTokeny).toHaveLength(3);
  });
});

describe("Wpis klienta i układ domeny", () => {
  it("przyjmuje domenę, adres e-mail i adres strony; odrzuca śmieci", () => {
    expect(rozbierzWpis("sklep.pl")).toEqual({ lokalna: null, domena: "sklep.pl" });
    expect(rozbierzWpis(" Newsletter@Sklep.PL ")).toEqual({ lokalna: "newsletter", domena: "sklep.pl" });
    expect(rozbierzWpis("https://www.sklep.pl/oferta?x=1")).toEqual({ lokalna: null, domena: "sklep.pl" });
    expect(rozbierzWpis("żółw.pl")?.domena).toBe("xn--w-uga1v8h.pl");
    for (const zly of ["", "sklep", "a@b@c.pl", "sklep .pl", "<a>@b.pl", "1.2.3.4", "-x.pl"]) expect(rozbierzWpis(zly)).toBeNull();
  });

  it("domyślnie subdomena news.<domena> i adres newsletter@ — część przed @ z wpisu zostaje", () => {
    expect(zaproponujUklad({ wpis: rozbierzWpis("sklep.pl")!, strefa: "sklep.pl" })).toEqual({
      strefa: "sklep.pl",
      domenaWysylkowa: "news.sklep.pl",
      adresNadawcy: "newsletter@news.sklep.pl",
      mailFrom: "bounce.news.sklep.pl",
      domenaGlowna: false,
    });
    expect(zaproponujUklad({ wpis: rozbierzWpis("kontakt@sklep.pl")!, strefa: "sklep.pl" })?.adresNadawcy).toBe("kontakt@news.sklep.pl");
  });

  it("wpisana subdomena zostaje bez dokładania prefiksu; strefa com.pl liczy się jako strefa", () => {
    expect(zaproponujUklad({ wpis: rozbierzWpis("mail.sklep.pl")!, strefa: "sklep.pl" })?.domenaWysylkowa).toBe("mail.sklep.pl");
    expect(zaproponujUklad({ wpis: rozbierzWpis("firma.com.pl")!, strefa: "firma.com.pl" })?.domenaWysylkowa).toBe("news.firma.com.pl");
  });

  it("pusty prefiks = świadoma wysyłka z domeny głównej; zły prefiks i domena spoza strefy odrzucone", () => {
    expect(zaproponujUklad({ wpis: rozbierzWpis("sklep.pl")!, strefa: "sklep.pl", prefiks: "" })).toMatchObject({ domenaWysylkowa: "sklep.pl", domenaGlowna: true, mailFrom: "bounce.sklep.pl" });
    expect(zaproponujUklad({ wpis: rozbierzWpis("sklep.pl")!, strefa: "sklep.pl", prefiks: "zły prefiks" })).toBeNull();
    expect(zaproponujUklad({ wpis: rozbierzWpis("sklep.pl")!, strefa: "inna.pl" })).toBeNull();
  });
});

describe("DMARC dobierany automatycznie", () => {
  const baza = { domenaWysylkowa: "news.sklep.pl", strefa: "sklep.pl", rekordWlasny: null };
  it("brak jakiegokolwiek rekordu → najłagodniejszy własny (Gmail/Yahoo go wymagają)", () => {
    expect(decyzjaDmarc({ ...baza, rekordStrefy: null }).propozycja).toBe("v=DMARC1; p=none");
  });
  it("łagodny rekord domeny głównej obejmuje subdomenę → nic nie dokładamy", () => {
    expect(decyzjaDmarc({ ...baza, rekordStrefy: "v=DMARC1; p=quarantine; rua=mailto:d@sklep.pl" }).propozycja).toBeNull();
  });
  it("ścisłe aspf=s (jak midrev.pl) → kopia polityki (sp przed p) z aspf=r; raporty tylko w tej samej domenie", () => {
    const d = decyzjaDmarc({ ...baza, rekordStrefy: "v=DMARC1; p=quarantine; sp=reject; adkim=s; aspf=s; rua=mailto:dmarc@sklep.pl,mailto:x@obcy.com" });
    expect(d.scisly).toBe(true);
    expect(d.propozycja).toBe("v=DMARC1; p=reject; aspf=r; rua=mailto:dmarc@sklep.pl");
  });
  it("własny rekord subdomeny wygrywa; przy wysyłce z domeny głównej ścisły tryb nie wymaga dodatkowego rekordu", () => {
    expect(decyzjaDmarc({ ...baza, rekordWlasny: "v=DMARC1; p=none", rekordStrefy: null }).propozycja).toBeNull();
    expect(decyzjaDmarc({ domenaWysylkowa: "sklep.pl", strefa: "sklep.pl", rekordWlasny: null, rekordStrefy: "v=DMARC1; p=reject; aspf=s" }).propozycja).toBeNull();
  });
});

describe("Rekordy do skopiowania", () => {
  const wejscie = {
    domenaWysylkowa: "news.sklep.pl",
    strefa: "sklep.pl",
    tokeny: ["aaa", "bbb", "ccc"],
    strefaPodpisu: "dkim.amazonses.com",
    mailFrom: "bounce.news.sklep.pl",
    region: "eu-north-1",
    dmarcPropozycja: "v=DMARC1; p=none",
  };

  it("nazwy względne wobec strefy, wartości CNAME/MX z kropką dla paneli, które dopisują domenę (Hostido)", () => {
    const r = rekordyPlatformowe({ ...wejscie, kropkaNaKoncu: true });
    expect(r.map((x) => [x.nazwa, x.typ, x.wartosc])).toEqual([
      ["aaa._domainkey.news", "CNAME", "aaa.dkim.amazonses.com."],
      ["bbb._domainkey.news", "CNAME", "bbb.dkim.amazonses.com."],
      ["ccc._domainkey.news", "CNAME", "ccc.dkim.amazonses.com."],
      ["bounce.news", "MX", "feedback-smtp.eu-north-1.amazonses.com."],
      ["bounce.news", "TXT", "v=spf1 include:amazonses.com ~all"],
      ["_dmarc.news", "TXT", "v=DMARC1; p=none"],
    ]);
    expect(r.find((x) => x.typ === "MX")?.priorytet).toBe(10);
    // wartość kanoniczna do porównań zawsze bez kropki
    expect(r[0].oczekiwana).toBe("aaa.dkim.amazonses.com");
  });

  it("Cloudflare/GoDaddy bez kropki; bez propozycji DMARC nie ma szóstego rekordu", () => {
    const r = rekordyPlatformowe({ ...wejscie, dmarcPropozycja: null, kropkaNaKoncu: false });
    expect(r).toHaveLength(5);
    expect(r[0].wartosc).toBe("aaa.dkim.amazonses.com");
    // słowa techniczne tylko w wartościach, nigdy w opisie dla klienta
    for (const x of r) expect(x.poCo).not.toMatch(/SES|SMTP|IMAP|MAIL FROM|DKIM|SPF|DMARC/);
  });

  it("nazwa względna dla domeny głównej to @", () => {
    expect(nazwaWzgledna("sklep.pl", "sklep.pl")).toBe("@");
    expect(nazwaWzgledna("_dmarc.sklep.pl", "sklep.pl")).toBe("_dmarc");
  });

  it("wykrywa doklejoną nazwę strefy (lekcja z Hostido)", () => {
    expect(porownajCel("aaa.dkim.amazonses.com.", "aaa.dkim.amazonses.com", "sklep.pl")).toBe("ok");
    expect(porownajCel("aaa.dkim.amazonses.com.sklep.pl", "aaa.dkim.amazonses.com", "sklep.pl")).toBe("doklejona_strefa");
    expect(porownajCel("cos.innego.pl", "aaa.dkim.amazonses.com", "sklep.pl")).toBe("inna");
  });
});

describe("Dostawca DNS po serwerach NS", () => {
  it.each([
    [["ns1.hostido.net.pl", "ns2.hostido.net.pl"], "hostido", true],
    [["dns.home.pl", "dns2.home.pl"], "homepl", true],
    [["dns200.anycast.me", "ns200.anycast.me"], "ovh", true],
    [["ns1.nazwa.pl"], "nazwapl", true],
    [["ada.ns.cloudflare.com.", "bob.ns.cloudflare.com."], "cloudflare", false],
    [["ns51.domaincontrol.com"], "godaddy", false],
    [["ns1.cyberfolks.pl"], "cyberfolks", true],
    [["ns1.lh.pl"], "lhpl", true],
    [["ns-cloud-a1.googledomains.com"], "google", true],
    [["ns1.nieznany-hosting.example"], "inny", true],
  ])("%s → %s", (ns, klucz, kropka) => {
    const d = rozpoznajDostawce(ns);
    expect(d.klucz).toBe(klucz);
    expect(d.kropkaNaKoncu).toBe(kropka);
  });
});

describe("Rytm sprawdzania i nazwy zasobów", () => {
  it("świeża domena co minutę, potem rzadziej; gotowa raz na dobę", () => {
    const t0 = new Date("2026-10-01T10:00:00Z");
    const za = (min: number) => (nastepneSprawdzenie(t0, false, new Date(t0.getTime() + min * 60_000)).getTime() - t0.getTime()) / 60_000 - min;
    expect(za(5)).toBe(1);
    expect(za(60)).toBe(5);
    expect(za(30 * 60)).toBe(15);
    expect(za(80 * 60)).toBe(60);
    expect((nastepneSprawdzenie(t0, true, t0).getTime() - t0.getTime()) / 3600_000).toBe(24);
  });

  it("configuration set tenanta: deterministyczny, ≤ 64 znaki, dozwolone znaki SES", () => {
    const n = nazwaConfigurationSetu("01a043a1-472a-7769-a85f-a919ca2395fd");
    expect(n).toBe("midrev-t-01a043a1472a7769a85fa919ca2395fd");
    expect(n).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("Konfiguracja platformy (guardy)", () => {
  const PROD = {
    DATABASE_URL: "postgresql://u:p@127.0.0.1:5434/x",
    SECRETS_KEY: "a".repeat(64),
    SUPPRESSION_HASH_KEY: "b".repeat(64),
    API_KEY_PEPPER: "d".repeat(64),
    APP_URL: "https://esp.midrev.pl",
    ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc",
    TRUSTED_PROXY: "ostatni-xff",
  };
  it("atrapa SES poza sandboksem = odmowa startu", () => {
    expect(() => zbudujKonfiguracje({ ...PROD, SES_ATRAPA: "1" })).toThrow(/SES_ATRAPA/);
  });
  it("temat SNS z innego regionu niż SES = odmowa startu", () => {
    expect(() => zbudujKonfiguracje({ ...PROD, AWS_REGION: "eu-north-1", SES_SNS_TOPIC_ARN: "arn:aws:sns:eu-central-1:509758189751:t" })).toThrow(/SES_SNS_TOPIC_ARN/);
  });
  it("klucz bez sekretu = odmowa; komunikat nie zawiera wartości", () => {
    expect(() => zbudujKonfiguracje({ ...PROD, AWS_SES_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST" })).toThrow(/podaje się razem/);
    try {
      zbudujKonfiguracje({ ...PROD, AWS_SES_SECRET_ACCESS_KEY: "tajne-tajne-tajne-123" });
    } catch (b) {
      expect(String((b as Error).message)).not.toContain("tajne-tajne");
    }
  });
  it("domyślnie eu-north-1 i port 587; poprawna konfiguracja przechodzi", () => {
    const k = zbudujKonfiguracje({
      ...PROD,
      SES_SMTP_HOST: "email-smtp.eu-north-1.amazonaws.com",
      SES_SNS_TOPIC_ARN: "arn:aws:sns:eu-north-1:509758189751:midrev-esp-ses-zdarzenia",
      SES_ZDARZENIA_SNS: "1",
    });
    expect(k.AWS_REGION).toBe("eu-north-1");
    expect(k.SES_SMTP_PORT).toBe(587);
    expect(k.SES_ZDARZENIA_SNS).toBe(true);
    expect(k.SES_SNS_TOPIC_ARN).toEqual(["arn:aws:sns:eu-north-1:509758189751:midrev-esp-ses-zdarzenia"]);
  });
});
