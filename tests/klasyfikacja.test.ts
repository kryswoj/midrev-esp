import { describe, expect, it } from "vitest";
import {
  klasyfikujOdbicieSes,
  klasyfikujOdpowiedzSmtp,
  klasyfikujSkarge,
  ocenAutomat,
  wyciagnijKodSmtp,
} from "../src/domain/email/klasyfikacja";

/**
 * Wykonywalna specyfikacja klasyfikacji odbić (A2) i detekcji zdarzeń maszynowych (A1).
 * Czysta domena, bez bazy: wejściem jest to, co powiedział dostawca, wyjściem decyzja,
 * którą zapisujemy w samym zdarzeniu.
 *
 * Kody SMTP i rozkład kategorii pochodzą z żywego konta Klaviyo (KLAVIYO-MODULY 3.2):
 * 5.1.1 (22), 5.7.1 (13), 5.5.0 (5), 5.2.2, 5.2.1, 4.3.0.
 */

describe("Klasyfikacja odbić (A2)", () => {
  it("wyciąga kod rozszerzony przed podstawowym, bo tylko ten niesie przyczynę", () => {
    expect(wyciagnijKodSmtp("550 5.1.1 User unknown")).toBe("5.1.1");
    expect(wyciagnijKodSmtp("SMTP: oczekiwano 250, dostano: 550 mailbox not found")).toBe("550");
    expect(wyciagnijKodSmtp("połączenie zerwane")).toBeNull();
  });

  it("5.1.1 (nieistniejący adres) to twarde odbicie z wykluczeniem adresu", () => {
    const k = klasyfikujOdpowiedzSmtp("550 5.1.1 User unknown");
    expect(k.typZdarzenia).toBe("bounced");
    expect(k.klasa).toBe("hard");
    expect(k.kategoria).toBe("invalid_address");
    expect(k.kodSmtp).toBe("5.1.1");
    expect(k.wykluczAdres).toBe(true);
    expect(k.liczySieDoWskaznika).toBe(true);
  });

  it("pełna skrzynka (5.2.2) to odbicie MIĘKKIE mimo kodu 5xx i NIE wyklucza adresu", () => {
    const k = klasyfikujOdpowiedzSmtp("552 5.2.2 Mailbox full");
    expect(k.klasa).toBe("soft");
    expect(k.kategoria).toBe("mailbox_full");
    // to jest miejsce, w którym najłatwiej skasować z bazy żywych ludzi
    expect(k.wykluczAdres).toBe(false);
    expect(k.liczySieDoWskaznika).toBe(false);
  });

  it("blokada antyspamowa (5.7.1) jest miękka: to problem reputacji, nie adresu", () => {
    const k = klasyfikujOdpowiedzSmtp("550 5.7.1 Message rejected as spam");
    expect(k.klasa).toBe("soft");
    expect(k.kategoria).toBe("spam_block");
    expect(k.wykluczAdres).toBe(false);
  });

  it("kod 4xx jest zawsze miękki", () => {
    const k = klasyfikujOdpowiedzSmtp("451 4.3.0 Temporary local problem");
    expect(k.klasa).toBe("soft");
    expect(k.wykluczAdres).toBe(false);
  });

  it("brak kodu to 'nie wiemy', a nie 'wykluczamy'", () => {
    const k = klasyfikujOdpowiedzSmtp("połączenie zerwane po DATA");
    expect(k.klasa).toBe("undetermined");
    expect(k.wykluczAdres).toBe(false);
    expect(k.liczySieDoWskaznika).toBe(false);
  });

  it("odmowa przy handoffie to 'dropped', nie 'bounced', i nie wchodzi do bounce rate", () => {
    const k = klasyfikujOdpowiedzSmtp("550 5.1.1 User unknown", "dropped");
    expect(k.typZdarzenia).toBe("dropped");
    expect(k.klasa).toBe("hard");
    // adres wykluczamy (jest martwy), ale mail nie dotarł do serwera odbiorcy,
    // więc nie mówi nic o naszej reputacji u niego
    expect(k.wykluczAdres).toBe(true);
    expect(k.liczySieDoWskaznika).toBe(false);
  });

  it("SES: Permanent/NoEmail to twarde odbicie liczone do wskaźnika", () => {
    const k = klasyfikujOdbicieSes("Permanent", "NoEmail", "smtp; 550 5.1.1 user unknown");
    expect(k.typZdarzenia).toBe("bounced");
    expect(k.klasa).toBe("hard");
    expect(k.kategoria).toBe("invalid_address");
    expect(k.kodSmtp).toBe("5.1.1");
    expect(k.wykluczAdres).toBe(true);
    expect(k.liczySieDoWskaznika).toBe(true);
  });

  it("SES: On*SuppressionList to 'dropped' i NIE wchodzi do bounce rate", () => {
    for (const subtyp of ["OnAccountSuppressionList", "OnTenantSuppressionList", "Suppressed"]) {
      const k = klasyfikujOdbicieSes("Permanent", subtyp);
      expect(k.typZdarzenia).toBe("dropped");
      expect(k.kategoria).toBe("suppressed_by_provider");
      // SES wprost wyłącza te podtypy ze swojego bounce rate; wliczenie ich zawyżyłoby
      // metrykę i wstrzymało tenanta bez powodu
      expect(k.liczySieDoWskaznika).toBe(false);
    }
  });

  it("SES: Transient jest miękkie i nie wyklucza adresu", () => {
    const k = klasyfikujOdbicieSes("Transient", "MailboxFull");
    expect(k.typZdarzenia).toBe("bounced");
    expect(k.klasa).toBe("soft");
    expect(k.kategoria).toBe("mailbox_full");
    expect(k.wykluczAdres).toBe(false);
  });

  it("SES: Undetermined zostaje 'undetermined', nie jest zrównywane z soft", () => {
    const k = klasyfikujOdbicieSes("Undetermined", "Undetermined");
    expect(k.klasa).toBe("undetermined");
    expect(k.wykluczAdres).toBe(false);
  });

  it("skarga 'not-spam' NIE jest skargą i nie tworzy zdarzenia", () => {
    expect(klasyfikujSkarge("not-spam")).toBeNull();
  });

  it("skarga abuse wyklucza adres i wchodzi do complaint rate", () => {
    const k = klasyfikujSkarge("abuse")!;
    expect(k.typZdarzenia).toBe("complained");
    expect(k.wykluczAdres).toBe(true);
    expect(k.liczySieDoWskaznika).toBe(true);
  });

  it("skarga z listy supresji nie podbija complaint rate drugi raz", () => {
    const k = klasyfikujSkarge("abuse", "OnAccountSuppressionList")!;
    expect(k.wykluczAdres).toBe(true);
    expect(k.liczySieDoWskaznika).toBe(false);
  });
});

describe("Otwarcia maszynowe i kliknięcia botów (A1)", () => {
  it("flaga dostawcy wygrywa z każdą heurystyką", () => {
    const czlowiek = ocenAutomat({
      kind: "open",
      flagaDostawcy: false,
      userAgent: "GoogleImageProxy",
      ip: "17.1.2.3",
    });
    expect(czlowiek).toEqual({ automat: false, powod: "dostawca_oznaczyl" });
    const bot = ocenAutomat({ kind: "click", flagaDostawcy: true, userAgent: "Mozilla/5.0" });
    expect(bot).toEqual({ automat: true, powod: "dostawca_oznaczyl" });
  });

  it("brak user agenta i brak flagi dostawcy to NULL, czyli 'nie wiemy'", () => {
    // to nie jest synonim "człowiek": wpisanie tu false psuje statystykę otwarć przy MPP
    expect(ocenAutomat({ kind: "open" })).toEqual({ automat: null, powod: null });
    expect(ocenAutomat({ kind: "open", userAgent: "   " })).toEqual({ automat: null, powod: null });
  });

  it("proxy obrazków operatora jest otwarciem maszynowym", () => {
    expect(ocenAutomat({ kind: "open", userAgent: "Mozilla/5.0 (GoogleImageProxy)" })).toEqual({
      automat: true,
      powod: "proxy_obrazkow",
    });
  });

  it("skaner bezpieczeństwa jest klikiem bota, nie człowieka", () => {
    const k = ocenAutomat({ kind: "click", userAgent: "Mozilla/5.0 SafeLinks/1.0" });
    expect(k).toEqual({ automat: true, powod: "skaner_bezpieczenstwa" });
    expect(ocenAutomat({ kind: "click", userAgent: "Proofpoint-Scanner" }).automat).toBe(true);
  });

  it("klient nieinteraktywny nigdy nie jest człowiekiem", () => {
    expect(ocenAutomat({ kind: "click", userAgent: "curl/8.5.0" })).toEqual({
      automat: true,
      powod: "klient_automatyczny",
    });
  });

  it("otwarcie z sieci Apple przy zwykłym user agencie to prawdopodobne MPP", () => {
    const k = ocenAutomat({
      kind: "open",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      ip: "17.58.63.10",
    });
    expect(k).toEqual({ automat: true, powod: "apple_mpp" });
    // ta sama heurystyka NIE dotyczy kliknięć: klik z sieci Apple to normalny użytkownik
    expect(
      ocenAutomat({ kind: "click", userAgent: "Mozilla/5.0 (Macintosh)", ip: "17.58.63.10" }).automat,
    ).toBe(false);
  });

  it("zwykła przeglądarka to 'sprawdziliśmy i nic nie znaleźliśmy', z zapisanym powodem", () => {
    const k = ocenAutomat({
      kind: "open",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      ip: "83.1.2.3",
    });
    expect(k).toEqual({ automat: false, powod: "brak_przeslanek" });
  });

  it("opóźnienie dostarczenia nie jest ani maszyną, ani człowiekiem", () => {
    expect(ocenAutomat({ kind: "delivery_delay", userAgent: "curl/8.5.0" })).toEqual({
      automat: null,
      powod: null,
    });
  });
});
