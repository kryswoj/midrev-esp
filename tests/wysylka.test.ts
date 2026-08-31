import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { canSendTo } from "../src/usecases/wysylka/can-send-to";
import { wyslijPartie, zbudujWiadomosciKampanii } from "../src/usecases/wysylka/wyslij-kampanie";
import { przeliczAtrybucje, raportKampanii } from "../src/usecases/przelicz-atrybucje";
import type { DostawcaWysylki } from "../src/domain/email/port";

// Wykonywalna specyfikacja silnika wysyłki (Epik 3) i atrybucji (Epik 5).
// Dostawca jest atrapą implementującą port (AD-7): testujemy NASZE zachowanie,
// nie Mailpita. Baza jest prawdziwa (AD-20).

const D = "2026-08-01T10:00:00.000Z";

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: string[] = [];
  padnijPo = Infinity;
  async wyslij(w: { do: string; idempotencyKey: string }) {
    if (this.wyslane.length >= this.padnijPo) throw new Error("atrapa: awaria dostawcy");
    this.wyslane.push(w.do);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

describe("Silnik wysyłki", () => {
  let tenantId: string;
  let campaignId: string;
  const profile: Record<string, string> = {};

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'WYS %'");
    const t = await pool.query("insert into tenants (name) values ($1) returning id", ["WYS tenant"]);
    tenantId = t.rows[0].id;

    // czterej odbiorcy: ze zgodą, bez zgody, wypisany ze sklepu, na globalnej liście
    for (const [klucz, email] of [
      ["zgodny", "wys-zgodny@example.test"],
      ["bez_zgody", "wys-bezzgody@example.test"],
      ["wypisany", "wys-wypisany@example.test"],
      ["spalony", "wys-spalony@example.test"],
    ] as const) {
      const p = await pool.query(
        "insert into profiles (tenant_id, email, first_name) values ($1, $2, $3) returning id",
        [tenantId, email, klucz],
      );
      profile[klucz] = p.rows[0].id;
    }
    for (const klucz of ["zgodny", "wypisany", "spalony"]) {
      await pool.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
         values ($1, $2, 'email', 'granted', 'test', $3)`,
        [tenantId, profile[klucz], D],
      );
    }
    await pool.query(
      `insert into tenant_suppressions (tenant_id, email, action, reason) values ($1, $2, 'suppressed', 'test')`,
      [tenantId, "wys-wypisany@example.test"],
    );
    await pool.query(
      `insert into suppressions (email, reason) values ($1, 'hard bounce u innego tenanta')
       on conflict do nothing`,
      ["wys-spalony@example.test"],
    );

    const lista = await pool.query(
      "insert into lists (tenant_id, name) values ($1, 'WYS lista') returning id",
      [tenantId],
    );
    await pool.query(
      `insert into list_members (tenant_id, list_id, profile_id)
       select $1, $2, unnest($3::uuid[])`,
      [tenantId, lista.rows[0].id, Object.values(profile)],
    );
    const k = await pool.query(
      `insert into campaigns (tenant_id, name, subject, content, status)
       values ($1, 'WYS kampania', 'Temat testowy', $2, 'approved') returning id`,
      [tenantId, JSON.stringify({ html: '<p>Cześć! <a href="https://sklep.example.test/promo">Promocja</a></p>' })],
    );
    campaignId = k.rows[0].id;
    await pool.query(
      `insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id)
       values ($1, $2, 'include', 'list', $3)`,
      [tenantId, campaignId, lista.rows[0].id],
    );
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from suppressions where email = 'wys-spalony@example.test'");
    await pool.query("delete from tenants where name like 'WYS %'");
    await closePool();
  });

  it("bramka odmawia z właściwym powodem dla każdej klasy odbiorcy", async () => {
    const pool = getPool();
    expect(await canSendTo(pool, tenantId, profile.zgodny)).toEqual({ wolno: true });
    expect((await canSendTo(pool, tenantId, profile.bez_zgody)).powod).toBe("brak_zgody");
    expect((await canSendTo(pool, tenantId, profile.wypisany)).powod).toBe("wykluczenie_sklepu");
    // globalna lista wygrywa z lokalną: chroni reputację całej platformy
    expect((await canSendTo(pool, tenantId, profile.spalony)).powod).toBe("wykluczenie_globalne");
  });

  it("budowa wiadomości jest idempotentna: tylko przechodzący bramkę, bez duplikatów", async () => {
    const raz = await zbudujWiadomosciKampanii(tenantId, campaignId);
    // bramka planowania: tylko 'zgodny' przechodzi (pozostali odpadają już na liście kandydatów)
    expect(raz.utworzone).toBe(1);
    const dwa = await zbudujWiadomosciKampanii(tenantId, campaignId);
    expect(dwa.utworzone).toBe(0);
  });

  it("wysyłka: sending zapisane PRZED dostawcą, sent po, HTML z przepisanymi linkami i wypisaniem", async () => {
    const pool = getPool();
    const dostawca = new DostawcaAtrapa();
    const wynik = await wyslijPartie(tenantId, { dostawca });
    expect(wynik.wyslane).toBe(1);
    expect(dostawca.wyslane).toEqual(["wys-zgodny@example.test"]);

    const { rows } = await pool.query(
      `select m.body_html, m.current_state, m.provider_id,
              array(select event_type from message_events e where e.message_id = m.id order by occurred_at) as zdarzenia
         from messages m where m.tenant_id = $1 and m.source_type = 'campaign'`,
      [tenantId],
    );
    expect(rows[0].current_state).toBe("sent");
    expect(rows[0].zdarzenia).toEqual(["sending", "sent"]);
    expect(rows[0].provider_id).toContain("atrapa-");
    // link przepisany na śledzony, oryginału nie ma w treści, stopka z wypisaniem jest
    expect(rows[0].body_html).not.toContain('href="https://sklep.example.test/promo"');
    expect(rows[0].body_html).toMatch(/\/r\/[A-Za-z0-9_-]+\?l=0/);
    expect(rows[0].body_html).toMatch(/\/u\/[A-Za-z0-9_-]+/);
  });

  it("wypisanie między budową a wysyłką zatrzymuje wiadomość w bramce (AD-25)", async () => {
    const pool = getPool();
    // nowa kampania do tych samych odbiorców
    const k = await pool.query(
      `insert into campaigns (tenant_id, name, subject, content, status)
       values ($1, 'WYS kampania 2', 'Drugi temat', $2, 'approved') returning id`,
      [tenantId, JSON.stringify({ html: "<p>Druga</p>" })],
    );
    const lista = await pool.query("select id from lists where tenant_id = $1", [tenantId]);
    await pool.query(
      `insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id)
       values ($1, $2, 'include', 'list', $3)`,
      [tenantId, k.rows[0].id, lista.rows[0].id],
    );
    await zbudujWiadomosciKampanii(tenantId, k.rows[0].id);
    // wypisanie PO zbudowaniu listy, PRZED wysyłką: dokładnie luka, którą zamyka AD-25
    await pool.query(
      `insert into tenant_suppressions (tenant_id, email, action, reason)
       values ($1, 'wys-zgodny@example.test', 'suppressed', 'wypisał się po zbudowaniu listy')`,
      [tenantId],
    );
    const dostawca = new DostawcaAtrapa();
    const wynik = await wyslijPartie(tenantId, { dostawca });
    expect(dostawca.wyslane).toEqual([]);
    expect(wynik.odmowy).toBe(1);
    const { rows } = await pool.query(
      `select current_state from messages where tenant_id = $1 and source_id = $2`,
      [tenantId, k.rows[0].id],
    );
    expect(rows[0].current_state).toBe("suppressed");
    // sprzątanie wpisu, żeby dalsze testy widziały zgodnego odbiorcę
    await pool.query(
      `insert into tenant_suppressions (tenant_id, email, action, reason, actor)
       values ($1, 'wys-zgodny@example.test', 'released', 'test', 'admin')`,
      [tenantId],
    );
  });

  it("klik w śledzony link plus zamówienie w oknie daje atrybucję przychodu", async () => {
    const pool = getPool();
    const { rows: wiadomosci } = await pool.query(
      `select id, click_token from messages
        where tenant_id = $1 and source_type = 'campaign' and source_id = $2`,
      [tenantId, campaignId],
    );
    const wiadomosc = wiadomosci[0];

    // klik: wczoraj; zamówienie: dziś (w oknie 120h)
    await pool.query(
      `insert into clicks (tenant_id, message_id, profile_id, url, occurred_at)
       values ($1, $2, $3, 'https://sklep.example.test/promo', now() - interval '20 hours')`,
      [tenantId, wiadomosc.id, profile.zgodny],
    );
    const sklep = await pool.query(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted)
       values ($1, 'woocommerce', 'http://wys.test', $2) returning id`,
      [tenantId, Buffer.from("x")],
    );
    await pool.query(
      `insert into orders (tenant_id, store_id, profile_id, external_id, status, total_minor, currency, occurred_at)
       values ($1, $2, $3, 'wys-1', 'completed', 25900, 'PLN', now())`,
      [tenantId, sklep.rows[0].id, profile.zgodny],
    );

    const przebieg = await przeliczAtrybucje(tenantId);
    expect(przebieg.przypisanych).toBe(1);
    const raport = await raportKampanii(tenantId, campaignId);
    expect(Number(raport.przychod_minor)).toBe(25900);
    expect(raport.zamowien).toBe(1);

    // zamówienie POZA oknem nie dostaje atrybucji: nowy przebieg nie dopisuje go
    await pool.query(
      `insert into orders (tenant_id, store_id, profile_id, external_id, status, total_minor, currency, occurred_at)
       values ($1, $2, $3, 'wys-2', 'completed', 9900, 'PLN', now() + interval '200 hours')`,
      [tenantId, sklep.rows[0].id, profile.zgodny],
    );
    const przebieg2 = await przeliczAtrybucje(tenantId);
    expect(przebieg2.przypisanych).toBe(1);
  });

  it("limit dobowy zatrzymuje wysyłkę zanim poleci (FR52)", async () => {
    const pool = getPool();
    await pool.query(
      `insert into tenant_send_limits (tenant_id, daily_limit) values ($1, 1)
       on conflict (tenant_id) do update set daily_limit = 1`,
      [tenantId],
    );
    // jedna wiadomość sent już dziś jest (z wcześniejszego testu), więc miejsce = 0
    const dostawca = new DostawcaAtrapa();
    const wynik = await wyslijPartie(tenantId, { dostawca });
    expect(wynik.powodZatrzymania).toBe("limit_dobowy");
    expect(dostawca.wyslane).toEqual([]);
  });
});
