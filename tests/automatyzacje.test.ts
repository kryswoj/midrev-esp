import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { uruchomAutomatyzacje } from "../src/usecases/automatyzacje/przetworz-zdarzenia";
import { pobierzAutomatyzacje } from "../src/usecases/automatyzacje/journeye";
import type { DostawcaWysylki } from "../src/domain/email/port";

// Zgodnosc wstecz automatyzacji (Epik E -> graf, migracja 0019). Test wykonuje PRAWDZIWY
// fragment migracji danych z pliku 0019 na journeyach w starym ksztalcie (wyzwalacz +
// opoznienie + jeden mail, rejestr journey_runs) i sprawdza, ze:
//  - graf jest deterministyczny (stale id wezlow, flow.id = journey.id),
//  - zmigrowany flow dalej wysyla tym samym silnikiem, z tym samym tematem i trescia,
//  - osoba z rejestru journey_runs nie dostaje powitania drugi raz,
//  - opoznienie liczy sie od occurred_at zdarzenia (AD-10), nie od tika.

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: string[] = [];
  async wyslij(w: { do: string; idempotencyKey: string }) {
    this.wyslane.push(w.do);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

const PLIK = readFileSync(join(import.meta.dirname, "..", "migrations", "0019_flow_graf.sql"), "utf-8");
const SEKCJA = PLIK.slice(PLIK.indexOf("-- >>> MIGRACJA DANYCH"), PLIK.indexOf("-- <<< MIGRACJA DANYCH"));
// 0025: migawka tresci w wersji (silnik wysyla z niej, nie z edytowanej wiadomosci)
const PLIK_0025 = readFileSync(join(import.meta.dirname, "..", "migrations", "0025_flow_migawki_i_poprawki.sql"), "utf-8");
const SEKCJA_0025 = PLIK_0025.slice(PLIK_0025.indexOf("-- >>> MIGAWKI WERSJI"), PLIK_0025.indexOf("-- <<< MIGAWKI WERSJI"));

describe("Automatyzacje: migracja starych journeyów do grafu (0019)", () => {
  let tenantId: string;
  let powitanieId: string;
  let podziekowanieId: string;
  const profile: Record<string, string> = {};

  async function dodajProfil(klucz: string, email: string) {
    const pool = getPool();
    const p = await pool.query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantId, email]);
    profile[klucz] = p.rows[0].id;
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
       values ($1, $2, 'email', 'granted', 'test', now() - interval '10 days')`,
      [tenantId, profile[klucz]],
    );
  }
  async function zdarzenie(klucz: string, typ: string, przesuniecie: string) {
    await getPool().query(
      `insert into events (tenant_id, profile_id, event_type, occurred_at) values ($1, $2, $3, now() - $4::interval)`,
      [tenantId, profile[klucz], typ, przesuniecie],
    );
  }

  beforeAll(async () => {
    const pool = getPool();
    expect(SEKCJA.length).toBeGreaterThan(500);
    await pool.query("delete from tenants where name like 'AUT %'");
    const t = await pool.query("insert into tenants (name) values ('AUT tenant') returning id");
    tenantId = t.rows[0].id;
    await dodajProfil("obsluzony", "aut-obsluzony@example.test");
    await dodajProfil("nowy", "aut-nowy@example.test");
    await dodajProfil("delayowy", "aut-delay@example.test");

    // journey w ksztalcie SPRZED 0019: aktywny, z opoznieniem i wpisem w rejestrze
    const j = await pool.query(
      `insert into journeys (tenant_id, name, trigger_event, delay_minutes, subject, content, active, active_since)
       values ($1, 'AUT powitanie', 'popup.submitted', 120, 'Witaj!', $2, true, now() - interval '1 day')
       returning id`,
      [tenantId, JSON.stringify({ html: '<p>Cześć! <a href="https://sklep.example.test">Sklep</a></p>' })],
    );
    powitanieId = j.rows[0].id;
    await pool.query("insert into journey_runs (journey_id, profile_id, triggered_at) values ($1, $2, now() - interval '3 hours')", [powitanieId, profile.obsluzony]);
    const j2 = await pool.query(
      `insert into journeys (tenant_id, name, trigger_event, delay_minutes, subject, content, active)
       values ($1, 'AUT podziękowanie', 'order.created', 0, 'Dzięki', $2, false) returning id`,
      [tenantId, JSON.stringify({ html: "<p>Dzięki za zakup</p>" })],
    );
    podziekowanieId = j2.rows[0].id;

    // PRAWDZIWY fragment migracji danych z pliku 0019 (wiersze z flow_id is null)
    await pool.query(SEKCJA);
    await pool.query(SEKCJA_0025);
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like 'AUT %'");
    await closePool();
  });

  it("każdy stary journey staje się flow o tym samym id z deterministycznym grafem", async () => {
    const pool = getPool();
    const { rows: flowy } = await pool.query("select id, status, trigger_event, live_version, draft from flows where tenant_id = $1 order by name", [tenantId]);
    expect(flowy.map((f) => f.id).sort()).toEqual([powitanieId, podziekowanieId].sort());
    const powitanie = flowy.find((f) => f.id === powitanieId)!;
    expect(powitanie).toMatchObject({ status: "wlaczony", trigger_event: "popup.submitted", live_version: 1 });
    expect(powitanie.draft.wezly.map((w: any) => w.id)).toEqual(["wyzwalacz", "opoznienie", "email", "koniec"]);
    expect(powitanie.draft.wezly[1]).toMatchObject({ typ: "opoznienie", ilosc: 120, jednostka: "minuty" });
    expect(powitanie.draft.wezly[2]).toMatchObject({ typ: "email", emailId: powitanieId });
    const podziekowanie = flowy.find((f) => f.id === podziekowanieId)!;
    expect(podziekowanie.status).toBe("szkic");
    expect(podziekowanie.draft.wezly.map((w: any) => w.id)).toEqual(["wyzwalacz", "email", "koniec"]);

    const { rows: wiadomosci } = await pool.query("select id, flow_id, node_id from journeys where tenant_id = $1", [tenantId]);
    expect(wiadomosci.every((w) => w.flow_id === w.id && w.node_id === "email")).toBe(true);

    // graf przechodzi bramke: stary journey z trescia i tematem da sie wlaczyc od razu
    const widok = (await pobierzAutomatyzacje(tenantId, powitanieId))!;
    expect(widok.bramka).toEqual([]);
    expect(widok.emaile[powitanieId]).toMatchObject({ temat: "Witaj!", maTresc: true });
    // migawka wersji 1 = dokladnie to, co stary journey wysylal
    const { rows: v } = await pool.query("select emails from flow_versions where tenant_id = $1 and flow_id = $2 and version = 1", [tenantId, powitanieId]);
    expect(v[0].emails[powitanieId].subject).toBe("Witaj!");
    expect(v[0].emails[powitanieId].html).toContain("sklep.example.test");
  });

  it("rejestr journey_runs staje się zakończonym uczestnikiem: ta osoba nie dostaje powitania drugi raz", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      "select status, node_id, entered_at from flow_participants where tenant_id = $1 and flow_id = $2 and profile_id = $3",
      [tenantId, powitanieId, profile.obsluzony],
    );
    expect(rows[0]).toMatchObject({ status: "zakonczony", node_id: "koniec" });
    // data wejscia = triggered_at rejestru (AD-10), nie chwila migracji
    expect(Date.now() - new Date(rows[0].entered_at).getTime()).toBeGreaterThan(2.5 * 3600_000);

    await zdarzenie("obsluzony", "popup.submitted", "10 minutes");
    const dostawca = new DostawcaAtrapa();
    const wynik = await uruchomAutomatyzacje(tenantId, { dostawca });
    expect(wynik.wejscia).toBe(0);
    expect(dostawca.wyslane).toEqual([]);
  });

  it("zmigrowany flow działa dalej: opóźnienie od occurred_at zdarzenia, potem mail z tym samym tematem i treścią, przez ten sam silnik", async () => {
    const pool = getPool();
    await zdarzenie("nowy", "popup.submitted", "30 minutes");
    const dostawca = new DostawcaAtrapa();
    const przedCzasem = await uruchomAutomatyzacje(tenantId, { dostawca });
    expect(przedCzasem.wejscia).toBe(1);
    expect(przedCzasem.zbudowane).toBe(0);
    expect(dostawca.wyslane).toEqual([]);
    const { rows: czeka } = await pool.query(
      "select node_id, resume_at, entered_at from flow_participants where tenant_id = $1 and flow_id = $2 and profile_id = $3",
      [tenantId, powitanieId, profile.nowy],
    );
    expect(czeka[0].node_id).toBe("opoznienie");
    // wznowienie = occurred_at zdarzenia + 120 min (a nie tik + 120 min)
    expect(new Date(czeka[0].resume_at).getTime() - new Date(czeka[0].entered_at).getTime()).toBe(120 * 60_000);

    // czas mija
    await pool.query("update flow_participants set resume_at = now() - interval '1 minute' where tenant_id = $1 and profile_id = $2", [tenantId, profile.nowy]);
    const poCzasie = await uruchomAutomatyzacje(tenantId, { dostawca });
    expect(poCzasie.zbudowane).toBe(1);
    expect(dostawca.wyslane).toEqual(["aut-nowy@example.test"]);

    const { rows } = await pool.query(
      `select current_state, subject, body_html from messages
        where tenant_id = $1 and source_type = 'journey' and source_id = $2 and profile_id = $3`,
      [tenantId, powitanieId, profile.nowy],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].current_state).toBe("sent");
    expect(rows[0].subject).toBe("Witaj!");
    // linki przepisane na sledzone, stopka z wypisaniem doklejona: pelny render kampanijny
    expect(rows[0].body_html).not.toContain('href="https://sklep.example.test"');
    expect(rows[0].body_html).toMatch(/\/u\/[A-Za-z0-9_-]+/);
  });

  it("nieaktywny stary journey jest szkicem: nie wpuszcza nikogo i nie wysyła", async () => {
    await zdarzenie("delayowy", "order.created", "1 hour");
    const dostawca = new DostawcaAtrapa();
    const wynik = await uruchomAutomatyzacje(tenantId, { dostawca });
    expect(wynik.wejscia).toBe(0);
    expect(dostawca.wyslane).toEqual([]);
  });

  it("włączenie nie sięga wstecz: zdarzenia sprzed active_since milczą", async () => {
    await zdarzenie("delayowy", "popup.submitted", "30 hours");
    const dostawca = new DostawcaAtrapa();
    const wynik = await uruchomAutomatyzacje(tenantId, { dostawca });
    expect(wynik.wejscia).toBe(0);
    expect(dostawca.wyslane).toEqual([]);
  });
});
