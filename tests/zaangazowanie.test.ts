import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import type { DostawcaWysylki, Wiadomosc, WynikWysylki } from "../src/domain/email/port";
import {
  metrykiZaangazowania,
  zapiszZaangazowanie,
} from "../src/usecases/wysylka/zaangazowanie";
import { zgodyNaSledzenie } from "../src/usecases/wysylka/zgody";
import { wyslijPartie, zbudujWiadomosciKampanii } from "../src/usecases/wysylka/wyslij-kampanie";

/**
 * Wykonywalna specyfikacja bloku A w części A1 (zdarzenia maszynowe), A3 (pola
 * diagnostyczne), A4 (tabela zdarzeń powtarzalnych) i A5 (zgody na śledzenie).
 * Baza jest prawdziwa, dostawca jest atrapą implementującą PEŁNY port (AD-7, AD-20).
 */

const DATA_ZGODY = "2026-08-01T10:00:00.000Z";
/** Data z przeszłości: sprawdza, że zapisujemy datę ZE ŹRÓDŁA, a nie chwilę zapisu (AD-10). */
const OTWARCIE_HISTORYCZNE = new Date("2026-09-01T08:15:30.000Z");

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa-diagnostyczna";
  wyslane: string[] = [];
  async wyslij(w: Wiadomosc): Promise<WynikWysylki> {
    this.wyslane.push(w.do);
    // pełna odpowiedź dostawcy, nie sam identyfikator: dokładnie te pola mają
    // wylądować na wiadomości (A3)
    return {
      providerId: `atrapa-${w.idempotencyKey}`,
      ipPool: "pula-wspolna",
      sendingIp: "203.0.113.17",
      handedOffAt: new Date("2026-09-10T11:22:33.000Z"),
    };
  }
}

/** Wiadomość KONKRETNEGO odbiorcy: kampania ma ich kilku i `rows[0]` bywałoby losowe. */
async function wiadomoscKampanii(tenantId: string, campaignId: string, profileId: string) {
  const { rows } = await getPool().query(
    `select id, provider_id, provider, ip_pool, host(sending_ip) as sending_ip,
            sending_domain_id, handed_off_at, open_tracking_allowed, click_tracking_allowed,
            body_html, links, click_token
       from messages
      where tenant_id = $1 and source_type = 'campaign' and source_id = $2 and profile_id = $3`,
    [tenantId, campaignId, profileId],
  );
  return rows[0];
}

describe("Zaangażowanie, diagnostyka i zgody na śledzenie (Blok A)", () => {
  let tenantId: string;
  let obcyTenantId: string;
  let domenaId: string;
  let listaId: string;
  let kampaniaId: string;
  let obcaWiadomoscId: string;
  const profile: Record<string, string> = {};

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'ZAANG %'");
    await pool.query("delete from suppressions where email like 'zaang-%'");

    const t = await pool.query("insert into tenants (name) values ($1) returning id", ["ZAANG tenant"]);
    tenantId = t.rows[0].id;
    const o = await pool.query("insert into tenants (name) values ($1) returning id", ["ZAANG obcy"]);
    obcyTenantId = o.rows[0].id;

    // domena wysyłkowa zgodna z MAIL_FROM z konfiguracji: bez niej sending_domain_id
    // zostanie pusty i test A3 nie sprawdziłby niczego
    const d = await pool.query(
      `insert into sending_domains (tenant_id, domain, status, verified_at)
       values ($1, 'midrev-esp.local', 'verified', now()) returning id`,
      [tenantId],
    );
    domenaId = d.rows[0].id;

    for (const [klucz, email] of [
      ["sledzony", "zaang-sledzony@example.test"],
      ["bez_sledzenia", "zaang-bezsledzenia@example.test"],
    ] as const) {
      const p = await pool.query(
        "insert into profiles (tenant_id, email, first_name) values ($1, $2, $3) returning id",
        [tenantId, email, klucz],
      );
      profile[klucz] = p.rows[0].id;
      await pool.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
         values ($1, $2, 'email', 'granted', 'test', $3)`,
        [tenantId, p.rows[0].id, DATA_ZGODY],
      );
    }

    // jawne WYCOFANIE zgody na śledzenie, w tym samym rejestrze co zgoda marketingowa
    for (const kanal of ["email_open_tracking", "email_click_tracking"]) {
      await pool.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
         values ($1, $2, $3, 'withdrawn', 'ustawienia odbiorcy', $4)`,
        [tenantId, profile.bez_sledzenia, kanal, DATA_ZGODY],
      );
    }

    const l = await pool.query(
      "insert into lists (tenant_id, name) values ($1, 'ZAANG lista') returning id",
      [tenantId],
    );
    listaId = l.rows[0].id;
    await pool.query(
      `insert into list_members (tenant_id, list_id, profile_id)
       select $1, $2, unnest($3::uuid[])`,
      [tenantId, listaId, Object.values(profile)],
    );

    const k = await pool.query(
      `insert into campaigns (tenant_id, name, subject, content, status)
       values ($1, 'ZAANG kampania', 'Temat', $2, 'approved') returning id`,
      [tenantId, JSON.stringify({ html: '<p><a href="https://sklep.example.test/oferta">Oferta</a></p>' })],
    );
    kampaniaId = k.rows[0].id;
    await pool.query(
      `insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id)
       values ($1, $2, 'include', 'list', $3)`,
      [tenantId, kampaniaId, listaId],
    );
    await pool.query(
      `insert into tenant_send_limits (tenant_id, daily_limit) values ($1, 500)
       on conflict (tenant_id) do update set daily_limit = 500`,
      [tenantId],
    );

    await zbudujWiadomosciKampanii(tenantId, kampaniaId);
    await wyslijPartie(tenantId, { dostawca: new DostawcaAtrapa() });

    // wiadomość obcego tenanta, do sprawdzenia izolacji
    const obcyProfil = await pool.query(
      "insert into profiles (tenant_id, email) values ($1, 'zaang-obcy@example.test') returning id",
      [obcyTenantId],
    );
    const obca = await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject,
                             body_html, click_token, unsubscribe_token)
       values ($1, $2, 'campaign', gen_random_uuid(), 'zaang-obcy@example.test', 'Obcy',
               '<p>x</p>', 'zaang-klik-obcy', 'zaang-unsub-obcy') returning id`,
      [obcyTenantId, obcyProfil.rows[0].id],
    );
    obcaWiadomoscId = obca.rows[0].id;
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from suppressions where email like 'zaang-%'");
    await pool.query("delete from tenants where name like 'ZAANG %'");
    await closePool();
  });

  // --- A3 -------------------------------------------------------------------

  it("A3: wysłana wiadomość niesie komplet pól diagnostycznych, odczytanych Z BAZY", async () => {
    const w = await wiadomoscKampanii(tenantId, kampaniaId, profile.sledzony);
    expect(w.provider_id).toBe(`atrapa-${w.id}`);
    expect(w.provider).toBe("atrapa-diagnostyczna");
    expect(w.ip_pool).toBe("pula-wspolna");
    expect(w.sending_ip).toBe("203.0.113.17");
    expect(w.sending_domain_id).toBe(domenaId);
    expect(new Date(w.handed_off_at).toISOString()).toBe("2026-09-10T11:22:33.000Z");
  });

  it("A3: domena wysyłkowa innego tenanta nie da się przypiąć do naszej wiadomości", async () => {
    const pool = getPool();
    const obcaDomena = await pool.query(
      `insert into sending_domains (tenant_id, domain) values ($1, 'obcy.example') returning id`,
      [obcyTenantId],
    );
    const w = await wiadomoscKampanii(tenantId, kampaniaId, profile.sledzony);
    await expect(
      pool.query("update messages set sending_domain_id = $3 where tenant_id = $1 and id = $2", [
        tenantId,
        w.id,
        obcaDomena.rows[0].id,
      ]),
    ).rejects.toThrow(/messages_sending_domain_fk|foreign key/i);
  });

  // --- A5 -------------------------------------------------------------------

  it("A5: wycofana zgoda na śledzenie zostaje MIGAWKĄ na wiadomości i wyłącza przepisywanie linków", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `select open_tracking_allowed, click_tracking_allowed, body_html, links
         from messages where tenant_id = $1 and profile_id = $2`,
      [tenantId, profile.bez_sledzenia],
    );
    // profil bez zgody nie dostał wiadomości? dostał — zgoda marketingowa jest,
    // wycofane jest wyłącznie śledzenie
    expect(rows).toHaveLength(1);
    expect(rows[0].open_tracking_allowed).toBe(false);
    expect(rows[0].click_tracking_allowed).toBe(false);
    // link zostaje ORYGINALNY, a snapshot linków pusty: /r nie ma czego podstawić
    expect(rows[0].body_html).toContain('href="https://sklep.example.test/oferta"');
    expect(rows[0].links).toEqual([]);

    const zgodny = await pool.query(
      `select open_tracking_allowed, click_tracking_allowed, body_html
         from messages where tenant_id = $1 and profile_id = $2`,
      [tenantId, profile.sledzony],
    );
    expect(zgodny.rows[0].open_tracking_allowed).toBe(true);
    expect(zgodny.rows[0].click_tracking_allowed).toBe(true);
    expect(zgodny.rows[0].body_html).toMatch(/\/r\/[A-Za-z0-9_-]+\?l=0/);
  });

  it("A5: polityka 'wymaga_zgody' odwraca domyślną odpowiedź, zgoda z terminem wygasa", async () => {
    const pool = getPool();
    await pool.query(
      `update tenants set open_tracking_default = 'wymaga_zgody', click_tracking_default = 'wymaga_zgody'
        where id = $1`,
      [tenantId],
    );
    // brak wpisu + polityka restrykcyjna = nie wolno
    expect(await zgodyNaSledzenie(pool, tenantId, profile.sledzony)).toEqual({
      otwarcia: false,
      klikniecia: false,
    });

    // zgoda ważna bezterminowo na otwarcia, zgoda WYGASŁA na kliknięcia
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
       values ($1, $2, 'email_open_tracking', 'granted', 'formularz', now())`,
      [tenantId, profile.sledzony],
    );
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at, valid_until)
       values ($1, $2, 'email_click_tracking', 'granted', 'formularz', now() - interval '2 years',
               now() - interval '1 day')`,
      [tenantId, profile.sledzony],
    );
    expect(await zgodyNaSledzenie(pool, tenantId, profile.sledzony)).toEqual({
      otwarcia: true,
      klikniecia: false,
    });

    await pool.query(
      `update tenants set open_tracking_default = 'dozwolone', click_tracking_default = 'dozwolone'
        where id = $1`,
      [tenantId],
    );
    // przy polityce liberalnej wygasła zgoda nadal BLOKUJE: jawny wpis, który nie uprawnia
    expect(await zgodyNaSledzenie(pool, tenantId, profile.sledzony)).toEqual({
      otwarcia: true,
      klikniecia: false,
    });
  });

  // --- A1 + A4 --------------------------------------------------------------

  it("A4: wiele otwarć jednej wiadomości daje wiele wierszy i NIE rusza message_events", async () => {
    const w = await wiadomoscKampanii(tenantId, kampaniaId, profile.sledzony);
    for (let i = 0; i < 3; i++) {
      const wynik = await zapiszZaangazowanie(tenantId, w.id, {
        rodzaj: "open",
        kiedy: new Date(OTWARCIE_HISTORYCZNE.getTime() + i * 60_000),
        zrodlo: "wlasne",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        ip: "83.10.20.30",
      });
      expect(wynik.zapisane).toBe(true);
    }
    const pool = getPool();
    const { rows } = await pool.query(
      "select count(*)::int as ile from message_engagement where tenant_id = $1 and message_id = $2 and kind = 'open'",
      [tenantId, w.id],
    );
    expect(rows[0].ile).toBe(3);
    // strumień stanu zostaje nietknięty: to jest cały powód istnienia osobnej tabeli (AD-22)
    const { rows: stany } = await pool.query(
      "select array_agg(event_type order by event_type) as typy from message_events where message_id = $1",
      [w.id],
    );
    expect(stany[0].typy).toEqual(["sending", "sent"]);
  });

  it("A4 + AD-10: zapisana data to data ZE ŹRÓDŁA, odczytana z powrotem z bazy", async () => {
    const w = await wiadomoscKampanii(tenantId, kampaniaId, profile.sledzony);
    const { rows } = await getPool().query(
      `select occurred_at, recorded_at from message_engagement
        where tenant_id = $1 and message_id = $2 and kind = 'open'
        order by occurred_at limit 1`,
      [tenantId, w.id],
    );
    expect(new Date(rows[0].occurred_at).toISOString()).toBe(OTWARCIE_HISTORYCZNE.toISOString());
    // data zapisu jest osobna i mówi prawdę o tym, kiedy dowiedzieliśmy się o zdarzeniu
    expect(new Date(rows[0].recorded_at).getTime()).toBeGreaterThan(
      new Date(rows[0].occurred_at).getTime(),
    );
  });

  it("A4: powtórzone powiadomienie dostawcy nie dokłada drugiego otwarcia", async () => {
    const w = await wiadomoscKampanii(tenantId, kampaniaId, profile.sledzony);
    const zdarzenie = {
      rodzaj: "open" as const,
      kiedy: new Date("2026-09-12T09:00:00.000Z"),
      zrodlo: "dostawca" as const,
      providerEventId: "sns-0001",
      userAgent: "Mozilla/5.0",
      flagaDostawcy: false,
    };
    const pierwsze = await zapiszZaangazowanie(tenantId, w.id, zdarzenie);
    const drugie = await zapiszZaangazowanie(tenantId, w.id, zdarzenie);
    expect(pierwsze.zapisane).toBe(true);
    expect(drugie).toMatchObject({ zapisane: false, duplikat: true });
  });

  it("A1: otwarcie maszynowe i klik bota są odróżnialne od ludzkich OD PIERWSZEGO ZAPISU", async () => {
    const pool = getPool();
    const w = await wiadomoscKampanii(tenantId, kampaniaId, profile.sledzony);

    const maszynowe = await zapiszZaangazowanie(tenantId, w.id, {
      rodzaj: "open",
      kiedy: new Date("2026-09-13T07:00:00.000Z"),
      zrodlo: "wlasne",
      userAgent: "Mozilla/5.0 (GoogleImageProxy)",
    });
    expect(maszynowe).toMatchObject({ automat: true, powodAutomatu: "proxy_obrazkow" });

    const botKlik = await zapiszZaangazowanie(tenantId, w.id, {
      rodzaj: "click",
      kiedy: new Date("2026-09-13T07:00:05.000Z"),
      zrodlo: "wlasne",
      url: "https://sklep.example.test/oferta",
      userAgent: "Mozilla/5.0 SafeLinks",
    });
    expect(botKlik).toMatchObject({ automat: true, powodAutomatu: "skaner_bezpieczenstwa" });

    const { rows } = await pool.query(
      `select kind, automat, automat_powod from message_engagement
        where tenant_id = $1 and message_id = $2 and automat
        order by occurred_at`,
      [tenantId, w.id],
    );
    expect(rows.map((r) => [r.kind, r.automat_powod])).toEqual([
      ["open", "proxy_obrazkow"],
      ["click", "skaner_bezpieczenstwa"],
    ]);
  });

  it("A1: klik bota NIE wchodzi do atrybucji, klik człowieka wchodzi", async () => {
    const pool = getPool();
    const w = await wiadomoscKampanii(tenantId, kampaniaId, profile.sledzony);
    const przed = await pool.query(
      "select count(*)::int as ile from clicks where tenant_id = $1 and message_id = $2",
      [tenantId, w.id],
    );
    await zapiszZaangazowanie(tenantId, w.id, {
      rodzaj: "click",
      kiedy: new Date("2026-09-14T10:00:00.000Z"),
      zrodlo: "wlasne",
      url: "https://sklep.example.test/oferta",
      userAgent: "curl/8.5.0",
    });
    const poBocie = await pool.query(
      "select count(*)::int as ile from clicks where tenant_id = $1 and message_id = $2",
      [tenantId, w.id],
    );
    // skaner doliczony do atrybucji przypisałby kampanii przychód, którego nie wygenerowała
    expect(poBocie.rows[0].ile).toBe(przed.rows[0].ile);

    await zapiszZaangazowanie(tenantId, w.id, {
      rodzaj: "click",
      kiedy: new Date("2026-09-14T10:05:00.000Z"),
      zrodlo: "wlasne",
      url: "https://sklep.example.test/oferta",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    });
    const poCzlowieku = await pool.query(
      `select count(*)::int as ile, max(occurred_at) as ostatni
         from clicks where tenant_id = $1 and message_id = $2`,
      [tenantId, w.id],
    );
    expect(poCzlowieku.rows[0].ile).toBe(przed.rows[0].ile + 1);
    // klik w `clicks` też dostaje datę ze źródła, nie datę zapisu
    expect(new Date(poCzlowieku.rows[0].ostatni).toISOString()).toBe("2026-09-14T10:05:00.000Z");
  });

  it("A5: zdarzenie na wiadomości bez zgody na śledzenie jest odrzucane", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      "select id from messages where tenant_id = $1 and profile_id = $2",
      [tenantId, profile.bez_sledzenia],
    );
    const odrzucone = await zapiszZaangazowanie(tenantId, rows[0].id, {
      rodzaj: "open",
      kiedy: new Date("2026-09-15T10:00:00.000Z"),
      zrodlo: "wlasne",
      userAgent: "Mozilla/5.0",
    });
    expect(odrzucone).toMatchObject({
      zapisane: false,
      powodOdrzucenia: "sledzenie_otwarc_niedozwolone",
    });
    const { rows: ile } = await pool.query(
      "select count(*)::int as ile from message_engagement where tenant_id = $1 and message_id = $2",
      [tenantId, rows[0].id],
    );
    expect(ile[0].ile).toBe(0);
  });

  it("izolacja tenantów: zdarzenie pod cudzy identyfikator wiadomości nie ma gdzie trafić", async () => {
    const wynik = await zapiszZaangazowanie(tenantId, obcaWiadomoscId, {
      rodzaj: "open",
      kiedy: new Date("2026-09-15T11:00:00.000Z"),
      zrodlo: "wlasne",
      userAgent: "Mozilla/5.0",
    });
    expect(wynik).toMatchObject({ zapisane: false, powodOdrzucenia: "brak_wiadomosci" });
  });

  it("izolacja tenantów: baza odrzuca wiersz zaangażowania z cudzym tenant_id", async () => {
    const pool = getPool();
    const w = await wiadomoscKampanii(tenantId, kampaniaId, profile.sledzony);
    await expect(
      pool.query(
        `insert into message_engagement
           (tenant_id, message_id, source_type, source_id, kind, source, occurred_at)
         values ($1, $2, 'campaign', $3, 'open', 'wlasne', now())`,
        [obcyTenantId, w.id, kampaniaId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("baza pilnuje, żeby zdenormalizowane źródło zgadzało się z wiadomością", async () => {
    const pool = getPool();
    const w = await wiadomoscKampanii(tenantId, kampaniaId, profile.sledzony);
    await expect(
      pool.query(
        `insert into message_engagement
           (tenant_id, message_id, source_type, source_id, kind, source, occurred_at)
         values ($1, $2, 'campaign', gen_random_uuid(), 'open', 'wlasne', now())`,
        [tenantId, w.id],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("opóźnienie dostarczenia zapisuje swój typ i nie udaje otwarcia", async () => {
    const pool = getPool();
    const w = await wiadomoscKampanii(tenantId, kampaniaId, profile.sledzony);
    const wynik = await zapiszZaangazowanie(tenantId, w.id, {
      rodzaj: "delivery_delay",
      kiedy: new Date("2026-09-16T12:00:00.000Z"),
      zrodlo: "dostawca",
      delayType: "SpamDetected",
      providerEventId: "sns-delay-1",
    });
    expect(wynik).toMatchObject({ zapisane: true, automat: null });
    const { rows } = await pool.query(
      `select delay_type, url from message_engagement
        where tenant_id = $1 and message_id = $2 and kind = 'delivery_delay'`,
      [tenantId, w.id],
    );
    expect(rows[0].delay_type).toBe("SpamDetected");
    expect(rows[0].url).toBeNull();
  });

  it("metryki kampanii rozdzielają zaangażowanie ludzkie od całkowitego", async () => {
    const m = await metrykiZaangazowania(tenantId, "campaign", kampaniaId);
    // 3 otwarcia ludzkie + 1 z dostawcy (Unlikely) + 1 proxy obrazków
    expect(m.otwarcia).toBe(5);
    expect(m.otwarciaLudzkie).toBe(4);
    expect(m.otwarciaUnikalne).toBe(1);
    // 3 kliknięcia: SafeLinks, curl, człowiek
    expect(m.klikniecia).toBe(3);
    expect(m.kliknieciaLudzkie).toBe(1);
    expect(m.opoznienia).toBe(1);
  });
});
