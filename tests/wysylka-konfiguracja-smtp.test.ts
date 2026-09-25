import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { AdapterNodemailer } from "../src/adapters/email/nodemailer";
import { config } from "../src/config";
import { dodajDomene } from "../src/usecases/wysylka-konfiguracja/domeny";
import { odczytajSerwer, testujSerwer, wyslijWiadomoscTestowa, zapiszSerwer } from "../src/usecases/wysylka-konfiguracja/serwer";
import { wyslijPartie } from "../src/usecases/wysylka/wyslij-kampanie";

/**
 * Adapter nodemailer na PRAWDZIWYM serwerze SMTP: lokalny Mailpit (127.0.0.1:1025,
 * API na 8026). Sprawdzamy to, czego atrapa nie pokaże: że wiadomość faktycznie
 * doszła, z jakim nadawcą, z jakimi nagłówkami, i że błędy połączenia mają kształt,
 * który rozumie klasyfikacja błędów silnika.
 *
 * Mailpit jest dopuszczony WYŁĄCZNIE jawną konfiguracją SMTP_HOSTY_DEWELOPERSKIE
 * (w .env: 127.0.0.1:1025). Bez niej bramka SSRF odmawia — to też jest tu sprawdzone.
 */

const MAILPIT_API = "http://127.0.0.1:8026/api/v1";
const DEV = ["127.0.0.1:1025"];

interface WiadomoscMailpit {
  ID: string;
  MessageID: string;
  From: { Name: string; Address: string };
  To: { Address: string }[];
  ReplyTo: { Address: string }[];
  Subject: string;
}

async function znajdzWMailpicie(messageId: string): Promise<WiadomoscMailpit | null> {
  const id = messageId.replace(/^<|>$/g, "");
  for (let proba = 0; proba < 20; proba++) {
    const odp = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(`message-id:"${id}"`)}`);
    const dane = (await odp.json()) as { messages: WiadomoscMailpit[] };
    const trafienie = dane.messages?.find((m) => m.MessageID === id);
    if (trafienie) {
      const szczegoly = await fetch(`${MAILPIT_API}/message/${trafienie.ID}`);
      return (await szczegoly.json()) as WiadomoscMailpit;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function naglowki(mailpitId: string): Promise<Record<string, string[]>> {
  return (await (await fetch(`${MAILPIT_API}/message/${mailpitId}/headers`)).json()) as Record<string, string[]>;
}

describe("Adapter nodemailer na Mailpicie", () => {
  it("konfiguracja środowiska testowego ma Mailpita na jawnej liście deweloperskiej", () => {
    expect(config().SMTP_HOSTY_DEWELOPERSKIE).toContain("127.0.0.1:1025");
  });

  it("test połączenia przechodzi, a wiadomość dochodzi z właściwym nadawcą i nagłówkami", async () => {
    const adapter = new AdapterNodemailer(
      { host: "127.0.0.1", port: 1025, bezpieczenstwo: "none", uzytkownik: null, haslo: null },
      { hostyDeweloperskie: DEV },
    );
    const test = await adapter.testujPolaczenie();
    expect(test.ok).toBe(true);

    const klucz = randomUUID();
    const wynik = await adapter.wyslij({
      do: "odbiorca@example.test",
      od: "sklep@nadawca.test",
      odNazwa: "Sklep Zażółć",
      odpowiedzDo: "kontakt@nadawca.test",
      temat: "Test adaptera ąę",
      html: "<p>treść</p>",
      adresWypisania: "http://app.example/u/token123",
      idempotencyKey: klucz,
    });
    // Message-ID: lewa strona = idempotencyKey, prawa = domena nadawcy (RFC 5322; po nim
    // skrzynka zwrotna dopasowuje odbicia)
    expect(wynik.providerId).toBe(`<${klucz}@nadawca.test>`);
    // adapter nie zmyśla IP nadania: zna tylko serwer, któremu oddał maila
    expect(wynik.sendingIp).toBeUndefined();

    const m = await znajdzWMailpicie(wynik.providerId);
    expect(m).not.toBeNull();
    expect(m!.From).toMatchObject({ Name: "Sklep Zażółć", Address: "sklep@nadawca.test" });
    expect(m!.To.map((t) => t.Address)).toEqual(["odbiorca@example.test"]);
    expect(m!.ReplyTo.map((t) => t.Address)).toEqual(["kontakt@nadawca.test"]);
    expect(m!.Subject).toBe("Test adaptera ąę");
    const h = await naglowki(m!.ID);
    expect(h["List-Unsubscribe"]?.[0]).toBe("<http://app.example/u/token123>");
    expect(h["List-Unsubscribe-Post"]?.[0]).toBe("List-Unsubscribe=One-Click");
    // koperta = adres nadawcy (SPF sprawdzany na domenie z From)
    expect(h["Return-Path"]?.[0]).toContain("sklep@nadawca.test");
  });

  it("bez jawnej listy deweloperskiej ten sam Mailpit jest odrzucony przez bramkę SSRF", async () => {
    const adapter = new AdapterNodemailer(
      { host: "127.0.0.1", port: 1025, bezpieczenstwo: "none", uzytkownik: null, haslo: null },
      { hostyDeweloperskie: [] },
    );
    const test = await adapter.testujPolaczenie();
    expect(test).toMatchObject({ ok: false });
    await expect(
      adapter.wyslij({ do: "a@example.test", od: "b@example.test", temat: "x", html: "x", adresWypisania: "http://x/u/1", idempotencyKey: randomUUID() }),
    ).rejects.toThrow();
  });

  it("zamknięty port: czytelny komunikat, a przy wysyłce kod odmowy połączenia (wiadomość wraca do kolejki)", async () => {
    const adapter = new AdapterNodemailer(
      { host: "127.0.0.1", port: 1026, bezpieczenstwo: "none", uzytkownik: null, haslo: null },
      { hostyDeweloperskie: ["127.0.0.1:1026"] },
    );
    const test = await adapter.testujPolaczenie();
    expect(test).toMatchObject({ ok: false, kod: "odmowa" });
    await expect(
      adapter.wyslij({ do: "a@example.test", od: "b@example.test", temat: "x", html: "x", adresWypisania: "http://x/u/1", idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("STARTTLS wymagany przez konfigurację, a serwer go nie ma: komunikat mówi to wprost", async () => {
    const adapter = new AdapterNodemailer(
      { host: "127.0.0.1", port: 1025, bezpieczenstwo: "starttls", uzytkownik: null, haslo: null },
      { hostyDeweloperskie: DEV },
    );
    const test = await adapter.testujPolaczenie();
    expect(test).toMatchObject({ ok: false, kod: "starttls" });
  });

  it("TLS na porcie bez TLS: komunikat o niedopasowaniu trybu do portu", async () => {
    const adapter = new AdapterNodemailer(
      { host: "127.0.0.1", port: 1025, bezpieczenstwo: "tls", uzytkownik: null, haslo: null },
      { hostyDeweloperskie: DEV },
    );
    const test = await adapter.testujPolaczenie();
    expect(test).toMatchObject({ ok: false, kod: "tryb_tls" });
  });

  it("adres z CRLF albo z listą odbiorców jest odrzucony przed połączeniem", async () => {
    const adapter = new AdapterNodemailer(
      { host: "127.0.0.1", port: 1025, bezpieczenstwo: "none", uzytkownik: null, haslo: null },
      { hostyDeweloperskie: DEV },
    );
    for (const zly of ["a@x.test\r\nBcc: b@y.test", "a@x.test, b@y.test"]) {
      await expect(
        adapter.wyslij({ do: zly, od: "b@example.test", temat: "x", html: "x", adresWypisania: "http://x/u/1", idempotencyKey: randomUUID() }),
      ).rejects.toThrow(/odrzucony/);
    }
  });
});

describe("Pełna ścieżka: konfiguracja w panelu → test → wysyłka przez silnik", () => {
  let tenantId: string;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'WKS %'");
    tenantId = (await pool.query("insert into tenants (name) values ('WKS tenant') returning id")).rows[0].id;
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like 'WKS %'");
    await closePool();
  });

  it("zapis serwera wskazującego Mailpita, test połączenia, wiadomość testowa i partia kampanii", async () => {
    const d = await dodajDomene(tenantId, { domena: "wks-sklep.test", selektorDkim: "", mechanizmSpf: "" });
    expect(d.ok).toBe(true);

    const zapis = await zapiszSerwer(tenantId, {
      host: "127.0.0.1",
      port: "1025",
      bezpieczenstwo: "none",
      uzytkownik: "",
      noweHaslo: "",
      usunHaslo: false,
      nazwaNadawcy: "Sklep WKS",
      adresNadawcy: "Newsletter@WKS-sklep.test",
      odpowiedzDo: "",
    });
    expect(zapis).toEqual({ ok: true });
    expect((await odczytajSerwer(tenantId))!.polaczenieSprawdzoneAt).toBeNull();

    const test = await testujSerwer(tenantId);
    expect(test.ok).toBe(true);
    const widok = await odczytajSerwer(tenantId);
    expect(widok!.polaczenieSprawdzoneAt).not.toBeNull();
    expect(widok!.deweloperski).toBe(true);

    const testowa = await wyslijWiadomoscTestowa(tenantId, "operator@example.test");
    expect(testowa.ok).toBe(true);
    if (!testowa.ok) return;
    const m = await znajdzWMailpicie(testowa.messageId);
    expect(m!.From).toMatchObject({ Name: "Sklep WKS", Address: "newsletter@wks-sklep.test" });

    // Partia przez silnik BEZ wstrzykniętego dostawcy: wybór per tenant bierze jego serwer.
    // Domena NIE jest zweryfikowana, ale serwer jest na jawnej liście deweloperskiej,
    // więc FR45 go nie blokuje — i to jest jedyna droga obejścia.
    const { rows } = await getPool().query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
       values ($1, null, 'test', $2, 'klient@example.test', 'WKS partia', '<p>x</p>', $3, $4) returning id`,
      [tenantId, randomUUID(), randomBytes(18).toString("base64url"), randomBytes(18).toString("base64url")],
    );
    const wynik = await wyslijPartie(tenantId);
    expect(wynik).toMatchObject({ wyslane: 1, bledy: 0, powodZatrzymania: null });
    const { rows: w } = await getPool().query(
      "select current_state, provider, provider_id from messages where tenant_id = $1 and id = $2",
      [tenantId, rows[0].id],
    );
    expect(w[0]).toMatchObject({ current_state: "sent", provider: "smtp:127.0.0.1" });
    const wMailpicie = await znajdzWMailpicie(w[0].provider_id);
    expect(wMailpicie!.From).toMatchObject({ Name: "Sklep WKS", Address: "newsletter@wks-sklep.test" });
    expect(wMailpicie!.To.map((t) => t.Address)).toEqual(["klient@example.test"]);
  });
});
