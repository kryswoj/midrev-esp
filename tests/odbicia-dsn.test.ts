import { describe, expect, it } from "vitest";
import { parsujDateNaglowka, parsujRaportZwrotny } from "../src/domain/email/dsn";
import { klasyfikujOdpowiedzSmtp } from "../src/domain/email/klasyfikacja";
import {
  autoresponder,
  gmailTwardeOdbicie,
  microsoftTwardeOdbicie,
  odpowiedzCzlowieka,
  postfixOpoznienie,
  postfixPelnaSkrzynka,
  qmailBezDsn,
  yahooSkarga,
} from "./dane/dsn-przyklady";

/**
 * Parser raportów zwrotnych (czysta domena, bez bazy). Każdy przykład to realny kształt
 * raportu danego MTA. Sprawdzamy trzy rzeczy, od których zależy reszta toru: rozpoznanie
 * rodzaju, Message-ID oryginału (klucz dopasowania) i to, jak klasyfikator SMTP odczyta
 * wyciągnięty status/diagnostykę (hard/soft, wykluczenie adresu).
 */
const MSGID = "<019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b@perf.example.test>";

describe("Parser DSN/ARF", () => {
  it("Gmail: twarde odbicie 5.1.1 z Message-ID z części message/rfc822, data z nagłówka Date raportu", () => {
    const r = parsujRaportZwrotny(gmailTwardeOdbicie(MSGID));
    expect(r.rodzaj).toBe("dsn");
    expect(r.pewnosc).toBe("wysoka");
    expect(r.messageIdOryginalu).toBe(MSGID);
    expect(r.mtaRaportujacy).toBe("googlemail.com");
    expect(r.odbiorcy).toHaveLength(1);
    const o = r.odbiorcy[0];
    expect(o.adres).toBe("nieistnieje@gmail.com");
    expect(o.akcja).toBe("failed");
    expect(o.status).toBe("5.1.1");
    // Diagnostic-Code zawinięty w kilka linii jest rozwinięty, bez prefiksu „smtp;"
    expect(o.diagnostyka).toMatch(/^550-5\.1\.1 The email account/);
    expect(o.diagnostyka).toContain("NoSuchUser");
    // data ZE ŹRÓDŁA: Date raportu, nie chwila odczytu
    expect(r.kiedy?.toISOString()).toBe("2026-09-24T08:15:02.000Z");
    // klasyfikator: twarde, adres do wykluczenia, wchodzi do wskaźnika
    const k = klasyfikujOdpowiedzSmtp(`${o.status} ${o.diagnostyka}`, "bounced");
    expect(k.klasa).toBe("hard");
    expect(k.kategoria).toBe("invalid_address");
    expect(k.wykluczAdres).toBe(true);
    expect(k.liczySieDoWskaznika).toBe(true);
  });

  it("Gmail: Auto-Submitted: auto-replied NIE zamienia DSN w autoresponder", () => {
    expect(gmailTwardeOdbicie(MSGID)).toContain("Auto-Submitted: auto-replied");
    expect(parsujRaportZwrotny(gmailTwardeOdbicie(MSGID)).rodzaj).toBe("dsn");
  });

  it("Gmail: Message-ID także z X-Original-Message-ID w grupie per-message, gdy brak kopii oryginału", () => {
    const bezKopii = gmailTwardeOdbicie(MSGID)
      .replace(/Content-Type: message\/rfc822[\s\S]*?(?=--000000000000a1b2c30623f1a9e1--)/, "")
      .replace("References: " + MSGID + "\r\n", "")
      .replace("In-Reply-To: " + MSGID + "\r\n", "");
    expect(bezKopii).not.toContain("message/rfc822");
    const r = parsujRaportZwrotny(bezKopii);
    expect(r.rodzaj).toBe("dsn");
    expect(r.messageIdOryginalu).toBe(MSGID);
  });

  it("Microsoft 365: 5.1.10 RecipientNotFound, adres bez spacji po „rfc822;”", () => {
    const r = parsujRaportZwrotny(microsoftTwardeOdbicie(MSGID));
    expect(r.rodzaj).toBe("dsn");
    expect(r.messageIdOryginalu).toBe(MSGID);
    expect(r.mtaRaportujacy).toBe("AM0PR01MB1234.eurprd01.prod.exchangelabs.com");
    const o = r.odbiorcy[0];
    expect(o.adres).toBe("nikt@firma-klienta.pl");
    expect(o.status).toBe("5.1.10");
    expect(o.diagnostyka).toMatch(/^550 5\.1\.10 RESOLVER\.ADR\.RecipientNotFound/);
    expect(r.kiedy?.toISOString()).toBe("2026-09-24T08:15:04.000Z");
    const k = klasyfikujOdpowiedzSmtp(`${o.status} ${o.diagnostyka}`, "bounced");
    expect(k.klasa).toBe("hard");
    expect(k.kodSmtp).toBe("5.1.10");
  });

  it("Postfix: pełna skrzynka 5.2.2 jest MIĘKKA mimo 5xx; Message-ID z text/rfc822-headers; data z (CEST)", () => {
    const r = parsujRaportZwrotny(postfixPelnaSkrzynka(MSGID));
    expect(r.rodzaj).toBe("dsn");
    expect(r.messageIdOryginalu).toBe(MSGID);
    const o = r.odbiorcy[0];
    expect(o.adres).toBe("pelna@skrzynka-klienta.pl");
    expect(o.status).toBe("5.2.2");
    expect(r.kiedy?.toISOString()).toBe("2026-09-24T08:15:30.000Z");
    const k = klasyfikujOdpowiedzSmtp(`${o.status} ${o.diagnostyka}`, "bounced");
    expect(k.klasa).toBe("soft");
    expect(k.kategoria).toBe("mailbox_full");
    expect(k.wykluczAdres).toBe(false);
  });

  it("Postfix: opóźnienie (Action: delayed, 4.4.1) to miękkie odbicie bez wykluczenia", () => {
    const r = parsujRaportZwrotny(postfixOpoznienie(MSGID));
    expect(r.rodzaj).toBe("dsn");
    const o = r.odbiorcy[0];
    expect(o.akcja).toBe("delayed");
    expect(o.status).toBe("4.4.1");
    // diagnostyka X-Postfix bez kodu SMTP: to Status na początku decyduje o klasie
    const k = klasyfikujOdpowiedzSmtp(`${o.status} ${o.diagnostyka}`, "bounced");
    expect(k.klasa).toBe("soft");
    expect(k.wykluczAdres).toBe(false);
  });

  it("Yahoo ARF: skarga z Feedback-Type: abuse i adresem z Original-Rcpt-To", () => {
    const r = parsujRaportZwrotny(yahooSkarga(MSGID));
    expect(r.rodzaj).toBe("arf");
    expect(r.typSkargi).toBe("abuse");
    expect(r.messageIdOryginalu).toBe(MSGID);
    expect(r.odbiorcy[0].adres).toBe("ktos@yahoo.com");
    expect(r.kiedy?.toISOString()).toBe("2026-09-24T10:01:00.000Z");
  });

  it("qmail bez DSN: heurystyka niskiej pewności, adres i kod z różnych linii, Message-ID z cytowanych nagłówków", () => {
    const r = parsujRaportZwrotny(qmailBezDsn(MSGID));
    expect(r.rodzaj).toBe("heurystyka");
    expect(r.pewnosc).toBe("niska");
    expect(r.messageIdOryginalu).toBe(MSGID);
    expect(r.odbiorcy[0].adres).toBe("zly@stary-hosting.pl");
    expect(r.odbiorcy[0].status).toBe("5.1.1");
    expect(r.odbiorcy[0].akcja).toBe("failed");
  });

  it("autoresponder z Auto-Submitted i liczbą 550 w treści NIE jest odbiciem", () => {
    const r = parsujRaportZwrotny(autoresponder(MSGID));
    expect(r.rodzaj).toBe("nie_odbicie");
    expect(r.odbiorcy).toEqual([]);
  });

  it("odpowiedź człowieka (Re:) z liczbą 550 w treści NIE jest odbiciem", () => {
    const r = parsujRaportZwrotny(odpowiedzCzlowieka(MSGID));
    expect(r.rodzaj).toBe("nie_odbicie");
  });

  it("raport z zepsutą datą nie zmyśla daty (null), a data z komentarzem w nawiasie przechodzi", () => {
    expect(parsujDateNaglowka("Thu, 24 Sep 2026 10:15:30 +0200 (CEST)")?.toISOString()).toBe("2026-09-24T08:15:30.000Z");
    expect(parsujDateNaglowka("wczoraj")).toBeNull();
    expect(parsujDateNaglowka("Thu, 1 Jan 1970 00:00:00 +0000")).toBeNull();
    const bezDaty = gmailTwardeOdbicie(MSGID).replace(/^Date: .*\r\n/m, "").replace(/^Arrival-Date: .*\r\n/m, "");
    expect(parsujRaportZwrotny(bezDaty).kiedy).toBeNull();
  });

  it("DSN o dostarczeniu (NOTIFY=SUCCESS) niesie akcję delivered i nie jest odbiciem dla klasyfikatora", () => {
    const sukces = postfixPelnaSkrzynka(MSGID)
      .replace("Action: failed", "Action: delivered")
      .replace("Status: 5.2.2", "Status: 2.0.0")
      .replace(/Diagnostic-Code: .*$/m, "Diagnostic-Code: smtp; 250 2.0.0 Ok: queued as 123");
    const r = parsujRaportZwrotny(sukces);
    expect(r.rodzaj).toBe("dsn");
    expect(r.odbiorcy[0].akcja).toBe("delivered");
    expect(r.odbiorcy[0].status).toBe("2.0.0");
  });
});
