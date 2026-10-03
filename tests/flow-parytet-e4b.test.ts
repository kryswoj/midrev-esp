process.env.MIDREV_GRAF_V2 = "1";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { nowyBlok, pustyDokument } from "../src/domain/email/bloki";
import {
  grafDoZapisu,
  schematGrafu,
  schematGrafuV2,
  wstawWezel,
  type Graf,
  type Wezel,
} from "../src/domain/automatyzacje/graf";
import type { Filtr } from "../src/domain/filtry";
import type { DostawcaWysylki } from "../src/domain/email/port";
import {
  opublikuj,
  pobierzAutomatyzacje,
  utworzAutomatyzacje,
  utworzWiadomosc,
  zapiszSzkic,
  zapiszWiadomosc,
  zmienStatus,
} from "../src/usecases/automatyzacje/journeye";
import { przesunUczestnikow, uruchomAutomatyzacje, wprowadzUczestnikow } from "../src/usecases/automatyzacje/przetworz-zdarzenia";
import { sciezkaOsobyWeFlow } from "../src/usecases/automatyzacje/sciezka-osoby";
import { podgladWyzwalacza } from "../src/usecases/automatyzacje/podglad-wyzwalacza";
import { wyslijPartie } from "../src/usecases/wysylka/wyslij-kampanie";
import { zapiszZdarzenie } from "../src/usecases/zdarzenia/zapisz-zdarzenie";

// Wykonywalna specyfikacja E4b na prawdziwej bazie (AD-20): filtr profilu przy wejsciu
// i przed kazda akcja (4.6), dodatkowe filtry maila, `metryka_profilu` z oknami (4.7),
// split po zdarzeniu i wlasciwosci profilu (4.8), smart sending i mail transakcyjny (4.9),
// podglad wyzwalacza (4.10) oraz scenariusz z planu integracji: porzucony checkout + zakup
// w trakcie = brak maila (takze gdy mail czekal w kolejce).

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

const CHECKOUT = { integracja: "api", nazwa: "Started Checkout" } as const;
const NIE_KUPIL_OD_STARTU: Filtr = { grupy: [{ warunki: [{ typ: "metryka_profilu", metryka: { nazwa: "Placed Order" }, operator: "rowna", wartosc: 0, okno: { od: "startu_flow" } }] }] };

describe("Automatyzacje E4b: parytet (filtry profilu, historia, split, smart sending, transakcyjny)", () => {
  let tenantId: string;
  const profile: Record<string, string> = {};
  const email = (k: string) => `e4b-${k}@example.test`;

  async function dodajProfil(klucz: string, opcje: { zgoda?: boolean; properties?: Record<string, unknown> } = {}) {
    const pool = getPool();
    const p = await pool.query("insert into profiles (tenant_id, email, properties) values ($1, $2, $3) returning id", [tenantId, email(klucz), JSON.stringify(opcje.properties ?? {})]);
    profile[klucz] = p.rows[0].id;
    if (opcje.zgoda !== false) {
      await pool.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
         values ($1, $2, 'email', 'granted', 'test', now() - interval '10 days')`,
        [tenantId, profile[klucz]],
      );
    }
  }

  async function zdarzenie(klucz: string, metryka: { integracja: string; nazwa: string }, opcje: { temu?: string; properties?: Record<string, unknown>; backfill?: boolean } = {}) {
    const pool = getPool();
    const { rows: t } = await pool.query("select date_trunc('second', now() - $1::interval) as kiedy", [opcje.temu ?? "5 seconds"]);
    const klient = await pool.connect();
    try {
      await klient.query("begin");
      const w = await zapiszZdarzenie(klient, {
        tenantId, metryka: metryka as never, profileId: profile[klucz], occurredAt: t[0].kiedy,
        uniqueId: randomUUID(), properties: opcje.properties ?? {}, source: "api", backfill: opcje.backfill,
      });
      await klient.query("commit");
      return w.id;
    } catch (b) {
      await klient.query("rollback");
      throw b;
    } finally {
      klient.release();
    }
  }

  async function wiadomosc(flowId: string, nazwa: string) {
    const w = await utworzWiadomosc(tenantId, flowId, nazwa);
    if (!w.ok) throw new Error(w.blad);
    const z = await zapiszWiadomosc(tenantId, flowId, w.id, { temat: nazwa, dokumentJson: dokument(`<p>${nazwa}</p>`) });
    if (!z.ok) throw new Error(z.blad);
    return w.id;
  }

  /** flow na metryce z dowolnymi krokami: `zbuduj(maile)` dostaje id wiadomosci */
  async function flow(name: string, metryka: { integracja: string; nazwa: string }, ileMaili: number, zbuduj: (m: string[], g: Graf) => Graf) {
    const f = await utworzAutomatyzacje(tenantId, { name, metryka: `${metryka.integracja}|${metryka.nazwa}` });
    if (!f.ok) throw new Error(f.blad);
    const maile: string[] = [];
    for (let i = 0; i < ileMaili; i++) maile.push(await wiadomosc(f.id, `${name} mail ${i + 1}`));
    const widok = (await pobierzAutomatyzacje(tenantId, f.id))!;
    const g = zbuduj(maile, widok.graf);
    const z = await zapiszSzkic(tenantId, f.id, { graf: g, oczekiwanaWersja: widok.draftVersion });
    if (!z.ok) throw new Error(z.blad);
    if (z.bramka.length) throw new Error(JSON.stringify(z.bramka));
    return { id: f.id, maile, graf: g };
  }

  async function wlacz(flowId: string) {
    // czysta karta zdarzen: zdarzenia poprzednich testow z ostatniej godziny wpadlyby w okno skanu
    await getPool().query("delete from event_keys where tenant_id = $1", [tenantId]);
    await getPool().query("delete from metric_events where tenant_id = $1", [tenantId]);
    const w = await zmienStatus(tenantId, flowId, "wlaczony");
    if (!w.ok) throw new Error(`${w.blad} ${JSON.stringify((w as { bledy?: unknown }).bledy ?? [])}`);
    await getPool().query("update flows set active_since = now() - interval '1 hour' where tenant_id = $1 and id = $2", [tenantId, flowId]);
    await getPool().query("update flow_trigger_state set scanned_to = now() - interval '1 hour' where tenant_id = $1 and flow_id = $2", [tenantId, flowId]);
  }
  async function wylaczWszystkie() {
    await getPool().query("update flows set status = 'szkic' where tenant_id = $1 and status <> 'szkic'", [tenantId]);
  }
  async function uczestnik(flowId: string, klucz: string) {
    const { rows } = await getPool().query("select * from flow_participants where tenant_id = $1 and flow_id = $2 and profile_id = $3", [tenantId, flowId, profile[klucz]]);
    return rows[0] ?? null;
  }
  async function przejscia(flowId: string, klucz: string) {
    const { rows } = await getPool().query("select kind, detail from flow_transitions where tenant_id = $1 and flow_id = $2 and profile_id = $3 order by occurred_at, id", [tenantId, flowId, profile[klucz]]);
    return rows as { kind: string; detail: Record<string, unknown> }[];
  }
  async function wiadomosciFlow(flowId: string, klucz: string) {
    const { rows } = await getPool().query(
      `select m.id, m.current_state, m.transactional, m.source_id from messages m join journeys j on j.tenant_id = m.tenant_id and j.id = m.source_id
        where m.tenant_id = $1 and j.flow_id = $2 and m.profile_id = $3 order by m.created_at`,
      [tenantId, flowId, profile[klucz]],
    );
    return rows;
  }
  /** "czas mija": opoznienia uczestnikow flow dobiegaja konca teraz */
  async function minalCzas(flowId: string) {
    await getPool().query("update flow_participants set resume_at = now() - interval '1 second' where tenant_id = $1 and flow_id = $2 and resume_at is not null", [tenantId, flowId]);
  }

  const mail = (id: string, emailId: string, next: string | null, extra: Partial<Extract<Wezel, { typ: "email" }>> = {}): Wezel => ({ id, typ: "email", emailId, links: { next }, ...extra });
  const opoznienie = (id: string, next: string, ilosc = 1): Wezel => ({ id, typ: "opoznienie", ilosc, jednostka: "godziny", links: { next } });
  const koniec = (id: string): Wezel => ({ id, typ: "koniec" });
  const zWezlami = (g: Graf, pierwszy: string, wezly: Wezel[], ustawienia: Partial<Graf["ustawienia"]> = {}): Graf => ({
    ...g,
    ustawienia: { ...g.ustawienia, ...ustawienia },
    wezly: [...g.wezly.filter((w) => w.typ === "wyzwalacz").map((w) => ({ ...w, links: { next: pierwszy } }) as Wezel), ...wezly],
  });

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'E4B %'");
    tenantId = (await pool.query("insert into tenants (name) values ('E4B tenant') returning id")).rows[0].id;
    await pool.query("insert into tenant_send_limits (tenant_id, daily_limit) values ($1, 1000) on conflict (tenant_id) do update set daily_limit = 1000", [tenantId]);
    for (const k of ["ania", "bartek", "celina", "darek", "ewa", "filip", "gosia", "henryk", "iza", "jan", "kasia", "leon", "marta", "nikola"]) await dodajProfil(k);
    await dodajProfil("bezzgody", { zgoda: false });
    await dodajProfil("wypisany", { zgoda: false });
    await pool.query("insert into tenant_suppressions (tenant_id, email, action, reason, actor) values ($1, $2, 'suppressed', 'test wypisu', 'odbiorca')", [tenantId, email("wypisany")]);
    // metryki istnieja w koncie (katalog), zanim powstana flow
    await zdarzenie("ania", CHECKOUT, { temu: "30 days", backfill: true });
    await zdarzenie("ania", { integracja: "api", nazwa: "Quiz Ukończony" }, { temu: "30 days", backfill: true });
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like 'E4B %'");
    await closePool();
  });

  describe("zapis i wsteczna zgodność (graf v3)", () => {
    it("funkcje E4b zapisują się jako v3, której schemat v2 (stary kod po rollbacku) NIE przyjmuje; bez nich v2/v1 jak dotąd", async () => {
      const f = await flow("E4B zapis", CHECKOUT, 1, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "k"), koniec("k")], { filtrProfilu: NIE_KUPIL_OD_STARTU }));
      const { rows } = await getPool().query("select draft from flows where tenant_id = $1 and id = $2", [tenantId, f.id]);
      expect(rows[0].draft.wersja).toBe(3);
      expect(schematGrafuV2.safeParse(rows[0].draft).success).toBe(false);
      expect(schematGrafu.parse(rows[0].draft).ustawienia.filtrProfilu).toEqual(NIE_KUPIL_OD_STARTU);
      // smart sending wylaczony = brak funkcji E4b: zapis v2 (filtr wyzwalacza nie, metryka API tak)
      const bez = { ...f.graf, ustawienia: { ...f.graf.ustawienia, filtrProfilu: undefined }, wezly: f.graf.wezly.map((w) => (w.typ === "email" ? { ...w, smartSending: false } : w)) };
      expect(grafDoZapisu(bez as Graf).wersja).toBe(2);
      expect(JSON.stringify(grafDoZapisu(bez as Graf))).not.toContain("smartSending");
    });

    it("bez MIDREV_GRAF_V2 funkcji E4b nie da się włączyć (bramka nazywa funkcję)", async () => {
      const { zwalidujGraf } = await import("../src/domain/automatyzacje/graf");
      const f = await flow("E4B flaga", CHECKOUT, 1, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "k", { smartSending: true }), koniec("k")]));
      const bledy = zwalidujGraf(f.graf, { grafV2Dostepny: false }).bledy.map((b) => b.tresc).join(" ");
      expect(bledy).toContain("smart sending");
    });
  });

  describe("porzucony checkout: zakup w trakcie = brak maila (plan integracji)", () => {
    it("zakup między wejściem a mailem: osoba wychodzi przed mailem z powodem „filtr profilu”; bez zakupu mail wychodzi", async () => {
      await wylaczWszystkie();
      const f = await flow("E4B porzucony checkout", CHECKOUT, 1, (m, g) =>
        zWezlami(g, "o1", [opoznienie("o1", "m1"), mail("m1", m[0], "k"), koniec("k")], { filtrProfilu: NIE_KUPIL_OD_STARTU }));
      await wlacz(f.id);
      await zdarzenie("bartek", CHECKOUT, { temu: "2 minutes", properties: { CheckoutURL: "https://sklep.test/c/1" } });
      await zdarzenie("celina", CHECKOUT, { temu: "2 minutes" });
      // zakup sprzed checkoutu NIE wyrzuca (liczy sie od startu flow)
      await zdarzenie("celina", { integracja: "woocommerce", nazwa: "Placed Order" }, { temu: "3 days" });
      const d = new DostawcaAtrapa();
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      expect((await uczestnik(f.id, "bartek")).status).toBe("w_toku");
      // bartek kupuje w trakcie oczekiwania (inna integracja niz Woo: Shopify)
      await zdarzenie("bartek", { integracja: "shopify", nazwa: "Placed Order" }, { temu: "10 seconds" });
      await minalCzas(f.id);
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      expect(d.wyslane).toEqual([email("celina")]);
      const u = await uczestnik(f.id, "bartek");
      expect(u.status).toBe("wyszedl");
      expect(u.exit_reason).toBe("filtr_profilu");
      expect(await wiadomosciFlow(f.id, "bartek")).toHaveLength(0);
      const sciezka = (await sciezkaOsobyWeFlow(tenantId, profile.bartek)).find((s) => s.flowId === f.id)!;
      expect(sciezka.powodWyjscia).toContain("filtra profilu");
      expect(sciezka.kroki.at(-1)?.opis).toContain("filtra profilu");
    });

    it("mail czekał w kolejce (limit dobowy), w tym czasie zakup: bramka przed wysyłką go wstrzymuje i zapisuje powód", async () => {
      await wylaczWszystkie();
      const f = await flow("E4B checkout kolejka", CHECKOUT, 2, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "o1"), opoznienie("o1", "m2", 24), mail("m2", m[1], "k"), koniec("k")], { filtrProfilu: NIE_KUPIL_OD_STARTU }));
      await wlacz(f.id);
      await zdarzenie("darek", CHECKOUT, { temu: "1 minute" });
      // wysylka wstrzymana (jak przy wyczerpanym limicie): mail czeka w kolejce
      await getPool().query("update tenants set sending_paused_at = now(), sending_pause_reason = 'test' where id = $1", [tenantId]);
      const d = new DostawcaAtrapa();
      try {
        await uruchomAutomatyzacje(tenantId, { dostawca: d });
        expect((await wiadomosciFlow(f.id, "darek"))[0].current_state).toBe("queued");
        await zdarzenie("darek", { integracja: "woocommerce", nazwa: "Placed Order" }, { temu: "5 seconds" });
      } finally {
        await getPool().query("update tenants set sending_paused_at = null, sending_pause_reason = null where id = $1", [tenantId]);
      }
      await wyslijPartie(tenantId, { dostawca: d });
      expect(d.wyslane).toEqual([]);
      const m = await wiadomosciFlow(f.id, "darek");
      expect(m[0].current_state).toBe("suppressed");
      const { rows: ev } = await getPool().query("select payload from message_events where tenant_id = $1 and message_id = $2 and event_type = 'suppressed'", [tenantId, m[0].id]);
      expect(ev[0].payload.powod).toBe("filtr_profilu");
      const t = await przejscia(f.id, "darek");
      expect(t.some((x) => x.kind === "pominieto" && x.detail.przyWysylce === true && x.detail.powod === "filtr_profilu")).toBe(true);
      const { rows: skip } = await getPool().query(
        `select e.properties from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
          where e.tenant_id = $1 and e.profile_id = $2 and m.name = 'Skipped Send'`,
        [tenantId, profile.darek],
      );
      expect(skip[0].properties["Skip Reason"]).toBe("FILTR_PROFILU");
      // i osoba WYCHODZI z automatyzacji (nie czeka 24 h na drugi mail)
      const u = await uczestnik(f.id, "darek");
      expect(u.status).toBe("wyszedl");
      expect(u.exit_reason).toBe("filtr_profilu");
    });

    it("smart sending też tuż przed wysyłką: mail czekał w kolejce, w tym czasie wyszła kampania = mail flow pominięty", async () => {
      await wylaczWszystkie();
      const f = await flow("E4B smart przy wysylce", CHECKOUT, 1, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "k", { smartSending: true }), koniec("k")]));
      await wlacz(f.id);
      await zdarzenie("henryk", CHECKOUT, { temu: "1 minute" });
      await getPool().query("update tenants set sending_paused_at = now(), sending_pause_reason = 'test' where id = $1", [tenantId]);
      const d = new DostawcaAtrapa();
      try {
        await uruchomAutomatyzacje(tenantId, { dostawca: d });
        expect((await wiadomosciFlow(f.id, "henryk"))[0].current_state).toBe("queued");
        // kampania wyslana w tym czasie (np. przez inny proces): stan sent + zdarzenie sent
        const { rows } = await getPool().query(
          `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token, current_state, current_rank, created_at)
           values ($1, $2, 'campaign', $3, $4, 'kampania', '<p>x</p>', md5(random()::text), md5(random()::text), 'sent', 3, now() - interval '30 hours') returning id`,
          [tenantId, profile.henryk, randomUUID(), email("henryk")],
        );
        await getPool().query("insert into message_events (tenant_id, message_id, event_type, payload, occurred_at) values ($1, $2, 'sent', '{}', now() - interval '5 minutes')", [tenantId, rows[0].id]);
      } finally {
        await getPool().query("update tenants set sending_paused_at = null, sending_pause_reason = null where id = $1", [tenantId]);
      }
      await wyslijPartie(tenantId, { dostawca: d });
      expect(d.wyslane).toEqual([]);
      const m = await wiadomosciFlow(f.id, "henryk");
      expect(m[0].current_state).toBe("suppressed");
      const t = await przejscia(f.id, "henryk");
      expect(t.some((x) => x.kind === "pominieto" && x.detail.powod === "smart_sending" && x.detail.przyWysylce === true)).toBe(true);
    });
  });

  describe("filtr profilu przy wejściu (4.6)", () => {
    it("kto nie spełnia przy wejściu, nie wchodzi (powód zapisany, klucz „raz” wolny); gdy zacznie spełniać, wchodzi przy kolejnym zdarzeniu", async () => {
      await wylaczWszystkie();
      const tylkoVip: Filtr = { grupy: [{ warunki: [{ typ: "wlasciwosc_profilu", pole: { rodzaj: "wlasna", nazwa: "vip" }, typPola: "boolean", operator: "prawda" }] }] };
      const f = await flow("E4B wejscie vip", CHECKOUT, 1, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "k"), koniec("k")], { filtrProfilu: tylkoVip }));
      await wlacz(f.id);
      await zdarzenie("ewa", CHECKOUT, { temu: "1 minute" });
      await wprowadzUczestnikow(tenantId);
      await wprowadzUczestnikow(tenantId); // zakladka czyta to samo zdarzenie: jeden wpis, jedna decyzja
      expect(await uczestnik(f.id, "ewa")).toBeNull();
      const { rows: skip } = await getPool().query("select reason, detail from flow_entry_skips where tenant_id = $1 and flow_id = $2 and profile_id = $3", [tenantId, f.id, profile.ewa]);
      expect(skip).toHaveLength(1);
      expect(skip[0].reason).toBe("filtr_profilu");
      await getPool().query("update profiles set properties = properties || '{\"vip\": true}' where tenant_id = $1 and id = $2", [tenantId, profile.ewa]);
      await wprowadzUczestnikow(tenantId); // stare zdarzenie juz rozstrzygniete: nie wchodzi
      expect(await uczestnik(f.id, "ewa")).toBeNull();
      await zdarzenie("ewa", CHECKOUT, { temu: "5 seconds" });
      await wprowadzUczestnikow(tenantId);
      expect((await uczestnik(f.id, "ewa"))?.entry_key).toBe("raz");
      const s = (await sciezkaOsobyWeFlow(tenantId, profile.ewa)).find((x) => x.flowId === f.id)!;
      expect(s).toBeTruthy();
    });

    it("filtr przed akcją: właściwość zmieniona w trakcie opóźnienia = wypadnięcie przed drugą akcją (zmiana profilu też jest akcją)", async () => {
      await wylaczWszystkie();
      const bezRezygnacji: Filtr = { grupy: [{ warunki: [{ typ: "wlasciwosc_profilu", pole: { rodzaj: "wlasna", nazwa: "rezygnacja" }, typPola: "boolean", operator: "nieustawione" }] }] };
      const f = await flow("E4B przed akcja", CHECKOUT, 2, (m, g) => zWezlami(g, "m1", [
        mail("m1", m[0], "o1"), opoznienie("o1", "p1"),
        { id: "p1", typ: "profil", akcja: { rodzaj: "ustaw_wlasciwosc", klucz: "etap", wartosc: 2 }, links: { next: "m2" } },
        mail("m2", m[1], "k"), koniec("k"),
      ], { filtrProfilu: bezRezygnacji }));
      await wlacz(f.id);
      await zdarzenie("filip", CHECKOUT, { temu: "1 minute" });
      const d = new DostawcaAtrapa();
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      expect(d.wyslane).toEqual([email("filip")]);
      await getPool().query("update profiles set properties = properties || '{\"rezygnacja\": true}' where tenant_id = $1 and id = $2", [tenantId, profile.filip]);
      await minalCzas(f.id);
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      expect(d.wyslane).toHaveLength(1);
      const u = await uczestnik(f.id, "filip");
      expect(u.exit_reason).toBe("filtr_profilu");
      expect(u.node_id).toBe("p1");
      const { rows } = await getPool().query("select properties from profiles where id = $1", [profile.filip]);
      expect(rows[0].properties.etap).toBeUndefined();
    });
  });

  describe("dodatkowe filtry maila i warunek po historii (4.6, 4.7)", () => {
    it("dodatkowy filtr: kto nie spełnia, pomija TEN mail (Skipped Send z powodem) i idzie dalej", async () => {
      await wylaczWszystkie();
      const tylkoPremium: Filtr = { grupy: [{ warunki: [{ typ: "wlasciwosc_profilu", pole: { rodzaj: "wlasna", nazwa: "plan" }, typPola: "string", operator: "rowna", wartosc: "premium" }] }] };
      const f = await flow("E4B dodatkowe", CHECKOUT, 2, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "m2", { dodatkoweFiltry: tylkoPremium }), mail("m2", m[1], "k"), koniec("k")]));
      await wlacz(f.id);
      await zdarzenie("gosia", CHECKOUT, { temu: "1 minute" });
      await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
      const m = await wiadomosciFlow(f.id, "gosia");
      expect(m.map((x) => x.source_id)).toEqual([f.maile[1]]);
      const t = await przejscia(f.id, "gosia");
      expect(t.find((x) => x.kind === "pominieto")?.detail.powod).toBe("dodatkowy_filtr");
      expect((await uczestnik(f.id, "gosia")).status).toBe("zakonczony");
    });

    it("„Quiz Ukończony = 0 od startu flow” w warunku: quiz sprzed wejścia się nie liczy, po wejściu tak; okno N dni liczy wstecz od teraz", async () => {
      await wylaczWszystkie();
      const QUIZ = { integracja: "api", nazwa: "Quiz Ukończony" };
      const f = await flow("E4B quiz", CHECKOUT, 2, (m, g) => zWezlami(g, "o1", [
        opoznienie("o1", "w1"),
        { id: "w1", typ: "warunek", regula: { rodzaj: "filtr", filtr: { grupy: [{ warunki: [{ typ: "metryka_profilu", metryka: QUIZ, operator: "rowna", wartosc: 0, okno: { od: "startu_flow" } }] }] } }, links: { next_if_true: "w2", next_if_false: "k1" } },
        { id: "w2", typ: "warunek", regula: { rodzaj: "filtr", filtr: { grupy: [{ warunki: [{ typ: "metryka_profilu", metryka: QUIZ, operator: "wieksza_rowna", wartosc: 1, okno: { od: "ostatnich_dni", dni: 7 } }] }] } }, links: { next_if_true: "m1", next_if_false: "m2" } },
        mail("m1", m[0], "k2"), mail("m2", m[1], "k3"), koniec("k1"), koniec("k2"), koniec("k3"),
      ]));
      await wlacz(f.id);
      await zdarzenie("henryk", { integracja: "api", nazwa: "Quiz Ukończony" }, { temu: "3 days" }); // przed wejsciem, w 7 dniach
      await zdarzenie("henryk", CHECKOUT, { temu: "2 minutes" });
      await zdarzenie("iza", CHECKOUT, { temu: "2 minutes" });
      await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
      await zdarzenie("iza", { integracja: "api", nazwa: "Quiz Ukończony" }, { temu: "30 seconds" }); // po wejsciu
      await minalCzas(f.id);
      await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
      expect((await wiadomosciFlow(f.id, "henryk")).map((x) => x.source_id)).toEqual([f.maile[0]]);
      expect(await wiadomosciFlow(f.id, "iza")).toHaveLength(0);
      expect((await uczestnik(f.id, "iza")).node_id).toBe("k1");
    });
  });

  describe("split po zdarzeniu i właściwości profilu (4.8)", () => {
    it("łańcuch splitów po product_slug (jak „Post Purchase Flow Pakiety”) + ustaw i usuń właściwość", async () => {
      await wylaczWszystkie();
      const slug = (wartosc: string): Filtr => ({ grupy: [{ warunki: [{ typ: "wlasciwosc_zdarzenia", pole: "product_slug", typPola: "string", operator: "rowna", wartosc }] }] });
      const f = await flow("E4B split", CHECKOUT, 3, (m, g) => zWezlami(g, "s1", [
        { id: "s1", typ: "podzial_zdarzenia", filtr: slug("longevity"), links: { next_if_true: "p1", next_if_false: "s2" } },
        { id: "p1", typ: "profil", akcja: { rodzaj: "ustaw_wlasciwosc", klucz: "pakiet", wartosc: "longevity" }, links: { next: "m1" } },
        mail("m1", m[0], "k1"),
        { id: "s2", typ: "podzial_zdarzenia", filtr: slug("waga"), links: { next_if_true: "m2", next_if_false: "p2" } },
        mail("m2", m[1], "k2"),
        { id: "p2", typ: "profil", akcja: { rodzaj: "usun_wlasciwosc", klucz: "pakiet" }, links: { next: "m3" } },
        mail("m3", m[2], "k3"),
        koniec("k1"), koniec("k2"), koniec("k3"),
      ]));
      await wlacz(f.id);
      await getPool().query("update profiles set properties = '{\"pakiet\": \"stary\"}' where id = $1", [profile.kasia]);
      await zdarzenie("jan", CHECKOUT, { temu: "1 minute", properties: { product_slug: "longevity" } });
      await zdarzenie("kasia", CHECKOUT, { temu: "1 minute", properties: { product_slug: "inne" } });
      await zdarzenie("leon", CHECKOUT, { temu: "1 minute", properties: { product_slug: "waga" } });
      await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
      expect((await wiadomosciFlow(f.id, "jan")).map((x) => x.source_id)).toEqual([f.maile[0]]);
      expect((await wiadomosciFlow(f.id, "leon")).map((x) => x.source_id)).toEqual([f.maile[1]]);
      expect((await wiadomosciFlow(f.id, "kasia")).map((x) => x.source_id)).toEqual([f.maile[2]]);
      const { rows } = await getPool().query("select id, properties from profiles where id = any($1::uuid[])", [[profile.jan, profile.kasia]]);
      expect(rows.find((r) => r.id === profile.jan).properties.pakiet).toBe("longevity");
      expect(rows.find((r) => r.id === profile.kasia).properties.pakiet).toBeUndefined();
      const t = await przejscia(f.id, "kasia");
      expect(t.filter((x) => x.kind === "warunek" && x.detail.podzialZdarzenia).map((x) => x.detail.wynik)).toEqual([false, false]);
    });

    it("walidacja: split po zdarzeniu przy wyzwalaczu listowym i pusty split blokują włączenie", async () => {
      const { zwalidujGraf, pustyGraf } = await import("../src/domain/automatyzacje/graf");
      const L = randomUUID();
      const g = wstawWezel(pustyGraf("list.joined", L), { po: "wyzwalacz", port: "next" }, { id: "s", typ: "podzial_zdarzenia", filtr: { grupy: [] }, links: { next_if_true: null, next_if_false: null } });
      const bledy = zwalidujGraf(g, { listy: new Set([L]), grafV2Dostepny: true }).bledy.map((b) => b.tresc);
      expect(bledy.some((b) => b.includes("tylko z wyzwalaczem metrycznym"))).toBe(true);
      expect(bledy.some((b) => b.includes("nie ma jeszcze żadnej reguły"))).toBe(true);
    });
  });

  describe("smart sending i mail transakcyjny (4.9)", () => {
    it("wyścig dwóch flow na tym samym zdarzeniu, oba ze smart sending: dokładnie 1 mail, drugi = Skipped Send SMART_SENDING", async () => {
      await wylaczWszystkie();
      const a = await flow("E4B smart A", CHECKOUT, 1, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "k", { smartSending: true }), koniec("k")]));
      const b = await flow("E4B smart B", CHECKOUT, 1, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "k", { smartSending: true }), koniec("k")]));
      await wlacz(a.id);
      await wlacz(b.id);
      await zdarzenie("marta", CHECKOUT, { temu: "1 minute" });
      await wprowadzUczestnikow(tenantId);
      // dwa workery naraz: kazdy zajmuje innego uczestnika (skip locked), blokada osoby je szereguje
      await Promise.all([przesunUczestnikow(tenantId), przesunUczestnikow(tenantId), przesunUczestnikow(tenantId)]);
      const wszystkie = [...(await wiadomosciFlow(a.id, "marta")), ...(await wiadomosciFlow(b.id, "marta"))];
      expect(wszystkie).toHaveLength(1);
      const t = [...(await przejscia(a.id, "marta")), ...(await przejscia(b.id, "marta"))];
      expect(t.filter((x) => x.kind === "pominieto" && x.detail.powod === "smart_sending")).toHaveLength(1);
      expect((await uczestnik(a.id, "marta")).status).toBe("zakonczony");
      expect((await uczestnik(b.id, "marta")).status).toBe("zakonczony");
    });

    it("okno 16 h: mail sprzed 17 h nie blokuje, sprzed 15 h blokuje; okno konfigurowalne per mail", async () => {
      await wylaczWszystkie();
      const f = await flow("E4B okno", CHECKOUT, 1, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "k", { smartSending: true }), koniec("k")]));
      const krotkie = await flow("E4B okno 2h", CHECKOUT, 1, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "k", { smartSending: true, smartSendingGodzin: 2 }), koniec("k")]));
      const stary = async (klucz: string, godzin: number) => {
        await getPool().query(
          `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token, current_state, created_at)
           values ($1, $2, 'campaign', $3, $4, 'stary', '<p>x</p>', md5(random()::text), md5(random()::text), 'sent', now() - make_interval(hours => $5::int))`,
          [tenantId, profile[klucz], randomUUID(), email(klucz), godzin],
        );
      };
      await stary("nikola", 17);
      await stary("ania", 15);
      await wlacz(f.id);
      await zdarzenie("nikola", CHECKOUT, { temu: "1 minute" });
      await zdarzenie("ania", CHECKOUT, { temu: "1 minute" });
      await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
      expect(await wiadomosciFlow(f.id, "nikola")).toHaveLength(1);
      expect(await wiadomosciFlow(f.id, "ania")).toHaveLength(0);
      await wylaczWszystkie();
      await wlacz(krotkie.id);
      await getPool().query("delete from messages where tenant_id = $1 and profile_id = $2 and source_type = 'journey'", [tenantId, profile.nikola]).catch(() => {});
      await zdarzenie("ania", CHECKOUT, { temu: "30 seconds" });
      await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
      expect(await wiadomosciFlow(krotkie.id, "ania")).toHaveLength(1); // 15 h > okno 2 h
    });

    it("transakcyjny: wychodzi bez zgody marketingowej i bez smart sending, ale NIE do wypisanego (supresja wygrywa)", async () => {
      await wylaczWszystkie();
      const f = await flow("E4B transakcyjny", CHECKOUT, 1, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "k", { transakcyjny: true, smartSending: true }), koniec("k")]));
      await wlacz(f.id);
      await zdarzenie("bezzgody", CHECKOUT, { temu: "1 minute" });
      await zdarzenie("wypisany", CHECKOUT, { temu: "1 minute" });
      await zdarzenie("bartek", CHECKOUT, { temu: "1 minute" }); // mial niedawno maile: smart sending i tak nie dotyczy
      const d = new DostawcaAtrapa();
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      expect(d.wyslane.sort()).toEqual([email("bartek"), email("bezzgody")].sort());
      expect((await wiadomosciFlow(f.id, "bezzgody"))[0].transactional).toBe(true);
      const u = await uczestnik(f.id, "wypisany");
      expect(u.status).toBe("wyszedl");
      expect(u.exit_reason).toBe("wykluczenie_sklepu");
      // wypis PO zbudowaniu maila: wiazaca bramka w transakcji wysylki tez go zatrzymuje
      await wylaczWszystkie();
      const g2 = await flow("E4B transakcyjny 2", CHECKOUT, 1, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "k", { transakcyjny: true }), koniec("k")]));
      await wlacz(g2.id);
      await zdarzenie("bezzgody", CHECKOUT, { temu: "20 seconds" });
      await wprowadzUczestnikow(tenantId);
      await przesunUczestnikow(tenantId);
      await getPool().query("insert into tenant_suppressions (tenant_id, email, action, reason, actor) values ($1, $2, 'suppressed', 'test', 'odbiorca')", [tenantId, email("bezzgody")]);
      const d2 = new DostawcaAtrapa();
      await wyslijPartie(tenantId, { dostawca: d2 });
      expect(d2.wyslane).toEqual([]);
      expect((await wiadomosciFlow(g2.id, "bezzgody"))[0].current_state).toBe("suppressed");
    });
  });

  describe("podgląd wyzwalacza (4.10)", () => {
    it("ostatnie zdarzenia z werdyktem i powodem: wszedłby / filtr wyzwalacza / filtr profilu / backfill / już w automatyzacji", async () => {
      await wylaczWszystkie();
      const tylkoPl: Filtr = { grupy: [{ warunki: [{ typ: "wlasciwosc_zdarzenia", pole: "kraj", typPola: "string", operator: "rowna", wartosc: "PL" }] }] };
      const f = await flow("E4B podglad", CHECKOUT, 1, (m, g) => ({
        ...zWezlami(g, "m1", [mail("m1", m[0], "k"), koniec("k")], { filtrProfilu: NIE_KUPIL_OD_STARTU }),
        wezly: zWezlami(g, "m1", [mail("m1", m[0], "k"), koniec("k")]).wezly.map((w) => (w.typ === "wyzwalacz" && w.zrodlo.rodzaj === "metryka" ? { ...w, zrodlo: { ...w.zrodlo, filtr: tylkoPl } } : w)),
      }));
      await getPool().query("delete from metric_events where tenant_id = $1 and metric_id = (select id from metrics where tenant_id = $1 and name = 'Started Checkout')", [tenantId]);
      await zdarzenie("ania", CHECKOUT, { temu: "2 hours", properties: { kraj: "PL" } });
      await zdarzenie("bartek", CHECKOUT, { temu: "3 hours", properties: { kraj: "DE" } });
      await zdarzenie("celina", CHECKOUT, { temu: "90 minutes", properties: { kraj: "PL" } });
      await zdarzenie("celina", { integracja: "woocommerce", nazwa: "Placed Order" }, { temu: "60 minutes" });
      await zdarzenie("darek", CHECKOUT, { temu: "30 minutes", properties: { kraj: "PL" }, backfill: true });
      const p = await podgladWyzwalacza(tenantId, f.id, f.graf);
      if (!p.ok) throw new Error(p.blad);
      const werdykt = (k: string) => p.wiersze.find((w) => w.profileId === profile[k]);
      expect(werdykt("ania")).toMatchObject({ wszedlby: true });
      expect(werdykt("bartek")).toMatchObject({ wszedlby: false, powod: "filtr_wyzwalacza" });
      expect(werdykt("celina")).toMatchObject({ wszedlby: false, powod: "filtr_profilu" });
      expect(werdykt("darek")).toMatchObject({ wszedlby: false, powod: "backfill" });
      expect(p.weszloby).toBe(1);
      expect(JSON.stringify(p)).not.toContain(tenantId);
    });
  });

  it("publikacja: flow bez funkcji E4b ma wersję v2 (stary kod ją czyta), z filtrem profilu v3", async () => {
    await wylaczWszystkie();
    const f = await flow("E4B publikacja", CHECKOUT, 1, (m, g) => zWezlami(g, "m1", [mail("m1", m[0], "k"), koniec("k")]));
    await wlacz(f.id);
    const wersja = async () => (await getPool().query("select definition from flow_versions where tenant_id = $1 and flow_id = $2 order by version desc limit 1", [tenantId, f.id])).rows[0].definition.wersja;
    expect(await wersja()).toBe(2);
    const widok = (await pobierzAutomatyzacje(tenantId, f.id))!;
    const z = await zapiszSzkic(tenantId, f.id, { graf: { ...widok.graf, ustawienia: { ...widok.graf.ustawienia, filtrProfilu: NIE_KUPIL_OD_STARTU } }, oczekiwanaWersja: widok.draftVersion });
    expect(z.ok).toBe(true);
    expect(await opublikuj(tenantId, f.id)).toMatchObject({ ok: true });
    expect(await wersja()).toBe(3);
  });
});
