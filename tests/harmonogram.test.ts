import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import type { DostawcaWysylki } from "../src/domain/email/port";
import { wyslijPartie, zbudujWiadomosciKampanii } from "../src/usecases/wysylka/wyslij-kampanie";
import {
  domknijOdwolane,
  odwolajKampanie,
  stanKampanii,
  wstrzymajKampanie,
  wypchnijZaplanowane,
  wznowKampanie,
  zaplanujKampanie,
} from "../src/usecases/wysylka/sterowanie";

/**
 * Wykonywalna specyfikacja B1 (dispatcher zaplanowanych kampanii) i B2 (wstrzymanie,
 * wznowienie, odwołanie). Baza jest prawdziwa, dostawca jest atrapą portu.
 *
 * Każdy test o wyścigu sprawdza SKUTEK w bazie po obu przebiegach, a nie to, co zwróciła
 * funkcja: podwójna wysyłka jest nieodwracalna i nie wolno jej badać po logu.
 */

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: string[] = [];
  async wyslij(w: { do: string; idempotencyKey: string }) {
    this.wyslane.push(w.do);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

describe("Harmonogram i hamulec wysyłki (B1, B2)", () => {
  let tenantId: string;
  let listaId: string;
  const pool = getPool();

  /** Kampania gotowa do wysyłki: treść, temat, odbiorcy i ZAPADŁA decyzja klienta. */
  async function nowaKampania(status = "approved", scheduledAt: Date | null = null) {
    const k = await pool.query(
      `insert into campaigns (tenant_id, name, subject, content, status, scheduled_at)
       values ($1, 'HARM kampania', 'Temat', $2, $3, $4) returning id`,
      [tenantId, JSON.stringify({ html: "<p>Cześć</p>" }), status, scheduledAt],
    );
    const campaignId = k.rows[0].id as string;
    await pool.query(
      `insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id)
       values ($1, $2, 'include', 'list', $3)`,
      [tenantId, campaignId, listaId],
    );
    await pool.query(
      `insert into campaign_approvals (tenant_id, campaign_id, token_hash, expires_at, decided_at, decision)
       values ($1, $2, $3, now() + interval '7 days', now(), 'approved')`,
      [tenantId, campaignId, `harm-${campaignId}`],
    );
    return campaignId;
  }

  async function status(campaignId: string) {
    const { rows } = await pool.query("select status from campaigns where id = $1", [campaignId]);
    return rows[0]?.status as string;
  }

  async function joby(campaignId: string) {
    const { rows } = await pool.query(
      "select count(*)::int as ile from jobs where tenant_id = $1 and kind = 'wyslij_kampanie' and payload->>'campaignId' = $2",
      [tenantId, campaignId],
    );
    return rows[0].ile as number;
  }

  async function stanyWiadomosci(campaignId: string) {
    const { rows } = await pool.query(
      `select current_state, count(*)::int as ile from messages
        where tenant_id = $1 and source_type = 'campaign' and source_id = $2
        group by current_state`,
      [tenantId, campaignId],
    );
    return Object.fromEntries(rows.map((w) => [w.current_state, w.ile])) as Record<string, number>;
  }

  beforeAll(async () => {
    await pool.query("delete from tenants where name like 'HARM %'");
    const t = await pool.query("insert into tenants (name) values ($1) returning id", ["HARM tenant"]);
    tenantId = t.rows[0].id;

    const idy: string[] = [];
    for (const nr of [1, 2, 3]) {
      const p = await pool.query(
        "insert into profiles (tenant_id, email) values ($1, $2) returning id",
        [tenantId, `harm-${nr}@example.test`],
      );
      idy.push(p.rows[0].id);
      await pool.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
         values ($1, $2, 'email', 'granted', 'test', now())`,
        [tenantId, p.rows[0].id],
      );
    }
    const l = await pool.query(
      "insert into lists (tenant_id, name) values ($1, 'HARM lista') returning id",
      [tenantId],
    );
    listaId = l.rows[0].id;
    await pool.query(
      `insert into list_members (tenant_id, list_id, profile_id) select $1, $2, unnest($3::uuid[])`,
      [tenantId, listaId, idy],
    );
  });

  beforeEach(async () => {
    // każdy test zaczyna od czystej kolejki tenanta: wyslijPartie opróżnia kolejkę
    // CAŁEGO tenanta, więc resztki z poprzedniego testu fałszowałyby liczniki
    await pool.query("delete from messages where tenant_id = $1", [tenantId]);
    await pool.query("delete from jobs where tenant_id = $1", [tenantId]);
    await pool.query("update tenants set sending_paused_at = null, sending_pause_reason = null where id = $1", [tenantId]);
  });

  afterAll(async () => {
    await pool.query("delete from tenants where name like 'HARM %'");
    await closePool();
  });

  // ── B1 ──────────────────────────────────────────────────────────────────────

  it("plan w przyszłości leży spokojnie, plan po terminie rusza wysyłkę", async () => {
    const pozniej = await nowaKampania("approved", new Date(Date.now() + 3600_000));
    await wypchnijZaplanowane();
    expect(await status(pozniej)).toBe("approved");
    expect(await joby(pozniej)).toBe(0);

    const teraz = await nowaKampania("approved", new Date(Date.now() - 60_000));
    await wypchnijZaplanowane();
    expect(await status(teraz)).toBe("sending");
    // zmiana statusu i wpis do kolejki są jedną transakcją: nie ma stanu "sending bez joba"
    expect(await joby(teraz)).toBe(1);
  });

  it("dwa dispatchery w tej samej chwili startują kampanię DOKŁADNIE raz", async () => {
    const campaignId = await nowaKampania("approved", new Date(Date.now() - 60_000));
    const [a, b] = await Promise.all([wypchnijZaplanowane(), wypchnijZaplanowane()]);
    const startow =
      a.uruchomione.filter((u) => u.campaignId === campaignId).length +
      b.uruchomione.filter((u) => u.campaignId === campaignId).length;
    expect(startow).toBe(1);
    // dowód rozstrzygający jest w bazie, nie w zwrotce: jeden job = jedna wysyłka
    expect(await joby(campaignId)).toBe(1);
    expect(await status(campaignId)).toBe("sending");
  });

  it("kampania bez zapadłej akceptacji klienta nie wychodzi o zaplanowanej porze", async () => {
    const campaignId = await nowaKampania("approved", new Date(Date.now() - 60_000));
    await pool.query(
      "update campaign_approvals set decision = 'changes_requested' where campaign_id = $1",
      [campaignId],
    );
    await wypchnijZaplanowane();
    expect(await status(campaignId)).toBe("approved");
    expect(await joby(campaignId)).toBe(0);
  });

  it("plan spóźniony ponad okno nie wychodzi po cichu: zgłasza się raz i zostaje w approved", async () => {
    const campaignId = await nowaKampania("approved", new Date(Date.now() - 30 * 3600_000));
    const pierwszy = await wypchnijZaplanowane();
    expect(pierwszy.uruchomione.some((u) => u.campaignId === campaignId)).toBe(false);
    expect(pierwszy.przeterminowane).toBeGreaterThanOrEqual(1);
    expect(await status(campaignId)).toBe("approved");

    const { rows: poPierwszym } = await pool.query(
      "select schedule_missed_alert_at from campaigns where id = $1",
      [campaignId],
    );
    expect(poPierwszym[0].schedule_missed_alert_at).not.toBeNull();

    // drugi przebieg nie powtarza alertu — znacznik stawiany jest atomowo, raz
    await wypchnijZaplanowane();
    const { rows: poDrugim } = await pool.query(
      "select schedule_missed_alert_at from campaigns where id = $1",
      [campaignId],
    );
    expect(new Date(poDrugim[0].schedule_missed_alert_at).getTime()).toBe(
      new Date(poPierwszym[0].schedule_missed_alert_at).getTime(),
    );
  });

  it("wstrzymany sklep nie startuje niczego nowego", async () => {
    const campaignId = await nowaKampania("approved", new Date(Date.now() - 60_000));
    await pool.query(
      "update tenants set sending_paused_at = now(), sending_pause_reason = 'test' where id = $1",
      [tenantId],
    );
    await wypchnijZaplanowane();
    expect(await status(campaignId)).toBe("approved");
    expect(await joby(campaignId)).toBe(0);
  });

  it("plan przyjmuje tylko przyszłość i tylko przed wysyłką, a zapis jest odczytywany z bazy", async () => {
    const campaignId = await nowaKampania("approved");
    const wstecz = await zaplanujKampanie(tenantId, campaignId, new Date(Date.now() - 1000));
    expect(wstecz.ok).toBe(false);

    const kiedy = new Date(Date.now() + 7200_000);
    const wynik = await zaplanujKampanie(tenantId, campaignId, kiedy);
    expect(wynik.ok).toBe(true);
    const { rows } = await pool.query("select scheduled_at from campaigns where id = $1", [campaignId]);
    // weryfikacja czyta ZAPISANY rekord, nie wejście
    expect(Math.abs(new Date(rows[0].scheduled_at).getTime() - kiedy.getTime())).toBeLessThan(1000);

    const zdjecie = await zaplanujKampanie(tenantId, campaignId, null);
    expect(zdjecie.ok).toBe(true);

    await pool.query("update campaigns set status = 'sending' where id = $1", [campaignId]);
    const wTrakcie = await zaplanujKampanie(tenantId, campaignId, new Date(Date.now() + 7200_000));
    expect(wTrakcie.ok).toBe(false);
  });

  // ── B2 ──────────────────────────────────────────────────────────────────────

  it("wstrzymanie zatrzymuje ZAJMOWANIE wiadomości, także z joba sąsiedniej kampanii", async () => {
    const campaignId = await nowaKampania("sending");
    await zbudujWiadomosciKampanii(tenantId, campaignId);
    expect((await stanyWiadomosci(campaignId)).queued).toBe(3);

    const wstrzymanie = await wstrzymajKampanie(tenantId, campaignId);
    expect(wstrzymanie.ok).toBe(true);
    expect(await status(campaignId)).toBe("paused");

    // wyslijPartie opróżnia kolejkę CAŁEGO tenanta — i właśnie dlatego warunek
    // o wstrzymanej kampanii musi siedzieć w zapytaniu zajmującym partię
    const dostawca = new DostawcaAtrapa();
    const wynik = await wyslijPartie(tenantId, { dostawca });
    expect(wynik.wyslane).toBe(0);
    expect(dostawca.wyslane).toEqual([]);
    expect((await stanyWiadomosci(campaignId)).queued).toBe(3);
  });

  it("wznowienie wraca do wysyłki i wpycha job; drugie kliknięcie nie dubluje niczego", async () => {
    const campaignId = await nowaKampania("sending");
    await zbudujWiadomosciKampanii(tenantId, campaignId);
    await wstrzymajKampanie(tenantId, campaignId);
    await pool.query("delete from jobs where tenant_id = $1", [tenantId]);

    expect((await wznowKampanie(tenantId, campaignId)).ok).toBe(true);
    expect(await status(campaignId)).toBe("sending");
    expect(await joby(campaignId)).toBe(1);

    const drugie = await wznowKampanie(tenantId, campaignId);
    expect(drugie.ok).toBe(false);
    expect(await joby(campaignId)).toBe(1);

    const dostawca = new DostawcaAtrapa();
    const wynik = await wyslijPartie(tenantId, { dostawca });
    expect(wynik.wyslane).toBe(3);
  });

  it("dwa wznowienia naraz dają jeden job, nie dwa", async () => {
    const campaignId = await nowaKampania("sending");
    await zbudujWiadomosciKampanii(tenantId, campaignId);
    await wstrzymajKampanie(tenantId, campaignId);
    await pool.query("delete from jobs where tenant_id = $1", [tenantId]);

    const [a, b] = await Promise.all([
      wznowKampanie(tenantId, campaignId),
      wznowKampanie(tenantId, campaignId),
    ]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
    expect(await joby(campaignId)).toBe(1);
  });

  it("kampanii w wysyłce nie da się odwołać bez wstrzymania", async () => {
    const campaignId = await nowaKampania("sending");
    const wynik = await odwolajKampanie(tenantId, campaignId);
    expect(wynik.ok).toBe(false);
    expect(await status(campaignId)).toBe("sending");
  });

  it("odwołanie zamyka kolejkę, a nie rusza tego, co już poszło ani tego, co jest w locie", async () => {
    const campaignId = await nowaKampania("sending");
    await zbudujWiadomosciKampanii(tenantId, campaignId);

    // jedna wiadomość faktycznie wychodzi
    const dostawca = new DostawcaAtrapa();
    await wyslijPartie(tenantId, { dostawca, limit: 1 });
    expect(dostawca.wyslane.length).toBe(1);

    // druga udaje partię zajętą w tej chwili przez innego workera
    const { rows: kolejka } = await pool.query(
      `select id from messages where tenant_id = $1 and source_type = 'campaign' and source_id = $2
         and current_state = 'queued' order by created_at limit 1`,
      [tenantId, campaignId],
    );
    const wLocie = kolejka[0].id;
    await pool.query(
      "update messages set current_state = 'claimed', claimed_at = now() where id = $1",
      [wLocie],
    );

    await wstrzymajKampanie(tenantId, campaignId);
    const wynik = await odwolajKampanie(tenantId, campaignId);
    expect(wynik.ok).toBe(true);
    if (!wynik.ok) return;
    expect(wynik.zatrzymaneTeraz).toBe(1);

    const stany = await stanyWiadomosci(campaignId);
    expect(stany.sent).toBe(1);
    // wiadomość zajęta ZOSTAJE zajęta: nadpisanie jej stanem terminalnym dałoby rekord,
    // który kłamie, bo projekcja stanu jest monotoniczna i 'sent' by go już nie poprawiło
    expect(stany.claimed).toBe(1);
    expect(stany.suppressed).toBe(1);
    expect(stany.queued).toBeUndefined();

    const { rows: zdarzenie } = await pool.query(
      `select payload->>'powod' as powod, occurred_at from message_events
        where tenant_id = $1 and event_type = 'suppressed'
          and message_id in (select id from messages where source_id = $2)`,
      [tenantId, campaignId],
    );
    expect(zdarzenie[0].powod).toBe("kampania_odwolana");
    expect(zdarzenie[0].occurred_at).not.toBeNull();

    const stan = await stanKampanii(tenantId, campaignId);
    expect(stan?.status).toBe("cancelled");
    expect(stan?.przekazane).toBe(1);
  });

  it("wiadomość, która wróciła do kolejki PO odwołaniu, jest domykana przez sprzątanie", async () => {
    const campaignId = await nowaKampania("sending");
    await zbudujWiadomosciKampanii(tenantId, campaignId);
    await wstrzymajKampanie(tenantId, campaignId);
    await odwolajKampanie(tenantId, campaignId);

    // tak wygląda wiadomość, którą worker zdążył zająć przed odwołaniem, a potem
    // oddał do kolejki (limit dobowy, błąd przejściowy, odzyskanie zombie)
    const { rows } = await pool.query(
      `select id from messages where tenant_id = $1 and source_id = $2 limit 1`,
      [tenantId, campaignId],
    );
    await pool.query(
      "update messages set current_state = 'queued', current_rank = 0 where id = $1",
      [rows[0].id],
    );

    const domkniete = await domknijOdwolane();
    expect(domkniete).toBeGreaterThanOrEqual(1);
    const { rows: po } = await pool.query("select current_state from messages where id = $1", [rows[0].id]);
    expect(po[0].current_state).toBe("suppressed");

    // i nadal nic nie wychodzi
    const dostawca = new DostawcaAtrapa();
    await wyslijPartie(tenantId, { dostawca });
    expect(dostawca.wyslane).toEqual([]);
  });
});
