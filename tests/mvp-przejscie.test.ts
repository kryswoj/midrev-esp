// Integracja MVP (raport 06): flaga MIDREV_GRAF_V2 WYŁĄCZONA w tym pliku (config() buforowany
// per plik), więc domyślnym źródłem wyzwalaczy jest stara tabela `events` - stare flow mają
// działać jak przed wydaniem. Przejście na `metric_events` (flaga włączona) symulujemy
// podmianą źródła (`ustawZrodloZdarzen`) na TEJ SAMEJ bazie i tych samych flow:
//  - to samo zdarzenie widziane w obu tabelach nie daje drugiego wejścia ani maila,
//  - transakcja zatwierdzona z opóźnieniem na styku przełączenia nie przepada,
//  - wiersze zapisane przez STARY kod (okno deployu) dosynchronizowane i wyzwalające,
//  - własne zamówienie nie wyrzuca z flow z regułą „wyjście po zakupie”.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { config } from "../src/config";
import { nowyBlok, pustyDokument } from "../src/domain/email/bloki";
import { regulaCzasu } from "../src/domain/automatyzacje/wyzwalanie";
import { grafDoZapisu, wstawWezel, type Graf } from "../src/domain/automatyzacje/graf";
import type { DostawcaWysylki } from "../src/domain/email/port";
import { METRYKI_WBUDOWANE } from "../src/domain/zdarzenia/kontrakt";
import type { ZamowienieSklepu } from "../src/domain/store/contract";
import { OKNO_DEPLOYU_MS, zaplanujZdarzenia } from "../src/jobs/handlery-zdarzenia";
import {
  metrykiDoWyzwalacza,
  pobierzAutomatyzacje,
  utworzAutomatyzacje,
  utworzWiadomosc,
  zapiszSzkic,
  zapiszWiadomosc,
  zmienStatus,
} from "../src/usecases/automatyzacje/journeye";
import { uruchomAutomatyzacje } from "../src/usecases/automatyzacje/przetworz-zdarzenia";
import {
  katalogMetrykTabela,
  katalogMetrykWbudowanych,
  ustawZrodloZdarzen,
  zrodloZdarzen,
  zrodloZdarzenEvents,
  zrodloZdarzenMetricEvents,
} from "../src/usecases/automatyzacje/zrodlo-zdarzen";
import { upsertZamowienie } from "../src/usecases/przetworz-zdarzenie";
import { dosynchronizujOknoDeployu } from "../src/usecases/zdarzenia/lustro";
import { zapiszZdarzenie } from "../src/usecases/zdarzenia/zapisz-zdarzenie";

const PREFIKS = "MVPPRZ ";

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: string[] = [];
  async wyslij(w: { do: string; idempotencyKey: string }) {
    this.wyslane.push(w.do);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

const naMetricEvents = () => ustawZrodloZdarzen(zrodloZdarzenMetricEvents, katalogMetrykTabela);
const naEvents = () => ustawZrodloZdarzen(zrodloZdarzenEvents, katalogMetrykWbudowanych);

describe("Integracja MVP: flaga wyłączona i przejście events → metric_events", () => {
  let tenantId = "";
  let storeId = "";
  const profil: Record<string, string> = {};
  const d = new DostawcaAtrapa();

  async function dodajProfil(k: string) {
    const pool = getPool();
    profil[k] = (await pool.query("insert into profiles (tenant_id, email, first_name) values ($1, $2, $3) returning id", [tenantId, `przejscie-${k}@example.test`, k])).rows[0].id;
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email', 'granted', 'test', now() - interval '10 days')`,
      [tenantId, profil[k]],
    );
  }
  /** Zapis popupu tak, jak robi to nowy kod (zglos-popup.ts): strumień + lustro, to samo id. */
  async function popupNowymKodem(k: string, klient?: pg.PoolClient) {
    const kl = klient ?? (await getPool().connect());
    try {
      if (!klient) await kl.query("begin");
      const id = randomUUID();
      await zapiszZdarzenie(
        kl,
        { tenantId, metryka: METRYKI_WBUDOWANE.zgloszenieFormularza, profileId: profil[k], occurredAt: new Date(), id, uniqueId: `form:p:${id}`, properties: { form_id: "p", form_name: "Popup" }, source: "client" },
        { lustro: { eventType: "popup.submitted", payload: { popup_id: "p", popup_name: "Popup" } } },
      );
      if (!klient) await kl.query("commit");
      return id;
    } finally {
      if (!klient) kl.release();
    }
  }
  async function mailOsoby(k: string) {
    const { rows } = await getPool().query("select id from messages where tenant_id = $1 and profile_id = $2 and source_type = 'journey'", [tenantId, profil[k]]);
    return rows.length;
  }
  async function wejscia(flowId: string, k: string) {
    const { rows } = await getPool().query("select id, status, context, exit_reason from flow_participants where tenant_id = $1 and flow_id = $2 and profile_id = $3", [tenantId, flowId, profil[k]]);
    return rows;
  }
  async function flowV1(name: string, zdarzenie: "popup.submitted" | "order.created", zmien: (g: Graf, emailId: string) => Graf) {
    const f = await utworzAutomatyzacje(tenantId, { name, zdarzenie });
    if (!f.ok) throw new Error(f.blad);
    const w = await utworzWiadomosc(tenantId, f.id, "Mail");
    if (!w.ok) throw new Error(w.blad);
    const zw = await zapiszWiadomosc(tenantId, f.id, w.id, { temat: "Witaj", dokumentJson: JSON.stringify({ ...pustyDokument(), bloki: [{ ...nowyBlok("tekst"), html: "<p>Witaj</p>" }] }) });
    if (!zw.ok) throw new Error(zw.blad);
    const widok = (await pobierzAutomatyzacje(tenantId, f.id))!;
    const z = await zapiszSzkic(tenantId, f.id, { graf: zmien(widok.graf, w.id), oczekiwanaWersja: widok.draftVersion });
    if (!z.ok) throw new Error(z.blad);
    const s = await zmienStatus(tenantId, f.id, "wlaczony");
    if (!s.ok) throw new Error(s.blad);
    // zdarzenia z tej samej sekundy co włączenie nie mają znaczenia dla tych testów
    await getPool().query("update flows set active_since = now() - interval '1 minute' where tenant_id = $1 and id = $2", [tenantId, f.id]);
    await getPool().query("update flow_trigger_state set scanned_to = now() - interval '1 minute' where tenant_id = $1 and flow_id = $2", [tenantId, f.id]);
    return f.id;
  }
  const tik = () => uruchomAutomatyzacje(tenantId, { dostawca: d });

  beforeAll(async () => {
    expect(config().MIDREV_GRAF_V2).toBe(false);
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "tenant"])).rows[0].id;
    storeId = (await pool.query(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status) values ($1, 'woocommerce', 'https://przejscie.example.test', '\\x00', 'connected') returning id`,
      [tenantId],
    )).rows[0].id;
    for (const k of ["anna", "bartek", "cezary", "dorota", "edek", "franek", "gosia"]) await dodajProfil(k);
  });

  afterEach(() => ustawZrodloZdarzen(null));

  afterAll(async () => {
    ustawZrodloZdarzen(null);
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  let powitanie = "";

  it("flaga wyłączona: źródło = stara tabela events, katalog = metryki wbudowane v1; stare powitanie po popupie działa jak dawniej", async () => {
    expect(zrodloZdarzen().nazwa).toBe("events");
    expect((await metrykiDoWyzwalacza(tenantId)).map((m) => m.klucz).sort()).toEqual(["midrev|Submitted Form", "woocommerce|Placed Order"]);
    expect((await utworzAutomatyzacje(tenantId, { name: PREFIKS + "api", metryka: "api|Lead z formularza" })).ok).toBe(false);
    powitanie = await flowV1(PREFIKS + "powitanie", "popup.submitted", (g, e) => wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "m", typ: "email", emailId: e, links: { next: null } }));
    const { rows } = await getPool().query("select live->>'wersja' as w, trigger_metric_id from flows where id = $1", [powitanie]);
    expect(rows[0]).toEqual({ w: "1", trigger_metric_id: null }); // v1 w bazie: rollback kodu go przeczyta
    await popupNowymKodem("anna");
    await tik();
    await tik();
    expect(await wejscia(powitanie, "anna")).toHaveLength(1);
    expect(await mailOsoby("anna")).toBe(1);
  });

  it("przełączenie na metric_events: zdarzenie już obsłużone ze starej tabeli nie wchodzi drugi raz; nowe wchodzi; powrót też bez duplikatu", async () => {
    naMetricEvents();
    await tik();
    expect(await wejscia(powitanie, "anna")).toHaveLength(1);
    expect(await mailOsoby("anna")).toBe(1);
    await popupNowymKodem("bartek");
    await tik();
    expect(await wejscia(powitanie, "bartek")).toHaveLength(1);
    expect(await mailOsoby("bartek")).toBe(1);
    naEvents();
    await tik();
    expect(await mailOsoby("anna")).toBe(1);
    expect(await mailOsoby("bartek")).toBe(1);
  });

  it("transakcja zatwierdzona PO tiku starego źródła i przed tikiem nowego (kursor z events, odczyt z metric_events) nie przepada", async () => {
    naEvents();
    const klient = await getPool().connect();
    try {
      await klient.query("begin");
      await popupNowymKodem("cezary", klient); // recorded_at przed kursorem kolejnego tiku
      await tik(); // stare źródło: zdarzenia jeszcze nie widać, kursor idzie naprzód
      expect(await wejscia(powitanie, "cezary")).toHaveLength(0);
      await klient.query("commit");
    } finally {
      klient.release();
    }
    naMetricEvents();
    await tik(); // zakładka 15 min w nowym źródle
    expect(await wejscia(powitanie, "cezary")).toHaveLength(1);
    expect(await mailOsoby("cezary")).toBe(1);
  });

  it("okno deployu: wiersz zapisany przez STARY kod tylko do events trafia do strumienia jako wyzwalający i wchodzi raz; historia > 4 h i import zostają backfillem", async () => {
    naMetricEvents();
    const pool = getPool();
    const { rows: stary } = await pool.query(
      `insert into events (tenant_id, profile_id, event_type, payload, occurred_at) values ($1, $2, 'popup.submitted', '{"popup_id":"p","popup_name":"Popup"}', now()) returning id`,
      [tenantId, profil.dorota],
    );
    const { rows: historia } = await pool.query(
      `insert into events (tenant_id, profile_id, event_type, payload, occurred_at, recorded_at) values ($1, $2, 'popup.submitted', '{"popup_id":"p"}', now() - interval '5 hours', now() - interval '5 hours') returning id`,
      [tenantId, profil.edek],
    );
    const { rows: imp } = await pool.query(
      `insert into events (tenant_id, profile_id, event_type, payload, occurred_at) values ($1, $2, 'order.created', '{"orderId":"x","totalMinor":100,"kanal":"import"}', now()) returning id`,
      [tenantId, profil.edek],
    );
    await tik();
    expect(await wejscia(powitanie, "dorota")).toHaveLength(0); // jeszcze nie ma go w strumieniu
    expect(await dosynchronizujOknoDeployu()).toBeGreaterThanOrEqual(1);
    const { rows: bf } = await pool.query("select id, backfill from metric_events where tenant_id = $1 and id = any($2::uuid[])", [tenantId, [stary[0].id, imp[0].id]]);
    expect(Object.fromEntries(bf.map((r) => [r.id, r.backfill]))).toEqual({ [stary[0].id]: false, [imp[0].id]: true });
    // historia sprzed 5 h: poza oknem cyklicznego przebiegu (1 h); przebieg startowy (7 dni) = backfill
    await pool.query("select metryki_dosynchronizuj_events(now() - interval '7 days')");
    expect((await pool.query("select backfill from metric_events where tenant_id = $1 and id = $2", [tenantId, historia[0].id])).rows[0].backfill).toBe(true);
    await tik();
    await tik();
    expect(await wejscia(powitanie, "dorota")).toHaveLength(1);
    expect(await mailOsoby("dorota")).toBe(1);
    expect(await wejscia(powitanie, "edek")).toHaveLength(0);
    // powrót na stare źródło: ten sam wiersz events, to samo id - bez drugiego wejścia
    naEvents();
    await tik();
    expect(await mailOsoby("dorota")).toBe(1);
  });

  it("cykliczne dosynchronizowanie okna deployu działa tylko przez pierwsze 30 min pracy workera", async () => {
    let teraz = Date.now();
    const plan = zaplanujZdarzenia({ workerId: "test", wyslijAlert: async () => {}, teraz: () => teraz });
    const okno = plan.cykliczne.find((c) => c.nazwa === "strumień: okno deployu")!;
    expect(okno.ms).toBe(60_000);
    const wstaw = async () =>
      (await getPool().query(
        `insert into events (tenant_id, profile_id, event_type, payload, occurred_at) values ($1, $2, 'popup.submitted', '{"popup_id":"p"}', now()) returning id`,
        [tenantId, profil.franek],
      )).rows[0].id as string;
    const jest = async (id: string) => (await getPool().query("select 1 from metric_events where tenant_id = $1 and id = $2", [tenantId, id])).rowCount;
    const a = await wstaw();
    await okno.praca();
    expect(await jest(a)).toBe(1);
    teraz += OKNO_DEPLOYU_MS + 60_000;
    const b = await wstaw();
    await okno.praca();
    expect(await jest(b)).toBe(0);
  });

  it("„złożone zamówienie” z wyjściem po zakupie: własne zamówienie (z ułamkiem sekundy) nie wyrzuca z flow, kolejne tak; orderId = orders.id", async () => {
    for (const zrodlo of ["metric_events", "events"] as const) {
      if (zrodlo === "metric_events") naMetricEvents();
      else naEvents();
      const k = zrodlo === "metric_events" ? "gosia" : "franek";
      const flow = await flowV1(PREFIKS + `zamowienie ${zrodlo}`, "order.created", (g, e) => {
        let x = { ...g, ustawienia: { ...g.ustawienia, wyjsciePoZakupie: true } };
        x = wstawWezel(x, { po: "wyzwalacz", port: "next" }, { id: "op", typ: "opoznienie", ilosc: 1, jednostka: "dni", links: { next: null } });
        return wstawWezel(x, { po: "op", port: "next" }, { id: "m", typ: "email", emailId: e, links: { next: null } });
      });
      const zamowienie = (ext: string, kiedy: Date): ZamowienieSklepu => ({
        externalId: ext, numer: ext, status: "processing", email: `przejscie-${k}@example.test`, imie: null, nazwisko: null,
        sumaMinor: 19900, waluta: "PLN", occurredAt: kiedy, zmodyfikowaneAt: kiedy,
        pozycje: [{ sku: "S1", nazwa: "Pakiet", ilosc: 1, cenaMinor: 19900, productId: "11" }], surowe: {},
      });
      const klient = await getPool().connect();
      let orderId = "";
      try {
        await klient.query("begin");
        const kiedy = new Date(Math.floor(Date.now() / 1000) * 1000 - 2000 + 789); // .789 s
        orderId = (await upsertZamowienie(klient, tenantId, storeId, zamowienie(`${zrodlo}-1`, kiedy))).orderId!;
        await klient.query("commit");
      } finally {
        klient.release();
      }
      await tik();
      await tik();
      const [u] = await wejscia(flow, k);
      expect(u, zrodlo).toBeDefined();
      expect(u.status, zrodlo).toBe("w_toku");
      expect(u.context.orderId, zrodlo).toBe(orderId);
      // drugie zamówienie po wejściu: wyjście „zakup” przy najbliższym ruchu
      await getPool().query(
        `insert into orders (tenant_id, store_id, profile_id, external_id, number, status, total_minor, currency, occurred_at)
         values ($1, $2, $3, $4, $4, 'completed', 5000, 'PLN', now())`,
        [tenantId, storeId, profil[k], `${zrodlo}-2`],
      );
      await getPool().query("update flow_participants set resume_at = now() - interval '1 minute' where id = $1", [u.id]);
      await tik();
      const [po] = await wejscia(flow, k);
      expect(po.status, zrodlo).toBe("wyszedl");
      expect(po.exit_reason, zrodlo).toBe("zakup");
      await getPool().query("update flows set status = 'wstrzymany' where id = $1", [flow]);
    }
  });

  it("metryka nieznana staremu źródłu (API przy fladze wyłączonej): kursor stoi, alert; po włączeniu zdarzenie z tego okresu wchodzi", async () => {
    const flow = await flowV1(PREFIKS + "api przy fladze off", "popup.submitted", (g, e) => wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "m", typ: "email", emailId: e, links: { next: null } }));
    // definicja v2 na metryce z API (tak zostaje w bazie po wyłączeniu flagi)
    const g = (await pobierzAutomatyzacje(tenantId, flow))!.graf;
    const v2 = { ...g, wezly: g.wezly.map((w) => (w.typ === "wyzwalacz" ? { ...w, zrodlo: { rodzaj: "metryka" as const, metryka: { integracja: "api", nazwa: "Lead z formularza" } } } : w)) };
    await getPool().query("update flows set live = $3 where tenant_id = $1 and id = $2", [tenantId, flow, JSON.stringify(grafDoZapisu(v2 as Graf))]);
    await getPool().query("update flows set status = 'wstrzymany' where tenant_id = $1 and id <> $2 and status = 'wlaczony'", [tenantId, flow]);
    const kursor = async () => (await getPool().query("select scanned_to::text as s from flow_trigger_state where flow_id = $1", [flow])).rows[0]?.s;
    naEvents();
    expect((await tik()).alerty.some((a) => a.includes("wymaga MIDREV_GRAF_V2"))).toBe(true);
    const przed = await kursor();
    // lead z API zapisany, gdy flaga jest wyłączona; kursor nie może przeskoczyć za niego
    // (bez poprawki tik starego źródła ustawiał scanned_to = now() i po > 15 min zdarzenie przepadało)
    const klient = await getPool().connect();
    try {
      await klient.query("begin");
      await zapiszZdarzenie(klient, { tenantId, metryka: { integracja: "api", nazwa: "Lead z formularza" }, profileId: profil.anna, occurredAt: new Date(), uniqueId: "lead-off", properties: { cel: "x" }, source: "api" });
      await klient.query("commit");
    } finally {
      klient.release();
    }
    expect((await tik()).alerty.some((a) => a.includes("wymaga MIDREV_GRAF_V2"))).toBe(false); // dławik: raz na godzinę
    expect(await kursor()).toBe(przed);
    naMetricEvents();
    await tik();
    expect(await wejscia(flow, "anna")).toHaveLength(1);
    await getPool().query("update flows set status = 'wstrzymany' where id = $1", [flow]);
    await getPool().query("update flows set status = 'wlaczony' where id = $1", [powitanie]);
  });

  it("{{ event.X }} ma ten sam kształt (Klaviyo, z metric_events) niezależnie od flagi: lustro ma to samo id", async () => {
    naEvents();
    await getPool().query("update flows set status = 'wstrzymany' where tenant_id = $1 and status = 'wlaczony'", [tenantId]);
    const f = await utworzAutomatyzacje(tenantId, { name: PREFIKS + "zmienne", zdarzenie: "popup.submitted" });
    if (!f.ok) throw new Error(f.blad);
    const w = await utworzWiadomosc(tenantId, f.id, "Mail");
    if (!w.ok) throw new Error(w.blad);
    await zapiszWiadomosc(tenantId, f.id, w.id, { temat: "Formularz {{ event.form_name }}", dokumentJson: JSON.stringify({ ...pustyDokument(), bloki: [{ ...nowyBlok("tekst"), html: "<p>{{ event.form_id }}</p>" }] }) });
    const widok = (await pobierzAutomatyzacje(tenantId, f.id))!;
    await zapiszSzkic(tenantId, f.id, { graf: wstawWezel(widok.graf, { po: "wyzwalacz", port: "next" }, { id: "m", typ: "email", emailId: w.id, links: { next: null } }), oczekiwanaWersja: widok.draftVersion });
    expect((await zmienStatus(tenantId, f.id, "wlaczony")).ok).toBe(true);
    await getPool().query("update flows set active_since = now() - interval '1 minute' where id = $1", [f.id]);
    await popupNowymKodem("gosia");
    await tik();
    const { rows } = await getPool().query("select subject from messages where tenant_id = $1 and profile_id = $2 and source_id = $3", [tenantId, profil.gosia, w.id]);
    expect(rows.map((r) => r.subject)).toEqual(["Formularz Popup"]);
  });

  it("reguła czasu: zdarzenie z sekundy włączenia liczy się, gdy DOTARŁO po włączeniu", () => {
    const aktywny = Date.parse("2026-09-30T10:00:00.750Z");
    const bazowe = { occurredAtMs: Date.parse("2026-09-30T10:00:00.000Z"), backfill: false, source: "api" as const };
    expect(regulaCzasu({ ...bazowe, recordedAtMs: aktywny + 100, ingestedAtMs: aktywny + 50 }, aktywny)).toBeNull();
    expect(regulaCzasu({ ...bazowe, recordedAtMs: aktywny + 100, ingestedAtMs: aktywny - 300 }, aktywny)).toBe("sprzed_wlaczenia");
    expect(regulaCzasu({ ...bazowe, occurredAtMs: bazowe.occurredAtMs - 1000, recordedAtMs: aktywny + 100, ingestedAtMs: aktywny + 50 }, aktywny)).toBe("sprzed_wlaczenia");
  });
});
