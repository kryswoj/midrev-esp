import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { uruchomAutomatyzacje } from "../src/usecases/automatyzacje/przetworz-zdarzenia";
import type { DostawcaWysylki } from "../src/domain/email/port";

// Wykonywalna specyfikacja automatyzacji (Epik E). Dostawca jest atrapą (AD-7),
// baza prawdziwa (AD-20). Wszystko, co tu wychodzi, przechodzi przez ten sam
// silnik i tę samą bramkę canSendTo co kampanie (AD-25, FR69).

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: string[] = [];
  async wyslij(w: { do: string; idempotencyKey: string }) {
    this.wyslane.push(w.do);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

describe("Automatyzacje", () => {
  let tenantId: string;
  let welcomeId: string;
  const profile: Record<string, string> = {};

  async function dodajProfil(klucz: string, email: string, zgoda: boolean) {
    const pool = getPool();
    const p = await pool.query(
      "insert into profiles (tenant_id, email) values ($1, $2) returning id",
      [tenantId, email],
    );
    profile[klucz] = p.rows[0].id;
    if (zgoda) {
      await pool.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
         values ($1, $2, 'email', 'granted', 'test', now() - interval '10 days')`,
        [tenantId, profile[klucz]],
      );
    }
  }

  async function dodajZdarzenie(klucz: string, typ: string, przesuniecie: string) {
    await getPool().query(
      `insert into events (tenant_id, profile_id, event_type, occurred_at)
       values ($1, $2, $3, now() - $4::interval)`,
      [tenantId, profile[klucz], typ, przesuniecie],
    );
  }

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'AUT %'");
    const t = await pool.query("insert into tenants (name) values ('AUT tenant') returning id");
    tenantId = t.rows[0].id;

    await dodajProfil("zgodny", "aut-zgodny@example.test", true);
    await dodajProfil("bez_zgody", "aut-bezzgody@example.test", false);

    // journey powitalny, aktywowany wczoraj: zdarzenia po aktywacji są w grze
    const j = await pool.query(
      `insert into journeys (tenant_id, name, trigger_event, delay_minutes, subject, content,
                             active, active_since)
       values ($1, 'AUT powitanie', 'popup.submitted', 0, 'Witaj!', $2, true, now() - interval '1 day')
       returning id`,
      [tenantId, JSON.stringify({ html: '<p>Cześć! <a href="https://sklep.example.test">Sklep</a></p>' })],
    );
    welcomeId = j.rows[0].id;
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like 'AUT %'");
    await closePool();
  });

  it("zdarzenie plus aktywny journey daje jedną wiadomość journey, wysłaną tym samym silnikiem", async () => {
    const pool = getPool();
    await dodajZdarzenie("zgodny", "popup.submitted", "1 hour");
    const dostawca = new DostawcaAtrapa();
    const wynik = await uruchomAutomatyzacje(tenantId, { dostawca });
    expect(wynik.zbudowane).toBe(1);
    expect(dostawca.wyslane).toEqual(["aut-zgodny@example.test"]);

    const { rows } = await pool.query(
      `select current_state, subject, body_html from messages
        where tenant_id = $1 and source_type = 'journey' and source_id = $2 and profile_id = $3`,
      [tenantId, welcomeId, profile.zgodny],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].current_state).toBe("sent");
    expect(rows[0].subject).toBe("Witaj!");
    // linki przepisane na śledzone, stopka z wypisaniem doklejona: pełny render kampanijny
    expect(rows[0].body_html).not.toContain('href="https://sklep.example.test"');
    expect(rows[0].body_html).toMatch(/\/u\/[A-Za-z0-9_-]+/);

    // rejestr przebiegów nosi occurred_at zdarzenia (AD-10), nie chwilę tika
    const { rows: przebiegi } = await pool.query(
      `select 1 from journey_runs jr
        join events e on e.profile_id = jr.profile_id and e.occurred_at = jr.triggered_at
       where jr.journey_id = $1 and jr.profile_id = $2 and e.event_type = 'popup.submitted'`,
      [welcomeId, profile.zgodny],
    );
    expect(przebiegi).toHaveLength(1);
  });

  it("ten sam profil nie dostaje drugiej wiadomości, nawet po kolejnym zdarzeniu", async () => {
    await dodajZdarzenie("zgodny", "popup.submitted", "30 minutes");
    const dostawca = new DostawcaAtrapa();
    const wynik = await uruchomAutomatyzacje(tenantId, { dostawca });
    expect(wynik.zbudowane).toBe(0);
    expect(dostawca.wyslane).toEqual([]);
  });

  it("journey nieaktywny nie buduje i nie wysyła", async () => {
    const pool = getPool();
    await pool.query(
      `insert into journeys (tenant_id, name, trigger_event, subject, content, active)
       values ($1, 'AUT nieaktywny', 'order.created', 'Dzięki', $2, false)`,
      [tenantId, JSON.stringify({ html: "<p>Dzięki za zakup</p>" })],
    );
    await dodajZdarzenie("zgodny", "order.created", "1 hour");
    const dostawca = new DostawcaAtrapa();
    const wynik = await uruchomAutomatyzacje(tenantId, { dostawca });
    expect(wynik.zbudowane).toBe(0);
    expect(dostawca.wyslane).toEqual([]);
  });

  it("profil bez zgody jest zatrzymany bramką w transakcji wysyłki (AD-25, FR69)", async () => {
    const pool = getPool();
    await dodajZdarzenie("bez_zgody", "popup.submitted", "1 hour");
    const dostawca = new DostawcaAtrapa();
    const wynik = await uruchomAutomatyzacje(tenantId, { dostawca });
    // wiadomość POWSTAJE jako kandydat, ale świat jej nie widzi: bramka gasi ją w wysyłce
    expect(wynik.zbudowane).toBe(1);
    expect(wynik.wysylka.odmowy).toBe(1);
    expect(dostawca.wyslane).toEqual([]);

    const { rows } = await pool.query(
      `select current_state from messages
        where tenant_id = $1 and source_type = 'journey' and profile_id = $2`,
      [tenantId, profile.bez_zgody],
    );
    expect(rows[0].current_state).toBe("suppressed");
  });

  it("delay_minutes odracza wysyłkę i liczy się od occurred_at zdarzenia (AD-10)", async () => {
    const pool = getPool();
    await dodajProfil("delayowy", "aut-delay@example.test", true);
    await pool.query(
      `insert into journeys (tenant_id, name, trigger_event, delay_minutes, subject, content,
                             active, active_since)
       values ($1, 'AUT po zakupie', 'order.created', 120, 'Dziękujemy', $2, true, now() - interval '1 day')`,
      [tenantId, JSON.stringify({ html: "<p>Dziękujemy za zamówienie</p>" })],
    );
    await dodajZdarzenie("delayowy", "order.created", "30 minutes");

    const dostawca = new DostawcaAtrapa();
    const przedCzasem = await uruchomAutomatyzacje(tenantId, { dostawca });
    expect(przedCzasem.zbudowane).toBe(0);
    expect(dostawca.wyslane).toEqual([]);

    // czas mija: to samo zdarzenie starzeje się poza próg opóźnienia
    await pool.query(
      `update events set occurred_at = now() - interval '3 hours'
        where tenant_id = $1 and profile_id = $2 and event_type = 'order.created'`,
      [tenantId, profile.delayowy],
    );
    const poCzasie = await uruchomAutomatyzacje(tenantId, { dostawca });
    expect(poCzasie.zbudowane).toBe(1);
    expect(dostawca.wyslane).toEqual(["aut-delay@example.test"]);
  });

  it("dwa równoległe tiki nie dublują wysyłki: unikalność AD-26 plus SKIP LOCKED", async () => {
    await dodajProfil("rownolegly", "aut-rownolegly@example.test", true);
    await dodajZdarzenie("rownolegly", "popup.submitted", "1 hour");
    const d1 = new DostawcaAtrapa();
    const d2 = new DostawcaAtrapa();
    // dokladnie scenariusz dwoch workerow, ktore wzialy tik w tej samej chwili
    const [w1, w2] = await Promise.all([
      uruchomAutomatyzacje(tenantId, { dostawca: d1 }),
      uruchomAutomatyzacje(tenantId, { dostawca: d2 }),
    ]);
    expect(w1.zbudowane + w2.zbudowane).toBe(1);
    expect([...d1.wyslane, ...d2.wyslane]).toEqual(["aut-rownolegly@example.test"]);
  });

  it("włączenie journeya nie sięga wstecz: zdarzenia sprzed active_since milczą", async () => {
    await dodajProfil("wczesniejszy", "aut-wczesniejszy@example.test", true);
    // zdarzenie w oknie 48h, ale PRZED aktywacją journeya (active_since = wczoraj)
    await dodajZdarzenie("wczesniejszy", "popup.submitted", "30 hours");
    const dostawca = new DostawcaAtrapa();
    const wynik = await uruchomAutomatyzacje(tenantId, { dostawca });
    expect(wynik.zbudowane).toBe(0);
    expect(dostawca.wyslane).toEqual([]);
  });
});
