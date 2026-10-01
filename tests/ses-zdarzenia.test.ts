import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Konfiguracja PRZED pierwszym config(): allowlista tematu i konto (vi.hoisted idzie przed importami).
vi.hoisted(() => {
  process.env.AWS_REGION = "eu-north-1";
  process.env.AWS_ACCOUNT_ID = "509758189751";
  process.env.SES_SNS_TOPIC_ARN = "arn:aws:sns:eu-north-1:509758189751:midrev-esp-ses-zdarzenia";
});

import {
  parsujWiadomoscSns,
  tekstDoPodpisuSns,
  wyczyscPamiecCertyfikatow,
  zweryfikujWiadomoscSns,
  type WiadomoscSns,
} from "../src/adapters/aws/podpis-sns";
import { AtrapaSes, AtrapaSns } from "../src/adapters/aws/atrapa-ses";
import { closePool, getPool } from "../src/adapters/db/pool";
import { BladAws, celKompletny } from "../src/domain/email/ses";
import { skonfigurujZdarzeniaSes } from "../src/usecases/wysylka-konfiguracja/zdarzenia-ses-konfiguracja";
import { przetworzWiadomoscSns } from "../src/usecases/wysylka/zdarzenia-ses";
import { POST } from "../src/app/api/webhooks/ses/route";

/**
 * Zdarzenia SES przez SNS. Podpisy liczone prawdziwym RSA na certyfikacie testowym
 * (tests/fixtures/sns, wygenerowany tylko do testów); pobranie certyfikatu wstrzyknięte.
 * Historia, której nie powtarzamy: brak weryfikacji podpisu webhooka, SSRF przy pobieraniu
 * certyfikatu, przypisanie tenanta z treści, podwójne przetworzenie zdarzenia.
 */

const KATALOG = join(import.meta.dirname, "fixtures", "sns");
const CERT = readFileSync(join(KATALOG, "certyfikat-testowy.pem"), "utf8");
const KLUCZ = readFileSync(join(KATALOG, "klucz-testowy.pem"), "utf8");
const OBCY_KLUCZ = readFileSync(join(KATALOG, "obcy-klucz.pem"), "utf8");
const TEMAT = "arn:aws:sns:eu-north-1:509758189751:midrev-esp-ses-zdarzenia";
const CERT_URL = "https://sns.eu-north-1.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem";
const KONTO = "509758189751";

let licznik = 0;
function podpisz(w: Omit<WiadomoscSns, "Signature">, klucz = KLUCZ): WiadomoscSns {
  const pelna = { ...w, Signature: "" } as WiadomoscSns;
  pelna.Signature = createSign(w.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256").update(tekstDoPodpisuSns(pelna)).sign(klucz, "base64");
  return pelna;
}

function powiadomienie(zdarzenie: Record<string, unknown>, opcje: { wersja?: "1" | "2"; temat?: string; id?: string } = {}): WiadomoscSns {
  return podpisz({
    Type: "Notification",
    MessageId: opcje.id ?? `sns-${++licznik}-${Date.now()}`,
    TopicArn: opcje.temat ?? TEMAT,
    Message: JSON.stringify(zdarzenie),
    Timestamp: new Date().toISOString(),
    SignatureVersion: opcje.wersja ?? "2",
    SigningCertURL: CERT_URL,
  });
}

function zdarzenieSes(typ: "Bounce" | "Complaint" | "Delivery" | "Send", o: { sesId: string; cs: string; zrodlo: string; konto?: string; bounceType?: string; bounceSubType?: string; feedback?: string }) {
  const kiedy = new Date(Date.now() - 60_000).toISOString();
  return {
    eventType: typ,
    mail: {
      timestamp: kiedy,
      messageId: o.sesId,
      source: o.zrodlo,
      sendingAccountId: o.konto ?? KONTO,
      destination: ["odbiorca@example.test"],
      tags: { "ses:configuration-set": [o.cs] },
    },
    ...(typ === "Bounce"
      ? { bounce: { bounceType: o.bounceType ?? "Permanent", bounceSubType: o.bounceSubType ?? "General", timestamp: kiedy, bouncedRecipients: [{ emailAddress: "odbiorca@example.test", diagnosticCode: "smtp; 550 5.1.1 user unknown" }] } }
      : {}),
    ...(typ === "Complaint" ? { complaint: { timestamp: kiedy, complainedRecipients: [{ emailAddress: "x@example.test" }], complaintFeedbackType: o.feedback ?? "abuse" } } : {}),
    ...(typ === "Delivery" ? { delivery: { timestamp: kiedy, smtpResponse: "250 2.0.0 OK" } } : {}),
    ...(typ === "Send" ? { send: {} } : {}),
  };
}

const pobierz = vi.fn(async (_u: string) => CERT);

describe("Podpis SNS", () => {
  beforeEach(() => {
    wyczyscPamiecCertyfikatow();
    pobierz.mockClear();
  });

  it("SignatureVersion 2 i 1: poprawny podpis przechodzi, certyfikat pobrany raz (pamięć)", async () => {
    const w2 = powiadomienie({ a: 1 });
    expect(await zweryfikujWiadomoscSns(w2, { region: "eu-north-1", pobierz })).toEqual({ ok: true });
    const w1 = powiadomienie({ a: 2 }, { wersja: "1" });
    expect(await zweryfikujWiadomoscSns(w1, { region: "eu-north-1", pobierz })).toEqual({ ok: true });
    expect(pobierz).toHaveBeenCalledTimes(1);
  });

  it("zmieniona treść, podpis obcym kluczem, nieznana wersja podpisu = odmowa", async () => {
    const w = powiadomienie({ a: 1 });
    expect((await zweryfikujWiadomoscSns({ ...w, Message: '{"a":2}' }, { region: "eu-north-1", pobierz })).ok).toBe(false);
    const obcy = podpisz({ ...w, Signature: undefined } as never, OBCY_KLUCZ);
    expect(await zweryfikujWiadomoscSns(obcy, { region: "eu-north-1", pobierz })).toEqual({ ok: false, powod: "zły podpis" });
    expect(parsujWiadomoscSns({ ...w, SignatureVersion: "3" })).toBeNull();
  });

  it.each([
    "http://sns.eu-north-1.amazonaws.com/SimpleNotificationService-abc.pem",
    "https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-abc.pem",
    "https://sns.eu-north-1.amazonaws.com.evil.test/SimpleNotificationService-abc.pem",
    "https://evil.test/SimpleNotificationService-abc.pem",
    "https://sns.eu-north-1.amazonaws.com@evil.test/SimpleNotificationService-abc.pem",
    "https://sns.eu-north-1.amazonaws.com:8443/SimpleNotificationService-abc.pem",
    "https://sns.eu-north-1.amazonaws.com/SimpleNotificationService-abc.pem?x=1",
    "https://sns.eu-north-1.amazonaws.com/../etc/passwd",
    "https://169.254.169.254/latest/meta-data",
  ])("SSRF: certyfikat spod %s nie jest nawet pobierany", async (url) => {
    const w = podpisz({ ...powiadomienie({}), SigningCertURL: url } as never);
    const r = await zweryfikujWiadomoscSns(w, { region: "eu-north-1", pobierz });
    expect(r).toEqual({ ok: false, powod: "niedozwolony adres certyfikatu" });
    expect(pobierz).not.toHaveBeenCalled();
  });

  it("przeterminowana wiadomość i temat z innego regionu = odmowa", async () => {
    const stara = podpisz({ ...powiadomienie({}), Timestamp: new Date(Date.now() - 25 * 3600_000).toISOString() } as never);
    expect(await zweryfikujWiadomoscSns(stara, { region: "eu-north-1", pobierz })).toEqual({ ok: false, powod: "wiadomość przeterminowana" });
    const inny = powiadomienie({}, { temat: "arn:aws:sns:us-east-1:509758189751:x" });
    expect((await zweryfikujWiadomoscSns(inny, { region: "eu-north-1", pobierz })).ok).toBe(false);
  });

  it("tekst do podpisu: kolejność bajtowa, Subject tylko gdy jest, nowa linia na końcu", () => {
    const w = { ...powiadomienie({}), Subject: "S" } as WiadomoscSns;
    expect(tekstDoPodpisuSns(w)).toBe(`Message\n${w.Message}\nMessageId\n${w.MessageId}\nSubject\nS\nTimestamp\n${w.Timestamp}\nTopicArn\n${w.TopicArn}\nType\nNotification\n`);
  });
});

describe("Zdarzenia SES → wiadomości, wykluczenia i metryki", () => {
  let tenantA: string;
  let tenantB: string;
  const csA = "midrev-t-sestesta";
  const csB = "midrev-t-sestestb";
  const msg: Record<string, string> = {};
  const alerty: { t: string; p: string }[] = [];
  const alert = async (t: string, p: string) => {
    alerty.push({ t, p });
  };

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'SESZ %'");
    await pool.query("delete from suppressions where email like 'sesz-%'");
    tenantA = (await pool.query("insert into tenants (name, ses_configuration_set) values ('SESZ A', $1) returning id", [csA])).rows[0].id;
    tenantB = (await pool.query("insert into tenants (name, ses_configuration_set) values ('SESZ B', $1) returning id", [csB])).rows[0].id;
    await pool.query(
      `insert into sending_domains (tenant_id, domain, managed_by, zone_apex, status, ses_mail_from_domain)
       values ($1, 'news.sesz-a.test', 'platforma', 'sesz-a.test', 'verified', 'bounce.news.sesz-a.test'),
              ($2, 'news.sesz-b.test', 'platforma', 'sesz-b.test', 'verified', 'bounce.news.sesz-b.test')`,
      [tenantA, tenantB],
    );
    const k = await pool.query("insert into campaigns (tenant_id, name, subject, content, status) values ($1, 'SESZ k', 'Temat', '{}', 'sent') returning id", [tenantA]);
    for (const nazwa of ["twarde", "skarga", "nie_spam", "dorecz", "powtorka"]) {
      const email = `sesz-${nazwa}@example.test`;
      const p = await pool.query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantA, email]);
      const m = await pool.query(
        `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token, provider_id, provider_message_id, current_state, current_rank)
         values ($1, $2, 'campaign', $3, $4, 'Temat', '<p>x</p>', $5, $6, $7, $8, 'sent', 3) returning id`,
        [tenantA, p.rows[0].id, k.rows[0].id, email, `sesz-k-${nazwa}`, `sesz-u-${nazwa}`, `<${nazwa}@x>`, `0107sesz-${nazwa}-000000`],
      );
      msg[nazwa] = m.rows[0].id;
    }
  });

  afterEach(() => {
    alerty.length = 0;
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from ses_sns_messages where tenant_id is null or topic_arn like '%midrev-esp-ses-zdarzenia%'");
    await pool.query("delete from suppressions where email like 'sesz-%'");
    await pool.query("delete from tenants where name like 'SESZ %'");
    await closePool();
  });

  async function metryki(messageId: string) {
    const { rows } = await getPool().query(
      "select m.name, e.source, e.unique_id, e.properties from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id where e.tenant_id = $1 and e.message_id = $2",
      [tenantA, messageId],
    );
    return rows;
  }

  it("obcy temat SNS: 403 i zero zapisu", async () => {
    const w = powiadomienie({}, { temat: "arn:aws:sns:eu-north-1:509758189751:cudzy" });
    expect(await przetworzWiadomoscSns(w, { alert })).toEqual({ status: 403, wynik: "nieznany_temat" });
    expect((await getPool().query("select 1 from ses_sns_messages where sns_message_id = $1", [w.MessageId])).rows).toHaveLength(0);
  });

  it("twarde odbicie: zdarzenie, wykluczenie sklepowe i globalne, metryka Bounced Email — RAZ mimo powtórek", async () => {
    const ev = zdarzenieSes("Bounce", { sesId: "0107sesz-twarde-000000", cs: csA, zrodlo: "newsletter@news.sesz-a.test" });
    const w = powiadomienie(ev);
    expect(await przetworzWiadomoscSns(w, { alert })).toEqual({ status: 200, wynik: "zapisane" });
    // SNS powtarza z tym samym MessageId
    expect(await przetworzWiadomoscSns(w, { alert })).toEqual({ status: 200, wynik: "duplikat" });
    // ten sam fakt SES dostarczony drugi raz z innym MessageId SNS
    expect((await przetworzWiadomoscSns(powiadomienie(ev), { alert })).status).toBe(200);

    const pool = getPool();
    const { rows: ev2 } = await pool.query("select event_type, bounce_class, occurred_at from message_events where message_id = $1 and event_type = 'bounced'", [msg.twarde]);
    expect(ev2).toHaveLength(1);
    expect(ev2[0].bounce_class).toBe("hard");
    // data ze źródła (bounce.timestamp), nie chwila zapisu
    expect(Math.abs(new Date(ev2[0].occurred_at).getTime() - (Date.now() - 60_000))).toBeLessThan(5_000);
    const { rows: lok } = await pool.query("select count(*)::int as n from tenant_suppressions where tenant_id = $1 and email = 'sesz-twarde@example.test'", [tenantA]);
    expect(lok[0].n).toBe(1);
    const { rows: glob } = await pool.query("select count(*)::int as n from suppressions where email = 'sesz-twarde@example.test'");
    expect(glob[0].n).toBe(1);
    const m = await metryki(msg.twarde);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ name: "Bounced Email", source: "webhook", unique_id: `msg:${msg.twarde}:bounced` });
    expect(m[0].properties["Bounce Type"]).toBe("Hard");
    expect(JSON.stringify(m[0].properties)).not.toContain("sesz-twarde@");
  });

  it("dwa RÓWNOLEGŁE dostarczenia tej samej wiadomości SNS: przetwarza jedno, drugie to duplikat", async () => {
    const pool = getPool();
    const k = await pool.query("select source_id from messages where id = $1", [msg.twarde]);
    const p = await pool.query("insert into profiles (tenant_id, email) values ($1, 'sesz-rownolegle@example.test') returning id", [tenantA]);
    const m = await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token, provider_message_id, current_state, current_rank)
       values ($1, $2, 'campaign', $3, 'sesz-rownolegle@example.test', 'T', '<p>x</p>', 'sesz-k-r', 'sesz-u-r', '0107sesz-rown-000000', 'sent', 3) returning id`,
      [tenantA, p.rows[0].id, k.rows[0].source_id],
    );
    const w = powiadomienie(zdarzenieSes("Bounce", { sesId: "0107sesz-rown-000000", cs: csA, zrodlo: "newsletter@news.sesz-a.test" }));
    const wyniki = await Promise.all([przetworzWiadomoscSns(w, { alert }), przetworzWiadomoscSns(w, { alert })]);
    expect(wyniki.map((x) => x.wynik).sort()).toEqual(["duplikat", "zapisane"]);
    const { rows } = await pool.query("select count(*)::int as n from tenant_suppressions where tenant_id = $1 and email = 'sesz-rownolegle@example.test'", [tenantA]);
    expect(rows[0].n).toBe(1);
    expect(await metryki(m.rows[0].id)).toHaveLength(1);
  });

  it("wiersz 'w_toku' po padnięciu procesu: świeży blokuje, starszy niż 5 min zostaje przejęty", async () => {
    const w = powiadomienie(zdarzenieSes("Send", { sesId: "0107sesz-dorecz-000000", cs: csA, zrodlo: "newsletter@news.sesz-a.test" }));
    await getPool().query(
      "insert into ses_sns_messages (sns_message_id, topic_arn, type, outcome, sns_timestamp) values ($1, $2, 'Notification', 'w_toku', now())",
      [w.MessageId, TEMAT],
    );
    expect((await przetworzWiadomoscSns(w, { alert })).wynik).toBe("duplikat");
    await getPool().query("update ses_sns_messages set received_at = now() - interval '10 minutes' where sns_message_id = $1", [w.MessageId]);
    expect((await przetworzWiadomoscSns(w, { alert })).wynik).toBe("pominiete");
  });

  it("skarga → Marked Email as Spam; „not-spam” nie jest skargą", async () => {
    await przetworzWiadomoscSns(powiadomienie(zdarzenieSes("Complaint", { sesId: "0107sesz-skarga-000000", cs: csA, zrodlo: "newsletter@news.sesz-a.test" })), { alert });
    expect((await metryki(msg.skarga)).map((r) => r.name)).toEqual(["Marked Email as Spam"]);
    const r = await przetworzWiadomoscSns(powiadomienie(zdarzenieSes("Complaint", { sesId: "0107sesz-nie_spam-000000", cs: csA, zrodlo: "newsletter@news.sesz-a.test", feedback: "not-spam" })), { alert });
    expect(r.wynik).toBe("nie_jest_skarga");
    expect(await metryki(msg.nie_spam)).toHaveLength(0);
  });

  it("doręczenie → Received Email; Send pomijane (stan sent już mamy)", async () => {
    await przetworzWiadomoscSns(powiadomienie(zdarzenieSes("Delivery", { sesId: "0107sesz-dorecz-000000", cs: csA, zrodlo: "newsletter@news.sesz-a.test" })), { alert });
    expect((await metryki(msg.dorecz)).map((r) => r.name)).toEqual(["Received Email"]);
    const s = await przetworzWiadomoscSns(powiadomienie(zdarzenieSes("Send", { sesId: "0107sesz-dorecz-000000", cs: csA, zrodlo: "newsletter@news.sesz-a.test" })), { alert });
    expect(s.wynik).toBe("pominiete");
  });

  it("tenant NIE z treści: zestaw tenanta B + identyfikator wiadomości tenanta A = brak zapisu u A", async () => {
    // zestaw B, nadawca z domeny B (wszystko „zgodne" po stronie B), ale wiadomość należy do A
    const r = await przetworzWiadomoscSns(powiadomienie(zdarzenieSes("Bounce", { sesId: "0107sesz-powtorka-000000", cs: csB, zrodlo: "x@news.sesz-b.test" })), { alert });
    expect(r.wynik).toBe("brak_wiadomosci");
    const { rows } = await getPool().query("select 1 from message_events where message_id = $1 and event_type = 'bounced'", [msg.powtorka]);
    expect(rows).toHaveLength(0);
  });

  it("nadawca spoza domeny tenanta z zestawu = odłożone + alert; nieznany zestaw i obce konto też odłożone", async () => {
    const r1 = await przetworzWiadomoscSns(powiadomienie(zdarzenieSes("Bounce", { sesId: "0107sesz-powtorka-000000", cs: csA, zrodlo: "x@news.sesz-b.test" })), { alert });
    expect(r1.wynik).toBe("tenant_niezgodny");
    expect(alerty.some((a) => a.t.includes("spoza domen"))).toBe(true);
    const r2 = await przetworzWiadomoscSns(powiadomienie(zdarzenieSes("Bounce", { sesId: "0107sesz-powtorka-000000", cs: "midrev-t-nieznany", zrodlo: "x@news.sesz-a.test" })), { alert });
    expect(r2.wynik).toBe("nieznany_zestaw");
    const r3 = await przetworzWiadomoscSns(powiadomienie(zdarzenieSes("Bounce", { sesId: "0107sesz-powtorka-000000", cs: csA, zrodlo: "x@news.sesz-a.test", konto: "111111111111" })), { alert });
    expect(r3.wynik).toBe("zle_konto");
    const { rows } = await getPool().query("select count(*)::int as n from message_events where message_id = $1 and event_type = 'bounced'", [msg.powtorka]);
    expect(rows[0].n).toBe(0);
  });

  it("potwierdzenie subskrypcji: tylko SubscribeURL tego tematu na hoście SNS regionu", async () => {
    const potwierdz = vi.fn(async () => {});
    const baza = {
      Type: "SubscriptionConfirmation" as const,
      TopicArn: TEMAT,
      Message: "You have chosen to subscribe",
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2" as const,
      SigningCertURL: CERT_URL,
      Token: "tok123",
    };
    const zly = podpisz({ ...baza, MessageId: "sub-zly", SubscribeURL: `https://evil.test/?Action=ConfirmSubscription&TopicArn=${TEMAT}&Token=tok123` });
    expect((await przetworzWiadomoscSns(zly, { potwierdz, alert })).status).toBe(400);
    const innyTemat = podpisz({ ...baza, MessageId: "sub-inny", SubscribeURL: `https://sns.eu-north-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:eu-north-1:509758189751:inny&Token=tok123` });
    expect((await przetworzWiadomoscSns(innyTemat, { potwierdz, alert })).status).toBe(400);
    expect(potwierdz).not.toHaveBeenCalled();
    const dobry = podpisz({ ...baza, MessageId: "sub-dobry", SubscribeURL: `https://sns.eu-north-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TEMAT)}&Token=tok123` });
    expect(await przetworzWiadomoscSns(dobry, { potwierdz, alert })).toEqual({ status: 200, wynik: "potwierdzono" });
    expect(potwierdz).toHaveBeenCalledTimes(1);
    // wypisanie = alert krytyczny dla operatora
    const wyp = podpisz({ ...baza, Type: "UnsubscribeConfirmation", MessageId: "sub-wyp", SubscribeURL: dobry.SubscribeURL });
    await przetworzWiadomoscSns(wyp, { potwierdz, alert });
    expect(alerty.some((a) => a.p === "krytyczny" && a.t.includes("WYPISANY"))).toBe(true);
  });

  it("trasa /api/webhooks/ses: zły podpis 403, śmieci 400, poprawna wiadomość 200 (certyfikat z atrapy fetch)", async () => {
    const fetchOryginalny = globalThis.fetch;
    const pobrane: string[] = [];
    globalThis.fetch = (async (u: string | URL) => {
      pobrane.push(String(u));
      return new Response(CERT, { status: 200 });
    }) as typeof fetch;
    wyczyscPamiecCertyfikatow();
    try {
      const zadanie = (cialo: string, typ = "Notification") =>
        new NextRequest("http://localhost/api/webhooks/ses", { method: "POST", body: cialo, headers: { "x-amz-sns-message-type": typ, "content-type": "text/plain" } });
      expect((await POST(zadanie("nie json"))).status).toBe(400);
      const w = powiadomienie(zdarzenieSes("Delivery", { sesId: "0107sesz-skarga-000000", cs: csA, zrodlo: "newsletter@news.sesz-a.test" }));
      expect((await POST(zadanie(JSON.stringify({ ...w, Message: w.Message.replace("Delivery", "Bounce") })))).status).toBe(403);
      expect((await POST(zadanie(JSON.stringify(w), "SubscriptionConfirmation"))).status).toBe(400);
      const ok = await POST(zadanie(JSON.stringify(w)));
      expect(ok.status).toBe(200);
      expect(pobrane.every((u) => u === CERT_URL)).toBe(true);
    } finally {
      globalThis.fetch = fetchOryginalny;
    }
  });
});

describe("Konfiguracja SNS przez operatora", () => {
  afterAll(async () => {
    await closePool().catch(() => {});
  });

  it("dry-run nic nie woła; wykonanie zakłada temat z polityką i SignatureVersion 2", async () => {
    const ses = new AtrapaSes();
    const sns = new AtrapaSns();
    const plan = await skonfigurujZdarzeniaSes({ ses, sns, konto: KONTO, endpoint: "https://esp.midrev.pl/api/webhooks/ses", wykonaj: false });
    expect(plan.kroki.every((k) => k.stan === "plan")).toBe(true);
    expect(sns.tematy.size).toBe(0);
    const w = await skonfigurujZdarzeniaSes({ ses, sns, konto: KONTO, endpoint: "https://esp.midrev.pl/api/webhooks/ses", wykonaj: true });
    expect(w.topicArn).toBe(TEMAT);
    const atr = sns.tematy.get(TEMAT)!;
    expect(atr.SignatureVersion).toBe("2");
    expect(JSON.parse(atr.Policy).Statement[0]).toMatchObject({ Principal: { Service: "ses.amazonaws.com" }, Condition: { StringEquals: { "AWS:SourceAccount": KONTO } } });
    expect(sns.subskrypcje).toEqual([{ topicArn: TEMAT, endpoint: "https://esp.midrev.pl/api/webhooks/ses" }]);
  });

  it("cel zdarzeń bez skarg albo na obcy temat NIE jest uznany za kompletny", () => {
    expect(celKompletny({ wlaczony: true, topicArn: TEMAT, typy: ["BOUNCE", "COMPLAINT", "DELIVERY"] }, TEMAT)).toBe(true);
    expect(celKompletny({ wlaczony: true, topicArn: TEMAT, typy: ["BOUNCE", "DELIVERY"] }, TEMAT)).toBe(false);
    expect(celKompletny({ wlaczony: false, topicArn: TEMAT, typy: ["BOUNCE", "COMPLAINT", "DELIVERY"] }, TEMAT)).toBe(false);
    expect(celKompletny({ wlaczony: true, topicArn: "arn:aws:sns:eu-north-1:1:inny", typy: ["BOUNCE", "COMPLAINT", "DELIVERY"] }, TEMAT)).toBe(false);
  });

  it("brak uprawnień SNS: czytelny komunikat dla operatora i stop, bez dalszych kroków", async () => {
    const sns = new AtrapaSns();
    sns.bledy.set("utworzTemat", new BladAws("AuthorizationError", 403, "SNS CreateTopic: AuthorizationError"));
    const w = await skonfigurujZdarzeniaSes({ ses: new AtrapaSes(), sns, konto: KONTO, endpoint: "https://esp.midrev.pl/api/webhooks/ses", wykonaj: true });
    expect(w.kroki).toEqual([{ krok: "temat", stan: "brak_uprawnien", opis: expect.stringContaining("sns:CreateTopic") }]);
    const http = await skonfigurujZdarzeniaSes({ ses: new AtrapaSes(), sns: new AtrapaSns(), konto: KONTO, endpoint: "http://x.test", wykonaj: true });
    expect(http.kroki[0].stan).toBe("blad");
  });
});
