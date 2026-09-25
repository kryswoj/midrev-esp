import { randomBytes, randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { BladHostaSmtp } from "../src/adapters/email/bezpieczny-host";
import { AdapterNodemailer, bladWysylki } from "../src/adapters/email/nodemailer";
import { Sekret } from "../src/adapters/crypto";
import type { DostawcaWysylki, Wiadomosc, WynikWysylki } from "../src/domain/email/port";
import { linkiSledzone } from "../src/domain/email/bloki";
import { odzyskajZombie } from "../src/jobs/partycje";
import { dodajDomene } from "../src/usecases/wysylka-konfiguracja/domeny";
import { wybierzWysylke } from "../src/usecases/wysylka-konfiguracja/nadawca";
import { testujSerwer, zapiszSerwer } from "../src/usecases/wysylka-konfiguracja/serwer";
import { rekoncyliacjaWysylki } from "../src/usecases/wysylka/rekoncyliacja";
import { przepiszLinki } from "../src/usecases/wysylka/renderuj";
import { wznowWysylkeTenanta } from "../src/usecases/wysylka/reputacja";
import { wyslijPartie, zbudujWiadomosciKampanii } from "../src/usecases/wysylka/wyslij-kampanie";

/**
 * Triaż A (review adwersaryjny: wyścigi i transakcje) — decyzje P1–P3 wdrożone w silniku
 * wysyłki. Każda zmiana w partiach ma tu test na wyścig dwóch workerów, a każda asercja
 * czyta ZAPISANY rekord (stan wiadomości, zdarzenia `sent`, joby), nie licznik przebiegu.
 * Baza prawdziwa (AD-20); dostawca to atrapa portu (AD-7).
 */

function blad(pola: Record<string, unknown>): Error {
  return Object.assign(new Error(String(pola.message ?? "blad")), pola);
}

class Atrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa-triaz";
  wyslane: string[] = [];
  constructor(private readonly zachowanie: (w: Wiadomosc, n: number) => Promise<void> = async () => {}) {}
  async wyslij(w: Wiadomosc): Promise<WynikWysylki> {
    await this.zachowanie(w, this.wyslane.length);
    this.wyslane.push(w.do);
    return { providerId: `<${w.idempotencyKey}@atrapa>` };
  }
}

const tok = () => randomBytes(18).toString("base64url");

/** Alerty idą przez console.error (ALERT_WEBHOOK_URL pusty w sandboksie): zbieramy linie `[alert]`. */
function zbierajAlerty() {
  const linie: string[] = [];
  const szpieg = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    linie.push(a.map(String).join(" "));
  });
  return {
    stop: () => szpieg.mockRestore(),
    krytyczne: (tenantId: string) => linie.filter((l) => l.startsWith("[alert] [KRYTYCZNY]") && l.includes(tenantId)),
  };
}

async function wstawWiadomosci(tenantId: string, prefiks: string, ile: number): Promise<string[]> {
  const pool = getPool();
  const adresy: string[] = [];
  for (let i = 0; i < ile; i++) {
    const email = `${prefiks}-${String(i).padStart(3, "0")}@example.test`;
    adresy.push(email);
    await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
       values ($1, null, 'test', $2, $3, 'T', '<p>x</p>', $4, $5)`,
      [tenantId, randomUUID(), email, tok(), tok()],
    );
  }
  return adresy;
}

async function stanWiadomosci(tenantId: string, prefiks: string) {
  const { rows } = await getPool().query(
    `select m.email, m.current_state, m.attempts, m.claimed_at,
            (select count(*)::int from message_events e where e.message_id = m.id and e.event_type = 'sent') as sent,
            (select count(*)::int from message_events e where e.message_id = m.id and e.event_type = 'held') as held
       from messages m where m.tenant_id = $1 and m.email like $2 order by m.email`,
    [tenantId, `${prefiks}-%`],
  );
  return rows as { email: string; current_state: string; attempts: number; claimed_at: Date | null; sent: number; held: number }[];
}

// ---------------------------------------------------------------------------
// P1 #1: błąd nadawcy nie robi lawiny `held`
// ---------------------------------------------------------------------------

describe("adapter nodemailer: klasyfikacja błędu nadawcy (P1 #1) i pula bez własnych ponowień (P2 #5)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("AUTH 535, EHLO, STARTTLS, MAIL FROM 421, API i DNS hosta dostają kod ENADAWCA; RCPT/DATA i gniazdo nie", () => {
    const kod = (e: Error) => (e as Error & { code?: string }).code;
    expect(kod(bladWysylki(blad({ message: "Invalid login: 535 5.7.8 Username and Password not accepted", code: "EAUTH", command: "AUTH PLAIN", responseCode: 535, response: "535 5.7.8 Username and Password not accepted" })))).toBe("ENADAWCA");
    expect(kod(bladWysylki(blad({ message: "Missing credentials", code: "EAUTH", command: "API" })))).toBe("ENADAWCA");
    expect(kod(bladWysylki(blad({ message: "Server terminates connection", code: "ECONNECTION", command: "EHLO", response: "421 bye" })))).toBe("ENADAWCA");
    expect(kod(bladWysylki(blad({ message: "Error upgrading connection with STARTTLS", code: "ETLS", command: "STARTTLS" })))).toBe("ENADAWCA");
    expect(kod(bladWysylki(blad({ message: "Mail command failed: 421 4.7.0 Try again later", code: "EENVELOPE", command: "MAIL FROM", responseCode: 421, response: "421 4.7.0 Try again later, closing connection" })))).toBe("ENADAWCA");
    expect(kod(bladWysylki(blad({ message: "Mail command failed: 432 4.7.12", code: "EENVELOPE", command: "MAIL FROM", responseCode: 432, response: "432 4.7.12 A password transition is needed" })))).toBe("ENADAWCA");
    expect(kod(bladWysylki(blad({ message: "Connection is closed", code: "ECONNECTION", command: "API" })))).toBe("ENADAWCA");
    expect(kod(bladWysylki(blad({ message: "Greeting never received", code: "ETIMEDOUT", command: "CONN" })))).toBe("ENADAWCA");
    expect(kod(bladWysylki(new BladHostaSmtp("dns", "Nie udało się ustalić adresu serwera")))).toBe("ENADAWCA");
    // review A2 #1: dławienie w powitaniu (Google/M365) i zamknięcie przed powitaniem w puli
    expect(kod(bladWysylki(blad({ message: "Invalid greeting. response=421 4.7.0 Too many connections: 421 4.7.0 Too many connections", code: "EPROTOCOL", command: "CONN", responseCode: 421, response: "421 4.7.0 Too many connections" })))).toBe("ENADAWCA");
    expect(kod(bladWysylki(blad({ message: "Invalid greeting. response=421 4.3.2 Service not available: 421 4.3.2 Service not available", code: "EPROTOCOL", command: "CONN", responseCode: 421, response: "421 4.3.2 Service not available" })))).toBe("ENADAWCA");
    expect(kod(bladWysylki(new Error("Reached maximum number of retries after connection was closed")))).toBe("ENADAWCA");
    expect(kod(bladWysylki(new Error("Unexpected socket close")))).toBe("ENADAWCA");
    // zamknięcie w trakcie rozmowy (np. po DATA) — nodemailer daje ECONNECTION/CONN: NIE nadawca
    expect(kod(bladWysylki(blad({ message: "Connection closed unexpectedly: 421 4.4.2 closing", code: "ECONNECTION", command: "CONN", response: "421 4.4.2 closing" })))).toBeUndefined();
    // inny EPROTOCOL przy CONN (nieoczekiwana odpowiedź w trakcie) — NIE nadawca
    expect(kod(bladWysylki(blad({ message: "Unexpected Response", code: "EPROTOCOL", command: "CONN" })))).toBeUndefined();

    // rozmiar wiadomości przy MAIL FROM to sprawa TEJ wiadomości — inaczej zablokowałaby kolejkę na zawsze
    expect(kod(bladWysylki(blad({ message: "Message size larger than allowed 1000", code: "EMESSAGE", command: "MAIL FROM" })))).toBeUndefined();
    // odbiorca: klasyfikacja z kodu odpowiedzi, nie błąd nadawcy
    const rcpt = bladWysylki(blad({ message: "Recipient command failed", code: "EENVELOPE", command: "RCPT TO", responseCode: 550, response: "550 5.1.1 no such user" }));
    expect(kod(rcpt)).toBeUndefined();
    expect(rcpt.message).toContain("dostano: 550 5.1.1");
    // odmowa zestawienia TCP: przejściowy kod gniazda
    expect(kod(bladWysylki(blad({ message: "connect ECONNREFUSED 10.0.0.1:587", code: "ESOCKET", command: "CONN" })))).toBe("ECONNREFUSED");
    // błąd gniazda PO kropce DATA z kodem w środku komunikatu: NIE przejściowy (mail mógł wyjść)
    expect(kod(bladWysylki(blad({ message: "read ECONNRESET after DATA; upstream said ECONNREFUSED", code: "ESOCKET", command: "CONN" })))).toBeUndefined();
    // timeout gniazda w trakcie rozmowy: nieznany
    expect(kod(bladWysylki(blad({ message: "Timeout", code: "ETIMEDOUT", command: "CONN" })))).toBeUndefined();
  });

  it("pula: jedno połączenie i maxRequeues 0; odmowa AUTH przez adapter wychodzi jako ENADAWCA bez hasła", async () => {
    const HASLO = "tajne-haslo-smtp-XYZ";
    const opcjeTransportu: Record<string, unknown>[] = [];
    vi.spyOn(nodemailer, "createTransport").mockImplementation(((opcje: Record<string, unknown>) => {
      opcjeTransportu.push(opcje);
      return {
        sendMail: async () => {
          throw blad({ message: "Invalid login: 535 5.7.8 Username and Password not accepted", code: "EAUTH", command: "AUTH PLAIN", responseCode: 535, response: "535 5.7.8 Username and Password not accepted" });
        },
        close: () => {},
      };
    }) as unknown as typeof nodemailer.createTransport);
    const adapter = new AdapterNodemailer(
      { host: "127.0.0.1", port: 1025, bezpieczenstwo: "none", uzytkownik: "sklep", haslo: new Sekret(HASLO) },
      { hostyDeweloperskie: ["127.0.0.1:1025"] },
    );
    const proba = adapter.wyslij({ do: "a@example.test", od: "sklep@example.test", temat: "T", html: "<p>x</p>", adresWypisania: "https://x.test/u/1", idempotencyKey: randomUUID() });
    await expect(proba).rejects.toMatchObject({ code: "ENADAWCA" });
    await proba.catch((e: Error) => {
      expect(e.message).toContain("535 5.7.8");
      expect(e.message).not.toContain(HASLO);
    });
    // review A2 #9: zły adres nadawcy/odpowiedzi = błąd nadawcy; zły odbiorca = trwała odmowa (5xx)
    const baza = { do: "a@example.test", od: "sklep@example.test", temat: "T", html: "<p>x</p>", adresWypisania: "https://x.test/u/1", idempotencyKey: randomUUID() };
    await expect(adapter.wyslij({ ...baza, od: "sklep@example.test,inny@example.test" })).rejects.toMatchObject({ code: "ENADAWCA" });
    await expect(adapter.wyslij({ ...baza, odpowiedzDo: "zly adres@example.test" })).rejects.toMatchObject({ code: "ENADAWCA" });
    const odbiorca = adapter.wyslij({ ...baza, do: "a@example.test;b@example.test" });
    await expect(odbiorca).rejects.toThrow(/dostano: 553 5\.1\.3/);
    await odbiorca.catch((e: Error & { code?: string }) => expect(e.code).toBe("EADRES_ODBIORCY"));
    await adapter.zamknij();
    expect(opcjeTransportu).toHaveLength(1);
    expect(opcjeTransportu[0]).toMatchObject({ pool: true, maxConnections: 1, maxRequeues: 0 });
  });
});

describe("silnik: błąd nadawcy, zegar próby, wznowienie sklepu, budowa porcjami", () => {
  let tenantId: string;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'TRA %'");
    tenantId = (await pool.query("insert into tenants (name) values ('TRA tenant') returning id")).rows[0].id;
    // serwer klienta na jawnym serwerze deweloperskim (Mailpit): ta sama ścieżka wyboru
    // nadawcy co w produkcji, z wstrzykniętą atrapą zamiast transportu
    expect((await dodajDomene(tenantId, { domena: "tra-sklep.test", selektorDkim: "", mechanizmSpf: "" })).ok).toBe(true);
    expect(
      await zapiszSerwer(tenantId, {
        host: "127.0.0.1", port: "1025", bezpieczenstwo: "none", uzytkownik: "", noweHaslo: "", usunHaslo: false,
        nazwaNadawcy: "Sklep TRA", adresNadawcy: "newsletter@tra-sklep.test", odpowiedzDo: "",
      }),
    ).toEqual({ ok: true });
    expect((await testujSerwer(tenantId)).ok).toBe(true);
    await pool.query("insert into tenant_send_limits (tenant_id, daily_limit) values ($1, 100000) on conflict (tenant_id) do update set daily_limit = 100000", [tenantId]);
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like 'TRA %'");
    await closePool();
  });

  it("P1 #1: ENADAWCA w środku partii — zero held, zero zużytych prób, reszta w queued, cache testu unieważniony, miejsce w limicie zwrócone, alert krytyczny", async () => {
    const pool = getPool();
    await wstawWiadomosci(tenantId, "tra-nadawca", 5);
    const uzycie = async () => (await pool.query("select coalesce(sum(used), 0)::int as used from tenant_send_usage where tenant_id = $1", [tenantId])).rows[0].used as number;
    const uzyciePrzed = await uzycie();
    const dostawca = new Atrapa(async (_w, n) => {
      if (n === 1) throw blad({ message: "SMTP: błąd nadawcy: Serwer odrzucił login lub hasło. 535 5.7.8", code: "ENADAWCA" });
    });
    const alerty = zbierajAlerty();
    const wynik = await wyslijPartie(tenantId, { dostawca, limit: 10 });
    alerty.stop();
    // jedna wysłana zużyła miejsce; cofnięta wiadomość swoje oddała (review A2 #2)
    expect(await uzycie()).toBe(uzyciePrzed + 1);
    // alert krytyczny z tenantem, raz (review A2 #3)
    expect(alerty.krytyczne(tenantId)).toHaveLength(1);
    expect(alerty.krytyczne(tenantId)[0]).toContain("535 5.7.8");
    expect(wynik).toMatchObject({ wyslane: 1, bledy: 1, powodZatrzymania: "blokada_nadawcy" });
    expect(wynik.powodOpis).toContain("535 5.7.8");
    // pierwsza wyszła, druga rzuciła, trzecia–piąta nie dotarły do dostawcy
    expect(dostawca.wyslane).toHaveLength(1);

    const stan = await stanWiadomosci(tenantId, "tra-nadawca");
    expect(stan.filter((w) => w.current_state === "sent")).toHaveLength(1);
    expect(stan.filter((w) => w.current_state === "queued")).toHaveLength(4);
    expect(stan.every((w) => w.held === 0)).toBe(true);
    expect(stan.every((w) => w.attempts === 0)).toBe(true);
    expect(stan.filter((w) => w.current_state === "queued").every((w) => w.claimed_at === null)).toBe(true);
    const { rows: rank } = await pool.query("select distinct current_rank from messages where tenant_id = $1 and current_state = 'queued'", [tenantId]);
    expect(rank.map((r) => r.current_rank)).toEqual([0]);

    const { rows: cfg } = await pool.query("select last_tested_at, last_test_error from tenant_smtp_configs where tenant_id = $1", [tenantId]);
    expect(cfg[0].last_tested_at).toBeNull();
    expect(cfg[0].last_test_error).toContain("535 5.7.8");

    // unieważniony cache = następny wybór wysyłki robi PRAWDZIWY verify() (tu: Mailpit)
    // przed zajęciem partii, zamiast ufać wynikowi sprzed błędu
    const wybor = await wybierzWysylke(tenantId);
    expect(wybor.rodzaj).toBe("serwer_klienta");
    await (wybor as { dostawca?: DostawcaWysylki }).dostawca?.zamknij?.();
    const { rows: cfgPo } = await pool.query("select last_tested_at, last_test_error from tenant_smtp_configs where tenant_id = $1", [tenantId]);
    expect(cfgPo[0].last_tested_at).not.toBeNull();
    expect(cfgPo[0].last_test_error).toBeNull();

    // po naprawie następna partia wysyła resztę dokładnie raz
    const zdrowy = new Atrapa();
    const dalej = await wyslijPartie(tenantId, { dostawca: zdrowy, limit: 10 });
    expect(dalej).toMatchObject({ wyslane: 4, bledy: 0, powodZatrzymania: null });
    const wszystkie = [...dostawca.wyslane, ...zdrowy.wyslane].sort();
    expect(wszystkie).toEqual(stan.map((w) => w.email));
    const po = await stanWiadomosci(tenantId, "tra-nadawca");
    expect(po.every((w) => w.current_state === "sent" && w.sent === 1 && w.attempts === 0)).toBe(true);
  });

  it("P1 #1, wyścig dwóch workerów: błąd nadawcy u A cofa TYLKO partię A, B wysyła swoją, nic nie wychodzi dwa razy", async () => {
    await wstawWiadomosci(tenantId, "tra-dwaj", 20);
    const opoznij = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const a = new Atrapa(async (_w, n) => {
      await opoznij(5);
      if (n === 1) throw blad({ message: "SMTP: błąd nadawcy: 421 4.7.0 Try again later", code: "ENADAWCA" });
    });
    const b = new Atrapa(async () => {
      await opoznij(15);
    });
    const alerty = zbierajAlerty();
    const [wa, wb] = await Promise.all([
      wyslijPartie(tenantId, { dostawca: a, limit: 10 }),
      wyslijPartie(tenantId, { dostawca: b, limit: 10 }),
    ]);
    alerty.stop();
    expect(wa.powodZatrzymania).toBe("blokada_nadawcy");
    expect(wb).toMatchObject({ wyslane: 10, bledy: 0 });
    // dławik: ta sama konfiguracja, niecała godzina od poprzedniego alertu — cisza
    expect(alerty.krytyczne(tenantId)).toHaveLength(0);
    const c = new Atrapa();
    await wyslijPartie(tenantId, { dostawca: c, limit: 50 });
    const wszystkie = [...a.wyslane, ...b.wyslane, ...c.wyslane].sort();
    const stan = await stanWiadomosci(tenantId, "tra-dwaj");
    expect(wszystkie).toEqual(stan.map((w) => w.email));
    expect(new Set(wszystkie).size).toBe(20);
    expect(stan.every((w) => w.current_state === "sent" && w.sent === 1 && w.held === 0 && w.attempts === 0)).toBe(true);
  });

  it("review A2 #8 i #3: spóźniony błąd nadawcy nie nadpisuje testu NOWEJ konfiguracji; zmiana konfiguracji odblokowuje alert", async () => {
    const pool = getPool();
    await wstawWiadomosci(tenantId, "tra-wersja", 2);
    const dostawca = new Atrapa(async () => {
      // w trakcie rozmowy z SMTP operator zapisuje i testuje NOWĄ konfigurację
      await pool.query(
        "update tenant_smtp_configs set updated_at = clock_timestamp(), last_tested_at = clock_timestamp(), last_test_error = null where tenant_id = $1",
        [tenantId],
      );
      throw blad({ message: "SMTP: błąd nadawcy: 535 5.7.8 stare hasło", code: "ENADAWCA" });
    });
    const alerty = zbierajAlerty();
    const w = await wyslijPartie(tenantId, { dostawca, limit: 10 });
    alerty.stop();
    expect(w.powodZatrzymania).toBe("blokada_nadawcy");
    const { rows } = await pool.query("select last_tested_at, last_test_error from tenant_smtp_configs where tenant_id = $1", [tenantId]);
    expect(rows[0].last_tested_at).not.toBeNull();
    expect(rows[0].last_test_error).toBeNull();
    // konfiguracja zmieniona po ostatnim alercie: nowy alert mimo dławika godzinnego
    expect(alerty.krytyczne(tenantId)).toHaveLength(1);
    await wyslijPartie(tenantId, { dostawca: new Atrapa(), limit: 10 });
    expect((await stanWiadomosci(tenantId, "tra-wersja")).every((m) => m.current_state === "sent" && m.attempts === 0)).toBe(true);
  });

  it("review A2: serwer leży (ECONNREFUSED) — partia wraca do kolejki bez zużycia prób, nie idzie w failed", async () => {
    await wstawWiadomosci(tenantId, "tra-odmowa", 4);
    const lezy = new Atrapa(async () => {
      throw blad({ message: "SMTP: connect ECONNREFUSED 10.0.0.1:587", code: "ECONNREFUSED" });
    });
    // sześć przebiegów pod rząd: dawniej po pięciu wszystko było w failed
    for (let i = 0; i < 6; i++) {
      const w = await wyslijPartie(tenantId, { dostawca: lezy, limit: 10 });
      expect(w).toMatchObject({ wyslane: 0, bledy: 1, powodZatrzymania: "blokada_nadawcy" });
    }
    const stan = await stanWiadomosci(tenantId, "tra-odmowa");
    expect(stan.every((m) => m.current_state === "queued" && m.attempts === 0 && m.held === 0)).toBe(true);
    await wyslijPartie(tenantId, { dostawca: new Atrapa(), limit: 10 });
    expect((await stanWiadomosci(tenantId, "tra-odmowa")).every((m) => m.current_state === "sent" && m.sent === 1)).toBe(true);
  });

  it("review A2 #9: niepoprawny adres odbiorcy w prawdziwym adapterze to dropped (trwała odmowa), nie sending/held", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
       values ($1, null, 'test', $2, 'tra-zly,adres@example.test', 'T', '<p>x</p>', $3, $4) returning id`,
      [tenantId, randomUUID(), tok(), tok()],
    );
    // bez wstrzykniętego dostawcy: serwer klienta z konfiguracji (Mailpit), prawdziwy AdapterNodemailer
    const w = await wyslijPartie(tenantId, { limit: 10 });
    expect(w).toMatchObject({ wyslane: 0, bledy: 1, powodZatrzymania: null });
    const { rows: m } = await pool.query(
      `select m.current_state, e.bounce_class, e.smtp_code
         from messages m left join message_events e on e.message_id = m.id and e.event_type = 'dropped'
        where m.id = $1`,
      [rows[0].id],
    );
    expect(m[0]).toMatchObject({ current_state: "dropped", smtp_code: "5.1.3" });
    // sklepowe wykluczenie jest (widoczne w panelu), globalnego nie ma: to nasza walidacja, nie dowód od serwera
    expect((await pool.query("select 1 from tenant_suppressions where tenant_id = $1 and email = 'tra-zly,adres@example.test'", [tenantId])).rowCount).toBe(1);
    const globalne = await pool.query("select 1 from suppressions where email = 'tra-zly,adres@example.test'");
    await pool.query("delete from suppressions where email = 'tra-zly,adres@example.test'");
    expect(globalne.rowCount).toBe(0);
  });

  it("P1 #2: wolna partia + równoległe odzyskiwanie zombie i rekoncyliacja — każda wiadomość wysłana dokładnie raz, zero held", async () => {
    const pool = getPool();
    await wstawWiadomosci(tenantId, "tra-zombie", 5);
    const b = new Atrapa();
    let wynikB: Awaited<ReturnType<typeof wyslijPartie>> | null = null;
    let raz = false;
    const a = new Atrapa(async () => {
      if (raz) return;
      raz = true;
      // „Mija kwadrans" dla ZNACZNIKA PARTII: postarzamy wiersze z najstarszym claimed_at
      // wśród zajętych/wysyłanych, czyli token partii. Wiadomość w locie ma od tej zmiany
      // własny, świeży zegar próby (claimed_at = now() w tx1) i nie może się postarzeć
      // razem z partią — przed poprawką miała token partii i rekoncyliacja robiła z niej held.
      await pool.query(
        `update messages set claimed_at = claimed_at - interval '20 minutes'
          where tenant_id = $1 and claimed_at = (
            select min(claimed_at) from messages where tenant_id = $1 and current_state in ('claimed', 'sending'))`,
        [tenantId],
      );
      await odzyskajZombie();
      await rekoncyliacjaWysylki(tenantId);
      // drugi worker przejmuje odzyskane wiadomości, zanim pierwszy skończy rozmowę z SMTP
      wynikB = await wyslijPartie(tenantId, { dostawca: b, limit: 10 });
    });
    const wynikA = await wyslijPartie(tenantId, { dostawca: a, limit: 10 });
    expect(wynikA.wyslane).toBe(1);
    expect(wynikB!.wyslane).toBe(4);

    const stan = await stanWiadomosci(tenantId, "tra-zombie");
    const wszystkie = [...a.wyslane, ...b.wyslane].sort();
    expect(wszystkie).toEqual(stan.map((w) => w.email));
    expect(new Set(wszystkie).size).toBe(5);
    expect(stan.every((w) => w.current_state === "sent" && w.sent === 1 && w.held === 0)).toBe(true);
  });

  it("P2 #8: wznowienie sklepu zdejmuje wstrzymanie i wpisuje joby w JEDNEJ transakcji", async () => {
    const pool = getPool();
    const kampania = (
      await pool.query(`insert into campaigns (tenant_id, name, subject, content, status) values ($1, 'TRA wznowienie', 'T', $2, 'sending') returning id`, [tenantId, JSON.stringify({ html: "<p>x</p>" })])
    ).rows[0].id as string;
    await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
       values ($1, null, 'campaign', $2, 'tra-wznow@example.test', 'T', '<p>x</p>', $3, $4)`,
      [tenantId, kampania, tok(), tok()],
    );
    await pool.query("update tenants set sending_paused_at = now(), sending_pause_reason = 'test' where id = $1", [tenantId]);

    // wpis joba pada (wyzwalacz tylko dla tego tenanta): wstrzymanie MUSI zostać
    await pool.query(`create or replace function tra_blokuj_job() returns trigger language plpgsql as $$
      begin
        if new.tenant_id = '${tenantId}'::uuid and new.kind = 'wyslij_kampanie' then raise exception 'tra: awaria zapisu joba'; end if;
        return new;
      end $$`);
    await pool.query("create trigger tra_blokuj_job before insert on jobs for each row execute function tra_blokuj_job()");
    try {
      await expect(wznowWysylkeTenanta(tenantId)).rejects.toThrow(/awaria zapisu joba/);
    } finally {
      await pool.query("drop trigger if exists tra_blokuj_job on jobs");
      await pool.query("drop function if exists tra_blokuj_job()");
    }
    const { rows: t } = await pool.query("select sending_paused_at from tenants where id = $1", [tenantId]);
    expect(t[0].sending_paused_at).not.toBeNull();

    const w = await wznowWysylkeTenanta(tenantId);
    expect(w).toEqual({ wznowiony: true, doWznowienia: [kampania] });
    const { rows: joby } = await pool.query(
      "select payload from jobs where tenant_id = $1 and kind = 'wyslij_kampanie' and status = 'pending'",
      [tenantId],
    );
    expect(joby.map((j) => j.payload.campaignId)).toEqual([kampania]);
    expect((await pool.query("select sending_paused_at from tenants where id = $1", [tenantId])).rows[0].sending_paused_at).toBeNull();
    // drugie kliknięcie: nic do wznowienia, żadnego drugiego joba
    expect(await wznowWysylkeTenanta(tenantId)).toEqual({ wznowiony: false, doWznowienia: [] });
    expect((await pool.query("select count(*)::int as ile from jobs where tenant_id = $1 and kind = 'wyslij_kampanie'", [tenantId])).rows[0].ile).toBe(1);
    await pool.query("delete from jobs where tenant_id = $1", [tenantId]);
    await pool.query("update campaigns set status = 'sent' where id = $1", [kampania]);
    await pool.query("update messages set current_state = 'suppressed', current_rank = 3 where tenant_id = $1 and source_id = $2", [tenantId, kampania]);
  });

  it("P3: budowa wiadomości porcjami daje ten sam zbiór co jedno zapytanie i jest idempotentna", async () => {
    const pool = getPool();
    const lista = (await pool.query("insert into lists (tenant_id, name) values ($1, 'TRA lista') returning id", [tenantId])).rows[0].id;
    for (let i = 0; i < 7; i++) {
      const p = await pool.query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantId, `tra-porcja-${i}@example.test`]);
      await pool.query(`insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email', 'granted', 'test', now() - interval '1 day')`, [tenantId, p.rows[0].id]);
      await pool.query("insert into list_members (tenant_id, list_id, profile_id) values ($1, $2, $3)", [tenantId, lista, p.rows[0].id]);
    }
    const kampania = (
      await pool.query(`insert into campaigns (tenant_id, name, subject, content, status) values ($1, 'TRA porcje', 'T', $2, 'approved') returning id`, [tenantId, JSON.stringify({ html: '<p><a href="https://sklep.example.test/x">x</a></p>' })])
    ).rows[0].id;
    await pool.query(`insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id) values ($1, $2, 'include', 'list', $3)`, [tenantId, kampania, lista]);

    expect(await zbudujWiadomosciKampanii(tenantId, kampania, { porcja: 3 })).toEqual({ utworzone: 7, kandydatow: 7 });
    expect(await zbudujWiadomosciKampanii(tenantId, kampania, { porcja: 3 })).toEqual({ utworzone: 0, kandydatow: 7 });
    const { rows } = await pool.query(
      "select count(*)::int as ile, count(distinct profile_id)::int as profile, count(distinct click_token)::int as tokeny from messages where tenant_id = $1 and source_id = $2",
      [tenantId, kampania],
    );
    expect(rows[0]).toEqual({ ile: 7, profile: 7, tokeny: 7 });
    await pool.query("update campaigns set status = 'cancelled' where id = $1", [kampania]);
    await pool.query("update messages set current_state = 'suppressed', current_rank = 3 where tenant_id = $1 and source_id = $2", [tenantId, kampania]);
  });
});

// ---------------------------------------------------------------------------
// Lista kontrolna: linki śledzone liczone tą samą regułą co silnik
// ---------------------------------------------------------------------------

describe("linkiSledzone = przepiszLinki", () => {
  it("każdy zapis, który silnik przepisuje, lista kontrolna liczy jako śledzony (i odwrotnie)", () => {
    const html = [
      `<a href="https://a.test/1">1</a>`,
      `<a href='http://b.test/2'>2</a>`,
      `<a href=https://c.test/3?x=1>3</a>`,
      `<a HREF = "https://d.test/4">4</a>`,
      `<a href="HTTPS://e.test/5">5</a>`,
      `<a href="mailto:x@y">m</a>`,
      `<a href="/lokalny">l</a>`,
    ].join(" ");
    const silnik = przepiszLinki(html, "TOK").linki;
    expect(silnik).toEqual(["https://a.test/1", "http://b.test/2", "https://c.test/3?x=1", "https://d.test/4", "HTTPS://e.test/5"]);
    expect(linkiSledzone(html)).toEqual(silnik);
  });
});
