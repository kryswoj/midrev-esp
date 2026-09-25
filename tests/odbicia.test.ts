import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import type { DostawcaWysylki, Wiadomosc, WynikWysylki } from "../src/domain/email/port";
import { wskaznikiReputacji } from "../src/usecases/wysylka/zaangazowanie";
import { zapiszZgloszenieDostawcy } from "../src/usecases/wysylka/zdarzenia-dostawcy";
import { wyslijPartie, zbudujWiadomosciKampanii } from "../src/usecases/wysylka/wyslij-kampanie";

/**
 * Wykonywalna specyfikacja A2: rozdział `dropped` od `bounced`, twarde od miękkich,
 * decyzja o wykluczeniu adresu zapisana w SAMYM zdarzeniu i wykonana w tej samej
 * transakcji. Baza jest prawdziwa; każda asercja czyta ZAPISANY rekord, nie wejście.
 */

const GODZINE_TEMU = new Date(Date.now() - 2 * 3600_000);
/** Data spoza okna raportu: dowód, że zapisujemy datę OD DOSTAWCY, nie chwilę zapisu. */
const ODBICIE_HISTORYCZNE = new Date("2026-06-01T06:30:00.000Z");

/** Dostawca, który odmawia na stałe przy przekazaniu wiadomości (5xx przy RCPT TO). */
class DostawcaOdmawiajacy implements DostawcaWysylki {
  readonly nazwa = "atrapa-odmowa";
  async wyslij(_w: Wiadomosc): Promise<WynikWysylki> {
    throw new Error("SMTP: oczekiwano 250, dostano: 550 5.1.1 <nieistnieje> User unknown");
  }
}

describe("Klasyfikacja odbić od końca do końca (A2)", () => {
  let tenantId: string;
  let obcyTenantId: string;
  let campaignId: string;
  const wiadomosci: Record<string, string> = {};

  async function zdarzenieWiadomosci(messageId: string, typ: string) {
    const { rows } = await getPool().query(
      `select event_type, bounce_class, bounce_category, smtp_code, provider_reason,
              add_exclusion, counts_to_rate, occurred_at, recorded_at
         from message_events where message_id = $1 and event_type = $2`,
      [messageId, typ],
    );
    return rows[0];
  }

  async function wykluczenia(email: string) {
    const pool = getPool();
    const { rows: lokalne } = await pool.query(
      `select action, reason from tenant_suppressions
        where tenant_id = $1 and lower(btrim(email)) = $2 order by occurred_at desc`,
      [tenantId, email],
    );
    const { rows: globalne } = await pool.query(
      "select reason from suppressions where lower(btrim(email)) = $1",
      [email],
    );
    return { lokalne, globalne };
  }

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'ODB %'");
    await pool.query("delete from suppressions where email like 'odb-%'");

    const t = await pool.query("insert into tenants (name) values ($1) returning id", ["ODB tenant"]);
    tenantId = t.rows[0].id;
    const o = await pool.query("insert into tenants (name) values ($1) returning id", ["ODB obcy"]);
    obcyTenantId = o.rows[0].id;

    const k = await pool.query(
      `insert into campaigns (tenant_id, name, subject, content, status)
       values ($1, 'ODB kampania', 'Temat', $2, 'approved') returning id`,
      [tenantId, JSON.stringify({ html: "<p>Treść</p>" })],
    );
    campaignId = k.rows[0].id;

    // siedem wiadomości, każda pod inny scenariusz raportu dostawcy
    for (const nazwa of ["twarde", "miekkie", "supresja", "skarga", "nie_skarga", "odrzucona", "historyczne"]) {
      const email = `odb-${nazwa}@example.test`;
      const p = await pool.query(
        "insert into profiles (tenant_id, email) values ($1, $2) returning id",
        [tenantId, email],
      );
      const m = await pool.query(
        `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject,
                               body_html, click_token, unsubscribe_token, provider_id)
         values ($1, $2, 'campaign', $3, $4, 'Temat', '<p>x</p>', $5, $6, $7) returning id`,
        [tenantId, p.rows[0].id, campaignId, email, `odb-klik-${nazwa}`, `odb-unsub-${nazwa}`, `prov-${nazwa}`],
      );
      wiadomosci[nazwa] = m.rows[0].id;
      // strumień stanu z datami podanymi JAWNIE: kolumna nie ma już `default now()`
      await pool.query(
        `insert into message_events (tenant_id, message_id, event_type, occurred_at)
         values ($1, $2, 'sent', $3)`,
        [tenantId, m.rows[0].id, new Date(Date.now() - 3 * 3600_000)],
      );
    }
    for (const nazwa of ["twarde", "miekkie", "skarga", "nie_skarga", "odrzucona"]) {
      await pool.query(
        `insert into message_events (tenant_id, message_id, event_type, occurred_at)
         values ($1, $2, 'delivered', $3)`,
        [tenantId, wiadomosci[nazwa], new Date(Date.now() - 2.5 * 3600_000)],
      );
    }
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from suppressions where email like 'odb-%'");
    await pool.query("delete from tenants where name like 'ODB %'");
    await closePool();
  });

  it("AD-10: message_events nie przyjmie zdarzenia bez daty — default został zdjęty", async () => {
    await expect(
      getPool().query(
        `insert into message_events (tenant_id, message_id, event_type, occurred_at)
         values ($1, $2, 'held', null)`,
        [tenantId, wiadomosci.twarde],
      ),
    ).rejects.toThrow(/null value in column "occurred_at"|not-null/i);
  });

  it("baza nie przyjmie odbicia BEZ klasyfikacji", async () => {
    await expect(
      getPool().query(
        `insert into message_events (tenant_id, message_id, event_type, occurred_at)
         values ($1, $2, 'bounced', now())`,
        [tenantId, wiadomosci.twarde],
      ),
    ).rejects.toThrow(/message_events_odbicie_sklasyfikowane_check/);
  });

  it("baza nie pozwoli dokleić klasyfikacji do zdarzenia pozytywnego", async () => {
    await expect(
      getPool().query(
        `insert into message_events (tenant_id, message_id, event_type, occurred_at, bounce_class)
         values ($1, $2, 'queued', now(), 'hard')`,
        [tenantId, wiadomosci.twarde],
      ),
    ).rejects.toThrow(/message_events_klasyfikacja_zakres_check/);
  });

  it("twarde odbicie: klasa, kod SMTP, powód i decyzja o wykluczeniu w jednym zdarzeniu", async () => {
    const wynik = await zapiszZgloszenieDostawcy(
      tenantId,
      { providerId: "prov-twarde" },
      {
        rodzaj: "bounce",
        kiedy: GODZINE_TEMU,
        bounceType: "Permanent",
        bounceSubType: "NoEmail",
        diagnosticCode: "smtp; 550 5.1.1 <odb-twarde@example.test> User unknown",
      },
    );
    expect(wynik).toMatchObject({ zapisane: true, typZdarzenia: "bounced" });

    const z = await zdarzenieWiadomosci(wiadomosci.twarde, "bounced");
    expect(z.bounce_class).toBe("hard");
    expect(z.bounce_category).toBe("invalid_address");
    expect(z.smtp_code).toBe("5.1.1");
    expect(z.provider_reason).toContain("User unknown");
    expect(z.add_exclusion).toBe(true);
    expect(z.counts_to_rate).toBe(true);
    // data ZE ŹRÓDŁA, nie chwila zapisu
    expect(new Date(z.occurred_at).toISOString()).toBe(GODZINE_TEMU.toISOString());

    // decyzja zapisana w zdarzeniu ma być WYKONANA, nie tylko odnotowana
    const w = await wykluczenia("odb-twarde@example.test");
    expect(w.lokalne[0]).toMatchObject({ action: "suppressed" });
    expect(w.lokalne[0].reason).toContain("invalid_address");
    // martwy adres blokujemy też globalnie: chroni reputację całej platformy (0001)
    expect(w.globalne).toHaveLength(1);
  });

  it("miękkie odbicie NIE wyklucza adresu i nie wchodzi do wskaźnika", async () => {
    const wynik = await zapiszZgloszenieDostawcy(
      tenantId,
      { providerId: "prov-miekkie" },
      { rodzaj: "bounce", kiedy: GODZINE_TEMU, bounceType: "Transient", bounceSubType: "MailboxFull" },
    );
    expect(wynik.typZdarzenia).toBe("bounced");

    const z = await zdarzenieWiadomosci(wiadomosci.miekkie, "bounced");
    expect(z.bounce_class).toBe("soft");
    expect(z.bounce_category).toBe("mailbox_full");
    expect(z.add_exclusion).toBe(false);
    expect(z.counts_to_rate).toBe(false);

    const w = await wykluczenia("odb-miekkie@example.test");
    expect(w.lokalne).toHaveLength(0);
    expect(w.globalne).toHaveLength(0);
  });

  it("adres z listy supresji dostawcy to 'dropped', nie 'bounced'", async () => {
    const wynik = await zapiszZgloszenieDostawcy(
      tenantId,
      { providerId: "prov-supresja" },
      {
        rodzaj: "bounce",
        kiedy: GODZINE_TEMU,
        bounceType: "Permanent",
        bounceSubType: "OnAccountSuppressionList",
      },
    );
    expect(wynik.typZdarzenia).toBe("dropped");

    // mail nie wyszedł z naszej strony, więc nie mówi nic o naszej reputacji u odbiorcy
    const z = await zdarzenieWiadomosci(wiadomosci.supresja, "dropped");
    expect(z.bounce_category).toBe("suppressed_by_provider");
    expect(z.counts_to_rate).toBe(false);
    expect(await zdarzenieWiadomosci(wiadomosci.supresja, "bounced")).toBeUndefined();
  });

  it("skarga wyklucza adres lokalnie i globalnie", async () => {
    await zapiszZgloszenieDostawcy(
      tenantId,
      { providerId: "prov-skarga" },
      { rodzaj: "complaint", kiedy: GODZINE_TEMU, complaintFeedbackType: "abuse" },
    );
    const z = await zdarzenieWiadomosci(wiadomosci.skarga, "complained");
    expect(z.add_exclusion).toBe(true);
    expect(z.counts_to_rate).toBe(true);
    const w = await wykluczenia("odb-skarga@example.test");
    expect(w.lokalne).toHaveLength(1);
    expect(w.globalne).toHaveLength(1);
  });

  it("zgłoszenie 'not-spam' nie tworzy żadnego zdarzenia", async () => {
    const wynik = await zapiszZgloszenieDostawcy(
      tenantId,
      { providerId: "prov-nie_skarga" },
      { rodzaj: "complaint", kiedy: GODZINE_TEMU, complaintFeedbackType: "not-spam" },
    );
    expect(wynik).toMatchObject({ zapisane: false, powodOdrzucenia: "nie_jest_skarga" });
    expect(await zdarzenieWiadomosci(wiadomosci.nie_skarga, "complained")).toBeUndefined();
    expect(await wykluczenia("odb-nie_skarga@example.test")).toMatchObject({ lokalne: [], globalne: [] });
  });

  it("odrzucenie treści to 'dropped' bez karania odbiorcy", async () => {
    await zapiszZgloszenieDostawcy(
      tenantId,
      { providerId: "prov-odrzucona" },
      { rodzaj: "reject", kiedy: GODZINE_TEMU, powod: "Bad content" },
    );
    const z = await zdarzenieWiadomosci(wiadomosci.odrzucona, "dropped");
    expect(z.bounce_category).toBe("content");
    expect(z.add_exclusion).toBe(false);
    const w = await wykluczenia("odb-odrzucona@example.test");
    expect(w.lokalne).toHaveLength(0);
  });

  it("powtórzone powiadomienie nie dokłada drugiego wykluczenia", async () => {
    await zapiszZgloszenieDostawcy(
      tenantId,
      { providerId: "prov-twarde" },
      {
        rodzaj: "bounce",
        kiedy: new Date(),
        bounceType: "Permanent",
        bounceSubType: "NoEmail",
        diagnosticCode: "smtp; 550 5.1.1 User unknown",
      },
    );
    const w = await wykluczenia("odb-twarde@example.test");
    // unikalność (message_id, event_type) z AD-22 zatrzymuje drugi zapis, a wraz z nim
    // drugi wpis w logu wykluczeń — log nie ma unikalności i sam by się nie obronił
    expect(w.lokalne).toHaveLength(1);
    // data pierwszego zdarzenia zostaje nietknięta
    const z = await zdarzenieWiadomosci(wiadomosci.twarde, "bounced");
    expect(new Date(z.occurred_at).toISOString()).toBe(GODZINE_TEMU.toISOString());
  });

  it("data odbicia pochodzi od dostawcy nawet wtedy, gdy jest sprzed kwartału", async () => {
    await zapiszZgloszenieDostawcy(
      tenantId,
      { providerId: "prov-historyczne" },
      { rodzaj: "bounce_smtp", kiedy: ODBICIE_HISTORYCZNE, odpowiedz: "552 5.2.2 Mailbox full" },
    );
    const z = await zdarzenieWiadomosci(wiadomosci.historyczne, "bounced");
    expect(new Date(z.occurred_at).toISOString()).toBe(ODBICIE_HISTORYCZNE.toISOString());
    // data zapisu jest osobna i mówi, kiedy MY się o tym dowiedzieliśmy
    expect(new Date(z.recorded_at).getTime()).toBeGreaterThan(new Date(z.occurred_at).getTime());
    expect(z.bounce_class).toBe("soft");
    expect(z.smtp_code).toBe("5.2.2");
  });

  it("izolacja tenantów: identyfikator dostawcy nie działa przez granicę tenanta", async () => {
    const wynik = await zapiszZgloszenieDostawcy(
      obcyTenantId,
      { providerId: "prov-twarde" },
      { rodzaj: "bounce", kiedy: new Date(), bounceType: "Permanent", bounceSubType: "NoEmail" },
    );
    expect(wynik).toMatchObject({ zapisane: false, powodOdrzucenia: "brak_wiadomosci" });
  });

  it("trwała odmowa dostawcy przy wysyłce to 'dropped' z pełną klasyfikacją", async () => {
    const pool = getPool();
    const email = "odb-handoff@example.test";
    const p = await pool.query(
      "insert into profiles (tenant_id, email) values ($1, $2) returning id",
      [tenantId, email],
    );
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
       values ($1, $2, 'email', 'granted', 'test', now())`,
      [tenantId, p.rows[0].id],
    );
    const lista = await pool.query(
      "insert into lists (tenant_id, name) values ($1, 'ODB lista') returning id",
      [tenantId],
    );
    await pool.query(
      "insert into list_members (tenant_id, list_id, profile_id) values ($1, $2, $3)",
      [tenantId, lista.rows[0].id, p.rows[0].id],
    );
    const k = await pool.query(
      `insert into campaigns (tenant_id, name, subject, content, status)
       values ($1, 'ODB kampania 2', 'Temat 2', $2, 'approved') returning id`,
      [tenantId, JSON.stringify({ html: "<p>Druga</p>" })],
    );
    await pool.query(
      `insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id)
       values ($1, $2, 'include', 'list', $3)`,
      [tenantId, k.rows[0].id, lista.rows[0].id],
    );
    await zbudujWiadomosciKampanii(tenantId, k.rows[0].id);
    const wynik = await wyslijPartie(tenantId, { dostawca: new DostawcaOdmawiajacy() });
    expect(wynik.bledy).toBe(1);

    const { rows } = await pool.query(
      "select id, current_state from messages where tenant_id = $1 and source_id = $2",
      [tenantId, k.rows[0].id],
    );
    // 'dropped', bo mail nigdy nie dotarł do serwera odbiorcy — a nie 'failed' i nie 'bounced'
    expect(rows[0].current_state).toBe("dropped");
    const z = await zdarzenieWiadomosci(rows[0].id, "dropped");
    expect(z.bounce_class).toBe("hard");
    expect(z.bounce_category).toBe("invalid_address");
    expect(z.smtp_code).toBe("5.1.1");
    expect(z.counts_to_rate).toBe(false);
    expect(z.add_exclusion).toBe(true);
    const w = await wykluczenia(email);
    expect(w.lokalne).toHaveLength(1);
  });

  it("wskaźniki reputacji to TRZY osobne liczby, nie jeden wspólny bounce rate", async () => {
    const r = await wskaznikiReputacji(tenantId, 24);
    expect(r.dostarczone).toBe(5);
    expect(r.odbiciaTwarde).toBe(1);
    expect(r.odbiciaMiekkie).toBe(1);
    // supresja dostawcy + odrzucona treść + odmowa przy handoffie
    expect(r.odrzuconePrzedWysylka).toBe(3);
    expect(r.skargi).toBe(1);
    expect(r.wskaznikOdbicTwardych).toBeCloseTo(1 / 6, 6);
    expect(r.wskaznikSkarg).toBeCloseTo(1 / 5, 6);
    // odbicie sprzed kwartału jest w bazie, ale POZA oknem raportu
    const szerokie = await wskaznikiReputacji(tenantId, 24 * 365);
    expect(szerokie.odbiciaMiekkie).toBe(2);
  });
});
