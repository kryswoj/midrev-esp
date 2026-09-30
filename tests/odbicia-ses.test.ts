import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { AdapterNodemailer, adresKoperty, idDostawcyZOdpowiedzi } from "../src/adapters/email/nodemailer";
import { parsujRaportZwrotny } from "../src/domain/email/dsn";
import { przetworzRaport } from "../src/usecases/wysylka/odbicia";

/**
 * Odbicia przy przekaźniku Amazon SES (audyt 28.09, 03-wysylka 7.3 pkt 2).
 *
 * SES nadpisuje Message-ID własnym (<id@eu-central-1.amazonses.com>) i zwraca ten id
 * w odpowiedzi na DATA („250 Ok <id>"). Przekazane odbicie (email feedback forwarding)
 * niesie więc Message-ID SES, a nie nasz. Kolejność dopasowania:
 *   nasz X-MidRev-Message-Id w kopii nagłówków → ID dostawcy → Message-ID → adres.
 *
 * UWAGA o fixturach: to raporty ZBUDOWANE według dokumentacji SES (format DSN RFC 3464,
 * Reporting-MTA amazonses, kopia nagłówków oryginału), nie złapane z symulatora — konto
 * SES jeszcze nie istnieje. Po pierwszym teście na bounce@simulator.amazonses.com
 * prawdziwy raport ma trafić do tests/dane/ i zastąpić te szablony.
 */

const SES_ID = "0107018f4c3e9a1b-2c3d4e5f-6a7b-8c9d-0e1f-a2b3c4d5e6f7-000000";

function dsnSes(opcje: { odbiorca: string; messageIdOryginalu: string; naszId?: string | null; kopiaJako?: "naglowki" | "rfc822"; naglowekRaportu?: string }): string {
  const kopia = [
    `From: MidRev <newsletter@news.midrev.test>`,
    `To: ${opcje.odbiorca}`,
    `Subject: Temat SES`,
    `Message-ID: ${opcje.messageIdOryginalu}`,
    ...(opcje.naszId ? [`X-MidRev-Message-Id: ${opcje.naszId}`] : []),
    `Date: Mon, 28 Sep 2026 10:00:00 +0000`,
    `MIME-Version: 1.0`,
  ].join("\r\n");
  const czescKopii =
    opcje.kopiaJako === "rfc822"
      ? ["Content-Type: message/rfc822", "", kopia, "", "<p>treść</p>"].join("\r\n")
      : ["Content-Type: text/rfc822-headers", "", kopia].join("\r\n");
  return [
    "Return-Path: <>",
    "From: MAILER-DAEMON@amazonses.com",
    "To: newsletter@news.midrev.test",
    "Subject: Delivery Status Notification (Failure)",
    "Date: Mon, 28 Sep 2026 10:00:05 +0000",
    ...(opcje.naglowekRaportu ? [opcje.naglowekRaportu] : []),
    "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="=_ses_granica"',
    "",
    "--=_ses_granica",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "An error occurred while trying to deliver the mail to the following recipients:",
    opcje.odbiorca,
    "",
    "--=_ses_granica",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; a3-45.smtp-out.eu-central-1.amazonses.com",
    "",
    `Action: failed`,
    `Final-Recipient: rfc822; ${opcje.odbiorca}`,
    `Diagnostic-Code: smtp; 550 5.1.1 user unknown`,
    `Status: 5.1.1`,
    "",
    "--=_ses_granica",
    czescKopii,
    "",
    "--=_ses_granica--",
    "",
  ].join("\r\n");
}

describe("Parser DSN: nasz nagłówek z kopii oryginału", () => {
  it("czyta X-MidRev-Message-Id z text/rfc822-headers i z message/rfc822", () => {
    const id = randomUUID();
    const a = parsujRaportZwrotny(dsnSes({ odbiorca: "x@example.test", messageIdOryginalu: `<${SES_ID}@eu-central-1.amazonses.com>`, naszId: id }));
    expect(a).toMatchObject({ rodzaj: "dsn", naszIdOryginalu: id, messageIdOryginalu: `<${SES_ID}@eu-central-1.amazonses.com>` });
    const b = parsujRaportZwrotny(dsnSes({ odbiorca: "x@example.test", messageIdOryginalu: "<a@b.test>", naszId: id, kopiaJako: "rfc822" }));
    expect(b.naszIdOryginalu).toBe(id);
  });

  it("NIE bierze nagłówka z samego raportu (tam pisze autor raportu) ani wartości spoza UUID", () => {
    const obcy = randomUUID();
    const tylkoWRaporcie = parsujRaportZwrotny(
      dsnSes({ odbiorca: "x@example.test", messageIdOryginalu: "<a@b.test>", naszId: null, naglowekRaportu: `X-MidRev-Message-Id: ${obcy}` }),
    );
    expect(tylkoWRaporcie.naszIdOryginalu).toBeNull();
    const smiec = parsujRaportZwrotny(dsnSes({ odbiorca: "x@example.test", messageIdOryginalu: "<a@b.test>", naszId: "test-1; drop table messages" }));
    expect(smiec.naszIdOryginalu).toBeNull();
  });
});

describe("Identyfikator dostawcy i koperta (adapter)", () => {
  it.each([
    ["250 Ok 0107018f4c3e9a1b-2c3d4e5f-6a7b-8c9d-0e1f-a2b3c4d5e6f7-000000", "0107018f4c3e9a1b-2c3d4e5f-6a7b-8c9d-0e1f-a2b3c4d5e6f7-000000"],
    ["250 2.0.0 Ok: queued as 4XyZ12AbC", "4XyZ12AbC"],
    // pełny Message-ID zapisywany jako lewa strona: tej postaci szuka dopasowanie odbić
    ["250 2.0.0 Ok: queued as <abc123@mx.example>", "abc123"],
    ["250 OK", null],
    ["", null],
    [undefined, null],
    ["354 go ahead", null],
  ])("odpowiedź %j → %j", (odpowiedz, oczekiwane) => {
    expect(idDostawcyZOdpowiedzi(odpowiedz as string | undefined)).toBe(oczekiwane);
  });

  it("koperta: przekaźnik = From (SES przepisuje sam, odbicia na From); własny serwer z domeną koperty = lokalna@koperta", () => {
    expect(adresKoperty("newsletter@news.midrev.pl", { rodzaj: "przekaznik", domenaKoperty: "bounce.news.midrev.pl" })).toBe("newsletter@news.midrev.pl");
    expect(adresKoperty("newsletter@news.midrev.pl", { rodzaj: "wlasny_serwer", domenaKoperty: "bounce.news.midrev.pl" })).toBe("newsletter@bounce.news.midrev.pl");
    expect(adresKoperty("newsletter@news.midrev.pl", { rodzaj: "wlasny_serwer", domenaKoperty: null })).toBe("newsletter@news.midrev.pl");
    expect(adresKoperty("newsletter@news.midrev.pl", {})).toBe("newsletter@news.midrev.pl");
  });
});

describe("Adapter nodemailer na Mailpicie: nagłówek, text/plain, koperta", () => {
  const MAILPIT_API = "http://127.0.0.1:8026/api/v1";
  async function znajdz(messageId: string) {
    const id = messageId.replace(/^<|>$/g, "");
    for (let proba = 0; proba < 30; proba++) {
      const dane = (await (await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(`message-id:"${id}"`)}`)).json()) as { messages: { ID: string; MessageID: string }[] };
      const t = dane.messages?.find((m) => m.MessageID === id);
      if (t) {
        const m = (await (await fetch(`${MAILPIT_API}/message/${t.ID}`)).json()) as { ID: string; Text: string; HTML: string };
        const h = (await (await fetch(`${MAILPIT_API}/message/${t.ID}/headers`)).json()) as Record<string, string[]>;
        return { m, h };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  it.each([
    ["wlasny_serwer", "bounce.nadawca.test", "sklep@bounce.nadawca.test"],
    ["przekaznik", "bounce.nadawca.test", "sklep@nadawca.test"],
  ] as const)("rodzaj %s, koperta %s → Return-Path %s; X-MidRev-Message-Id i wersja tekstowa", async (rodzaj, domenaKoperty, returnPath) => {
    const adapter = new AdapterNodemailer(
      { host: "127.0.0.1", port: 1025, bezpieczenstwo: "none", uzytkownik: null, haslo: null, rodzaj, domenaKoperty },
      { hostyDeweloperskie: ["127.0.0.1:1025"] },
    );
    const klucz = randomUUID();
    const wynik = await adapter.wyslij({
      do: "odbiorca@example.test",
      od: "sklep@nadawca.test",
      odNazwa: "Sklep",
      temat: "Test SES",
      html: '<p>Cześć &amp; witaj</p><p><a href="https://link.example/r/abc?l=0">Zobacz ofertę</a></p><img src="https://link.example/api/o/x.gif" width="1" height="1" alt="">',
      adresWypisania: "https://link.example/u/tok",
      idempotencyKey: klucz,
    });
    await adapter.zamknij();
    const z = await znajdz(wynik.providerId);
    expect(z).not.toBeNull();
    expect(z!.h["X-Midrev-Message-Id"]?.[0] ?? z!.h["X-MidRev-Message-Id"]?.[0]).toBe(klucz);
    expect(z!.h["Return-Path"]?.[0]).toContain(returnPath);
    // multipart/alternative: wersja tekstowa z linkiem w nawiasie, bez pixela
    expect(z!.m.Text).toContain("Cześć & witaj");
    expect(z!.m.Text).toContain("Zobacz ofertę (https://link.example/r/abc?l=0)");
    expect(z!.m.Text).not.toContain("api/o");
    expect(z!.m.HTML).toContain("<p>Cześć &amp; witaj</p>");
  });
});

describe("Dopasowanie odbicia SES do wiadomości (baza)", () => {
  let tenantId: string;
  let obcyTenantId: string;
  let campaignId: string;

  async function wiadomosc(t: string, email: string, pola: { providerMessageId?: string | null } = {}) {
    const pool = getPool();
    const p = await pool.query(
      `insert into profiles (tenant_id, email) values ($1, $2)
       on conflict (tenant_id, (lower(btrim(email)))) where email is not null do update set email = excluded.email
       returning id`,
      [t, email],
    );
    const kampania =
      t === tenantId
        ? campaignId
        : (await pool.query(`insert into campaigns (tenant_id, name, subject, content, status) values ($1, 'SES obca', 'x', '{"html":"<p>x</p>"}', 'sent') returning id`, [t])).rows[0].id;
    const { rows } = await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token,
                             current_state, current_rank, handed_off_at, provider_id, provider_message_id)
       values ($1, $2, 'campaign', $3, $4, 'Temat SES', '<p>x</p>', $5, $6, 'sent', 2, now() - interval '1 hour', $7, $8) returning id`,
      [t, p.rows[0].id, kampania, email, `ses-k-${randomUUID()}`, `ses-u-${randomUUID()}`, `<${randomUUID()}@news.midrev.test>`, pola.providerMessageId ?? null],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'SES-ODB %'");
    tenantId = (await pool.query("insert into tenants (name) values ('SES-ODB tenant') returning id")).rows[0].id;
    obcyTenantId = (await pool.query("insert into tenants (name) values ('SES-ODB obcy') returning id")).rows[0].id;
    campaignId = (
      await pool.query(`insert into campaigns (tenant_id, name, subject, content, status) values ($1, 'SES', 'x', '{"html":"<p>x</p>"}', 'sent') returning id`, [tenantId])
    ).rows[0].id;
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from suppressions where email like 'ses-odb-%@example.test'");
    await pool.query("delete from tenants where name like 'SES-ODB %'");
    await closePool();
  });

  it("1. nasz nagłówek w kopii oryginału wygrywa, nawet gdy Message-ID jest SES-owy", async () => {
    const id = await wiadomosc(tenantId, "ses-odb-1@example.test", { providerMessageId: `${SES_ID}-a` });
    const { wyniki } = await przetworzRaport(tenantId, dsnSes({ odbiorca: "ses-odb-1@example.test", messageIdOryginalu: `<${SES_ID}-a@eu-central-1.amazonses.com>`, naszId: id }));
    expect(wyniki[0]).toMatchObject({ wynik: "zapisane", messageId: id, dopasowanie: "naglowek", typZdarzenia: "bounced", kodSmtp: "5.1.1" });
  });

  it("2. bez naszego nagłówka: Message-ID SES → provider_message_id", async () => {
    const id = await wiadomosc(tenantId, "ses-odb-2@example.test", { providerMessageId: `${SES_ID}-b` });
    const { wyniki } = await przetworzRaport(tenantId, dsnSes({ odbiorca: "ses-odb-2@example.test", messageIdOryginalu: `<${SES_ID}-b@eu-central-1.amazonses.com>` }));
    expect(wyniki[0]).toMatchObject({ wynik: "zapisane", messageId: id, dopasowanie: "id_dostawcy" });
  });

  it("3. identyfikator wiadomości INNEGO tenanta nie trafia w nic (izolacja), a adres obcego tenanta też nie", async () => {
    const obca = await wiadomosc(obcyTenantId, "ses-odb-3@example.test", { providerMessageId: `${SES_ID}-c` });
    const { wyniki } = await przetworzRaport(tenantId, dsnSes({ odbiorca: "ses-odb-3@example.test", messageIdOryginalu: `<${SES_ID}-c@eu-central-1.amazonses.com>`, naszId: obca }));
    expect(wyniki[0]).toMatchObject({ wynik: "brak_wiadomosci", messageId: null });
    const { rows } = await getPool().query("select count(*)::int as ile from message_events where message_id = $1 and event_type = 'bounced'", [obca]);
    expect(rows[0].ile).toBe(0);
  });

  it("4. niejednoznaczne ID dostawcy: rozstrzyga adres WYŁĄCZNIE wśród kandydatów, inaczej raport bez wiadomości", async () => {
    await wiadomosc(tenantId, "ses-odb-4a@example.test", { providerMessageId: "4XyZ12" });
    const druga = await wiadomosc(tenantId, "ses-odb-4b@example.test", { providerMessageId: "4XyZ12" });
    const { wyniki } = await przetworzRaport(tenantId, dsnSes({ odbiorca: "ses-odb-4b@example.test", messageIdOryginalu: "<4XyZ12@mx.stary.test>" }));
    expect(wyniki[0]).toMatchObject({ wynik: "zapisane", messageId: druga, dopasowanie: "id_dostawcy" });
    // adresat spoza kandydatów, choć ma własną, nowszą wiadomość: NIE przyklejamy do niej
    const inna = await wiadomosc(tenantId, "ses-odb-4c@example.test", { providerMessageId: null });
    const { wyniki: w2 } = await przetworzRaport(tenantId, dsnSes({ odbiorca: "ses-odb-4c@example.test", messageIdOryginalu: "<4XyZ12@mx.stary.test>" }));
    expect(w2[0]).toMatchObject({ wynik: "brak_wiadomosci", messageId: null });
    const { rows } = await getPool().query("select count(*)::int as ile from message_events where message_id = $1 and event_type = 'bounced'", [inna]);
    expect(rows[0].ile).toBe(0);
  });

  it("4b. sfałszowany raport: prawdziwy nagłówek, ale cudzy Final-Recipient — bez wykluczenia GLOBALNEGO", async () => {
    const id = await wiadomosc(tenantId, "ses-odb-5@example.test", { providerMessageId: null });
    const { wyniki } = await przetworzRaport(tenantId, dsnSes({ odbiorca: "ses-odb-5-ofiara@example.test", messageIdOryginalu: "<x@y.test>", naszId: id }));
    expect(wyniki[0]).toMatchObject({ wynik: "zapisane", messageId: id, dopasowanie: "naglowek" });
    const pool = getPool();
    const { rows: glob } = await pool.query("select count(*)::int as ile from suppressions where email in ('ses-odb-5@example.test', 'ses-odb-5-ofiara@example.test')");
    expect(glob[0].ile).toBe(0);
    // zgodny adresat (test 1) daje wykluczenie globalne — kontrola, że test coś mierzy
    const { rows: zgodny } = await pool.query("select count(*)::int as ile from suppressions where email = 'ses-odb-1@example.test'");
    expect(zgodny[0].ile).toBe(1);
  });

  it("5. rejestr raportów przyjmuje nowe klucze dopasowania (check z 0029)", async () => {
    const pool = getPool();
    for (const jak of ["naglowek", "id_dostawcy", "message_id", "adres"]) {
      await pool.query(
        `insert into bounce_reports (tenant_id, imap_uidvalidity, imap_uid, kind, outcome, matched_by, received_at)
         values ($1, 1, $2, 'dsn', 'zapisane', $3, '2026-09-28T10:00:00Z')`,
        [tenantId, 1000 + ["naglowek", "id_dostawcy", "message_id", "adres"].indexOf(jak), jak],
      );
    }
    await expect(
      pool.query(
        `insert into bounce_reports (tenant_id, imap_uidvalidity, imap_uid, kind, outcome, matched_by, received_at)
         values ($1, 1, 2000, 'dsn', 'zapisane', 'zgadywanie', '2026-09-28T10:00:00Z')`,
        [tenantId],
      ),
    ).rejects.toThrow(/matched_by/);
  });
});
