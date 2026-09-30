import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adresKlienta } from "../src/adapters/ip-klienta";
import { zbudujKonfiguracje } from "../src/config";
import { htmlNaTekst } from "../src/domain/email/tekst";
import { normalizujNip } from "../src/usecases/wysylka-konfiguracja/dane-nadawcy";
import { liniaNadawcy, zlozWiadomosc } from "../src/usecases/wysylka/renderuj";
import { ocenGotowosc } from "../src/usecases/tresc/lista-kontrolna";

/**
 * Guardy konfiguracji NIEZALEŻNE od NODE_ENV (audyt 28.09, P0-3): worker startuje przez
 * `node src/jobs/worker.ts`, więc NODE_ENV nie dostaje, a to on wkleja adresy do maili.
 * Tryb sandboxa jest jawną flagą MIDREV_SANDBOX; bez niej = produkcja.
 * Testy wołają czystą funkcję zbudujKonfiguracje, nie globalny config() procesu testów.
 */

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const PROD = {
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5434/midrev_esp_prod",
  SECRETS_KEY: HEX_A,
  SUPPRESSION_HASH_KEY: HEX_B,
  APP_URL: "https://esp.midrev.pl",
  ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc",
  TRUSTED_PROXY: "ostatni-xff",
};

describe("Guard konfiguracji poza sandboksem", () => {
  it("poprawna konfiguracja produkcyjna przechodzi BEZ NODE_ENV (proces workera)", () => {
    const k = zbudujKonfiguracje({ ...PROD });
    expect(k.MIDREV_SANDBOX).toBe(false);
    expect(k.APP_URL).toBe("https://esp.midrev.pl");
  });

  it.each([
    ["APP_URL domyślny (gołe IP po http)", { APP_URL: undefined }, /APP_URL/],
    ["APP_URL po http", { APP_URL: "http://esp.midrev.pl" }, /APP_URL musi zaczynać się od https/],
    ["APP_URL na gołym IP", { APP_URL: "https://137.74.42.199" }, /APP_URL nie może wskazywać na adres IP/],
    ["APP_URL na IPv6", { APP_URL: "https://[2001:db8::1]" }, /APP_URL nie może wskazywać na adres IP/],
    ["APP_URL localhost", { APP_URL: "https://localhost:3005" }, /APP_URL nie może wskazywać/],
    ["APP_URL ze ścieżką", { APP_URL: "https://esp.midrev.pl/panel" }, /bez ścieżki/],
    ["TRACKING_URL po http", { TRACKING_URL: "http://link.midrev.pl" }, /TRACKING_URL musi zaczynać się od https/],
    ["TRACKING_URL na IP", { TRACKING_URL: "https://10.0.0.5" }, /TRACKING_URL nie może wskazywać na adres IP/],
    ["TRACKING_URL .local", { TRACKING_URL: "https://link.midrev.local" }, /TRACKING_URL nie może wskazywać/],
    ["SECRETS_KEY z zer", { SECRETS_KEY: undefined }, /SECRETS_KEY/],
    ["SECRETS_KEY nie-hex", { SECRETS_KEY: "z".repeat(64) }, /SECRETS_KEY/],
    ["brak SUPPRESSION_HASH_KEY", { SUPPRESSION_HASH_KEY: undefined }, /SUPPRESSION_HASH_KEY/],
    ["SUPPRESSION_HASH_KEY = SECRETS_KEY", { SUPPRESSION_HASH_KEY: HEX_A }, /inny niż SECRETS_KEY/],
    ["brak ALERT_WEBHOOK_URL", { ALERT_WEBHOOK_URL: undefined }, /ALERT_WEBHOOK_URL jest wymagany/],
    ["ALERT_WEBHOOK_URL po http", { ALERT_WEBHOOK_URL: "http://hooks.example/x" }, /ALERT_WEBHOOK_URL musi/],
    ["SMTP_HOSTY_DEWELOPERSKIE ustawione", { SMTP_HOSTY_DEWELOPERSKIE: "127.0.0.1:1025" }, /SMTP_HOSTY_DEWELOPERSKIE/],
    ["brak jawnego TRUSTED_PROXY", { TRUSTED_PROXY: undefined }, /TRUSTED_PROXY jest wymagany/],
    ["TRUSTED_PROXY spoza listy", { TRUSTED_PROXY: "pierwszy-xff" }, /TRUSTED_PROXY/],
    ["TRUSTED_PROXY=brak poza sandboksem (wyłącza limit per IP)", { TRUSTED_PROXY: "brak" }, /TRUSTED_PROXY jest wymagany/],
  ])("odmawia: %s", (_opis, zmiana, blad) => {
    expect(() => zbudujKonfiguracje({ ...PROD, ...zmiana })).toThrow(blad);
  });

  it("komunikat nigdy nie zawiera wartości sekretu", () => {
    const sekret = "c".repeat(64);
    try {
      zbudujKonfiguracje({ ...PROD, SECRETS_KEY: sekret, SUPPRESSION_HASH_KEY: sekret });
      throw new Error("miało rzucić");
    } catch (b) {
      expect(String((b as Error).message)).not.toContain(sekret);
    }
  });

  it("MIDREV_SANDBOX=1 luzuje guardy (dev), ale NIE przy NODE_ENV=production", () => {
    const dev = zbudujKonfiguracje({ DATABASE_URL: "postgresql://x", MIDREV_SANDBOX: "1", SMTP_HOSTY_DEWELOPERSKIE: "127.0.0.1:1025" });
    expect(dev.MIDREV_SANDBOX).toBe(true);
    expect(dev.APP_URL).toBe("http://137.74.42.199:3005");
    expect(() => zbudujKonfiguracje({ ...PROD, MIDREV_SANDBOX: "1", NODE_ENV: "production" })).toThrow(/MIDREV_SANDBOX nie może/);
  });

  it("flaga inna niż jawne „tak” to produkcja (literówka nie wyłącza guardów)", () => {
    expect(() => zbudujKonfiguracje({ DATABASE_URL: "postgresql://x", MIDREV_SANDBOX: "0" })).toThrow(/Konfiguracja niebezpieczna/);
    expect(() => zbudujKonfiguracje({ DATABASE_URL: "postgresql://x", MIDREV_SANDBOX: "sandbox" })).toThrow(/Konfiguracja niebezpieczna/);
  });

  it("adresy bez ukośnika na końcu (inaczej linki //u/…)", () => {
    const k = zbudujKonfiguracje({ ...PROD, APP_URL: "https://esp.midrev.pl/", TRACKING_URL: "https://link.midrev.pl/" });
    expect(k.APP_URL).toBe("https://esp.midrev.pl");
    expect(k.TRACKING_URL).toBe("https://link.midrev.pl");
  });
});

describe("Walidacja startowa: jeden sposób ładowania środowiska", () => {
  it("poza sandboksem odmawia startu, gdy w katalogu aplikacji leży plik .env* (Next go czyta, worker nie)", async () => {
    const { sprawdzSrodowiskoStartowe } = await import("../src/walidacja-startowa");
    const prod = zbudujKonfiguracje({ ...PROD });
    const dev = zbudujKonfiguracje({ DATABASE_URL: "postgresql://x", MIDREV_SANDBOX: "1" });
    const katalog = mkdtempSync(join(tmpdir(), "midrev-env-"));
    try {
      expect(() => sprawdzSrodowiskoStartowe("worker", katalog, prod)).not.toThrow();
      for (const plik of [".env", ".env.production", ".env.local", ".env.production.local"]) {
        writeFileSync(join(katalog, plik), "APP_URL=https://x.pl\n");
        expect(() => sprawdzSrodowiskoStartowe("panel", katalog, prod)).toThrow(new RegExp(plik.replace(/\./g, "\\.")));
        // sandbox (dev) ma .env i to jest w porządku
        expect(() => sprawdzSrodowiskoStartowe("worker", katalog, dev)).not.toThrow();
        rmSync(join(katalog, plik));
      }
    } finally {
      rmSync(katalog, { recursive: true, force: true });
    }
  });
});

describe("Adres klienta za zaufanym proxy (limity)", () => {
  const h = (pola: Record<string, string>) => new Headers(pola);
  it("ostatni-xff: bierze adres dopisany przez NASZE proxy, nie podany przez klienta", () => {
    expect(adresKlienta(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }), "ostatni-xff")).toBe("203.0.113.9");
    expect(adresKlienta(h({ "x-forwarded-for": "203.0.113.9" }), "ostatni-xff")).toBe("203.0.113.9");
    expect(adresKlienta(h({ "x-forwarded-for": "to-nie-ip" }), "ostatni-xff")).toBeNull();
    expect(adresKlienta(h({ "x-forwarded-for": "[2001:db8::5]:443" }), "ostatni-xff")).toBe("2001:db8::5");
  });
  it("x-real-ip i brak proxy", () => {
    expect(adresKlienta(h({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "9.9.9.9" }), "x-real-ip")).toBe("198.51.100.1");
    expect(adresKlienta(h({ "x-forwarded-for": "9.9.9.9" }), "brak")).toBeNull();
  });
});

describe("Wersja text/plain z HTML", () => {
  it("akapity, linki z adresem, listy, encje; bez stylu, skryptu, komentarza i pixela", () => {
    const t = htmlNaTekst(`<!doctype html><html><head><style>p{color:red}</style><title>x</title></head><body>
      <div style="display:none">ukryty preheader</div><!-- komentarz -->
      <h1>Nowa&nbsp;kolekcja</h1><p>Cześć,<br>mamy &#8222;coś&#8221; dla Ciebie &amp; bliskich.</p>
      <ul><li>Pierwsze</li><li>Drugie</li></ul>
      <p><a href="https://link.example/r/tok?l=0">Zobacz</a> albo <a href="https://sklep.pl">https://sklep.pl</a></p>
      <img src="https://link.example/o/abc.png" alt="Zdjęcie produktu"><img src="https://link.example/api/o/p.gif" width="1" height="1" alt="">
      <script>alert(1)</script></body></html>`);
    expect(t).toContain("Nowa kolekcja");
    expect(t).toContain("Cześć,\nmamy „coś” dla Ciebie & bliskich.");
    expect(t).toContain("• Pierwsze");
    expect(t).toContain("Zobacz (https://link.example/r/tok?l=0)");
    expect(t).toContain("https://sklep.pl");
    expect(t).not.toContain("https://sklep.pl (https://sklep.pl)");
    expect(t).toContain("[Zdjęcie produktu]");
    for (const nie of ["ukryty preheader", "komentarz", "color:red", "alert(1)", "api/o", "<"]) expect(t).not.toContain(nie);
    expect(t).not.toMatch(/\n{3,}/);
  });

  it("stopka złożonej wiadomości (wypis) przechodzi do wersji tekstowej", () => {
    const { html } = zlozWiadomosc({ trescHtml: "<p>treść</p>", clickToken: "K", unsubscribeToken: "W", nazwaSklepu: "Sklep", sledzOtwarcia: false });
    expect(htmlNaTekst(html)).toMatch(/Wypisz się jednym kliknięciem \(\S+\/u\/W\)/);
  });
});

describe("Dane nadawcy w stopce i bramka listy kontrolnej", () => {
  it("linia nadawcy jest escapowana i łączy firmę, adres i NIP; bez danych nie ma linii", () => {
    expect(liniaNadawcy({ firma: "MidRev <sp. z o.o.>", adres: "ul. Prosta 1\n00-001 Warszawa", nip: "5260250274" })).toContain(
      "MidRev &lt;sp. z o.o.&gt; · ul. Prosta 1, 00-001 Warszawa · NIP 5260250274",
    );
    expect(liniaNadawcy({ firma: null, adres: null, nip: null })).toBe("");
    const { html } = zlozWiadomosc({
      trescHtml: "<p>x</p>",
      clickToken: "K",
      unsubscribeToken: "W",
      nazwaSklepu: "Sklep",
      nadawca: { firma: "MidRev", adres: "ul. Prosta 1, 00-001 Warszawa", nip: null },
    });
    expect(html).toContain("MidRev · ul. Prosta 1, 00-001 Warszawa");
  });

  it("NIP: normalizacja i suma kontrolna polskiego NIP-u", () => {
    expect(normalizujNip("526-025-02-74")).toBe("5260250274");
    expect(normalizujNip("PL 526 025 02 74")).toBe("PL5260250274");
    expect(normalizujNip("5260250275")).toBeUndefined();
    expect(normalizujNip("abc")).toBeUndefined();
    expect(normalizujNip("  ")).toBeNull();
    expect(normalizujNip("DE123456789")).toBe("DE123456789");
  });

  it("lista kontrolna blokuje kampanię bez adresu pocztowego nadawcy", () => {
    const baza = {
      temat: "Temat",
      docelowo: 10,
      kandydaci: 10,
      html: '<a href="https://sklep.pl">x</a>',
      maStopkeZWypisem: true,
      domena: { rodzaj: "zweryfikowana", domena: "news.midrev.pl", adres: "n@news.midrev.pl" } as const,
      uwagiTresci: [],
    };
    const bez = ocenGotowosc({ ...baza, adresPocztowy: null }).find((p) => p.klucz === "adres");
    expect(bez?.stan).toBe("blad");
    const z = ocenGotowosc({ ...baza, adresPocztowy: "ul. Prosta 1\n00-001 Warszawa" }).find((p) => p.klucz === "adres");
    expect(z?.stan).toBe("ok");
  });
});
