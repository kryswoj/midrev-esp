import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { nowyBlok, pustyDokument } from "../src/domain/email/bloki";
import { duplikujKampanie, liczbyKampaniiTenanta, nazwaKopii, usunSzkicKampanii } from "../src/usecases/tresc/kampanie";

/**
 * Duplikat kampanii (audyt #20) i usuwanie szkiców. Każdy test czyta ZAPISANY rekord.
 * Najważniejsze: kopia nie dziedziczy NICZEGO z wysyłki — planu, akceptacji, wiadomości,
 * zdarzeń, statystyk, znaczników wstrzymania i odwołania.
 */

describe("nazwa kopii", () => {
  it("sufiks (kopia), potem numer przy kolizji; kopia kopii nie rośnie", () => {
    expect(nazwaKopii("Black Friday", ["Black Friday"])).toBe("Black Friday (kopia)");
    expect(nazwaKopii("Black Friday", ["Black Friday", "Black Friday (kopia)"])).toBe("Black Friday (kopia 2)");
    expect(nazwaKopii("Black Friday (kopia)", ["Black Friday", "Black Friday (kopia)", "black friday (kopia 2)"])).toBe("Black Friday (kopia 3)");
    expect(nazwaKopii("Black Friday (kopia 2)", ["Black Friday (kopia 2)"])).toBe("Black Friday (kopia)");
  });
});

describe("duplikowanie i usuwanie szkiców (baza)", () => {
  const pool = getPool();
  let tenantId: string;
  let obcyTenantId: string;
  let lista: string;
  let segment: string;
  let zrodloId: string;

  const dokument = () => {
    const d = pustyDokument();
    d.bloki = [{ ...nowyBlok("tekst"), html: "Cześć <b>Ala</b>" }, { ...nowyBlok("przycisk"), link: "https://sklep.pl/bf" }];
    d.style = { ...d.style, kolorMarki: "#123456" };
    return d;
  };

  beforeAll(async () => {
    await pool.query("delete from tenants where name like 'DUPL %'");
    tenantId = (await pool.query("insert into tenants (name) values ('DUPL tenant') returning id")).rows[0].id;
    obcyTenantId = (await pool.query("insert into tenants (name) values ('DUPL obcy') returning id")).rows[0].id;
    lista = (await pool.query("insert into lists (tenant_id, name) values ($1, 'DUPL lista') returning id", [tenantId])).rows[0].id;
    segment = (await pool.query("insert into segments (tenant_id, name, rules) values ($1, 'DUPL segment', '[]') returning id", [tenantId])).rows[0].id;
    const listaUsunieta = (await pool.query("insert into lists (tenant_id, name) values ($1, 'DUPL usunieta') returning id", [tenantId])).rows[0].id;

    // Oryginał PO WYSYŁCE: plan, znaczniki, akceptacja, wiadomość ze zdarzeniem sent.
    const d = dokument();
    const content = { html: "<p>Cześć <b>Ala</b></p>", wersjaSchematu: d.wersjaSchematu, style: d.style, bloki: d.bloki, silnikWewnetrzny: "nie-kopiowac" };
    zrodloId = (
      await pool.query(
        `insert into campaigns (tenant_id, name, subject, preheader, content, status, scheduled_at, paused_at, cancelled_at, schedule_missed_alert_at)
         values ($1, 'DUPL Black Friday', 'Temat BF', 'Preheader BF', $2, 'sent', '2026-11-27T08:00:00Z', '2026-11-27T09:00:00Z', null, '2026-11-27T10:00:00Z')
         returning id`,
        [tenantId, JSON.stringify(content)],
      )
    ).rows[0].id;
    await pool.query(
      `insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id)
       values ($1, $2, 'include', 'list', $3), ($1, $2, 'exclude', 'segment', $4), ($1, $2, 'include', 'list', $5)`,
      [tenantId, zrodloId, lista, segment, listaUsunieta],
    );
    await pool.query("delete from lists where id = $1", [listaUsunieta]);
    await pool.query(
      `insert into campaign_approvals (tenant_id, campaign_id, token_hash, expires_at, decided_at, decision)
       values ($1, $2, md5(random()::text), now() + interval '7 days', now(), 'approved')`,
      [tenantId, zrodloId],
    );
    const wiadomosc = (
      await pool.query(
        `insert into messages (tenant_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token, current_state)
         values ($1, 'campaign', $2, 'ala@example.com', 'Temat BF', '<p>x</p>', md5(random()::text), md5(random()::text), 'sent') returning id`,
        [tenantId, zrodloId],
      )
    ).rows[0].id;
    await pool.query(
      "insert into message_events (tenant_id, message_id, event_type, occurred_at) values ($1, $2, 'sent', '2026-11-27T08:01:00Z')",
      [tenantId, wiadomosc],
    );
  });

  afterAll(async () => {
    await pool.query("delete from tenants where name like 'DUPL %'");
    await closePool();
  });

  it("kopia wysłanej kampanii: szkic z treścią, tematem, preheaderem i odbiorcami — bez niczego z wysyłki", async () => {
    const w = await duplikujKampanie(tenantId, zrodloId);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.nazwa).toBe("DUPL Black Friday (kopia)");
    expect(w.pominieteZrodla).toBe(1);

    const { rows } = await pool.query("select * from campaigns where tenant_id = $1 and id = $2", [tenantId, w.id]);
    const k = rows[0];
    const { rows: o } = await pool.query("select content from campaigns where id = $1", [zrodloId]);
    expect(k.status).toBe("draft");
    expect(k.subject).toBe("Temat BF");
    expect(k.preheader).toBe("Preheader BF");
    expect(k.content.html).toBe(o[0].content.html);
    expect(k.content.bloki).toEqual(o[0].content.bloki);
    expect(k.content.style).toEqual(o[0].content.style);
    expect(k.content.wersjaSchematu).toBe(o[0].content.wersjaSchematu);
    // nic z wysyłki
    expect(k.content.silnikWewnetrzny).toBeUndefined();
    expect(k.scheduled_at).toBeNull();
    expect(k.paused_at).toBeNull();
    expect(k.cancelled_at).toBeNull();
    expect(k.schedule_missed_alert_at).toBeNull();
    const zliczenia = await pool.query(
      `select
         (select count(*)::int from campaign_approvals where tenant_id = $1 and campaign_id = $2) as akceptacje,
         (select count(*)::int from messages where tenant_id = $1 and source_type = 'campaign' and source_id = $2) as wiadomosci,
         (select count(*)::int from attributions where tenant_id = $1 and campaign_id = $2) as atrybucje`,
      [tenantId, w.id],
    );
    expect(zliczenia.rows[0]).toEqual({ akceptacje: 0, wiadomosci: 0, atrybucje: 0 });
    const { liczby } = await liczbyKampaniiTenanta(tenantId);
    expect(liczby.get(zrodloId)?.wyslane).toBe(1);
    expect(liczby.get(w.id)).toBeUndefined();

    // odbiorcy: istniejące źródła 1:1 z trybem, usunięta lista pominięta
    const { rows: aud } = await pool.query(
      "select mode, source_type, source_id from campaign_audience where tenant_id = $1 and campaign_id = $2 order by mode",
      [tenantId, w.id],
    );
    expect(aud).toEqual([
      { mode: "exclude", source_type: "segment", source_id: segment },
      { mode: "include", source_type: "list", source_id: lista },
    ]);

    // oryginał nietknięty
    const { rows: po } = await pool.query("select status, scheduled_at from campaigns where id = $1", [zrodloId]);
    expect(po[0].status).toBe("sent");
    expect(po[0].scheduled_at).not.toBeNull();
  });

  it("kolejne kopie dostają numer; kopia kopii też", async () => {
    const druga = await duplikujKampanie(tenantId, zrodloId);
    expect(druga).toMatchObject({ ok: true, nazwa: "DUPL Black Friday (kopia 2)" });
    if (!druga.ok) return;
    const trzecia = await duplikujKampanie(tenantId, druga.id);
    expect(trzecia).toMatchObject({ ok: true, nazwa: "DUPL Black Friday (kopia 3)" });
  });

  it("izolacja: obcy tenant nie zduplikuje ani nie usunie kampanii", async () => {
    expect(await duplikujKampanie(obcyTenantId, zrodloId)).toMatchObject({ ok: false });
    const { rows } = await pool.query("select count(*)::int as n from campaigns where tenant_id = $1", [obcyTenantId]);
    expect(rows[0].n).toBe(0);
    const szkic = await duplikujKampanie(tenantId, zrodloId);
    if (!szkic.ok) throw new Error(szkic.blad);
    expect(await usunSzkicKampanii(obcyTenantId, szkic.id)).toMatchObject({ ok: false });
    expect((await pool.query("select 1 from campaigns where id = $1", [szkic.id])).rowCount).toBe(1);
  });

  it("usuwanie: szkic znika razem z odbiorcami; kampania poza szkicem zostaje", async () => {
    const szkic = await duplikujKampanie(tenantId, zrodloId);
    if (!szkic.ok) throw new Error(szkic.blad);
    expect(await usunSzkicKampanii(tenantId, szkic.id)).toMatchObject({ ok: true });
    expect((await pool.query("select 1 from campaigns where id = $1", [szkic.id])).rowCount).toBe(0);
    expect((await pool.query("select 1 from campaign_audience where campaign_id = $1", [szkic.id])).rowCount).toBe(0);

    for (const status of ["awaiting_approval", "approved", "sending", "paused", "sent", "cancelled"]) {
      const { rows } = await pool.query(
        "insert into campaigns (tenant_id, name, status) values ($1, $2, $3) returning id",
        [tenantId, `DUPL ${status}`, status],
      );
      const w = await usunSzkicKampanii(tenantId, rows[0].id);
      expect(w.ok).toBe(false);
      expect((await pool.query("select status from campaigns where id = $1", [rows[0].id])).rows[0].status).toBe(status);
    }
  });

  it("szkic z wiadomościami kampanii (stan po ręcznej zmianie statusu) nie jest usuwany", async () => {
    const { rows } = await pool.query("insert into campaigns (tenant_id, name, status) values ($1, 'DUPL szkic z historią', 'draft') returning id", [tenantId]);
    await pool.query(
      `insert into messages (tenant_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
       values ($1, 'campaign', $2, 'b@example.com', 't', '<p>x</p>', md5(random()::text), md5(random()::text))`,
      [tenantId, rows[0].id],
    );
    expect(await usunSzkicKampanii(tenantId, rows[0].id)).toMatchObject({ ok: false });
    expect((await pool.query("select 1 from campaigns where id = $1", [rows[0].id])).rowCount).toBe(1);
  });
});
