import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import type { DostawcaWysylki } from "../src/domain/email/port";
import { wyslijPartie, zbudujWiadomosciKampanii } from "../src/usecases/wysylka/wyslij-kampanie";
import {
  PROGI,
  sprawdzProgiReputacji,
  stanWysylkiTenanta,
  wznowWysylkeTenanta,
} from "../src/usecases/wysylka/reputacja";

/**
 * Wykonywalna specyfikacja B5: progi odbić i skarg z automatycznym wstrzymaniem tenanta.
 * Punktem odniesienia są progi AWS z SES-BYOD-SPEC sekcja 8 — nasze mają leżeć poniżej
 * progu REVIEW Amazona, nie poniżej jego progu wstrzymania.
 */

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: string[] = [];
  async wyslij(w: { do: string; idempotencyKey: string }) {
    this.wyslane.push(w.do);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

describe("Progi reputacji i wstrzymanie tenanta (B5)", () => {
  let tenantId: string;
  let listaId: string;
  const pool = getPool();

  /**
   * N wiadomości z jednym zdarzeniem danego typu, datowanych NA TERAZ (okno wskaźników
   * to 24 h kroczące). Zdarzenia wchodzą prosto SQL-em, bo badamy liczenie i decyzję,
   * a nie ścieżkę zapisu — tę sprawdza tests/odbicia.test.ts.
   */
  async function zdarzenia(
    typ: "delivered" | "bounced" | "complained",
    ile: number,
  ) {
    const klasa = typ === "bounced" ? "hard" : null;
    const wyklucz = typ === "bounced" ? false : null;
    const liczySie = typ === "delivered" ? null : true;
    await pool.query(
      `with nowe as (
         insert into messages (tenant_id, profile_id, source_type, source_id, email, subject,
                               body_html, click_token, unsubscribe_token)
         select $1, null, 'test', gen_random_uuid(), 'rep@example.test', 'temat', '<p>x</p>',
                gen_random_uuid()::text, gen_random_uuid()::text
           from generate_series(1, $2::int)
         returning id
       )
       insert into message_events (tenant_id, message_id, event_type, occurred_at,
                                   bounce_class, add_exclusion, counts_to_rate)
       select $1, id, $3, now(), $4, $5, $6 from nowe`,
      [tenantId, ile, typ, klasa, wyklucz, liczySie],
    );
  }

  beforeAll(async () => {
    await pool.query("delete from tenants where name like 'REP %'");
    const t = await pool.query("insert into tenants (name) values ($1) returning id", ["REP tenant"]);
    tenantId = t.rows[0].id;
    const p = await pool.query(
      "insert into profiles (tenant_id, email) values ($1, 'rep-odbiorca@example.test') returning id",
      [tenantId],
    );
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
       values ($1, $2, 'email', 'granted', 'test', now())`,
      [tenantId, p.rows[0].id],
    );
    const l = await pool.query(
      "insert into lists (tenant_id, name) values ($1, 'REP lista') returning id",
      [tenantId],
    );
    listaId = l.rows[0].id;
    await pool.query(
      "insert into list_members (tenant_id, list_id, profile_id) values ($1, $2, $3)",
      [tenantId, listaId, p.rows[0].id],
    );
  });

  beforeEach(async () => {
    await pool.query("delete from messages where tenant_id = $1", [tenantId]);
    await pool.query(
      `update tenants set sending_paused_at = null, sending_pause_reason = null,
              reputation_alert_at = null where id = $1`,
      [tenantId],
    );
  });

  afterAll(async () => {
    await pool.query("delete from tenants where name like 'REP %'");
    await closePool();
  });

  it("nasze progi leżą poniżej progów REVIEW z AWS, nie tylko poniżej progów wstrzymania", () => {
    // AWS (SES-BYOD-SPEC sekcja 8): odbicia 5 procent review / 10 procent wstrzymanie,
    // skargi 0,1 procenta review / 0,5 procenta wstrzymanie. Ten test istnieje po to,
    // żeby podniesienie naszych progów "na chwilę" wymagało świadomej zmiany specyfikacji.
    expect(PROGI.odbiciaWstrzymanie).toBeLessThan(0.05);
    expect(PROGI.skargiWstrzymanie).toBeLessThan(0.001);
    expect(PROGI.odbiciaPrzeglad).toBeLessThan(PROGI.odbiciaWstrzymanie);
    expect(PROGI.skargiPrzeglad).toBeLessThan(PROGI.skargiWstrzymanie);
  });

  it("mała próbka nie wstrzymuje nikogo, choćby wskaźnik był dramatyczny", async () => {
    // 20 dostarczonych i 10 skarg to 50 procent — i nie znaczy nic poza tym, że próbka
    // jest mała. Wstrzymanie z fałszywego alarmu uczy operatora ignorować wstrzymania.
    await zdarzenia("delivered", 20);
    await zdarzenia("complained", 10);
    const wynik = await sprawdzProgiReputacji(tenantId);
    expect(wynik.decyzja).toBe("ok");
    expect(wynik.wstrzymany).toBe(false);
    expect((await stanWysylkiTenanta(tenantId)).wstrzymany).toBe(false);
  });

  it("przekroczony próg przeglądu melduje, ale wysyłki nie zatrzymuje", async () => {
    // 5 twardych odbić na 205 = 2,44 procent: powyżej naszego progu przeglądu (2 procent),
    // poniżej progu wstrzymania (4 procent) i daleko poniżej progu review AWS (5 procent)
    await zdarzenia("delivered", 200);
    await zdarzenia("bounced", 5);
    const wynik = await sprawdzProgiReputacji(tenantId);
    expect(wynik.decyzja).toBe("przeglad");
    expect(wynik.wstrzymany).toBe(false);
    expect(wynik.powod).toContain("odbicia twarde");
  });

  it("przekroczony próg skarg wstrzymuje tenanta — i przy dwóch workerach robi to raz", async () => {
    await zdarzenia("delivered", 1000);
    await zdarzenia("complained", 2); // 0,2 procenta, powyżej naszego progu 0,08 procenta

    const [a, b] = await Promise.all([
      sprawdzProgiReputacji(tenantId),
      sprawdzProgiReputacji(tenantId),
    ]);
    // wstrzymanie to jeden atomowy UPDATE z warunkiem `sending_paused_at is null`:
    // wiersz dostaje jeden proces, więc alert do człowieka idzie dokładnie raz
    expect([a.wstrzymanyTeraz, b.wstrzymanyTeraz].filter(Boolean).length).toBe(1);
    expect(a.wstrzymany && b.wstrzymany).toBe(true);

    const stan = await stanWysylkiTenanta(tenantId);
    expect(stan.wstrzymany).toBe(true);
    expect(stan.powod).toContain("skargi");
    expect(stan.od).not.toBeNull();
  });

  it("wstrzymany tenant nie wysyła NIC, a kolejka zostaje nietknięta", async () => {
    const k = await pool.query(
      `insert into campaigns (tenant_id, name, subject, content, status)
       values ($1, 'REP kampania', 'Temat', $2, 'sending') returning id`,
      [tenantId, JSON.stringify({ html: "<p>Cześć</p>" })],
    );
    const campaignId = k.rows[0].id;
    await pool.query(
      `insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id)
       values ($1, $2, 'include', 'list', $3)`,
      [tenantId, campaignId, listaId],
    );
    await zbudujWiadomosciKampanii(tenantId, campaignId);

    await pool.query(
      "update tenants set sending_paused_at = now(), sending_pause_reason = 'skargi 0,20 procent' where id = $1",
      [tenantId],
    );

    const dostawca = new DostawcaAtrapa();
    const wynik = await wyslijPartie(tenantId, { dostawca });
    expect(wynik.powodZatrzymania).toBe("wstrzymanie_tenanta");
    expect(wynik.wyslane).toBe(0);
    expect(dostawca.wyslane).toEqual([]);

    const { rows } = await pool.query(
      "select current_state from messages where tenant_id = $1 and source_id = $2",
      [tenantId, campaignId],
    );
    // nic nie zostało zajęte: wstrzymanie działa PRZED zajęciem partii, więc nie ma
    // wiadomości porzuconej w stanie 'claimed' bez nikogo, kto ją domknie
    expect(rows.every((w) => w.current_state === "queued")).toBe(true);

    const wznowienie = await wznowWysylkeTenanta(tenantId);
    expect(wznowienie.wznowiony).toBe(true);
    // kampania, której job domknął się na wstrzymaniu, musi wrócić do kolejki —
    // samo zdjęcie blokady nie wznowiłoby jej nigdy
    expect(wznowienie.doWznowienia).toContain(campaignId);
    expect((await stanWysylkiTenanta(tenantId)).wstrzymany).toBe(false);

    const wynik2 = await wyslijPartie(tenantId, { dostawca });
    expect(wynik2.wyslane).toBe(1);
  });

  it("drugie wznowienie nie udaje, że coś zrobiło", async () => {
    await pool.query("update tenants set sending_paused_at = now() where id = $1", [tenantId]);
    expect((await wznowWysylkeTenanta(tenantId)).wznowiony).toBe(true);
    expect((await wznowWysylkeTenanta(tenantId)).wznowiony).toBe(false);
  });
});
