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

  it("A3: wysłana wiadomość zapisuje dostawcę i moment przekazania, a brakujących pól nie zmyśla", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `select provider, ip_pool, sending_ip, sending_domain_id, handed_off_at
         from messages where tenant_id = $1 and source_type = 'campaign' and source_id = $2`,
      [tenantId, campaignId],
    );
    expect(rows[0].provider).toBe("atrapa");
    // atrapa nie podaje puli ani IP — kolumny zostają PUSTE zamiast dostać wartość zastępczą,
    // bo przy pierwszym problemie z dostarczalnością zmyślone IP jest gorsze niż żadne
    expect(rows[0].ip_pool).toBeNull();
    expect(rows[0].sending_ip).toBeNull();
    // tenant testowy nie ma wiersza w sending_domains, więc powiązania też nie ma
    expect(rows[0].sending_domain_id).toBeNull();
    expect(rows[0].handed_off_at).not.toBeNull();
  });

  it("A2: zdarzenie o pozytywnym wyniku nie niesie żadnej klasyfikacji odbicia", async () => {
    const { rows } = await getPool().query(
      `select e.bounce_class, e.add_exclusion, e.counts_to_rate, e.occurred_at, e.recorded_at
         from message_events e join messages m on m.id = e.message_id
        where m.tenant_id = $1 and m.source_id = $2 and e.event_type = 'sent'`,
      [tenantId, campaignId],
    );
    expect(rows[0].bounce_class).toBeNull();
    expect(rows[0].add_exclusion).toBeNull();
    expect(rows[0].counts_to_rate).toBeNull();
    // przejście stanu dostaje datę z zegara BAZY, tego samego, po którym liczy się doba
    expect(rows[0].occurred_at).not.toBeNull();
    expect(rows[0].recorded_at).not.toBeNull();
  });

  it("A5: bez ustawień tenanta śledzenie zostaje włączone, a decyzja ląduje na wiadomości", async () => {
    const { rows } = await getPool().query(
      `select open_tracking_allowed, click_tracking_allowed from messages
        where tenant_id = $1 and source_type = 'campaign' and source_id = $2`,
      [tenantId, campaignId],
    );
    // domyślna polityka 'dozwolone' nie zmienia dotychczasowego zachowania; zmiana
    // domyślnej odpowiedzi jest świadomą decyzją tenanta, nie efektem migracji
    expect(rows[0].open_tracking_allowed).toBe(true);
    expect(rows[0].click_tracking_allowed).toBe(true);
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

  it("dwa workery w tej samej chwili nie wysyłają tej samej wiadomości dwa razy", async () => {
    const pool = getPool();
    // dziesięć wiadomości bez profilu (ścieżka testowa: bramka canSendTo nie ma czego
    // sprawdzać), żeby badać WYŁĄCZNIE zajmowanie partii przez SKIP LOCKED
    await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject,
                             body_html, click_token, unsubscribe_token)
       select $1, null, 'test', gen_random_uuid(), 'wys-wyscig@example.test', 'Wyścig', '<p>x</p>',
              gen_random_uuid()::text, gen_random_uuid()::text
         from generate_series(1, 10)`,
      [tenantId],
    );

    // JEDNA atrapa dla obu przebiegów: dowodem nie jest suma zwróconych liczników,
    // tylko lista adresów, które faktycznie poszły do dostawcy
    const dostawca = new DostawcaAtrapa();
    const [a, b] = await Promise.all([
      wyslijPartie(tenantId, { dostawca, limit: 10 }),
      wyslijPartie(tenantId, { dostawca, limit: 10 }),
    ]);
    expect(a.wyslane + b.wyslane).toBe(10);
    expect(dostawca.wyslane.length).toBe(10);

    const { rows } = await pool.query(
      `select m.current_state, count(*)::int as ile,
              count(distinct e.id)::int as zdarzen_sent
         from messages m
         left join message_events e on e.message_id = m.id and e.event_type = 'sent'
        where m.tenant_id = $1 and m.email = 'wys-wyscig@example.test'
        group by m.current_state`,
      [tenantId],
    );
    expect(rows).toEqual([{ current_state: "sent", ile: 10, zdarzen_sent: 10 }]);
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
