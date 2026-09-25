import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { Sekret } from "../src/adapters/crypto";
import { KlientImap } from "../src/adapters/email/imap";
import { hashAdresu } from "../src/adapters/hash-adresu";
import { anonimizujOdbicia, eksportujOdbicia, pobierzOdbicia, pozostaleDaneOdbic, przetworzRaport } from "../src/usecases/wysylka/odbicia";
import { wskaznikiReputacji } from "../src/usecases/wysylka/zaangazowanie";
import { zapiszSkrzynke, odczytajSkrzynke, testujSkrzynke, zaladujSkrzynke } from "../src/usecases/wysylka-konfiguracja/skrzynka-zwrotna";
import {
  gmailTwardeOdbicie,
  microsoftTwardeOdbicie,
  odpowiedzCzlowieka,
  postfixOpoznienie,
  postfixPelnaSkrzynka,
  qmailBezDsn,
  yahooSkarga,
} from "./dane/dsn-przyklady";

/**
 * Ścieżka zapisu odbić od skrzynki do bazy (audyt 24.09, #3). Baza prawdziwa (AD-20).
 * IMAP: prawdziwy klient (`KlientImap`, node:net) rozmawia z fałszywym serwerem IMAP
 * uruchomionym w teście — Mailpit nie generuje DSN, a prawdziwej skrzynki w sandboxie
 * nie ma. Serwer mówi tym samym dialektem co Dovecot/Gmail dla pięciu komend, których
 * używamy, i pamięta flagi \Seen, więc test sprawdza także, że odpowiedź człowieka
 * zostaje nieprzeczytana.
 */

interface MailNaSerwerze {
  uid: number;
  surowy: string;
  seen: boolean;
}

/** Minimalny serwer IMAP na potrzeby testu (bez TLS; klient dopuszcza to tylko dla hosta deweloperskiego). */
function falszywyImap(skrzynka: MailNaSerwerze[], opcje: { uidvalidity: number; haslo: string }): Promise<{ serwer: Server; port: number; logowania: string[] }> {
  const logowania: string[] = [];
  const serwer = createServer((s: Socket) => {
    s.write("* OK [CAPABILITY IMAP4rev1 LITERAL+] Fake IMAP ready\r\n");
    let bufor = Buffer.alloc(0);
    let oczekiwanyLiteral = 0;
    let liniaZLiteralem = "";
    let literaly: string[] = [];
    const wykonaj = (linia: string, lit: string[]) => {
      const m = /^(\S+) (.*)$/s.exec(linia);
      if (!m) return;
      const [, tag, reszta] = m;
      const komenda = reszta.trim();
      if (/^LOGIN\b/i.test(komenda)) {
        const [uzytkownik, haslo] = lit;
        logowania.push(`${uzytkownik}`);
        if (haslo === opcje.haslo && uzytkownik === "sklep@perf.example.test") s.write(`${tag} OK [CAPABILITY IMAP4rev1] Logged in\r\n`);
        else s.write(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`);
        return;
      }
      if (/^SELECT\b/i.test(komenda)) {
        s.write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* ${skrzynka.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${opcje.uidvalidity}] UIDs valid\r\n* OK [UIDNEXT ${skrzynka.length + 1}] Predicted next UID\r\n${tag} OK [READ-WRITE] Select completed.\r\n`);
        return;
      }
      const search = /^UID SEARCH UNSEEN UID (\d+):\*$/i.exec(komenda);
      if (search) {
        const od = Number(search[1]);
        const uidy = skrzynka.filter((w) => !w.seen && w.uid >= od).map((w) => w.uid);
        // RFC 3501: pusty zakres n:* przy n > max zwraca ostatni UID — symulujemy Dovecota
        if (uidy.length === 0 && od > Math.max(0, ...skrzynka.map((w) => w.uid)) && skrzynka.length) {
          const ostatni = skrzynka[skrzynka.length - 1];
          s.write(`* SEARCH${ostatni.seen ? "" : ` ${ostatni.uid}`}\r\n${tag} OK Search completed.\r\n`);
          return;
        }
        s.write(`* SEARCH${uidy.length ? " " + uidy.join(" ") : ""}\r\n${tag} OK Search completed.\r\n`);
        return;
      }
      const fetch = /^UID FETCH (\d+) \(UID INTERNALDATE RFC822\.SIZE BODY\.PEEK\[\]<0\.(\d+)>\)$/i.exec(komenda);
      if (fetch) {
        const w = skrzynka.find((x) => x.uid === Number(fetch[1]));
        if (!w) {
          s.write(`${tag} OK Fetch completed.\r\n`);
          return;
        }
        const bajty = Buffer.from(w.surowy, "utf8");
        const czesc = bajty.subarray(0, Number(fetch[2]));
        s.write(Buffer.concat([
          Buffer.from(`* ${skrzynka.indexOf(w) + 1} FETCH (UID ${w.uid} INTERNALDATE "24-Sep-2026 10:15:02 +0200" RFC822.SIZE ${bajty.length} BODY[]<0> {${czesc.length}}\r\n`),
          czesc,
          Buffer.from(`)\r\n${tag} OK Fetch completed.\r\n`),
        ]));
        return;
      }
      const store = /^UID STORE (\d+) \+FLAGS\.SILENT \(\\Seen\)$/i.exec(komenda);
      if (store) {
        const w = skrzynka.find((x) => x.uid === Number(store[1]));
        if (w) w.seen = true;
        s.write(`${tag} OK Store completed.\r\n`);
        return;
      }
      if (/^LOGOUT$/i.test(komenda)) {
        s.write(`* BYE Logging out\r\n${tag} OK Logout completed.\r\n`);
        s.end();
        return;
      }
      s.write(`${tag} BAD Unknown command\r\n`);
    };
    s.on("data", (d: Buffer) => {
      bufor = Buffer.concat([bufor, d]);
      for (;;) {
        if (oczekiwanyLiteral > 0) {
          if (bufor.length < oczekiwanyLiteral) return;
          literaly.push(bufor.subarray(0, oczekiwanyLiteral).toString("utf8"));
          bufor = bufor.subarray(oczekiwanyLiteral);
          oczekiwanyLiteral = 0;
          continue;
        }
        const i = bufor.indexOf("\r\n");
        if (i < 0) return;
        const linia = bufor.subarray(0, i).toString("utf8");
        bufor = bufor.subarray(i + 2);
        const lit = /\{(\d+)\}$/.exec(linia);
        if (lit) {
          oczekiwanyLiteral = Number(lit[1]);
          if (!liniaZLiteralem) liniaZLiteralem = linia.replace(/\s*\{\d+\}$/, "");
          s.write("+ OK\r\n");
          continue;
        }
        if (liniaZLiteralem) {
          wykonaj(liniaZLiteralem, literaly);
          liniaZLiteralem = "";
          literaly = [];
        } else {
          wykonaj(linia, []);
        }
      }
    });
  });
  return new Promise((resolve) => {
    serwer.listen(0, "127.0.0.1", () => {
      resolve({ serwer, port: (serwer.address() as { port: number }).port, logowania });
    });
  });
}

const HASLO = "tajne hasło \"IMAP\" ąę";

describe("Odbicia ze skrzynki zwrotnej: zapis do bazy", () => {
  let tenantId: string;
  let obcyTenantId: string;
  let campaignId: string;
  const msgid: Record<string, string> = {};
  const messageId: Record<string, string> = {};

  async function wiadomosc(nazwa: string, email: string, opcje: { tenant?: string; providerId?: boolean; kampania?: string } = {}) {
    const pool = getPool();
    const t = opcje.tenant ?? tenantId;
    // ten sam adres drugi raz w tym samym tenancie = ten sam profil (unikalność lower(btrim(email)))
    const p = await pool.query(
      `insert into profiles (tenant_id, email) values ($1, $2)
       on conflict (tenant_id, (lower(btrim(email)))) where email is not null do update set email = excluded.email
       returning id`,
      [t, email],
    );
    const m = await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token, current_state, current_rank, handed_off_at)
       values ($1, $2, 'campaign', $3, $4, 'Temat PERF', '<p>x</p>', $5, $6, 'sent', 2, now() - interval '1 hour') returning id`,
      [t, p.rows[0].id, opcje.kampania ?? campaignId, email, `dsn-klik-${nazwa}-${t.slice(0, 8)}`, `dsn-unsub-${nazwa}-${t.slice(0, 8)}`],
    );
    const id = m.rows[0].id as string;
    const providerId = `<${id}@perf.example.test>`;
    if (opcje.providerId !== false) await pool.query("update messages set provider_id = $2 where id = $1", [id, providerId]);
    await pool.query(
      "insert into message_events (tenant_id, message_id, event_type, occurred_at) values ($1, $2, 'sent', now() - interval '1 hour')",
      [t, id],
    );
    messageId[nazwa] = id;
    msgid[nazwa] = providerId;
  }

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'DSN %'");
    await pool.query("delete from suppressions where email like '%@gmail.com' and email like 'dsn-%'");
    tenantId = (await pool.query("insert into tenants (name) values ('DSN tenant') returning id")).rows[0].id;
    obcyTenantId = (await pool.query("insert into tenants (name) values ('DSN obcy') returning id")).rows[0].id;
    campaignId = (
      await pool.query(
        `insert into campaigns (tenant_id, name, subject, content, status) values ($1, 'DSN kampania', 'Temat PERF', $2, 'sent') returning id`,
        [tenantId, JSON.stringify({ html: "<p>x</p>" })],
      )
    ).rows[0].id;
    await wiadomosc("gmail", "dsn-nieistnieje@gmail.com");
    await wiadomosc("microsoft", "nikt@firma-klienta.pl");
    await wiadomosc("postfix", "pelna@skrzynka-klienta.pl");
    await wiadomosc("opoznienie", "wolny@serwer-lezy.pl");
    await wiadomosc("yahoo", "ktos@yahoo.com");
    await wiadomosc("qmail", "zly@stary-hosting.pl");
    // bez provider_id: dopasowanie musi pójść po adresie
    await wiadomosc("po_adresie", "po-adresie@example.test", { providerId: false });
    await wiadomosc("czlowiek", "jan@klient.pl");
  });

  afterAll(async () => {
    const pool = getPool();
    const adresy = ["dsn-nieistnieje@gmail.com", "nikt@firma-klienta.pl", "ktos@yahoo.com", "zly@stary-hosting.pl", "po-adresie@example.test"];
    // także zaślepki zanonimizowanych adresów: kasowanie tylko po email zostawiało je w bazie
    // i każdy następny przebieg padał na „globalne = 0”
    await pool.query("delete from suppressions where email = any($1) or email_hash = any($2)", [adresy, adresy.map(hashAdresu)]);
    await pool.query("delete from tenants where name like 'DSN %'");
    await closePool();
  });

  async function zdarzenia(id: string) {
    const { rows } = await getPool().query(
      "select event_type, bounce_class, bounce_category, smtp_code, add_exclusion, counts_to_rate, occurred_at from message_events where message_id = $1 order by occurred_at",
      [id],
    );
    return rows;
  }

  it("Gmail 5.1.1: zdarzenie bounced/hard z datą raportu, wykluczenie sklepowe i globalne", async () => {
    const { wyniki } = await przetworzRaport(tenantId, gmailTwardeOdbicie(msgid.gmail, "dsn-nieistnieje@gmail.com"));
    expect(wyniki).toHaveLength(1);
    expect(wyniki[0]).toMatchObject({ rodzaj: "dsn", wynik: "zapisane", messageId: messageId.gmail, dopasowanie: "message_id", typZdarzenia: "bounced", klasa: "hard", kodSmtp: "5.1.1" });
    const z = await zdarzenia(messageId.gmail);
    const odbicie = z.find((e) => e.event_type === "bounced");
    expect(odbicie).toMatchObject({ bounce_class: "hard", bounce_category: "invalid_address", smtp_code: "5.1.1", add_exclusion: true, counts_to_rate: true });
    // data ZE ŹRÓDŁA (Date raportu), nie z chwili zapisu
    expect(new Date(odbicie!.occurred_at).toISOString()).toBe("2026-09-24T08:15:02.000Z");
    const pool = getPool();
    const lokalne = await pool.query("select action, reason from tenant_suppressions where tenant_id = $1 and email = 'dsn-nieistnieje@gmail.com'", [tenantId]);
    expect(lokalne.rows[0]).toMatchObject({ action: "suppressed" });
    expect(lokalne.rows[0].reason).toMatch(/odbicie:invalid_address/);
    const globalne = await pool.query("select 1 from suppressions where email = 'dsn-nieistnieje@gmail.com'");
    expect(globalne.rowCount).toBe(1);
    const stan = await pool.query("select current_state from messages where id = $1", [messageId.gmail]);
    expect(stan.rows[0].current_state).toBe("bounced");
  });

  it("wykluczenie globalne z odbicia ma email_hash (0022) i nie dubluje wpisu po haszu", async () => {
    const pool = getPool();
    const { rows } = await pool.query("select email_hash, reason from suppressions where email = 'dsn-nieistnieje@gmail.com'");
    expect(rows).toHaveLength(1);
    expect(rows[0].email_hash).toBe(hashAdresu("dsn-nieistnieje@gmail.com"));
    // adres zanonimizowany siedzi na liście jako zaślepka z haszem: kolejne odbicie tego
    // adresu (inna wiadomość) nie może dopisać go drugi raz jawnie
    await pool.query("update suppressions set email = 'anonimizowano:' || left(email_hash, 16) where email = 'dsn-nieistnieje@gmail.com'");
    // ta sama osoba, INNA kampania: druga wiadomość do tego samego adresu (unikalność
    // wiadomości to tenant + źródło + profil, więc w tej samej kampanii byłby duplikat)
    const drugaKampania = (
      await pool.query(
        `insert into campaigns (tenant_id, name, subject, content, status) values ($1, 'DSN kampania 2', 'Temat PERF', $2, 'sent') returning id`,
        [tenantId, JSON.stringify({ html: "<p>x</p>" })],
      )
    ).rows[0].id;
    await wiadomosc("gmail2", "dsn-nieistnieje@gmail.com", { kampania: drugaKampania });
    await przetworzRaport(tenantId, gmailTwardeOdbicie(msgid.gmail2, "dsn-nieistnieje@gmail.com"));
    const po = await pool.query("select email from suppressions where email_hash = $1", [hashAdresu("dsn-nieistnieje@gmail.com")]);
    expect(po.rows).toHaveLength(1);
    expect(po.rows[0].email).toMatch(/^anonimizowano:/);
    await pool.query("delete from suppressions where email_hash = $1", [hashAdresu("dsn-nieistnieje@gmail.com")]);
    await pool.query("delete from messages where id = $1", [messageId.gmail2]);
  });

  it("spóźniony DSN do wiadomości już zanonimizowanej (RODO) nie wpisuje zaślepki na wykluczenia", async () => {
    const pool = getPool();
    await wiadomosc("rodo", "rodo-usuniety@example.test");
    await pool.query("update messages set email = 'usuniety@rodo.invalid' where id = $1", [messageId.rodo]);
    const { wyniki } = await przetworzRaport(tenantId, microsoftTwardeOdbicie(msgid.rodo, "rodo-usuniety@example.test"));
    expect(wyniki[0]).toMatchObject({ wynik: "zapisane", typZdarzenia: "bounced", klasa: "hard" });
    const lokalne = await pool.query("select 1 from tenant_suppressions where tenant_id = $1 and email in ('usuniety@rodo.invalid', 'rodo-usuniety@example.test')", [tenantId]);
    expect(lokalne.rowCount).toBe(0);
    const globalne = await pool.query("select 1 from suppressions where email in ('usuniety@rodo.invalid', 'rodo-usuniety@example.test')");
    expect(globalne.rowCount).toBe(0);
  });

  it("ten sam raport drugi raz nie tworzy drugiego zdarzenia ani drugiego wykluczenia", async () => {
    // Liczymy PRZYROST, a nie stan bezwzględny: ten sam adres może mieć legalnie drugie
    // wykluczenie z odbicia innej wiadomości (test „gmail2" z drugiej kampanii).
    const licz = async () =>
      (await getPool().query("select count(*)::int as ile from tenant_suppressions where tenant_id = $1 and email = 'dsn-nieistnieje@gmail.com'", [tenantId])).rows[0].ile as number;
    const przed = await licz();
    await przetworzRaport(tenantId, gmailTwardeOdbicie(msgid.gmail, "dsn-nieistnieje@gmail.com"));
    const z = await zdarzenia(messageId.gmail);
    expect(z.filter((e) => e.event_type === "bounced")).toHaveLength(1);
    expect(await licz()).toBe(przed);
  });

  it("Postfix 5.2.2 (pełna skrzynka): miękkie, BEZ wykluczenia adresu", async () => {
    const { wyniki } = await przetworzRaport(tenantId, postfixPelnaSkrzynka(msgid.postfix));
    expect(wyniki[0]).toMatchObject({ wynik: "zapisane", typZdarzenia: "bounced", klasa: "soft" });
    const odbicie = (await zdarzenia(messageId.postfix)).find((e) => e.event_type === "bounced");
    expect(odbicie).toMatchObject({ bounce_class: "soft", bounce_category: "mailbox_full", add_exclusion: false, counts_to_rate: false });
    const lokalne = await getPool().query("select 1 from tenant_suppressions where tenant_id = $1 and email = 'pelna@skrzynka-klienta.pl'", [tenantId]);
    expect(lokalne.rowCount).toBe(0);
  });

  it("Postfix opóźnienie 4.4.1: miękkie odbicie bez wykluczenia", async () => {
    const { wyniki } = await przetworzRaport(tenantId, postfixOpoznienie(msgid.opoznienie));
    expect(wyniki[0]).toMatchObject({ wynik: "zapisane", typZdarzenia: "bounced", klasa: "soft", kodSmtp: "4.4.1" });
  });

  it("Yahoo ARF: skarga wyklucza adres i wchodzi do wskaźnika skarg", async () => {
    const { wyniki } = await przetworzRaport(tenantId, yahooSkarga(msgid.yahoo));
    expect(wyniki[0]).toMatchObject({ rodzaj: "arf", wynik: "zapisane", typZdarzenia: "complained" });
    const skarga = (await zdarzenia(messageId.yahoo)).find((e) => e.event_type === "complained");
    expect(skarga).toMatchObject({ add_exclusion: true, counts_to_rate: true });
    expect(new Date(skarga!.occurred_at).toISOString()).toBe("2026-09-24T10:01:00.000Z");
    const globalne = await getPool().query("select 1 from suppressions where email = 'ktos@yahoo.com'");
    expect(globalne.rowCount).toBe(1);
  });

  it("dopasowanie po adresie, gdy raport nie niesie Message-ID, a wiadomość nie ma provider_id", async () => {
    const raport = postfixPelnaSkrzynka("<brak@nigdzie>", "po-adresie@example.test").replace(/^Message-ID: .*\r\n/m, "");
    const { wyniki } = await przetworzRaport(tenantId, raport);
    expect(wyniki[0]).toMatchObject({ wynik: "zapisane", messageId: messageId.po_adresie, dopasowanie: "adres" });
  });

  it("sfałszowany DSN bez Message-ID (dopasowanie po adresie) wyklucza adres TYLKO w sklepie, nigdy globalnie", async () => {
    const pool = getPool();
    await wiadomosc("ofiara", "ofiara@example.test", { providerId: false });
    // twarde odbicie 5.1.1 z adresem ofiary, bez żadnego Message-ID (skrzynka jest publiczna)
    const falszywy = gmailTwardeOdbicie("<x@y>", "ofiara@example.test")
      .replace(/^Message-ID: .*\r\n/gm, "")
      .replace(/^References: .*\r\n/m, "")
      .replace(/^In-Reply-To: .*\r\n/m, "")
      .replace(/^X-Original-Message-ID: .*\r\n/m, "");
    expect(falszywy).not.toContain("<x@y>");
    const { wyniki } = await przetworzRaport(tenantId, falszywy);
    expect(wyniki[0]).toMatchObject({ wynik: "zapisane", dopasowanie: "adres", klasa: "hard" });
    const lokalne = await pool.query("select 1 from tenant_suppressions where tenant_id = $1 and email = 'ofiara@example.test'", [tenantId]);
    expect(lokalne.rowCount).toBe(1);
    const globalne = await pool.query("select 1 from suppressions where email = 'ofiara@example.test'");
    expect(globalne.rowCount).toBe(0);
    await pool.query("delete from suppressions where email = 'ofiara@example.test'");
  });

  it("raport z cudzego tenanta (ten sam Message-ID) NIE trafia w wiadomość tego tenanta", async () => {
    const { wyniki } = await przetworzRaport(obcyTenantId, microsoftTwardeOdbicie(msgid.microsoft));
    expect(wyniki[0]).toMatchObject({ wynik: "brak_wiadomosci", messageId: null });
    expect((await zdarzenia(messageId.microsoft)).find((e) => e.event_type === "bounced")).toBeUndefined();
  });

  it("qmail bez DSN: heurystyka z kodem rozszerzonym zapisuje twarde odbicie; bez kodu rozszerzonego tylko rejestr", async () => {
    const { wyniki } = await przetworzRaport(tenantId, qmailBezDsn(msgid.qmail));
    expect(wyniki[0]).toMatchObject({ rodzaj: "heurystyka", wynik: "zapisane", klasa: "hard", kodSmtp: "5.1.1" });
    const bezKodu = qmailBezDsn(msgid.qmail).replace("(#5.1.1)", "(550)");
    const drugi = await przetworzRaport(tenantId, bezKodu);
    expect(drugi.wyniki[0].wynik).toBe("pominiete");
  });

  it("raport bez żadnej daty ze źródła jest odrzucany jako brak_daty, chyba że jest INTERNALDATE serwera", async () => {
    const bez = microsoftTwardeOdbicie(msgid.microsoft).replace(/^Date: .*\r\n/m, "").replace(/^Arrival-Date: .*\r\n/m, "");
    const a = await przetworzRaport(tenantId, bez);
    expect(a.wyniki[0].wynik).toBe("brak_daty");
    const b = await przetworzRaport(tenantId, bez, { dataZapasowa: new Date("2026-09-24T09:00:00Z") });
    expect(b.wyniki[0].wynik).toBe("zapisane");
    const odbicie = (await zdarzenia(messageId.microsoft)).find((e) => e.event_type === "bounced");
    expect(new Date(odbicie!.occurred_at).toISOString()).toBe("2026-09-24T09:00:00.000Z");
  });

  it("wskaźniki reputacji przy własnym SMTP liczą do PRZEKAZANYCH (sent), bo nikt nie raportuje delivered", async () => {
    const r = await wskaznikiReputacji(tenantId, 24 * 365);
    expect(r.dostarczone).toBe(0);
    expect(r.podstawa).toBe("sent");
    // 8 z beforeAll + ofiara + rodo (gmail2 usunięta razem ze zdarzeniami) = 10 przekazanych
    expect(r.wyslane).toBe(10);
    expect(r.mianownikOdbic).toBe(10);
    expect(r.mianownikSkarg).toBe(10);
    // twarde liczące się do wskaźnika: gmail, microsoft, qmail, ofiara, rodo = 5
    expect(r.odbiciaTwarde).toBe(5);
    expect(r.wskaznikOdbicTwardych).toBeCloseTo(5 / 10, 6);
    expect(r.skargi).toBe(1);
    expect(r.wskaznikSkarg).toBeCloseTo(1 / 10, 6);
  });

  describe("prawdziwy klient IMAP na fałszywym serwerze", () => {
    let serwer: Server;
    let port: number;
    let logowania: string[];
    let skrzynka: MailNaSerwerze[];
    let hosty: string[];

    beforeAll(async () => {
      skrzynka = [
        { uid: 1, surowy: odpowiedzCzlowieka(msgid.czlowiek), seen: false },
        { uid: 2, surowy: gmailTwardeOdbicie(msgid.gmail, "dsn-nieistnieje@gmail.com"), seen: false },
        { uid: 3, surowy: "From: a@b.c\r\nSubject: stare\r\n\r\nx", seen: true },
        { uid: 4, surowy: microsoftTwardeOdbicie(msgid.microsoft), seen: false },
      ];
      ({ serwer, port, logowania } = await falszywyImap(skrzynka, { uidvalidity: 4242, haslo: HASLO }));
      hosty = [`127.0.0.1:${port}`];
    });
    afterAll(() => new Promise<void>((r) => serwer.close(() => r())));

    function klient(haslo = HASLO) {
      return new KlientImap(
        { host: "127.0.0.1", port, bezpieczenstwo: "none", uzytkownik: "sklep@perf.example.test", haslo: new Sekret(haslo), skrzynka: "INBOX" },
        { hostyDeweloperskie: hosty, limitCzasuMs: 5000 },
      );
    }

    it("bramka SSRF: 127.0.0.1 poza listą deweloperską jest odrzucane, komunikat bez hasła", async () => {
      const k = new KlientImap(
        { host: "127.0.0.1", port, bezpieczenstwo: "tls", uzytkownik: "u", haslo: new Sekret(HASLO), skrzynka: "INBOX" },
        { hostyDeweloperskie: [] },
      );
      await expect(k.otworz()).rejects.toThrow(/adresem prywatnym|nie jest portem IMAP/);
      try {
        await k.otworz();
      } catch (b) {
        expect(String((b as Error).message)).not.toContain(HASLO);
      }
    });

    it("brak szyfrowania poza serwerem deweloperskim jest odrzucany przed wysłaniem hasła", async () => {
      const k = new KlientImap(
        { host: "127.0.0.1", port: 143, bezpieczenstwo: "none", uzytkownik: "u", haslo: new Sekret(HASLO), skrzynka: "INBOX" },
        { hostyDeweloperskie: [] },
      );
      await expect(k.otworz()).rejects.toThrow(/prywatnym|szyfrowane/);
    });

    it("złe hasło daje błąd logowania bez hasła w komunikacie", async () => {
      const k = klient("inne");
      await expect(k.otworz()).rejects.toThrow(/odrzucił login lub hasło/);
      await k.zamknij();
      expect(logowania.at(-1)).toBe("sklep@perf.example.test");
    });

    it("przebieg: DSN-y zapisane, odpowiedź człowieka zostaje nieprzeczytana, kursor przesunięty", async () => {
      // czyścimy skutki wcześniejszych testów dla tych dwóch wiadomości, żeby przebieg
      // udowodnił zapis od zera
      const pool = getPool();
      await pool.query("delete from message_events where message_id = any($1) and event_type = 'bounced'", [[messageId.gmail, messageId.microsoft]]);
      await pool.query("update messages set current_state = 'sent', current_rank = 2 where id = any($1)", [[messageId.gmail, messageId.microsoft]]);

      const k = klient();
      const p = await pobierzOdbicia(tenantId, k, { uidvalidity: null, ostatniUid: null });
      await k.zamknij();
      expect(p.uidvalidity).toBe(4242);
      expect(p.przejrzane).toBe(3); // uid 1, 2, 4 (3 była przeczytana)
      expect(p.zapisane).toBe(2);
      expect(p.nieOdbicia).toBe(1);
      expect(p.ostatniUid).toBe(4);
      expect(skrzynka.map((w) => w.seen)).toEqual([false, true, true, true]);

      const { rows } = await pool.query(
        "select imap_uid, kind, outcome, matched_message_id, recipient, event_type, bounce_class from bounce_reports where tenant_id = $1 and imap_uidvalidity = 4242 order by imap_uid",
        [tenantId],
      );
      expect(rows).toMatchObject([
        { imap_uid: "1", kind: "nie_odbicie", outcome: "nie_odbicie", matched_message_id: null },
        { imap_uid: "2", kind: "dsn", outcome: "zapisane", matched_message_id: messageId.gmail, recipient: "dsn-nieistnieje@gmail.com", event_type: "bounced", bounce_class: "hard" },
        { imap_uid: "4", kind: "dsn", outcome: "zapisane", matched_message_id: messageId.microsoft, event_type: "bounced", bounce_class: "hard" },
      ]);
      expect((await zdarzenia(messageId.microsoft)).find((e) => e.event_type === "bounced")).toBeTruthy();
    });

    it("drugi przebieg od kursora nic nie przetwarza; nowy mail po kursorze wchodzi; zmiana UIDVALIDITY zeruje kursor", async () => {
      const k = klient();
      const p = await pobierzOdbicia(tenantId, k, { uidvalidity: 4242, ostatniUid: 4 });
      await k.zamknij();
      expect(p.przejrzane).toBe(0);
      expect(p.zapisane).toBe(0);

      skrzynka.push({ uid: 5, surowy: postfixPelnaSkrzynka(msgid.postfix), seen: false });
      const k2 = klient();
      const p2 = await pobierzOdbicia(tenantId, k2, { uidvalidity: 4242, ostatniUid: 4 });
      await k2.zamknij();
      expect(p2.przejrzane).toBe(1);
      expect(p2.ostatniUid).toBe(5);

      // kursor z inną UIDVALIDITY (np. po odtworzeniu skrzynki) = czytamy od zera. Serwer
      // ma nadal 4242, więc druga warstwa idempotencji (bounce_reports per UIDVALIDITY+UID)
      // pomija uid 1 (człowiek, wciąż nieprzeczytany) bez ponownego pobierania; zdarzenia
      // są unikalne per wiadomość, więc nic nie liczy się podwójnie
      const k3 = klient();
      const p3 = await pobierzOdbicia(tenantId, k3, { uidvalidity: 1, ostatniUid: 99 });
      await k3.zamknij();
      expect(p3.przejrzane).toBe(0);
      expect(p3.ostatniUid).toBe(1);
      expect(skrzynka[0].seen).toBe(false);
      expect((await zdarzenia(messageId.gmail)).filter((e) => e.event_type === "bounced")).toHaveLength(1);
    });

    it("RODO: eksport i anonimizacja raportów tej osoby (po wiadomości i po adresie), z kontrolą zwrotną", async () => {
      const pool = getPool();
      const profil = (await pool.query("select profile_id from messages where id = $1", [messageId.gmail])).rows[0].profile_id;
      const przed = await eksportujOdbicia(tenantId, profil, "dsn-nieistnieje@gmail.com");
      expect(przed.length).toBeGreaterThanOrEqual(1);
      expect(przed[0]).toMatchObject({ adres: "dsn-nieistnieje@gmail.com", rodzaj: "dsn", typZdarzenia: "bounced" });
      expect(przed[0].temat).toContain("Delivery Status Notification");
      // raport innej osoby zostaje nietknięty
      const cudze = (await pool.query("select count(*)::int as ile from bounce_reports where tenant_id = $1 and recipient = 'nikt@firma-klienta.pl'", [tenantId])).rows[0].ile;
      expect(cudze).toBeGreaterThanOrEqual(1);

      const zmienione = await anonimizujOdbicia(tenantId, profil, "dsn-nieistnieje@gmail.com");
      expect(zmienione).toBe(przed.length);
      expect(await pozostaleDaneOdbic(tenantId, profil, "dsn-nieistnieje@gmail.com")).toBe(0);
      const po = await pool.query("select recipient, subject, original_message_id from bounce_reports where tenant_id = $1 and matched_message_id = $2", [tenantId, messageId.gmail]);
      expect(po.rows.every((r) => r.recipient === "usuniety@rodo.invalid" && r.subject === "[usunięto]" && r.original_message_id === null)).toBe(true);
      expect((await pool.query("select count(*)::int as ile from bounce_reports where tenant_id = $1 and recipient = 'nikt@firma-klienta.pl'", [tenantId])).rows[0].ile).toBe(cudze);
      // drugi przebieg nic nie zmienia (idempotentny)
      expect(await anonimizujOdbicia(tenantId, profil, "dsn-nieistnieje@gmail.com")).toBe(0);
    });

    it("konfiguracja skrzynki: zapis z bramką SSRF, hasło zaszyfrowane, widok bez hasła, test przez use-case", async () => {
      const pool = getPool();
      await pool.query("insert into sending_domains (tenant_id, domain) values ($1, 'perf.example.test') on conflict do nothing", [tenantId]);
      const domena = await pool.query("select id from sending_domains where tenant_id = $1 and domain = 'perf.example.test'", [tenantId]);
      await pool.query(
        `insert into tenant_smtp_configs (tenant_id, sending_domain_id, host, port, security, from_name, from_email)
         values ($1, $2, '127.0.0.1', 1025, 'none', 'PERF', 'sklep@perf.example.test') on conflict (tenant_id) do nothing`,
        [tenantId, domena.rows[0].id],
      );
      const prywatny = await zapiszSkrzynke(tenantId, { host: "10.0.0.5", port: "993", bezpieczenstwo: "tls", uzytkownik: "u", noweHaslo: "x", skrzynka: "INBOX" });
      expect(prywatny).toMatchObject({ ok: false });
      expect((prywatny as { blad: string }).blad).toMatch(/prywatnym/);
      const zlyPort = await zapiszSkrzynke(tenantId, { host: "imap.gmail.com", port: "5433", bezpieczenstwo: "tls", uzytkownik: "u", noweHaslo: "x", skrzynka: "INBOX" }, { lookup: async () => [{ address: "142.250.1.1", family: 4 }] });
      expect((zlyPort as { blad: string }).blad).toMatch(/nie jest portem IMAP/);

      // host deweloperski z testu nie jest w .env, więc zapis przez use-case go odrzuci;
      // sprawdzamy zapis na publicznym hoście z podstawionym DNS, a test połączenia — na fałszywym serwerze przez zaladuj
      const zapis = await zapiszSkrzynke(
        tenantId,
        { host: "imap.perf.example.test", port: "993", bezpieczenstwo: "tls", uzytkownik: "sklep@perf.example.test", noweHaslo: HASLO, skrzynka: "INBOX" },
        { lookup: async () => [{ address: "203.0.114.7", family: 4 }] },
      );
      expect(zapis).toEqual({ ok: true });
      const widok = await odczytajSkrzynke(tenantId);
      expect(widok).toMatchObject({ host: "imap.perf.example.test", port: 993, hasloUstawione: true, uzytkownik: "sklep@perf.example.test" });
      expect(JSON.stringify(widok)).not.toContain(HASLO);
      const { rows } = await pool.query("select bounce_imap_password_encrypted from tenant_smtp_configs where tenant_id = $1", [tenantId]);
      expect(rows[0].bounce_imap_password_encrypted.toString("utf8")).not.toContain("tajne");
      const zaladowana = await zaladujSkrzynke(tenantId);
      expect(zaladowana?.polaczenieSprawdzone).toBe(false);
      expect(JSON.stringify(zaladowana)).not.toContain(HASLO);
      const test = await testujSkrzynke(tenantId, { lookup: async () => [{ address: "203.0.114.7", family: 4 }], limitCzasuMs: 1500 });
      // 203.0.114.7 nie odpowiada: test nie przechodzi, a komunikat nie zawiera hasła
      expect(test.ok).toBe(false);
      expect(JSON.stringify(test)).not.toContain(HASLO);
    }, 15_000);
  });
});
