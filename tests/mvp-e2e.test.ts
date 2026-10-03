// Kryterium „gotowe” MVP MidRev (03-PLAN 7.2) jako JEDEN test end-to-end na prawdziwej bazie,
// z nowymi automatyzacjami włączonymi (MIDREV_GRAF_V2; config() jest buforowany per plik).
//
//   n8n wysyła „Lead z formularza” w kształcie Klaviyo (POST /api/events/, klucz tenanta)
//   → worker (handler joba przetworz_zdarzenie_api) zapisuje zdarzenie w metric_events
//   → flow z wyzwalaczem metrycznym i filtrem wyzwalacza wysyła powitanie
//     z {{ event.X }} i {{ person.first_name }};
//   retry n8n (to samo ciało, ten sam unique_id) i ponowienie joba nie dublują ani zdarzenia,
//   ani wejścia, ani maila; powitanie po popupie działa na metryce „Submitted Form”;
//   zdarzenie widać na osi profilu z właściwościami.
process.env.MIDREV_GRAF_V2 = "1";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { middleware } from "../middleware";
import { closePool, getPool } from "../src/adapters/db/pool";
import { POST } from "../src/app/api/events/route";
import { config } from "../src/config";
import { nowyBlok, pustyDokument } from "../src/domain/email/bloki";
import { wstawWezel, type Graf, type Wezel } from "../src/domain/automatyzacje/graf";
import type { DostawcaWysylki } from "../src/domain/email/port";
import { HANDLERY_AUTOMATYZACJI } from "../src/jobs/handlery-automatyzacje";
import { HANDLERY_ZDARZEN } from "../src/jobs/handlery-zdarzenia";
import { domknijZadanie, zajmijZadanie, zwolnijZadanie, type Zadanie } from "../src/jobs/kolejka";
import { utworzKlucz } from "../src/usecases/api/klucze";
import { wyczyscLimity } from "../src/usecases/api/limity";
import { RODZAJ_JOBA } from "../src/usecases/api/przyjmij-zdarzenie";
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
import { katalogMetryk, zrodloZdarzen } from "../src/usecases/automatyzacje/zrodlo-zdarzen";
import { ustawAktywnosc, utworzPopup } from "../src/usecases/popupy/zarzadzaj";
import { przyjmijZgloszenie } from "../src/usecases/popupy/zglos-popup";
import { osProfilu, wlasciwosciZdarzenia } from "../src/usecases/zdarzenia/odczyt";
import { sciezkaPoPrzepisaniu } from "../src/trasy-publiczne";

const PREFIKS = "MVPE2E ";
const znak = randomBytes(3).toString("hex");
const NAGLOWKI_N8N: Record<string, string> = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "n8n-klaviyo", "naglowki.json"), "utf-8"),
);

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: string[] = [];
  async wyslij(w: { do: string; idempotencyKey: string }) {
    this.wyslane.push(w.do);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

/** Ciało dokładnie jak z węzła HTTP n8n (Create Event, revision 2025-01-15). */
function cialoLeada(o: { email: string; imie: string; cel: string; uniqueId: string }) {
  return JSON.stringify({
    data: {
      type: "event",
      attributes: {
        properties: { cel: o.cel, zrodlo: "formularz-kontakt", $extra: { strona: "/kontakt" } },
        metric: { data: { type: "metric", attributes: { name: "Lead z formularza" } } },
        profile: { data: { type: "profile", attributes: { email: o.email, first_name: o.imie } } },
        unique_id: o.uniqueId,
      },
    },
  });
}

/** Jak w produkcji: middleware (ukośnik na końcu, bez 308), potem handler trasy. */
async function wyslijZN8n(cialo: string, klucz: string) {
  const naglowki = { ...NAGLOWKI_N8N, Authorization: `Klaviyo-API-Key ${klucz}` };
  const wstepne = new NextRequest(new URL("/api/events/", "https://api.midrev.test"), { method: "POST", headers: naglowki, body: cialo });
  const mw = middleware(wstepne);
  expect(mw.headers.get("location")).toBeNull();
  expect(mw.headers.get("x-middleware-rewrite")).toBeNull();
  const cel = new URL(sciezkaPoPrzepisaniu("/api/events/"), "https://api.midrev.test");
  const odp = await POST(new NextRequest(cel, { method: "POST", headers: naglowki, body: cialo }));
  return odp.status;
}

describe("MVP end-to-end: n8n → /api/events → flow z filtrem → mail ze zmiennymi (flaga MIDREV_GRAF_V2)", () => {
  let tenantId = "";
  let obcyTenantId = "";
  let klucz = "";
  let kluczObcy = "";
  const profil: Record<string, string> = {};
  const d = new DostawcaAtrapa();

  /**
   * Worker: produkcyjne zajmowanie (`zajmijZadanie`, globalna kolejka, SKIP LOCKED), handler
   * z mapy workera i domknięcie z tokenem. Zadania innych tenantów (resztki innych plików
   * testów) są oddawane nietknięte przez `zwolnijZadanie`.
   */
  async function worker(t: string) {
    const WORKER = `e2e-${znak}`;
    const moje: Zadanie[] = [];
    const cudze: Zadanie[] = [];
    for (let z = await zajmijZadanie(WORKER); z; z = await zajmijZadanie(WORKER)) {
      if (z.tenant_id !== t || !HANDLERY_ZDARZEN[z.kind]) {
        cudze.push(z);
        continue;
      }
      await HANDLERY_ZDARZEN[z.kind](z);
      await domknijZadanie(z, WORKER);
      moje.push(z);
    }
    for (const z of cudze) await zwolnijZadanie(z, WORKER);
    const { rows } = await getPool().query("select count(*)::int as n from jobs where tenant_id = $1 and kind = $2 and status <> 'done'", [t, RODZAJ_JOBA]);
    expect(rows[0].n).toBe(0);
    return moje;
  }
  /** Tik automatyzacji: ta sama funkcja co handler `automatyzacje_tik`, z atrapą dostawcy. */
  async function tik() {
    expect(HANDLERY_AUTOMATYZACJI.automatyzacje_tik).toBeTypeOf("function");
    const w = await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(w.alerty).toEqual([]);
    return w;
  }
  async function wiadomosci(klucz: string) {
    const { rows } = await getPool().query(
      "select subject, body_html, source_id, journey_run_id from messages where tenant_id = $1 and profile_id = $2 and source_type = 'journey' order by created_at",
      [tenantId, profil[klucz]],
    );
    return rows;
  }
  async function dodajProfil(k: string, email: string) {
    const pool = getPool();
    profil[k] = (await pool.query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantId, email])).rows[0].id;
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
       values ($1, $2, 'email', 'granted', 'test', now() - interval '10 days')`,
      [tenantId, profil[k]],
    );
  }
  async function flowZMailem(o: { name: string; metryka: string; temat: string; html: string; filtr?: unknown }) {
    const f = await utworzAutomatyzacje(tenantId, { name: o.name, metryka: o.metryka });
    if (!f.ok) throw new Error(f.blad);
    const w = await utworzWiadomosc(tenantId, f.id, "Powitanie");
    if (!w.ok) throw new Error(w.blad);
    const dokument = JSON.stringify({ ...pustyDokument(), bloki: [{ ...nowyBlok("tekst"), html: o.html }] });
    const zw = await zapiszWiadomosc(tenantId, f.id, w.id, { temat: o.temat, dokumentJson: dokument });
    if (!zw.ok) throw new Error(zw.blad);
    const widok = (await pobierzAutomatyzacje(tenantId, f.id))!;
    let g: Graf = widok.graf;
    if (o.filtr) g = { ...g, wezly: g.wezly.map((x) => (x.typ === "wyzwalacz" && x.zrodlo.rodzaj === "metryka" ? ({ ...x, zrodlo: { ...x.zrodlo, filtr: o.filtr } } as Wezel) : x)) };
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "mail", typ: "email", emailId: w.id, links: { next: null } });
    const z = await zapiszSzkic(tenantId, f.id, { graf: g, oczekiwanaWersja: widok.draftVersion });
    if (!z.ok) throw new Error(z.blad);
    const s = await zmienStatus(tenantId, f.id, "wlaczony");
    if (!s.ok) throw new Error(`${s.blad} ${JSON.stringify((s as { bledy?: unknown }).bledy ?? [])}`);
    return { id: f.id, emailId: w.id };
  }

  beforeAll(async () => {
    expect(config().MIDREV_GRAF_V2).toBe(true);
    expect(zrodloZdarzen().nazwa).toBe("metric_events");
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "tenant"])).rows[0].id;
    obcyTenantId = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "obcy"])).rows[0].id;
    klucz = (await utworzKlucz(tenantId, { nazwa: "n8n MidRev", zakresy: ["events:write"], aktorId: null })).jawny;
    kluczObcy = (await utworzKlucz(obcyTenantId, { nazwa: "n8n obcy", zakresy: ["events:write"], aktorId: null })).jawny;
    await dodajProfil("anna", `e2e-anna-${znak}@example.test`);
    await dodajProfil("bartek", `e2e-bartek-${znak}@example.test`);
  });

  beforeEach(() => wyczyscLimity());

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  it("1. pierwsze zdarzenie z n8n zakłada metrykę API; metryka trafia do katalogu wyzwalaczy", async () => {
    expect(await wyslijZN8n(cialoLeada({ email: `e2e-rozgrzewka-${znak}@example.test`, imie: "Rozgrzewka", cel: "energia", uniqueId: "lead-0" }), klucz)).toBe(202);
    expect(await worker(tenantId)).toHaveLength(1);
    const metryki = await metrykiDoWyzwalacza(tenantId);
    expect(metryki.map((m) => m.klucz)).toEqual(expect.arrayContaining(["api|Lead z formularza", "midrev|Submitted Form", "woocommerce|Placed Order"]));
    expect((await katalogMetryk().lista(getPool(), tenantId)).find((m) => m.nazwa === "Lead z formularza")!.id).not.toBeNull();
  });

  let flowLead = { id: "", emailId: "" };

  it("2. flow na metryce „Lead z formularza” z filtrem wyzwalacza (cel = energia) i zmiennymi się publikuje", async () => {
    flowLead = await flowZMailem({
      name: PREFIKS + "Lead z formularza",
      metryka: "api|Lead z formularza",
      temat: "Cześć {{ person.first_name }}, mamy plan",
      html: "<p>Twój cel: {{ event.cel }} (strona {{ event.extra.strona }})</p>",
      filtr: { grupy: [{ warunki: [{ typ: "wlasciwosc_zdarzenia", pole: "cel", typPola: "string", operator: "rowna", wartosc: "energia" }] }] },
    });
    const { rows } = await getPool().query(
      "select f.trigger_metric_id, m.name, f.live->>'wersja' as wersja from flows f join metrics m on m.tenant_id = f.tenant_id and m.id = f.trigger_metric_id where f.tenant_id = $1 and f.id = $2",
      [tenantId, flowLead.id],
    );
    expect(rows[0]).toMatchObject({ name: "Lead z formularza", wersja: "2" });
  });

  it("3. lead pasujący do filtra → jeden mail z {{ event.X }} i {{ person.first_name }}; niepasujący → nic", async () => {
    const annaLead = cialoLeada({ email: `E2E-Anna-${znak}@Example.test`, imie: "Anna", cel: "energia", uniqueId: "lead-anna-1" });
    expect(await wyslijZN8n(annaLead, klucz)).toBe(202);
    // retry n8n (timeout po stronie n8n): to samo ciało, ten sam unique_id
    expect(await wyslijZN8n(annaLead, klucz)).toBe(202);
    expect(await wyslijZN8n(cialoLeada({ email: `e2e-bartek-${znak}@example.test`, imie: "Bartek", cel: "waga", uniqueId: "lead-bartek-1" }), klucz)).toBe(202);
    // retry z tym samym unique_id odpada już przy przyjęciu (raw_events, AD-38): dwa joby
    const zadania = await worker(tenantId);
    expect(zadania).toHaveLength(2);
    // ponowienie joba (at-least-once): ten sam raw_event drugi raz przez handler
    await HANDLERY_ZDARZEN[RODZAJ_JOBA](zadania[0]);

    const { rows: zd } = await getPool().query(
      `select e.profile_id, e.properties from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
        where e.tenant_id = $1 and m.name = 'Lead z formularza' and e.profile_id = $2`,
      [tenantId, profil.anna],
    );
    expect(zd).toHaveLength(1);

    await tik();
    await tik(); // ten sam event w zakładce skanu drugiego tiku
    const ma = await wiadomosci("anna");
    expect(ma).toHaveLength(1);
    expect(ma[0].subject).toBe("Cześć Anna, mamy plan");
    expect(ma[0].body_html).toContain("Twój cel: energia (strona /kontakt)");
    expect(ma[0].journey_run_id).not.toBeNull();
    expect(await wiadomosci("bartek")).toHaveLength(0);
    expect(d.wyslane.filter((x) => x === `e2e-anna-${znak}@example.test`)).toHaveLength(1);
    const { rows: u } = await getPool().query("select profile_id from flow_participants where tenant_id = $1 and flow_id = $2", [tenantId, flowLead.id]);
    expect(u.map((r) => r.profile_id)).toEqual([profil.anna]);
  });

  it("4. retry n8n PO wysłaniu maila (np. po 10 min) i ten sam lead w obcym tenancie: bez drugiego wejścia i maila", async () => {
    const annaLead = cialoLeada({ email: `e2e-anna-${znak}@example.test`, imie: "Anna", cel: "energia", uniqueId: "lead-anna-1" });
    expect(await wyslijZN8n(annaLead, klucz)).toBe(202);
    expect(await wyslijZN8n(annaLead, kluczObcy)).toBe(202);
    await worker(tenantId);
    await worker(obcyTenantId);
    await tik();
    expect(await wiadomosci("anna")).toHaveLength(1);
    const { rows } = await getPool().query(
      `select count(*)::int as n from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
        where e.tenant_id = $1 and m.name = 'Lead z formularza' and e.profile_id = $2`,
      [tenantId, profil.anna],
    );
    expect(rows[0].n).toBe(1);
    // obcy tenant ma własną kopię osoby i zdarzenia, a do flow tenanta nie trafia nic
    const { rows: obce } = await getPool().query("select count(*)::int as n from flow_participants where flow_id = $1 and tenant_id <> $2", [flowLead.id, tenantId]);
    expect(obce[0].n).toBe(0);
    expect(d.wyslane.filter((x) => x === `e2e-anna-${znak}@example.test`)).toHaveLength(1);
  });

  it("5. zdarzenie widać na osi profilu, właściwości tylko dla właściciela", async () => {
    const os = await osProfilu(tenantId, profil.anna);
    const wpis = os.wpisy.find((w) => w.nazwa === "Lead z formularza");
    expect(wpis).toBeDefined();
    expect(wpis!.integracja).toBe("api");
    const occurred = (await getPool().query("select occurred_at::text as t from metric_events where tenant_id = $1 and id = $2", [tenantId, wpis!.id])).rows[0].t;
    expect(await wlasciwosciZdarzenia(tenantId, profil.anna, wpis!.id, occurred)).toEqual({ cel: "energia", zrodlo: "formularz-kontakt", $extra: { strona: "/kontakt" } });
    expect(await wlasciwosciZdarzenia(tenantId, profil.bartek, wpis!.id, occurred)).toBeNull();
    expect(await wlasciwosciZdarzenia(obcyTenantId, profil.anna, wpis!.id, occurred)).toBeNull();
    // atrybut z API scalony do profilu (person.first_name w mailu pochodził właśnie stąd)
    const { rows } = await getPool().query("select first_name from profiles where tenant_id = $1 and id = $2", [tenantId, profil.anna]);
    expect(rows[0].first_name).toBe("Anna");
  });

  it("6. powitanie po popupie na metryce „Submitted Form” (metryka zakładana przy publikacji)", async () => {
    const przed = await getPool().query("select count(*)::int as n from metrics where tenant_id = $1 and name = 'Submitted Form'", [tenantId]);
    expect(przed.rows[0].n).toBe(0);
    const flow = await flowZMailem({
      name: PREFIKS + "Powitanie po popupie",
      metryka: "midrev|Submitted Form",
      temat: "Witaj {{ person.first_name|default:'nowa osobo' }}",
      html: "<p>Dziękujemy za zapis przez „{{ event.form_name }}”.</p>",
    });
    const { rows: fm } = await getPool().query(
      "select m.name, m.builtin from flows f join metrics m on m.tenant_id = f.tenant_id and m.id = f.trigger_metric_id where f.tenant_id = $1 and f.id = $2",
      [tenantId, flow.id],
    );
    expect(fm[0]).toMatchObject({ name: "Submitted Form", builtin: true });

    const popup = await utworzPopup(tenantId, { name: "Newsletter -10%", headline: "-10%", bodyText: "Zapisz się", buttonText: "Zapisz", discountCode: null, delaySeconds: 0 });
    await ustawAktywnosc(tenantId, popup, true);
    const w = await przyjmijZgloszenie(popup, { zgoda: true, wersjaKlauzuli: 1, email: `e2e-cela-${znak}@example.test`, imie: "Cela" });
    expect(w).not.toBeNull();
    profil.cela = (await getPool().query("select id from profiles where tenant_id = $1 and email = $2", [tenantId, `e2e-cela-${znak}@example.test`])).rows[0].id;
    await tik();
    await tik();
    const m = await wiadomosci("cela");
    expect(m).toHaveLength(1);
    expect(m[0].source_id).toBe(flow.emailId);
    expect(m[0].subject).toBe("Witaj Cela");
    expect(m[0].body_html).toContain("Dziękujemy za zapis przez „Newsletter -10%”.");
    // popup zapisał zdarzenie raz w strumieniu i raz w lustrze (to samo id) - wejście jedno
    const { rows: ev } = await getPool().query(
      `select (select count(*)::int from metric_events where tenant_id = $1 and profile_id = $2) as strumien,
              (select count(*)::int from events where tenant_id = $1 and profile_id = $2) as lustro,
              (select count(*)::int from flow_participants where tenant_id = $1 and profile_id = $2) as wejscia`,
      [tenantId, profil.cela],
    );
    expect(ev[0]).toEqual({ strumien: 1, lustro: 1, wejscia: 1 });
    // Anna (lead) nie dostaje powitania popupowego: inna metryka
    expect(await wiadomosci("anna")).toHaveLength(1);
  });
});
