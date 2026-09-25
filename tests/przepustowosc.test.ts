import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { config } from "../src/config";
import type { DostawcaWysylki, Wiadomosc, WynikWysylki } from "../src/domain/email/port";
import { przepiszLinki, zlozWiadomosc } from "../src/usecases/wysylka/renderuj";
import { naPoleCzasuPolskiego, parsujCzasPolski, przesuniecieMinut } from "../src/usecases/wysylka/strefa";
import { wyslijPartie, zbudujWiadomosciKampanii } from "../src/usecases/wysylka/wyslij-kampanie";
import { zgodyNaSledzenie } from "../src/usecases/wysylka/zgody";
import { odczytajLimit, zapiszLimit } from "../src/usecases/wysylka-konfiguracja/limity";

/**
 * Audyt 24.09, #5 (przepustowość), #6 (strefa czasu), #7 (linki i APP_URL).
 * Regresja: budowa wiadomości jednym INSERT…SELECT ma dawać BAJT W BAJT to samo, co
 * dawała pętla per profil (zlozWiadomosc z tokenami tej wiadomości), także przy różnych
 * zgodach na śledzenie. Wyścig dwóch workerów przy większej partii: żadna wiadomość
 * nie wychodzi dwa razy, a dostawca jest zamykany po każdej partii.
 */

class DostawcaZPula implements DostawcaWysylki {
  readonly nazwa = "atrapa-pula";
  wyslane: string[] = [];
  zamkniecia = 0;
  async wyslij(w: Wiadomosc): Promise<WynikWysylki> {
    this.wyslane.push(w.do);
    return { providerId: `<${w.idempotencyKey}@atrapa>` };
  }
  async zamknij() {
    this.zamkniecia++;
  }
}

describe("Budowa wiadomości jednym zapytaniem (regresja) i partie", () => {
  let tenantId: string;
  let campaignId: string;
  const profile: Record<string, string> = {};
  const HTML = `<p>Cześć! <a href="https://sklep.example.test/a">A</a>, <a href='https://sklep.example.test/b?x=1&y=2'>B</a> i <a href=https://sklep.example.test/c>C</a></p>`;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'PRZ %'");
    tenantId = (await pool.query("insert into tenants (name, open_tracking_default, click_tracking_default) values ($1, 'dozwolone', 'wymaga_zgody') returning id", ["PRZ Sklep <&>"])).rows[0].id;
    const lista = (await pool.query("insert into lists (tenant_id, name) values ($1, 'PRZ lista') returning id", [tenantId])).rows[0].id;
    // cztery profile: bez wpisów, ze zgodą na kliknięcia, z wycofaną zgodą na otwarcia, z wygasłą zgodą na kliknięcia
    for (const nazwa of ["czysty", "klik_zgoda", "otwarcia_wycofane", "klik_wygasla"]) {
      const email = `prz-${nazwa}@example.test`;
      const p = await pool.query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantId, email]);
      profile[nazwa] = p.rows[0].id;
      await pool.query(`insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email', 'granted', 'test', now() - interval '2 days')`, [tenantId, p.rows[0].id]);
      await pool.query("insert into list_members (tenant_id, list_id, profile_id) values ($1, $2, $3)", [tenantId, lista, p.rows[0].id]);
    }
    await pool.query(`insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email_click_tracking', 'granted', 'test', now() - interval '1 day')`, [tenantId, profile.klik_zgoda]);
    await pool.query(`insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email_open_tracking', 'granted', 'test', now() - interval '3 days')`, [tenantId, profile.otwarcia_wycofane]);
    await pool.query(`insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email_open_tracking', 'withdrawn', 'test', now() - interval '1 day')`, [tenantId, profile.otwarcia_wycofane]);
    await pool.query(`insert into consents (tenant_id, profile_id, channel, state, source, occurred_at, valid_until) values ($1, $2, 'email_click_tracking', 'granted', 'test', now() - interval '30 days', now() - interval '1 day')`, [tenantId, profile.klik_wygasla]);
    campaignId = (
      await pool.query(`insert into campaigns (tenant_id, name, subject, content, status) values ($1, 'PRZ', 'Temat', $2, 'approved') returning id`, [tenantId, JSON.stringify({ html: HTML })])
    ).rows[0].id;
    await pool.query(`insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id) values ($1, $2, 'include', 'list', $3)`, [tenantId, campaignId, lista]);
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like 'PRZ %'");
    await closePool();
  });

  it("body_html, links i flagi śledzenia są identyczne z tym, co dałaby ścieżka per profil", async () => {
    const pool = getPool();
    const wynik = await zbudujWiadomosciKampanii(tenantId, campaignId);
    expect(wynik).toEqual({ utworzone: 4, kandydatow: 4 });
    expect((await zbudujWiadomosciKampanii(tenantId, campaignId)).utworzone).toBe(0);

    const { rows } = await pool.query(
      `select m.profile_id, m.email, m.body_html, m.links, m.click_token, m.unsubscribe_token, m.open_tracking_allowed, m.click_tracking_allowed, m.subject
         from messages m where m.tenant_id = $1 and m.source_id = $2`,
      [tenantId, campaignId],
    );
    expect(rows).toHaveLength(4);
    const oczekiwane: Record<string, { otwarcia: boolean; klikniecia: boolean }> = {
      czysty: { otwarcia: true, klikniecia: false },
      klik_zgoda: { otwarcia: true, klikniecia: true },
      otwarcia_wycofane: { otwarcia: false, klikniecia: false },
      klik_wygasla: { otwarcia: true, klikniecia: false },
    };
    for (const [nazwa, id] of Object.entries(profile)) {
      const m = rows.find((r) => r.profile_id === id)!;
      // ta sama reguła co zgodyNaSledzenie w JS
      const zgody = await zgodyNaSledzenie(pool, tenantId, id);
      expect(zgody, nazwa).toEqual(oczekiwane[nazwa]);
      expect({ otwarcia: m.open_tracking_allowed, klikniecia: m.click_tracking_allowed }, nazwa).toEqual(oczekiwane[nazwa]);
      const wzorzec = zlozWiadomosc({
        trescHtml: HTML,
        clickToken: m.click_token,
        unsubscribeToken: m.unsubscribe_token,
        nazwaSklepu: "PRZ Sklep <&>",
        sledzKlikniecia: zgody.klikniecia,
        sledzOtwarcia: zgody.otwarcia,
      });
      expect(m.body_html, nazwa).toBe(wzorzec.html);
      expect(m.links, nazwa).toEqual(wzorzec.linki);
      expect(m.subject).toBe("Temat");
      // tokeny unikalne per wiadomość i nieobecne w cudzych treściach
      for (const inna of rows) {
        if (inna.profile_id === m.profile_id) continue;
        expect(inna.body_html).not.toContain(m.click_token);
        expect(inna.body_html).not.toContain(m.unsubscribe_token);
      }
    }
    // nazwa sklepu w stopce escapowana (#7)
    expect(rows[0].body_html).toContain("PRZ Sklep &lt;&amp;&gt;");
    expect(rows[0].body_html).not.toContain("PRZ Sklep <&>");
    // wszystkie trzy formy href przepisane (#7)
    const zKlikiem = rows.find((r) => r.profile_id === profile.klik_zgoda)!;
    expect(zKlikiem.links).toEqual(["https://sklep.example.test/a", "https://sklep.example.test/b?x=1&y=2", "https://sklep.example.test/c"]);
    expect(zKlikiem.body_html).not.toContain("sklep.example.test");
  });

  it("dwa workery z partią 100 nie wysyłają żadnej wiadomości dwa razy, a dostawca jest zamykany po każdej partii", async () => {
    const pool = getPool();
    await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
       select $1, null, 'test', gen_random_uuid(), 'prz-wyscig@example.test', 'W', '<p>x</p>', gen_random_uuid()::text, gen_random_uuid()::text
         from generate_series(1, 150)`,
      [tenantId],
    );
    const dostawca = new DostawcaZPula();
    const [a, b] = await Promise.all([
      wyslijPartie(tenantId, { dostawca, limit: 100 }),
      wyslijPartie(tenantId, { dostawca, limit: 100 }),
    ]);
    // 4 wiadomości kampanii + 150 testowych = 154; dwie partie po 100 obejmują wszystko
    expect(a.wyslane + b.wyslane).toBe(154);
    expect(dostawca.wyslane.length).toBe(154);
    expect(new Set(dostawca.wyslane.filter((e) => e !== "prz-wyscig@example.test")).size).toBe(4);
    expect(dostawca.zamkniecia).toBe(2);
    const { rows } = await pool.query(
      `select count(*)::int as ile, count(distinct e.id)::int as zdarzen_sent
         from messages m join message_events e on e.message_id = m.id and e.event_type = 'sent'
        where m.tenant_id = $1`,
      [tenantId],
    );
    expect(rows[0]).toEqual({ ile: 154, zdarzen_sent: 154 });
    const stany = await pool.query("select distinct current_state from messages where tenant_id = $1", [tenantId]);
    expect(stany.rows.map((r) => r.current_state)).toEqual(["sent"]);
  });

  it("dostawca jest zamykany także po wyjątku w środku partii", async () => {
    const pool = getPool();
    await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
       values ($1, null, 'test', gen_random_uuid(), 'prz-awaria@example.test', 'W', '<p>x</p>', gen_random_uuid()::text, gen_random_uuid()::text)`,
      [tenantId],
    );
    const dostawca = new DostawcaZPula();
    dostawca.wyslij = async () => {
      // zerwane połączenie = wynik nieznany, wiadomość zostaje w sending (rekoncyliacja)
      const e = new Error("SMTP: zerwane") as Error & { code?: string };
      e.code = "ECONNRESET";
      throw e;
    };
    const w = await wyslijPartie(tenantId, { dostawca, limit: 10 });
    expect(w.bledy).toBe(1);
    expect(dostawca.zamkniecia).toBe(1);
    await pool.query("delete from messages where tenant_id = $1 and email = 'prz-awaria@example.test'", [tenantId]);
  });

  it("limit dobowy: odczyt z domyślną wartością, zapis z walidacją i odczytem zwrotnym", async () => {
    const przed = await odczytajLimit(tenantId);
    expect(przed).toMatchObject({ limit: 500, domyslny: true });
    expect(przed.zuzyteDzis).toBeGreaterThanOrEqual(154);
    expect(await zapiszLimit(tenantId, "0")).toMatchObject({ ok: false });
    expect(await zapiszLimit(tenantId, "abc")).toMatchObject({ ok: false });
    expect(await zapiszLimit(tenantId, "999999999")).toMatchObject({ ok: false });
    expect(await zapiszLimit(tenantId, " 2 000 ")).toEqual({ ok: true, limit: 2000 });
    const po = await odczytajLimit(tenantId);
    expect(po).toMatchObject({ limit: 2000, domyslny: false });
    expect(po.wolneDzis).toBe(2000 - po.zuzyteDzis);
  });
});

describe("Linki i strefa czasu (#6, #7)", () => {
  it("przepiszLinki łapie href w cudzysłowie podwójnym, pojedynczym i bez cudzysłowu; nie rusza mailto i względnych", () => {
    const html = `<a href="https://a.test/1">1</a> <a href='http://b.test/2'>2</a> <a href=https://c.test/3?x=1>3</a> <a HREF = "https://d.test/4">4</a> <a href="mailto:x@y">m</a> <a href="/lokalny">l</a>`;
    const { html: out, linki } = przepiszLinki(html, "TOK");
    expect(linki).toEqual(["https://a.test/1", "http://b.test/2", "https://c.test/3?x=1", "https://d.test/4"]);
    expect(out).toContain(`href="${config().APP_URL}/r/TOK?l=0"`);
    expect(out).toContain(`href="${config().APP_URL}/r/TOK?l=3"`);
    expect(out).toContain('href="mailto:x@y"');
    expect(out).toContain('href="/lokalny"');
    expect(out).not.toContain("a.test");
  });

  it("czas polski: lato (CEST, +2) i zima (CET, +1) parsowane niezależnie od strefy serwera, i z powrotem do pola", () => {
    // Black Friday 2026: 27 listopada, zima
    const zima = parsujCzasPolski("2026-11-27T08:00");
    expect(zima?.toISOString()).toBe("2026-11-27T07:00:00.000Z");
    expect(przesuniecieMinut(zima!)).toBe(60);
    expect(naPoleCzasuPolskiego(zima)).toBe("2026-11-27T08:00");
    // lato
    const lato = parsujCzasPolski("2026-07-15T10:30");
    expect(lato?.toISOString()).toBe("2026-07-15T08:30:00.000Z");
    expect(przesuniecieMinut(lato!)).toBe(120);
    expect(naPoleCzasuPolskiego(lato)).toBe("2026-07-15T10:30");
    // dzień zmiany czasu: 25.10.2026 o 3:00 wraca 2:00. 01:30 to jeszcze CEST, 03:30 już CET
    expect(parsujCzasPolski("2026-10-25T01:30")?.toISOString()).toBe("2026-10-24T23:30:00.000Z");
    expect(parsujCzasPolski("2026-10-25T03:30")?.toISOString()).toBe("2026-10-25T02:30:00.000Z");
    // luka w marcu (29.03.2026, 2:00 → 3:00): 02:30 nie istnieje, ląduje godzinę później
    expect(parsujCzasPolski("2026-03-29T02:30")?.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    // śmieci
    expect(parsujCzasPolski("2026-02-31T10:00")).toBeNull();
    expect(parsujCzasPolski("jutro")).toBeNull();
    expect(parsujCzasPolski("2026-11-27T25:00")).toBeNull();
    expect(naPoleCzasuPolskiego(null)).toBe("");
    // wartość z bazy jako tekst ISO
    expect(naPoleCzasuPolskiego("2026-11-27T07:00:00.000Z")).toBe("2026-11-27T08:00");
  });
});
