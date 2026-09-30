// Flaga ponownego wejscia dla CALEGO pliku (config() jest buforowany per plik testow).
// Dostepnosc i tak zalezy od schematu: do czasu 0036 kod odmawia mimo flagi.
process.env.MIDREV_PONOWNE_WEJSCIE = "1";
process.env.MIDREV_GRAF_V2 = "1";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { config } from "../src/config";
import { nowyBlok, pustyDokument } from "../src/domain/email/bloki";
import { wstawWezel, type Graf, type PonowneWejscie, type ZrodloWyzwalacza } from "../src/domain/automatyzacje/graf";
import type { DostawcaWysylki } from "../src/domain/email/port";
import type { KatalogMetryk, ZrodloZdarzenDoWyzwalaczy, ZdarzenieWyzwalajace } from "../src/domain/automatyzacje/wyzwalanie";
import {
  opublikuj,
  pobierzAutomatyzacje,
  utworzAutomatyzacje,
  utworzWiadomosc,
  zapiszSzkic,
  zapiszWiadomosc,
  zmienStatus,
} from "../src/usecases/automatyzacje/journeye";
import { uruchomAutomatyzacje, wprowadzUczestnikow } from "../src/usecases/automatyzacje/przetworz-zdarzenia";
import { ponowneWejscieDostepne } from "../src/usecases/automatyzacje/ponowne-wejscie";
import { ustawZrodloZdarzen } from "../src/usecases/automatyzacje/zrodlo-zdarzen";
import { zbudujWiadomosciKampanii } from "../src/usecases/wysylka/wyslij-kampanie";
import { METRYKI_WBUDOWANE } from "../src/domain/zdarzenia/kontrakt";
import { zapiszZdarzenie } from "../src/usecases/zdarzenia/zapisz-zdarzenie";

// Wykonywalna specyfikacja E4a na prawdziwej bazie (AD-20): wyzwalacz metryczny z filtrem
// i regula 4 h (4.3), ponowne wejscie z macierza 7.3 (4.4), zmienne w kazdym mailu przebiegu
// (4.5). Czesc "po 0036" zaklada kontrakt na czas testu i przywraca stare unikalnosci.

const KATALOG = join(import.meta.dirname, "..");

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: string[] = [];
  async wyslij(w: { do: string; idempotencyKey: string }) {
    this.wyslane.push(w.do);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

function dokument(html: string) {
  return JSON.stringify({ ...pustyDokument(), bloki: [{ ...nowyBlok("tekst"), html }] });
}

describe("Automatyzacje E4a: wyzwalacz metryczny, ponowne wejście, zmienne", () => {
  let tenantId: string;
  let obcyTenantId: string;
  const profile: Record<string, string> = {};

  async function dodajProfil(klucz: string, email: string, imie: string | null = null) {
    const pool = getPool();
    const p = await pool.query("insert into profiles (tenant_id, email, first_name) values ($1, $2, $3) returning id", [tenantId, email, imie]);
    profile[klucz] = p.rows[0].id;
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
       values ($1, $2, 'email', 'granted', 'test', now() - interval '10 days')`,
      [tenantId, profile[klucz]],
    );
  }
  /**
   * Zdarzenie tak, jak zapisuje je kod produkcyjny po scaleniu strumienia A: `zapiszZdarzenie`
   * (metric_events) z lustrem w `events` pod tym samym id. Z MIDREV_GRAF_V2 (ten plik) silnik
   * czyta strumien metric_events.
   */
  async function zdarzenie(klucz: string, typ: string, przesuniecie = "5 seconds", payload: Record<string, unknown> = {}) {
    if (typ !== "popup.submitted") throw new Error(`test: nieobslugiwany typ ${typ}`);
    const pool = getPool();
    const { rows: t } = await pool.query("select (now() - $1::interval) as kiedy", [przesuniecie]);
    const klient = await pool.connect();
    try {
      await klient.query("begin");
      const id = randomUUID();
      const w = await zapiszZdarzenie(
        klient,
        {
          tenantId, metryka: METRYKI_WBUDOWANE.zgloszenieFormularza, profileId: profile[klucz], occurredAt: t[0].kiedy,
          id, uniqueId: `form:test:${id}`, properties: { form_id: "test", ...payload }, source: "client",
        },
        { lustro: { eventType: typ, payload: { popup_id: "test", ...payload } } },
      );
      await klient.query("commit");
      return w.id;
    } catch (b) {
      await klient.query("rollback");
      throw b;
    } finally {
      klient.release();
    }
  }
  async function usunZdarzenia() {
    await getPool().query("delete from event_keys where tenant_id = $1", [tenantId]);
    await getPool().query("delete from metric_events where tenant_id = $1", [tenantId]);
    await getPool().query("delete from events where tenant_id = $1", [tenantId]);
  }
  async function wiadomosc(flowId: string, nazwa: string, temat: string, html = `<p>${nazwa}</p>`) {
    const w = await utworzWiadomosc(tenantId, flowId, nazwa);
    if (!w.ok) throw new Error(w.blad);
    const z = await zapiszWiadomosc(tenantId, flowId, w.id, { temat, dokumentJson: dokument(html) });
    if (!z.ok) throw new Error(z.blad);
    return w.id;
  }
  async function zapisz(flowId: string, graf: Graf) {
    const widok = (await pobierzAutomatyzacje(tenantId, flowId))!;
    const z = await zapiszSzkic(tenantId, flowId, { graf, oczekiwanaWersja: widok.draftVersion });
    if (!z.ok) throw new Error(z.blad);
    return z;
  }
  async function wlacz(flowId: string) {
    await getPool().query("update flows set status = 'szkic' where tenant_id = $1 and id <> $2 and status <> 'szkic'", [tenantId, flowId]);
    await usunZdarzenia();
    const w = await zmienStatus(tenantId, flowId, "wlaczony");
    if (!w.ok) throw new Error(`${w.blad} ${JSON.stringify((w as { bledy?: unknown }).bledy ?? [])}`);
    await getPool().query("update flows set active_since = now() - interval '1 hour' where tenant_id = $1 and id = $2", [tenantId, flowId]);
    await getPool().query("update flow_trigger_state set scanned_to = now() - interval '1 hour' where tenant_id = $1 and flow_id = $2", [tenantId, flowId]);
  }
  /** flow: wyzwalacz -> mail -> koniec, z podanym trybem ponownego wejscia */
  async function prosty(name: string, tryb: PonowneWejscie, zrodlo?: ZrodloWyzwalacza, html?: string, temat = "Witaj") {
    const f = await utworzAutomatyzacje(tenantId, { name, zdarzenie: "popup.submitted" });
    if (!f.ok) throw new Error(f.blad);
    const e = await wiadomosc(f.id, "Mail", temat, html);
    let g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "m", typ: "email", emailId: e, links: { next: null } });
    g = { ...g, ustawienia: { ...g.ustawienia, ponowneWejscie: tryb } };
    if (zrodlo) g = { ...g, wezly: g.wezly.map((w) => (w.typ === "wyzwalacz" ? { ...w, zrodlo } : w)) };
    await zapisz(f.id, g);
    return { id: f.id, emailId: e, graf: g };
  }
  async function uczestnicy(flowId: string, klucz: string) {
    const { rows } = await getPool().query(
      "select id, status, node_id, entry_key, trigger_event_id, entered_at from flow_participants where tenant_id = $1 and flow_id = $2 and profile_id = $3 order by entered_at, id",
      [tenantId, flowId, profile[klucz]],
    );
    return rows;
  }
  async function wiadomosciOsoby(klucz: string, emailId?: string) {
    const { rows } = await getPool().query(
      `select id, subject, body_html, journey_run_id, current_state from messages
        where tenant_id = $1 and profile_id = $2 and source_type = 'journey' and ($3::uuid is null or source_id = $3)
        order by created_at, id`,
      [tenantId, profile[klucz], emailId ?? null],
    );
    return rows;
  }

  beforeAll(async () => {
    expect(config().MIDREV_PONOWNE_WEJSCIE).toBe(true);
    const pool = getPool();
    await pool.query("delete from tenants where name like 'REENTRY %'");
    tenantId = (await pool.query("insert into tenants (name) values ('REENTRY tenant') returning id")).rows[0].id;
    obcyTenantId = (await pool.query("insert into tenants (name) values ('REENTRY obcy') returning id")).rows[0].id;
    await dodajProfil("anna", "reentry-anna@example.test", "Anna");
    await dodajProfil("bartek", "reentry-bartek@example.test", "Bartek");
    for (let i = 0; i < 5; i++) await dodajProfil(`p${i}`, `reentry-p${i}@example.test`);
  });

  afterAll(async () => {
    ustawZrodloZdarzen(null);
    await getPool().query("delete from tenants where name like 'REENTRY %'");
    await closePool();
  });

  // ── Wydanie N (0035, stare unikalnosci stoja) ─────────────────────────────

  describe("wydanie N: 0035 bez 0036", () => {
    it("flaga włączona, ale stare unikalności stoją: ponowne wejście niedostępne; szkicu z „zawsze” nie da się zapisać ani opublikować", async () => {
      expect(await ponowneWejscieDostepne(getPool())).toBe(false);
      await expect(prosty("REENTRY zawsze zablokowane", { tryb: "zawsze" })).rejects.toThrow(/Ponowne wejście/);
      // publikacja definicji wpisanej z pominieciem zapisu szkicu tez stoi na bramce
      const f = await prosty("REENTRY zawsze bramka", { tryb: "raz" });
      const g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
      await getPool().query("update flows set draft = $3 where tenant_id = $1 and id = $2", [tenantId, f.id, JSON.stringify({ ...g, ustawienia: { ...g.ustawienia, ponowneWejscie: { tryb: "zawsze" } } })]);
      const w = await zmienStatus(tenantId, f.id, "wlaczony");
      expect(w.ok).toBe(false);
      expect(JSON.stringify(w)).toContain("Ponowne wejście");
    });

    it("„raz”: drugie zdarzenie tej samej osoby nie wchodzi; jedna wiadomość z przebiegiem", async () => {
      const f = await prosty("REENTRY raz", { tryb: "raz" });
      await wlacz(f.id);
      await zdarzenie("anna", "popup.submitted", "20 seconds");
      await zdarzenie("anna", "popup.submitted", "10 seconds");
      const d = new DostawcaAtrapa();
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      await zdarzenie("anna", "popup.submitted", "1 second");
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      expect(d.wyslane).toEqual(["reentry-anna@example.test"]);
      const u = await uczestnicy(f.id, "anna");
      expect(u).toHaveLength(1);
      expect(u[0].entry_key).toBe("raz");
      const m = await wiadomosciOsoby("anna", f.emailId);
      expect(m).toHaveLength(1);
      expect(m[0].journey_run_id).toBe(u[0].id);
    });

    it("definicja z „zawsze” wpisana mimo braku 0036: silnik wpuszcza raz i alarmuje, bez błędu unikalności", async () => {
      const f = await prosty("REENTRY zawsze wymuszone", { tryb: "raz" });
      await wlacz(f.id);
      const zawsze = { ...f.graf, ustawienia: { ...f.graf.ustawienia, ponowneWejscie: { tryb: "zawsze" } } };
      await getPool().query("update flows set live = $3 where tenant_id = $1 and id = $2", [tenantId, f.id, JSON.stringify(zawsze)]);
      await getPool().query("update flow_versions set definition = $3 where tenant_id = $1 and flow_id = $2", [tenantId, f.id, JSON.stringify(zawsze)]);
      await zdarzenie("bartek", "popup.submitted", "20 seconds");
      await zdarzenie("bartek", "popup.submitted", "10 seconds");
      const w = await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
      expect(w.alerty.some((a) => a.includes("niedostępne"))).toBe(true);
      expect(await uczestnicy(f.id, "bartek")).toHaveLength(1);
    });

    it("stary uczestnik sprzed 0035 (bez klucza i przebiegu w wiadomości) kończy ścieżkę bez duplikatu; ponowienie kroku = 1 wiadomość", async () => {
      const f = await prosty("REENTRY stary", { tryb: "raz" });
      await wlacz(f.id);
      const { rows: v } = await getPool().query("select live_version from flows where tenant_id = $1 and id = $2", [tenantId, f.id]);
      // wstawienie jak stary kod: bez entry_key (domyslne 'raz'), bez trigger_event_occurred_at
      const { rows: p } = await getPool().query(
        `insert into flow_participants (tenant_id, flow_id, profile_id, version, node_id, status, entered_at, node_since, context)
         values ($1, $2, $3, $4, 'm', 'w_toku', now() - interval '1 minute', now() - interval '1 minute', '{}') returning id, entry_key`,
        [tenantId, f.id, profile.p0, v[0].live_version],
      );
      expect(p[0].entry_key).toBe("raz");
      const d = new DostawcaAtrapa();
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      expect(d.wyslane).toEqual(["reentry-p0@example.test"]);
      // "ponowienie": osoba cofnieta na krok e-mail w TYM SAMYM przebiegu
      await getPool().query("update flow_participants set status = 'w_toku', node_id = 'm', finished_at = null where tenant_id = $1 and id = $2", [tenantId, p[0].id]);
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      expect(d.wyslane).toHaveLength(1);
      const m = await wiadomosciOsoby("p0", f.emailId);
      expect(m).toHaveLength(1);
      expect(m[0].journey_run_id).toBe(p[0].id);
      const { rows: t } = await getPool().query("select kind, detail->>'powod' as powod from flow_transitions where tenant_id = $1 and participant_id = $2 and kind = 'pominieto'", [tenantId, p[0].id]);
      expect(t[0].powod).toContain("w tym przebiegu");
    });

    it("wiadomość zbudowana przez STARY kod w oknie deployu (bez przebiegu) zostaje przypięta, nie ma 23505 ani drugiego maila", async () => {
      const f = await prosty("REENTRY okno deployu", { tryb: "raz" });
      await wlacz(f.id);
      const { rows: v } = await getPool().query("select live_version from flows where tenant_id = $1 and id = $2", [tenantId, f.id]);
      const { rows: p } = await getPool().query(
        `insert into flow_participants (tenant_id, flow_id, profile_id, version, node_id, status, entered_at, node_since, context)
         values ($1, $2, $3, $4, 'm', 'w_toku', now() - interval '1 minute', now() - interval '1 minute', '{}') returning id`,
        [tenantId, f.id, profile.p1, v[0].live_version],
      );
      // stary kod: wiadomosc z tego kroku bez journey_run_id (np. jego transakcja zbudowala ja,
      // a nowy worker dostaje te sama osobe na tym samym kroku)
      const { rows: stara } = await getPool().query(
        `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
         values ($1, $2, 'journey', $3, 'reentry-p1@example.test', 'Witaj', '<p>x</p>', md5(random()::text), md5(random()::text)) returning id`,
        [tenantId, profile.p1, f.emailId],
      );
      const d = new DostawcaAtrapa();
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      const m = await wiadomosciOsoby("p1", f.emailId);
      expect(m).toHaveLength(1);
      expect(m[0].id).toBe(stara[0].id);
      expect(m[0].journey_run_id).toBe(p[0].id);
      expect(d.wyslane.filter((x) => x === "reentry-p1@example.test").length).toBeLessThanOrEqual(1);
    });

    it("backfill 0035: wiadomość w starym kształcie dostaje przebieg; wiadomość osoby bez przebiegu wycofuje migrację", async () => {
      const sql = readFileSync(join(KATALOG, "migrations", "0035_przebiegi_expand.sql"), "utf-8");
      const sekcja = sql.slice(sql.indexOf("-- >>> BACKFILL PRZEBIEGOW"), sql.indexOf("-- <<< BACKFILL PRZEBIEGOW"));
      expect(sekcja.length).toBeGreaterThan(100);
      const [m] = await wiadomosciOsoby("anna");
      const [u] = await uczestnicy((await getPool().query("select id from flows where tenant_id = $1 and name = 'REENTRY raz'", [tenantId])).rows[0].id, "anna");
      await getPool().query("update messages set journey_run_id = null where tenant_id = $1 and id = $2", [tenantId, m.id]);
      await getPool().query(sekcja);
      const { rows } = await getPool().query("select journey_run_id from messages where tenant_id = $1 and id = $2", [tenantId, m.id]);
      expect(rows[0].journey_run_id).toBe(u.id);

      // wiadomosc przypieta do przebiegu INNEJ osoby: asercja wycofuje cala transakcje
      const klient = await getPool().connect();
      try {
        await klient.query("begin");
        const { rows: src } = await klient.query("select source_id from messages where id = $1", [m.id]);
        await klient.query(
          `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token, journey_run_id)
           values ($1, $2, 'journey', $3, 'x@example.test', 't', 'b', md5(random()::text), md5(random()::text), $4)`,
          [tenantId, profile.p4, src[0].source_id, u.id],
        );
        await expect(klient.query(sekcja)).rejects.toThrow(/z cudzym przebiegiem: 1/);
      } finally {
        await klient.query("rollback");
        klient.release();
      }
    });
  });

  // ── Wyzwalacz metryczny na atrapie zrodla zgodnej z kontraktem A ─────────

  describe("wyzwalacz metryczny (4.3) na atrapie źródła metric_events", () => {
    interface ZdarzenieAtrapy {
      id: string; tenantId: string; profileId: string; integracja: string; nazwa: string;
      occurred: Date; recorded: Date; properties: Record<string, unknown>; backfill: boolean; source: ZdarzenieWyzwalajace["source"];
    }
    const baza: ZdarzenieAtrapy[] = [];
    let licznik = 0;
    const idZdarzenia = () => `01a0ffff-0000-7000-8000-${String(++licznik).padStart(12, "0")}`;
    const atrapa: ZrodloZdarzenDoWyzwalaczy = {
      nazwa: "atrapa-metric_events",
      async kandydaci(klient, z) {
        const zk = z.zakres;
        const { rows } = await klient.query(
          "select extract(epoch from $1::timestamptz) * 1000 as k, extract(epoch from $2::timestamptz) * 1000 as g, extract(epoch from $3::timestamptz) * 1000 as zaszle",
          [zk.kursor.recordedAt, zk.rodzaj === "nowe" ? zk.nieWczesniejNiz : zk.od, z.zaszlePo],
        );
        const k = Number(rows[0].k), g = Number(rows[0].g), zaszle = Number(rows[0].zaszle);
        const poKursorze = (e: ZdarzenieAtrapy) => e.recorded.getTime() > k || (e.recorded.getTime() === k && e.id > zk.kursor.id);
        const naKursorze = (e: ZdarzenieAtrapy) => e.recorded.getTime() === k && e.id === zk.kursor.id;
        // kontrakt portu: `nowe` rosnaco po kursorze; `zakladka` malejaco, <= kursor (kolejne strony <)
        const wZakladce = (e: ZdarzenieAtrapy) => !poKursorze(e) && (zk.rodzaj === "zakladka" && zk.wlacznie === false ? !naKursorze(e) : true);
        const kier = zk.rodzaj === "nowe" ? 1 : -1;
        return baza
          .filter((e) => e.tenantId === z.tenantId && e.integracja === z.metryka.integracja && e.nazwa === z.metryka.nazwa)
          .filter((e) => e.occurred.getTime() >= zaszle && e.recorded.getTime() > g)
          .filter((e) => (zk.rodzaj === "nowe" ? poKursorze(e) : wZakladce(e)))
          .sort((a, b) => kier * (a.recorded.getTime() - b.recorded.getTime() || a.id.localeCompare(b.id)))
          .slice(0, z.limit)
          .map((e) => ({
            id: e.id, profileId: e.profileId,
            occurredAt: e.occurred.toISOString(), recordedAt: e.recorded.toISOString(),
            occurredAtMs: e.occurred.getTime(), recordedAtMs: e.recorded.getTime(),
            properties: e.properties, backfill: e.backfill, source: e.source, context: {},
          }));
      },
      async pobierzWlasciwosci(_k, t, id) {
        return baza.find((e) => e.id === id && e.tenantId === t)?.properties ?? null;
      },
      async idMetryki() {
        return null;
      },
    };
    const katalog: KatalogMetryk = {
      async lista() {
        return [
          { id: null, integracja: "api", nazwa: "Ordered Product", canTrigger: true },
          { id: null, integracja: "midrev", nazwa: "Opened Email", canTrigger: false },
        ];
      },
    };
    const QUIZ = { rodzaj: "metryka" as const, metryka: { integracja: "api", nazwa: "Ordered Product" } };
    function dodaj(klucz: string, properties: Record<string, unknown>, o: Partial<ZdarzenieAtrapy> = {}) {
      const teraz = Date.now();
      baza.push({
        id: idZdarzenia(), tenantId, profileId: profile[klucz], integracja: "api", nazwa: "Ordered Product",
        occurred: new Date(teraz - 5000), recorded: new Date(teraz - 1000), properties, backfill: false, source: "api", ...o,
      });
    }

    beforeAll(() => ustawZrodloZdarzen(atrapa, katalog));
    afterAll(() => ustawZrodloZdarzen(null));

    it("filtr wyzwalacza (6× ProductID w jednej grupie) i reguła czasu: backfill, import, > 4 h, sprzed włączenia, inny tenant nie wchodzą", async () => {
      const filtr = { grupy: [{ warunki: ["101", "102", "103", "104", "105", "106"].map((id) => ({ typ: "wlasciwosc_zdarzenia" as const, pole: "ProductID", typPola: "string" as const, operator: "rowna", wartosc: id })) }] };
      const f = await prosty("REENTRY metryka filtr", { tryb: "raz" }, { ...QUIZ, filtr });
      await wlacz(f.id);
      const teraz = Date.now();
      dodaj("p0", { ProductID: "104" });                                   // wchodzi
      dodaj("p1", { ProductID: "999" });                                   // filtr
      dodaj("p2", { ProductID: "101" }, { backfill: true });              // backfill
      dodaj("p3", { ProductID: "101" }, { source: "import" });            // import
      dodaj("p4", { ProductID: "101" }, { occurred: new Date(teraz - 5 * 3600_000) }); // > 4 h spoznienia
      dodaj("anna", { ProductID: "101" }, { occurred: new Date(teraz - 2 * 3600_000), recorded: new Date(teraz - 2 * 3600_000 + 1000) }); // sprzed wlaczenia (active_since = teraz - 1 h)
      baza.push({ ...baza[baza.length - 1], id: idZdarzenia(), tenantId: obcyTenantId, occurred: new Date(teraz - 5000), recorded: new Date(teraz - 1000) }); // inny tenant
      const d = new DostawcaAtrapa();
      const w = await uruchomAutomatyzacje(tenantId, { dostawca: d });
      expect(w.wejscia).toBe(1);
      expect(d.wyslane).toEqual(["reentry-p0@example.test"]);
    });

    it("kursor: przy limicie skanu kolejne tiki nadrabiają bez gubienia i bez dublowania", async () => {
      const f = await prosty("REENTRY metryka kursor", { tryb: "raz" }, QUIZ);
      await wlacz(f.id);
      baza.length = 0;
      const t0 = Date.now() - 60_000;
      for (let i = 0; i < 5; i++) {
        baza.push({ id: idZdarzenia(), tenantId, profileId: profile[`p${i}`], integracja: "api", nazwa: "Ordered Product", occurred: new Date(t0), recorded: new Date(t0 + 1000), properties: {}, backfill: false, source: "api" });
      }
      const pierwszy = await wprowadzUczestnikow(tenantId, { limitSkanu: 2 });
      expect(pierwszy.wprowadzeni).toBe(2);
      expect(pierwszy.alerty.some((a) => a.includes("nadrabianie"))).toBe(true);
      expect((await wprowadzUczestnikow(tenantId, { limitSkanu: 2 })).wprowadzeni).toBe(2);
      expect((await wprowadzUczestnikow(tenantId, { limitSkanu: 2 })).wprowadzeni).toBe(1);
      expect((await wprowadzUczestnikow(tenantId, { limitSkanu: 2 })).wprowadzeni).toBe(0);
      const { rows } = await getPool().query("select count(*)::int as n, count(distinct profile_id)::int as osoby from flow_participants where tenant_id = $1 and flow_id = $2", [tenantId, f.id]);
      expect(rows[0]).toEqual({ n: 5, osoby: 5 });
      const { rows: st } = await getPool().query("select kursor_id from flow_trigger_state where tenant_id = $1 and flow_id = $2", [tenantId, f.id]);
      expect(st[0].kursor_id).toBeNull();
    });

    it("zakładka: spóźnione commity przed kursorem wchodzą, także gdy jest ich więcej niż limit jednej strony", async () => {
      const f = await prosty("REENTRY metryka zakladka", { tryb: "raz" }, QUIZ);
      await wlacz(f.id);
      baza.length = 0;
      await wprowadzUczestnikow(tenantId, { limitSkanu: 2 }); // kursor = teraz
      const t = Date.now() - 30_000; // zarejestrowane PRZED kursorem, zatwierdzone po nim
      for (let i = 0; i < 5; i++) {
        baza.push({ id: idZdarzenia(), tenantId, profileId: profile[`p${i}`], integracja: "api", nazwa: "Ordered Product", occurred: new Date(t - 1000), recorded: new Date(t + i), properties: {}, backfill: false, source: "api" });
      }
      const w = await wprowadzUczestnikow(tenantId, { limitSkanu: 2 });
      expect(w.wprowadzeni).toBe(5);
      expect(w.alerty.some((a) => a.includes("zakładka"))).toBe(false);
    });

    it("{{ event.X }} i {{ person.X }} w KAŻDYM mailu przebiegu; XSS z właściwości escapowany, javascript: usunięty, CR/LF z tematu", async () => {
      const f = await utworzAutomatyzacje(tenantId, { name: "REENTRY zmienne", zdarzenie: "popup.submitted" });
      if (!f.ok) throw new Error(f.blad);
      const e1 = await wiadomosc(f.id, "Mail 1", "Dzięki {{ person.first_name }} za {{ event.ProductName }}",
        '<p>{{ event.ProductName }} dla {{ person.first_name|default:&#39;Ciebie&#39; }}</p><p><a href="{{ event.url }}">link</a></p>');
      const e2 = await wiadomosc(f.id, "Mail 2", "Przypomnienie: {{ event.ProductName }}", "<p>Nadal {{ event.ProductName }}, {{ person.first_name }}</p>");
      let g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
      g = { ...g, wezly: g.wezly.map((w) => (w.typ === "wyzwalacz" ? { ...w, zrodlo: QUIZ } : w)) };
      g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "m1", typ: "email", emailId: e1, links: { next: null } });
      g = wstawWezel(g, { po: "m1", port: "next" }, { id: "op", typ: "opoznienie", ilosc: 1, jednostka: "minuty", links: { next: null } });
      g = wstawWezel(g, { po: "op", port: "next" }, { id: "m2", typ: "email", emailId: e2, links: { next: null } });
      await zapisz(f.id, g);
      await wlacz(f.id);
      baza.length = 0;
      dodaj("anna", { ProductName: "Longevity <script>alert(1)</script>\r\nBcc: x@y.pl", url: "javascript:alert(1)" });
      const d = new DostawcaAtrapa();
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      await getPool().query("update flow_participants set resume_at = now() - interval '1 minute' where tenant_id = $1 and flow_id = $2 and status = 'w_toku'", [tenantId, f.id]);
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      const [m1] = await wiadomosciOsoby("anna", e1);
      const [m2] = await wiadomosciOsoby("anna", e2);
      expect(m1.subject).toBe("Dzięki Anna za Longevity <script>alert(1)</script> Bcc: x@y.pl");
      expect(m1.subject).not.toMatch(/[\r\n]/);
      expect(m1.body_html).toContain("Longevity &lt;script&gt;alert(1)&lt;/script&gt;");
      expect(m1.body_html).toContain("dla Anna");
      expect(m1.body_html).not.toMatch(/<script>|javascript:/i);
      expect(m2.subject).toContain("Przypomnienie: Longevity");
      expect(m2.body_html).toContain("Nadal Longevity &lt;script&gt;");
      expect(m2.body_html).toContain(", Anna");
      expect(d.wyslane).toHaveLength(2);
    });

    it("błąd w zmiennych blokuje publikację, a wersja sprzed szablonów wychodzi bez renderu (tekst z {{ }} dosłownie)", async () => {
      const f = await prosty("REENTRY zly szablon", { tryb: "raz" }, QUIZ, "<p>{% if event.x %}bez końca</p>");
      const w = await zmienStatus(tenantId, f.id, "wlaczony");
      expect(w.ok).toBe(false);
      expect(JSON.stringify(w)).toContain("Błąd w zmiennych");

      const stary = await prosty("REENTRY stara migawka", { tryb: "raz" }, QUIZ, "<p>Cena {{ ceny }}</p>", "Temat {{ x }}");
      await wlacz(stary.id);
      // migawka jak przed wprowadzeniem szablonow: bez znacznika `szablon`
      await getPool().query(
        `update flow_versions set emails = (select jsonb_object_agg(k, v - 'szablon') from jsonb_each(emails) e(k, v))
          where tenant_id = $1 and flow_id = $2`,
        [tenantId, stary.id],
      );
      baza.length = 0;
      dodaj("bartek", {});
      await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
      const [m] = await wiadomosciOsoby("bartek", stary.emailId);
      expect(m.subject).toBe("Temat {{ x }}");
      expect(m.body_html).toContain("Cena {{ ceny }}");
    });
  });

  // ── Wydanie N+1 (0036 zastosowana) ────────────────────────────────────────

  describe("wydanie N+1: po 0036 (kontrakt) i z flagą", () => {
    const PRZYWROC = `
      alter table messages drop constraint if exists messages_journey_ma_przebieg;
      drop index if exists flow_participants_osoba_wejscia_idx;
      alter table flow_participants add constraint flow_participants_tenant_id_flow_id_profile_id_key unique (tenant_id, flow_id, profile_id);
      alter table messages add constraint messages_tenant_id_source_type_source_id_profile_id_key unique nulls not distinct (tenant_id, source_type, source_id, profile_id);`;

    beforeAll(async () => {
      // czysty stan wejsc z czesci N (inaczej 0036 slusznie odmowi przy wielu wejsciach)
      await getPool().query("delete from flows where tenant_id = $1", [tenantId]);
      await getPool().query(readFileSync(join(KATALOG, "migrations-pending", "0036_przebiegi_contract.sql"), "utf-8"));
      ustawZrodloZdarzen(null);
    });

    afterAll(async () => {
      // odwrocenie kontraktu: dane z wieloma przebiegami znikaja razem z tenantem testu
      await getPool().query("delete from flows where tenant_id = $1", [tenantId]);
      await getPool().query("delete from messages where tenant_id = $1", [tenantId]);
      await getPool().query(PRZYWROC);
    });

    it("ponowne wejście staje się dostępne dopiero teraz; „zawsze” da się włączyć", async () => {
      expect(await ponowneWejscieDostepne(getPool())).toBe(true);
      const f = await prosty("REENTRY zawsze", { tryb: "zawsze" });
      await wlacz(f.id);
    });

    it("„zawsze”: dwa zdarzenia = dwa przebiegi = dwie wiadomości z tego samego kroku; jedno zdarzenie w dwóch tikach = jedno wejście", async () => {
      const f = (await getPool().query("select id from flows where tenant_id = $1 and name = 'REENTRY zawsze'", [tenantId])).rows[0];
      const emailId = (await getPool().query("select id from journeys where tenant_id = $1 and flow_id = $2", [tenantId, f.id])).rows[0].id;
      const z1 = await zdarzenie("anna", "popup.submitted", "20 seconds");
      const z2 = await zdarzenie("anna", "popup.submitted", "10 seconds");
      const d = new DostawcaAtrapa();
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      await uruchomAutomatyzacje(tenantId, { dostawca: d }); // te same zdarzenia w zakladce skanu
      const u = await uczestnicy(f.id, "anna");
      expect(u.map((x) => x.entry_key).sort()).toEqual([`e:${z1}`, `e:${z2}`].sort());
      const m = await wiadomosciOsoby("anna", emailId);
      expect(m).toHaveLength(2);
      expect(new Set(m.map((x) => x.journey_run_id))).toEqual(new Set(u.map((x) => x.id)));
      expect(d.wyslane).toEqual(["reentry-anna@example.test", "reentry-anna@example.test"]);
    });

    it("dwa tiki naraz („zawsze” i „po X”): brak podwójnego wejścia i podwójnego maila", async () => {
      const f = (await getPool().query("select id from flows where tenant_id = $1 and name = 'REENTRY zawsze'", [tenantId])).rows[0];
      await usunZdarzenia();
      await zdarzenie("bartek", "popup.submitted", "3 seconds");
      await zdarzenie("bartek", "popup.submitted", "2 seconds");
      await Promise.all([wprowadzUczestnikow(tenantId), wprowadzUczestnikow(tenantId), wprowadzUczestnikow(tenantId)]);
      expect(await uczestnicy(f.id, "bartek")).toHaveLength(2);
      const d = new DostawcaAtrapa();
      await Promise.all([uruchomAutomatyzacje(tenantId, { dostawca: d }), uruchomAutomatyzacje(tenantId, { dostawca: d })]);
      expect(d.wyslane.filter((x) => x === "reentry-bartek@example.test")).toHaveLength(2);

      const po = await prosty("REENTRY po wyscig", { tryb: "po", ilosc: 30, jednostka: "dni" });
      await wlacz(po.id);
      await zdarzenie("p1", "popup.submitted", "3 seconds");
      await zdarzenie("p1", "popup.submitted", "2 seconds");
      await Promise.all([wprowadzUczestnikow(tenantId), wprowadzUczestnikow(tenantId), wprowadzUczestnikow(tenantId)]);
      expect(await uczestnicy(po.id, "p1")).toHaveLength(1);
    });

    it("„po 30 dniach”: w 29. dniu nie, w 31. tak", async () => {
      const f = await prosty("REENTRY po 30", { tryb: "po", ilosc: 30, jednostka: "dni" });
      await wlacz(f.id);
      await zdarzenie("p2", "popup.submitted", "10 seconds");
      await wprowadzUczestnikow(tenantId);
      const [pierwszy] = await uczestnicy(f.id, "p2");
      await getPool().query("update flow_participants set entered_at = now() - interval '29 days' where tenant_id = $1 and id = $2", [tenantId, pierwszy.id]);
      await zdarzenie("p2", "popup.submitted", "5 seconds");
      await wprowadzUczestnikow(tenantId);
      expect(await uczestnicy(f.id, "p2")).toHaveLength(1);
      await getPool().query("update flow_participants set entered_at = now() - interval '31 days' where tenant_id = $1 and id = $2", [tenantId, pierwszy.id]);
      await zdarzenie("p2", "popup.submitted", "1 second");
      await wprowadzUczestnikow(tenantId);
      expect(await uczestnicy(f.id, "p2")).toHaveLength(2);
    });

    it("„raz” po 0036 dalej egzekwuje baza: drugie zdarzenie nie wchodzi", async () => {
      const f = await prosty("REENTRY raz po 0036", { tryb: "raz" });
      await wlacz(f.id);
      await zdarzenie("p3", "popup.submitted", "10 seconds");
      await zdarzenie("p3", "popup.submitted", "5 seconds");
      await wprowadzUczestnikow(tenantId);
      await zdarzenie("p3", "popup.submitted", "1 second");
      await wprowadzUczestnikow(tenantId);
      expect(await uczestnicy(f.id, "p3")).toHaveLength(1);
    });

    it("usunięcie profilu z dwoma przebiegami tego samego kroku przechodzi; historia wiadomości zostaje bez przebiegu", async () => {
      const { rows: przed } = await getPool().query("select count(*)::int as n from messages where tenant_id = $1 and profile_id = $2 and source_type = 'journey'", [tenantId, profile.anna]);
      expect(przed[0].n).toBeGreaterThanOrEqual(2);
      await getPool().query("delete from profiles where tenant_id = $1 and id = $2", [tenantId, profile.anna]);
      const { rows } = await getPool().query(
        "select count(*)::int as n, count(journey_run_id)::int as z_przebiegiem from messages where tenant_id = $1 and profile_id is null and source_type = 'journey'",
        [tenantId],
      );
      expect(rows[0].n).toBe(przed[0].n);
      expect(rows[0].z_przebiegiem).toBe(0);
    });

    it("kampanie po 0036: journey_run_id = NULL, NULLS NOT DISTINCT; dwukrotna budowa = jedna wiadomość na osobę", async () => {
      const l = (await getPool().query("insert into lists (tenant_id, name) values ($1, 'REENTRY lista') returning id", [tenantId])).rows[0].id;
      await getPool().query("insert into list_members (tenant_id, list_id, profile_id, source) values ($1, $2, $3, 'reczny'), ($1, $2, $4, 'reczny')", [tenantId, l, profile.p0, profile.bartek]);
      const c = (await getPool().query(
        `insert into campaigns (tenant_id, name, subject, content, status) values ($1, 'REENTRY kampania', 'Temat', $2, 'draft') returning id`,
        [tenantId, JSON.stringify({ html: "<p>Kampania</p>" })],
      )).rows[0].id;
      await getPool().query("insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id) values ($1, $2, 'include', 'list', $3)", [tenantId, c, l]);
      const a = await zbudujWiadomosciKampanii(tenantId, c);
      const b = await zbudujWiadomosciKampanii(tenantId, c);
      expect(a.utworzone).toBe(2);
      expect(b.utworzone).toBe(0);
      const { rows } = await getPool().query("select count(*)::int as n, count(journey_run_id)::int as z_przebiegiem from messages where tenant_id = $1 and source_id = $2", [tenantId, c]);
      expect(rows[0]).toEqual({ n: 2, z_przebiegiem: 0 });
    });
  });
});
