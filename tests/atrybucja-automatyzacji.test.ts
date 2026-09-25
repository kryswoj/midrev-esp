import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import {
  przeliczAtrybucje,
  przychodAutomatyzacji,
  raportAutomatyzacji,
  raportKampanii,
} from "../src/usecases/przelicz-atrybucje";
import { przychodPrzegladu } from "../src/usecases/raport-przegladu";
import { zapiszZaangazowanie } from "../src/usecases/wysylka/zaangazowanie";

// Wykonywalna specyfikacja atrybucji po migracji 0018: last-click liczony po wiadomościach
// z kampanii I z automatyzacji razem, z jednym źródłem na zamówienie.
//
// Daty są STAŁE, nie `now()`: data zdarzenia pochodzi ze źródła (AD-10), a test na `now()`
// utrwala nawyk, który kiedyś sfałszował raporty przychodu. Okno reguły to domyślne 120 h.

const PREFIKS = "ATR0018 ";
const ZAMOWIENIE = "2026-08-10T12:00:00.000Z";
const godzinPrzed = (h: number) => new Date(Date.parse(ZAMOWIENIE) - h * 3_600_000).toISOString();

interface Swiat {
  tenantId: string;
  profileId: string;
  storeId: string;
  campaignId: string;
  journeyId: string;
}

async function zbudujSwiat(nazwa: string): Promise<Swiat> {
  const pool = getPool();
  const t = await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + nazwa]);
  const tenantId = t.rows[0].id;
  const p = await pool.query(
    "insert into profiles (tenant_id, email) values ($1, $2) returning id",
    [tenantId, `atr-${randomUUID()}@example.test`],
  );
  const s = await pool.query(
    `insert into stores (tenant_id, platform, base_url, credentials_encrypted)
     values ($1, 'woocommerce', 'http://atr.test', $2) returning id`,
    [tenantId, Buffer.from("x")],
  );
  const k = await pool.query(
    `insert into campaigns (tenant_id, name, subject, content, status)
     values ($1, 'ATR kampania', 'Temat', '{}', 'sent') returning id`,
    [tenantId],
  );
  const j = await pool.query(
    `insert into journeys (tenant_id, name, trigger_event, subject)
     values ($1, 'ATR powitanie', 'popup.submitted', 'Witaj') returning id`,
    [tenantId],
  );
  return {
    tenantId,
    profileId: p.rows[0].id,
    storeId: s.rows[0].id,
    campaignId: k.rows[0].id,
    journeyId: j.rows[0].id,
  };
}

async function wiadomosc(
  tenantId: string,
  profileId: string | null,
  sourceType: "campaign" | "journey" | "test",
  sourceId: string,
): Promise<string> {
  const { rows } = await getPool().query(
    `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject,
                           body_html, click_token, unsubscribe_token)
     values ($1, $2, $3, $4, $5, 'Temat', '<p>x</p>', $6, $7) returning id`,
    [tenantId, profileId, sourceType, sourceId, `atr-${randomUUID()}@example.test`, randomUUID(), randomUUID()],
  );
  return rows[0].id;
}

async function klik(tenantId: string, messageId: string, profileId: string, kiedy: string): Promise<string> {
  const { rows } = await getPool().query(
    `insert into clicks (tenant_id, message_id, profile_id, url, occurred_at)
     values ($1, $2, $3, 'https://sklep.example.test/', $4) returning id`,
    [tenantId, messageId, profileId, kiedy],
  );
  return rows[0].id;
}

async function zamowienie(w: Swiat, kwota: number, kiedy = ZAMOWIENIE): Promise<string> {
  const { rows } = await getPool().query(
    `insert into orders (tenant_id, store_id, profile_id, external_id, status, total_minor, currency, occurred_at)
     values ($1, $2, $3, $4, 'completed', $5, 'PLN', $6) returning id`,
    [w.tenantId, w.storeId, w.profileId, `atr-${randomUUID()}`, kwota, kiedy],
  );
  return rows[0].id;
}

/** Zapisane wiersze atrybucji przebiegu — odczyt z bazy, nie z wyniku funkcji. */
async function zapisane(tenantId: string, runId: string) {
  const { rows } = await getPool().query(
    `select order_id, click_id, message_id, source_type, source_id, campaign_id, journey_id, amount_minor::int
       from attributions where tenant_id = $1 and run_id = $2 order by order_id`,
    [tenantId, runId],
  );
  return rows;
}

describe("Atrybucja: kampanie i automatyzacje (0018)", () => {
  beforeEach(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  it("zamówienie po kliknięciu w mail z automatyzacji trafia do automatyzacji", async () => {
    const w = await zbudujSwiat("automatyzacja");
    const m = await wiadomosc(w.tenantId, w.profileId, "journey", w.journeyId);
    const c = await klik(w.tenantId, m, w.profileId, godzinPrzed(3));
    const o = await zamowienie(w, 15900);

    const wynik = await przeliczAtrybucje(w.tenantId);
    expect(wynik.przypisanych).toBe(1);
    expect(wynik.automatyzacje).toEqual({ zamowien: 1, przychodMinor: 15900 });
    expect(wynik.kampanie).toEqual({ zamowien: 0, przychodMinor: 0 });

    expect(await zapisane(w.tenantId, wynik.runId)).toEqual([
      {
        order_id: o, click_id: c, message_id: m, source_type: "journey", source_id: w.journeyId,
        campaign_id: null, journey_id: w.journeyId, amount_minor: 15900,
      },
    ]);
    const raport = await raportAutomatyzacji(w.tenantId, w.journeyId);
    expect(Number(raport.przychod_minor)).toBe(15900);
    expect(raport.zamowien).toBe(1);
    expect(raport.klikniecia).toBe(1);
    expect(raport.przebieg_at).not.toBeNull();
    const kampania = await raportKampanii(w.tenantId, w.campaignId);
    expect(Number(kampania.przychod_minor)).toBe(0);
  });

  it("kampania, potem automatyzacja, potem zamówienie: wygrywa automatyzacja", async () => {
    const w = await zbudujSwiat("kampania-potem-automatyzacja");
    const mk = await wiadomosc(w.tenantId, w.profileId, "campaign", w.campaignId);
    const mj = await wiadomosc(w.tenantId, w.profileId, "journey", w.journeyId);
    await klik(w.tenantId, mk, w.profileId, godzinPrzed(10));
    const ostatni = await klik(w.tenantId, mj, w.profileId, godzinPrzed(2));
    await zamowienie(w, 20000);

    const wynik = await przeliczAtrybucje(w.tenantId);
    const wiersze = await zapisane(w.tenantId, wynik.runId);
    // jedno zamówienie, jedno źródło: nie ma podwójnego przypisania obu stronom
    expect(wiersze).toHaveLength(1);
    expect(wiersze[0].click_id).toBe(ostatni);
    expect(wiersze[0].source_type).toBe("journey");
    expect(Number((await raportKampanii(w.tenantId, w.campaignId)).przychod_minor)).toBe(0);
    expect(Number((await raportAutomatyzacji(w.tenantId, w.journeyId)).przychod_minor)).toBe(20000);
  });

  it("automatyzacja, potem kampania, potem zamówienie: wygrywa kampania", async () => {
    const w = await zbudujSwiat("automatyzacja-potem-kampania");
    const mk = await wiadomosc(w.tenantId, w.profileId, "campaign", w.campaignId);
    const mj = await wiadomosc(w.tenantId, w.profileId, "journey", w.journeyId);
    await klik(w.tenantId, mj, w.profileId, godzinPrzed(10));
    const ostatni = await klik(w.tenantId, mk, w.profileId, godzinPrzed(2));
    await zamowienie(w, 20000);

    const wynik = await przeliczAtrybucje(w.tenantId);
    const wiersze = await zapisane(w.tenantId, wynik.runId);
    expect(wiersze).toHaveLength(1);
    expect(wiersze[0].click_id).toBe(ostatni);
    expect(wiersze[0].source_type).toBe("campaign");
    expect(wiersze[0].campaign_id).toBe(w.campaignId);
    expect(wiersze[0].journey_id).toBeNull();
    expect(Number((await raportKampanii(w.tenantId, w.campaignId)).przychod_minor)).toBe(20000);
    expect(Number((await raportAutomatyzacji(w.tenantId, w.journeyId)).przychod_minor)).toBe(0);
  });

  it("klik poza oknem reguły nie daje atrybucji, klik na granicy okna daje", async () => {
    const w = await zbudujSwiat("okno");
    const m = await wiadomosc(w.tenantId, w.profileId, "journey", w.journeyId);
    await klik(w.tenantId, m, w.profileId, godzinPrzed(121));
    // klik PO zamówieniu też nie może zarobić na zamówieniu, które już się stało
    await klik(w.tenantId, m, w.profileId, "2026-08-10T12:00:01.000Z");
    await zamowienie(w, 5000);
    const poza = await przeliczAtrybucje(w.tenantId);
    expect(poza.przypisanych).toBe(0);
    expect(await zapisane(w.tenantId, poza.runId)).toEqual([]);

    await klik(w.tenantId, m, w.profileId, godzinPrzed(120));
    const granica = await przeliczAtrybucje(w.tenantId);
    expect(granica.przypisanych).toBe(1);
  });

  it("klik bota (jest w message_engagement, nie ma go w clicks) nie daje atrybucji", async () => {
    const w = await zbudujSwiat("bot");
    const m = await wiadomosc(w.tenantId, w.profileId, "journey", w.journeyId);
    // Skaner bramki pocztowej przez PRAWDZIWĄ ścieżkę zapisu redirectu: zdarzenie ląduje
    // w message_engagement z werdyktem automatu i nie trafia do clicks.
    const bot = await zapiszZaangazowanie(w.tenantId, m, {
      rodzaj: "click",
      kiedy: new Date(godzinPrzed(1)),
      zrodlo: "wlasne",
      url: "https://sklep.example.test/oferta",
      userAgent: "Mozilla/5.0 SafeLinks",
    });
    expect(bot).toMatchObject({ zapisane: true, automat: true });
    await zamowienie(w, 7000);
    const wynik = await przeliczAtrybucje(w.tenantId);
    expect(wynik.przypisanych).toBe(0);
    const { rows } = await getPool().query("select count(*)::int as n from clicks where tenant_id = $1", [w.tenantId]);
    expect(rows[0].n).toBe(0);

    // kontrola: ten sam klik człowieka tą samą ścieżką daje atrybucję automatyzacji
    const czlowiek = await zapiszZaangazowanie(w.tenantId, m, {
      rodzaj: "click",
      kiedy: new Date(godzinPrzed(2)),
      zrodlo: "wlasne",
      url: "https://sklep.example.test/oferta",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36",
    });
    expect(czlowiek).toMatchObject({ zapisane: true });
    expect(czlowiek.automat).not.toBe(true);
    const po = await przeliczAtrybucje(w.tenantId);
    expect(po.automatyzacje).toEqual({ zamowien: 1, przychodMinor: 7000 });
  });

  it("wiadomość testowa nie zarabia", async () => {
    const w = await zbudujSwiat("test");
    const m = await wiadomosc(w.tenantId, w.profileId, "test", randomUUID());
    await klik(w.tenantId, m, w.profileId, godzinPrzed(1));
    await zamowienie(w, 9900);
    const wynik = await przeliczAtrybucje(w.tenantId);
    expect(wynik.przypisanych).toBe(0);
  });

  it("wiadomość testowa kliknięta PÓŹNIEJ nie odbiera zamówienia automatyzacji", async () => {
    const w = await zbudujSwiat("test-pozniej");
    const mj = await wiadomosc(w.tenantId, w.profileId, "journey", w.journeyId);
    const mt = await wiadomosc(w.tenantId, w.profileId, "test", randomUUID());
    const cj = await klik(w.tenantId, mj, w.profileId, godzinPrzed(5));
    await klik(w.tenantId, mt, w.profileId, godzinPrzed(1));
    await zamowienie(w, 9900);
    const wynik = await przeliczAtrybucje(w.tenantId);
    const wiersze = await zapisane(w.tenantId, wynik.runId);
    expect(wiersze).toHaveLength(1);
    expect(wiersze[0].click_id).toBe(cj);
  });

  it("izolacja: klik tenanta B nie przypisuje zamówienia tenanta A", async () => {
    const a = await zbudujSwiat("izolacja A");
    const b = await zbudujSwiat("izolacja B");
    const mb = await wiadomosc(b.tenantId, b.profileId, "journey", b.journeyId);
    // najgorszy przypadek: klik w tenancie B podpisany profilem z tenanta A
    await klik(b.tenantId, mb, a.profileId, godzinPrzed(1));
    await zamowienie(a, 12345);

    const wynikA = await przeliczAtrybucje(a.tenantId);
    expect(wynikA.przypisanych).toBe(0);
    const wynikB = await przeliczAtrybucje(b.tenantId);
    expect(wynikB.przypisanych).toBe(0);
  });

  it("izolacja w bazie: atrybucja nie może wskazać źródła, kliku ani przebiegu innego tenanta", async () => {
    const a = await zbudujSwiat("fk A");
    const b = await zbudujSwiat("fk B");
    const ma = await wiadomosc(a.tenantId, a.profileId, "journey", a.journeyId);
    const ca = await klik(a.tenantId, ma, a.profileId, godzinPrzed(1));
    const oa = await zamowienie(a, 100);
    const mb = await wiadomosc(b.tenantId, b.profileId, "journey", b.journeyId);
    const cb = await klik(b.tenantId, mb, b.profileId, godzinPrzed(1));
    const runA = (await przeliczAtrybucje(a.tenantId)).runId;
    const runB = (await przeliczAtrybucje(b.tenantId)).runId;
    const pool = getPool();
    await pool.query("delete from attributions where tenant_id = $1 and run_id = $2", [a.tenantId, runA]);

    const wstaw = (runId: string, clickId: string, messageId: string, st: string, sid: string, cid: string | null, jid: string | null) =>
      pool.query(
        `insert into attributions (tenant_id, run_id, order_id, message_id, click_id, amount_minor,
                                   source_type, source_id, campaign_id, journey_id)
         values ($1, $2, $3, $4, $5, 100, $6, $7, $8, $9)`,
        [a.tenantId, runId, oa, messageId, clickId, st, sid, cid, jid],
      );

    // automatyzacja tenanta B
    await expect(wstaw(runA, ca, ma, "journey", b.journeyId, null, b.journeyId)).rejects.toThrow(/foreign key/);
    // klik tenanta B
    await expect(wstaw(runA, cb, ma, "journey", a.journeyId, null, a.journeyId)).rejects.toThrow(/foreign key/);
    // przebieg tenanta B
    await expect(wstaw(runB, ca, ma, "journey", a.journeyId, null, a.journeyId)).rejects.toThrow(/foreign key/);
    // klik tego samego tenanta, ale z INNEJ wiadomości niż zapisana w atrybucji
    // (ta sama automatyzacja, inna wiadomość: np. druga wysyłka bez profilu)
    const mInna = await wiadomosc(a.tenantId, null, "journey", a.journeyId);
    const cInny = await klik(a.tenantId, mInna, a.profileId, godzinPrzed(1));
    await expect(wstaw(runA, cInny, ma, "journey", a.journeyId, null, a.journeyId)).rejects.toThrow(/attributions_click_fk/);
    // źródło niezgodne z wiadomością: klik w automatyzację zapisany jako kampania
    await expect(wstaw(runA, ca, ma, "campaign", a.campaignId, a.campaignId, null)).rejects.toThrow(/foreign key/);
    // dwa źródła naraz albo żadne
    await expect(wstaw(runA, ca, ma, "journey", a.journeyId, a.campaignId, a.journeyId)).rejects.toThrow(/attributions_source_check/);
    await expect(wstaw(runA, ca, ma, "journey", a.journeyId, null, null)).rejects.toThrow(/attributions_source_check/);
    // kontrola: poprawny wiersz przechodzi
    await expect(wstaw(runA, ca, ma, "journey", a.journeyId, null, a.journeyId)).resolves.toBeTruthy();
  });

  it("dwa przebiegi na tych samych danych dają identyczny wynik", async () => {
    const w = await zbudujSwiat("powtarzalnosc");
    const mk = await wiadomosc(w.tenantId, w.profileId, "campaign", w.campaignId);
    const mj = await wiadomosc(w.tenantId, w.profileId, "journey", w.journeyId);
    // remis co do mikrosekundy: rozstrzyga id kliknięcia, nie kolejność fizyczna w tabeli
    await klik(w.tenantId, mk, w.profileId, godzinPrzed(4));
    await klik(w.tenantId, mj, w.profileId, godzinPrzed(4));
    await klik(w.tenantId, mk, w.profileId, godzinPrzed(30));
    await zamowienie(w, 1000);
    await zamowienie(w, 2000, godzinPrzed(20));
    await zamowienie(w, 3000, godzinPrzed(-50));

    const r1 = await przeliczAtrybucje(w.tenantId);
    const r2 = await przeliczAtrybucje(w.tenantId);
    expect(r1.runId).not.toBe(r2.runId);
    const wiersze1 = await zapisane(w.tenantId, r1.runId);
    // trzy zamówienia, każde ma klik w oknie (T+50 h: klik sprzed 54 h)
    expect(wiersze1).toHaveLength(3);
    expect(await zapisane(w.tenantId, r2.runId)).toEqual(wiersze1);
    expect(r2.kampanie).toEqual(r1.kampanie);
    expect(r2.automatyzacje).toEqual(r1.automatyzacje);
    // pierwszy przebieg został nietknięty przez drugi (zapis ograniczony do run_id)
    expect((await zapisane(w.tenantId, r1.runId)).length).toBe(r1.przypisanych);
  });

  it("dwa przebiegi NARAZ: jedna reguła domyślna i ten sam wynik", async () => {
    const w = await zbudujSwiat("wspolbieznosc");
    const mj = await wiadomosc(w.tenantId, w.profileId, "journey", w.journeyId);
    await klik(w.tenantId, mj, w.profileId, godzinPrzed(3));
    await zamowienie(w, 2500);
    const [r1, r2] = await Promise.all([przeliczAtrybucje(w.tenantId), przeliczAtrybucje(w.tenantId)]);
    const { rows } = await getPool().query(
      "select count(*)::int as n from attribution_rules where tenant_id = $1", [w.tenantId]);
    expect(rows[0].n).toBe(1);
    expect(await zapisane(w.tenantId, r2.runId)).toEqual(await zapisane(w.tenantId, r1.runId));
    expect(r1.automatyzacje).toEqual({ zamowien: 1, przychodMinor: 2500 });
    // przebiegi się nie nakładają, a kolejność finished_at to kolejność faktycznego
    // zakończenia: późniejszy zaczął się dopiero po zakończeniu wcześniejszego
    const { rows: przebiegi } = await getPool().query(
      `select id, started_at, finished_at from attribution_runs
        where tenant_id = $1 order by finished_at`, [w.tenantId]);
    expect(przebiegi).toHaveLength(2);
    expect(new Date(przebiegi[1].started_at).getTime()).toBeGreaterThanOrEqual(
      new Date(przebiegi[0].finished_at).getTime());
    const przeglad = await przychodPrzegladu(w.tenantId);
    expect(new Date(przeglad.przebiegAt!).getTime()).toBe(new Date(przebiegi[1].finished_at).getTime());
  });

  it("regresja raportKampanii: dane tylko z kampanii dają to samo co zapytanie sprzed 0018", async () => {
    const w = await zbudujSwiat("regresja");
    const k2 = await getPool().query(
      `insert into campaigns (tenant_id, name, subject, content, status)
       values ($1, 'ATR kampania 2', 'Temat', '{}', 'sent') returning id`,
      [w.tenantId],
    );
    const kampania2 = k2.rows[0].id;
    const m1 = await wiadomosc(w.tenantId, w.profileId, "campaign", w.campaignId);
    const m2 = await wiadomosc(w.tenantId, w.profileId, "campaign", kampania2);
    await klik(w.tenantId, m1, w.profileId, godzinPrzed(40));
    await klik(w.tenantId, m2, w.profileId, godzinPrzed(6));
    await klik(w.tenantId, m1, w.profileId, godzinPrzed(80));
    await zamowienie(w, 11100);
    await zamowienie(w, 22200, godzinPrzed(30));
    await zamowienie(w, 33300, godzinPrzed(-200));

    // Zapytanie wyboru kliknięcia DOSŁOWNIE z 0007/przed zmianą (tylko kampanie).
    const { rows: stare } = await getPool().query(
      `select o.id as order_id, k.id as click_id, m.source_id as campaign_id, o.total_minor::int as amount_minor
         from orders o
         join lateral (
           select c.id, c.message_id
             from clicks c
             join messages m2 on m2.tenant_id = c.tenant_id and m2.id = c.message_id
            where c.tenant_id = o.tenant_id
              and c.profile_id = o.profile_id
              and m2.source_type = 'campaign'
              and c.occurred_at <= o.occurred_at
              and c.occurred_at >= o.occurred_at - make_interval(hours => 120)
            order by c.occurred_at desc, c.id desc
            limit 1
         ) k on true
         join messages m on m.tenant_id = o.tenant_id and m.id = k.message_id
        where o.tenant_id = $1 and o.profile_id is not null and o.status in ('completed', 'processing')
        order by o.id`,
      [w.tenantId],
    );
    const wynik = await przeliczAtrybucje(w.tenantId);
    const nowe = (await zapisane(w.tenantId, wynik.runId)).map((r) => ({
      order_id: r.order_id, click_id: r.click_id, campaign_id: r.campaign_id, amount_minor: r.amount_minor,
    }));
    expect(nowe).toEqual(stare);
    expect(stare).toHaveLength(2);

    const r1 = await raportKampanii(w.tenantId, w.campaignId);
    const r2 = await raportKampanii(w.tenantId, kampania2);
    expect(Object.keys(r1).sort()).toEqual(["klikniecia", "przychod_minor", "wyslane", "zamowien", "zatrzymane"]);
    expect(r1).toMatchObject({ przychod_minor: "22200", zamowien: 1, klikniecia: 1 });
    expect(r2).toMatchObject({ przychod_minor: "11100", zamowien: 1, klikniecia: 1 });
  });

  it("przegląd: null przed pierwszym przebiegiem, rozbicie po nim sumuje się do całości", async () => {
    const w = await zbudujSwiat("przeglad");
    const mk = await wiadomosc(w.tenantId, w.profileId, "campaign", w.campaignId);
    const mj = await wiadomosc(w.tenantId, w.profileId, "journey", w.journeyId);
    await klik(w.tenantId, mj, w.profileId, godzinPrzed(2));
    await zamowienie(w, 4000);
    await klik(w.tenantId, mk, w.profileId, godzinPrzed(52));
    await zamowienie(w, 6000, godzinPrzed(50));

    const przed = await przychodPrzegladu(w.tenantId);
    expect(przed.przypisanyMinor).toBeNull();
    expect(przed.kampanieMinor).toBeNull();
    expect(przed.automatyzacjeMinor).toBeNull();
    const listaPrzed = await przychodAutomatyzacji(w.tenantId);
    expect(listaPrzed).toEqual({ przebiegAt: null, perAutomatyzacja: {} });

    await przeliczAtrybucje(w.tenantId);
    const po = await przychodPrzegladu(w.tenantId);
    expect(po.przypisanyMinor).toBe(10000);
    expect(po.kampanieMinor).toBe(6000);
    expect(po.automatyzacjeMinor).toBe(4000);
    expect(po.kampanieZamowien).toBe(1);
    expect(po.automatyzacjeZamowien).toBe(1);
    expect(po.przypisanychZamowien).toBe(2);
    const lista = await przychodAutomatyzacji(w.tenantId);
    expect(lista.przebiegAt).not.toBeNull();
    expect(lista.perAutomatyzacja).toEqual({ [w.journeyId]: { zamowien: 1, przychodMinor: 4000 } });
  });

  it("przegląd: przeliczono i automatyzacje nic nie zarobiły to 0, nie null", async () => {
    const w = await zbudujSwiat("przeglad-zero");
    const mk = await wiadomosc(w.tenantId, w.profileId, "campaign", w.campaignId);
    await klik(w.tenantId, mk, w.profileId, godzinPrzed(2));
    await zamowienie(w, 4000);
    await przeliczAtrybucje(w.tenantId);
    const po = await przychodPrzegladu(w.tenantId);
    expect(po.automatyzacjeMinor).toBe(0);
    expect(po.kampanieMinor).toBe(4000);
    const lista = await przychodAutomatyzacji(w.tenantId);
    expect(lista.przebiegAt).not.toBeNull();
    expect(lista.perAutomatyzacja).toEqual({});
  });

  it("usunięcie tenanta dalej sprząta wszystko kaskadą (FK do kampanii i automatyzacji bez kaskady)", async () => {
    const w = await zbudujSwiat("kaskada");
    const mk = await wiadomosc(w.tenantId, w.profileId, "campaign", w.campaignId);
    const mj = await wiadomosc(w.tenantId, w.profileId, "journey", w.journeyId);
    await klik(w.tenantId, mk, w.profileId, godzinPrzed(20));
    await klik(w.tenantId, mj, w.profileId, godzinPrzed(2));
    await zamowienie(w, 4000);
    await zamowienie(w, 4000, godzinPrzed(10));
    await przeliczAtrybucje(w.tenantId);
    await getPool().query("delete from tenants where id = $1", [w.tenantId]);
    const { rows } = await getPool().query("select count(*)::int as n from attributions where tenant_id = $1", [w.tenantId]);
    expect(rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// Migracja 0018 na wierszu w kształcie sprzed niej. W jednej transakcji: cofamy 0018
// (DDL w Postgresie jest transakcyjny), wstawiamy wiersz w kształcie 0007, wykonujemy
// PRAWDZIWY plik migracji i czytamy zapisany wiersz. Na końcu ROLLBACK: schemat i dane
// sandboxa wracają do stanu sprzed testu.
// ---------------------------------------------------------------------------------------

const COFNIJ_0018 = `
  drop index attributions_source_idx, attributions_journey_idx, attributions_click_idx;
  alter table attribution_runs drop constraint attribution_runs_rule_fk;
  alter table attribution_runs add constraint attribution_runs_rule_id_fkey
    foreign key (rule_id) references attribution_rules (id);
  alter table attributions drop constraint attributions_click_fk;
  alter table attributions add constraint attributions_click_id_fkey foreign key (click_id) references clicks (id);
  alter table attributions drop constraint attributions_run_fk;
  alter table attributions add constraint attributions_run_id_fkey
    foreign key (run_id) references attribution_runs (id) on delete cascade;
  alter table attributions drop constraint attributions_message_source_fk;
  alter table attributions add constraint attributions_tenant_id_message_id_fkey
    foreign key (tenant_id, message_id) references messages (tenant_id, id) on delete cascade;
  alter table attributions drop constraint attributions_campaign_fk, drop constraint attributions_journey_fk,
    drop constraint attributions_source_check;
  delete from attributions where campaign_id is null;
  alter table attributions drop column source_type, drop column source_id, drop column journey_id,
    alter column campaign_id set not null;
  alter table attribution_rules drop constraint attribution_rules_tenant_id_unique;
  alter table attribution_runs drop constraint attribution_runs_tenant_id_unique;
  alter table clicks drop constraint clicks_tenant_id_message_unique;
`;

describe("Migracja 0018: uzupełnienie starych wierszy", () => {
  const plik = readFileSync(join(import.meta.dirname, "..", "migrations", "0018_atrybucja_automatyzacji.sql"), "utf-8");

  async function wTransakcjiCofnietej<T>(fn: (q: (sql: string, p?: unknown[]) => Promise<any>) => Promise<T>) {
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query(COFNIJ_0018);
      return await fn((sql, p) => client.query(sql, p));
    } finally {
      await client.query("rollback");
      client.release();
    }
  }

  async function staryWiersz(q: (sql: string, p?: unknown[]) => Promise<any>, zlaKampania = false) {
    const t = (await q("insert into tenants (name) values ($1) returning id", [PREFIKS + "migracja"])).rows[0].id;
    const p = (await q("insert into profiles (tenant_id, email) values ($1, 'atr-mig@example.test') returning id", [t])).rows[0].id;
    const s = (await q(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted)
       values ($1, 'woocommerce', 'http://atr.test', '\\x78') returning id`, [t])).rows[0].id;
    const k = (await q(
      `insert into campaigns (tenant_id, name, subject, content, status)
       values ($1, 'mig', 'T', '{}', 'sent'), ($1, 'mig inna', 'T', '{}', 'sent') returning id`, [t])).rows.map((r: any) => r.id);
    const m = (await q(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
       values ($1, $2, 'campaign', $3, 'atr-mig@example.test', 'T', 'x', $4, $5) returning id`,
      [t, p, k[0], randomUUID(), randomUUID()])).rows[0].id;
    const c = (await q(
      `insert into clicks (tenant_id, message_id, profile_id, url, occurred_at)
       values ($1, $2, $3, 'https://x.test', $4) returning id`, [t, m, p, godzinPrzed(1)])).rows[0].id;
    const o = (await q(
      `insert into orders (tenant_id, store_id, profile_id, external_id, status, total_minor, currency, occurred_at)
       values ($1, $2, $3, 'mig-1', 'completed', 4321, 'PLN', $4) returning id`, [t, s, p, ZAMOWIENIE])).rows[0].id;
    const reg = (await q("insert into attribution_rules (tenant_id) values ($1) returning id", [t])).rows[0].id;
    const run = (await q(
      `insert into attribution_runs (tenant_id, rule_id, finished_at) values ($1, $2, $3) returning id`,
      [t, reg, ZAMOWIENIE])).rows[0].id;
    const a = (await q(
      `insert into attributions (tenant_id, run_id, order_id, message_id, campaign_id, click_id, amount_minor)
       values ($1, $2, $3, $4, $5, $6, 4321) returning id`,
      [t, run, o, m, zlaKampania ? k[1] : k[0], c])).rows[0].id;
    return { a, kampania: k[0] };
  }

  it("stary wiersz dostaje źródło 'campaign' i source_id = campaign_id", async () => {
    await wTransakcjiCofnietej(async (q) => {
      const { a, kampania } = await staryWiersz(q);
      await q(plik);
      const { rows } = await q(
        "select source_type, source_id, campaign_id, journey_id, amount_minor::int from attributions where id = $1", [a]);
      expect(rows[0]).toEqual({
        source_type: "campaign", source_id: kampania, campaign_id: kampania, journey_id: null, amount_minor: 4321,
      });
      // żaden wiersz w całej tabeli nie został bez źródła
      const { rows: puste } = await q("select count(*)::int as n from attributions where source_type is null");
      expect(puste[0].n).toBe(0);
    });
  });

  it("wiersz sprzeczny z wiadomością zatrzymuje migrację zamiast przepisać fałsz", async () => {
    await wTransakcjiCofnietej(async (q) => {
      await staryWiersz(q, true);
      await expect(q(plik)).rejects.toThrow(/0018: .*sprzecznych/);
    });
  });
});
