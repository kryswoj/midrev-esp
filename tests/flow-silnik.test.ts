import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { nowyBlok, pustyDokument } from "../src/domain/email/bloki";
import { wstawWezel, type Graf, type Wezel } from "../src/domain/automatyzacje/graf";
import {
  opublikuj,
  pobierzAutomatyzacje,
  statystykiAutomatyzacji,
  utworzZBiblioteki,
  zmienNazwe,
  utworzAutomatyzacje,
  utworzWiadomosc,
  zapiszSzkic,
  zapiszWiadomosc,
  zmienStatus,
} from "../src/usecases/automatyzacje/journeye";
import { alertSystemowy, jestBledemSystemowym, uruchomAutomatyzacje } from "../src/usecases/automatyzacje/przetworz-zdarzenia";
import { sciezkaOsobyWeFlow } from "../src/usecases/automatyzacje/sciezka-osoby";
import type { DostawcaWysylki } from "../src/domain/email/port";

// Wykonywalna specyfikacja SILNIKA flow: prawdziwa baza (AD-20), dostawca-atrapa (AD-7).
// Kazdy mail wychodzi tym samym silnikiem i przez te same bramki co kampanie.

class DostawcaAtrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: string[] = [];
  async wyslij(w: { do: string; idempotencyKey: string }) {
    this.wyslane.push(w.do);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

function dokument(html: string) {
  return JSON.stringify({ ...pustyDokument(), bloki: [{ ...nowyBlok("tekst"), html }, { ...nowyBlok("przycisk"), tekst: "Sklep", link: "https://sklep.example.test" }] });
}

describe("Silnik flow", () => {
  let tenantId: string;
  const profile: Record<string, string> = {};

  async function dodajProfil(klucz: string, email: string, zgoda = true) {
    const pool = getPool();
    const p = await pool.query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantId, email]);
    profile[klucz] = p.rows[0].id;
    if (zgoda) {
      await pool.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at)
         values ($1, $2, 'email', 'granted', 'test', now() - interval '10 days')`,
        [tenantId, profile[klucz]],
      );
    }
  }
  async function zdarzenie(klucz: string, typ: string, przesuniecie: string, payload: Record<string, unknown> = {}) {
    await getPool().query(
      `insert into events (tenant_id, profile_id, event_type, payload, occurred_at) values ($1, $2, $3, $4, now() - $5::interval)`,
      [tenantId, profile[klucz], typ, JSON.stringify(payload), przesuniecie],
    );
  }
  async function wiadomosc(flowId: string, nazwa: string, temat: string) {
    const w = await utworzWiadomosc(tenantId, flowId, nazwa);
    if (!w.ok) throw new Error(w.blad);
    const z = await zapiszWiadomosc(tenantId, flowId, w.id, { temat, dokumentJson: dokument(`<p>${nazwa}</p>`) });
    if (!z.ok) throw new Error(z.blad);
    return w.id;
  }
  async function przesunCzas(flowId: string, klucz: string) {
    // "czas mija": termin wznowienia i data wejscia w krok cofaja sie za teraz
    await getPool().query(
      `update flow_participants set resume_at = now() - interval '1 minute'
        where tenant_id = $1 and flow_id = $2 and profile_id = $3 and status = 'w_toku'`,
      [tenantId, flowId, profile[klucz]],
    );
  }
  /** zapis szkicu z wersja, ktora widzi "klient" (optymistyczna wspolbieznosc) */
  async function zapisz(flowId: string, graf: Graf) {
    const widok = (await pobierzAutomatyzacje(tenantId, flowId))!;
    return zapiszSzkic(tenantId, flowId, { graf, oczekiwanaWersja: widok.draftVersion });
  }
  /** wlaczenie "godzine temu": zdarzenia testow datowane w niedalekiej przeszlosci mieszcza sie po active_since */
  async function wlacz(flowId: string) {
    // testy sa niezalezne: flow z poprzednich testow (ten sam wyzwalacz) nie lapia zdarzen tego
    // testu, a zdarzenia z poprzednich testow nie wchodza do tego flow
    await getPool().query("update flows set status = 'szkic' where tenant_id = $1 and id <> $2 and status <> 'szkic'", [tenantId, flowId]);
    await getPool().query("delete from events where tenant_id = $1", [tenantId]);
    await getPool().query("delete from orders where tenant_id = $1", [tenantId]);
    const w = await zmienStatus(tenantId, flowId, "wlaczony");
    if (!w.ok) throw new Error(w.blad);
    await getPool().query("update flows set active_since = now() - interval '1 hour' where tenant_id = $1 and id = $2", [tenantId, flowId]);
    return w;
  }
  async function uczestnik(flowId: string, klucz: string) {
    const { rows } = await getPool().query(
      "select status, node_id, resume_at, exit_reason, version from flow_participants where tenant_id = $1 and flow_id = $2 and profile_id = $3",
      [tenantId, flowId, profile[klucz]],
    );
    return rows[0];
  }
  async function wiadomosciOsoby(klucz: string) {
    const { rows } = await getPool().query(
      "select subject, current_state from messages where tenant_id = $1 and profile_id = $2 and source_type = 'journey' order by created_at",
      [tenantId, profile[klucz]],
    );
    return rows;
  }

  /** powitanie: wyzwalacz -> mail1 -> opoznienie 1 min -> warunek kupil_od_wejscia -> Tak: koniec / Nie: mail2 -> koniec */
  async function powitalny(name: string) {
    const f = await utworzAutomatyzacje(tenantId, { name, zdarzenie: "popup.submitted" });
    if (!f.ok) throw new Error(f.blad);
    const e1 = await wiadomosc(f.id, "Mail 1", "Witaj!");
    const e2 = await wiadomosc(f.id, "Mail 2", "Nie kupiłeś? Zobacz to");
    let g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "m1", typ: "email", emailId: e1, links: { next: null } });
    g = wstawWezel(g, { po: "m1", port: "next" }, { id: "op", typ: "opoznienie", ilosc: 1, jednostka: "minuty", links: { next: null } });
    g = wstawWezel(g, { po: "op", port: "next" }, { id: "w", typ: "warunek", regula: { rodzaj: "kupil_od_wejscia" }, links: { next_if_true: null, next_if_false: null } });
    g = wstawWezel(g, { po: "w", port: "next_if_false" }, { id: "m2", typ: "email", emailId: e2, links: { next: null } });
    const z = await zapisz(f.id, g);
    if (!z.ok) throw new Error(z.blad);
    expect(z.bramka).toEqual([]);
    return { id: f.id, e1, e2, graf: g };
  }

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'FLOW %'");
    const t = await pool.query("insert into tenants (name) values ('FLOW tenant') returning id");
    tenantId = t.rows[0].id;
    await dodajProfil("anna", "flow-anna@example.test");
    await dodajProfil("bartek", "flow-bartek@example.test");
    await dodajProfil("bez_zgody", "flow-bezzgody@example.test", false);
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like 'FLOW %'");
    await closePool();
  });

  it("bramka: nie da się włączyć flow z gałęzią bez końca ani z pustym mailem; po naprawie włącza się jako wersja 1", async () => {
    const f = await utworzAutomatyzacje(tenantId, { name: "FLOW bramka", zdarzenie: "popup.submitted" });
    if (!f.ok) throw new Error(f.blad);
    const pusty = await utworzWiadomosc(tenantId, f.id, "Pusty mail");
    if (!pusty.ok) throw new Error(pusty.blad);
    let g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "m", typ: "email", emailId: pusty.id, links: { next: null } });
    g = { ...g, wezly: g.wezly.map((w) => (w.id === "m" ? ({ ...w, links: { next: null } } as Wezel) : w)).filter((w) => w.typ !== "koniec") };
    const zapis = await zapisz(f.id, g);
    expect(zapis.ok).toBe(true);
    const wlacz = await zmienStatus(tenantId, f.id, "wlaczony");
    expect(wlacz.ok).toBe(false);
    const bledy = (wlacz as any).bledy.map((b: any) => b.tresc);
    expect(bledy).toContain("Ta gałąź nie ma końca.");
    expect(bledy).toContain("Wiadomość nie ma tematu.");
    expect((await pobierzAutomatyzacje(tenantId, f.id))!.status).toBe("szkic");

    await zapiszWiadomosc(tenantId, f.id, pusty.id, { temat: "Już nie pusty", dokumentJson: dokument("<p>Treść</p>") });
    g = { ...g, wezly: [...g.wezly.map((w) => (w.id === "m" ? ({ ...w, links: { next: "k" } } as Wezel) : w)), { id: "k", typ: "koniec" }] };
    await zapisz(f.id, g);
    const ok = await zmienStatus(tenantId, f.id, "wlaczony");
    expect(ok.ok).toBe(true);
    expect((ok as any).wersja).toBe(1);
  });

  it("osoba idzie właściwą gałęzią: mail 1 od razu, po opóźnieniu warunek, kupujący kończy, niekupujący dostaje mail 2", async () => {
    const f = await powitalny("FLOW powitanie");
    await wlacz(f.id);
    await zdarzenie("anna", "popup.submitted", "1 minute");
    await zdarzenie("bartek", "popup.submitted", "1 minute");

    const d1 = new DostawcaAtrapa();
    const tik1 = await uruchomAutomatyzacje(tenantId, { dostawca: d1 });
    expect(tik1.wejscia).toBe(2);
    expect(tik1.zbudowane).toBe(2);
    expect(d1.wyslane.sort()).toEqual(["flow-anna@example.test", "flow-bartek@example.test"]);
    // obie osoby stoja w opoznieniu z terminem wznowienia
    expect((await uczestnik(f.id, "anna")).node_id).toBe("op");
    expect((await uczestnik(f.id, "anna")).resume_at).not.toBeNull();

    // tik przed czasem nikogo nie rusza
    const d2 = new DostawcaAtrapa();
    const tik2 = await uruchomAutomatyzacje(tenantId, { dostawca: d2 });
    expect(tik2.przesunieci).toBe(0);
    expect(d2.wyslane).toEqual([]);

    // Anna kupila po wejsciu, Bartek nie
    await getPool().query(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status) values ($1, 'woocommerce', 'https://flow.example.test', '\\x00', 'connected') returning id`,
      [tenantId],
    ).then(async (s) => {
      await getPool().query(
        `insert into orders (tenant_id, store_id, profile_id, external_id, number, status, total_minor, currency, occurred_at)
         values ($1, $2, $3, 'FLOW-1', '1', 'completed', 19900, 'PLN', now())`,
        [tenantId, s.rows[0].id, profile.anna],
      );
    });
    await przesunCzas(f.id, "anna");
    await przesunCzas(f.id, "bartek");
    const d3 = new DostawcaAtrapa();
    const tik3 = await uruchomAutomatyzacje(tenantId, { dostawca: d3 });
    expect(tik3.przesunieci).toBe(2);
    expect(d3.wyslane).toEqual(["flow-bartek@example.test"]);
    expect(await uczestnik(f.id, "anna")).toMatchObject({ status: "zakonczony", node_id: "koniec" });
    expect(await uczestnik(f.id, "bartek")).toMatchObject({ status: "zakonczony" });
    expect((await wiadomosciOsoby("anna")).map((m) => m.subject)).toEqual(["Witaj!"]);
    expect((await wiadomosciOsoby("bartek")).map((m) => m.subject)).toEqual(["Witaj!", "Nie kupiłeś? Zobacz to"]);

    // sciezka osoby: kazde przejscie zapisane, warunek z wynikiem, wersja 1
    const sciezka = await sciezkaOsobyWeFlow(tenantId, profile.bartek);
    const ta = sciezka.find((s) => s.flowId === f.id)!;
    expect(ta.status).toBe("zakonczony");
    expect(ta.wersja).toBe(1);
    expect(ta.kroki.map((k) => k.rodzaj)).toEqual(["wejscie", "przejscie", "wyslano", "przejscie", "oczekiwanie", "przejscie", "warunek", "przejscie", "wyslano", "koniec"]);
    expect(ta.kroki.find((k) => k.rodzaj === "warunek")!.tytul).toMatch(/Nie$/);

    // statystyki per wezel: dwa maile z m1, jeden z m2, zero w toku
    const st = (await statystykiAutomatyzacji(tenantId, f.id))!;
    expect(st.emaile[f.e1].wyslane).toBe(2);
    expect(st.emaile[f.e2].wyslane).toBe(1);
    expect(st.zakonczyli).toBe(2);
    expect(Object.keys(st.wToku)).toEqual([]);
  });

  it("ponowione zdarzenie tej samej osoby nie tworzy drugiego wejścia, a powtórzony tik nikogo nie przesuwa dwa razy", async () => {
    const f = await powitalny("FLOW idempotencja");
    await wlacz(f.id);
    await zdarzenie("anna", "popup.submitted", "30 seconds");
    await zdarzenie("anna", "popup.submitted", "10 seconds");
    const d = new DostawcaAtrapa();
    const t1 = await uruchomAutomatyzacje(tenantId, { dostawca: d });
    const t2 = await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(t1.wejscia).toBe(1);
    expect(t2.wejscia).toBe(0);
    expect(t2.przesunieci).toBe(0);
    expect(d.wyslane).toEqual(["flow-anna@example.test"]);
    const { rows } = await getPool().query("select count(*)::int as n from flow_participants where tenant_id = $1 and flow_id = $2", [tenantId, f.id]);
    expect(rows[0].n).toBe(1);
  });

  it("dwa workery naraz: jedno wejście, jeden mail, jedno przejście (SKIP LOCKED + unikalności)", async () => {
    const f = await powitalny("FLOW równolegle");
    await wlacz(f.id);
    await zdarzenie("bartek", "popup.submitted", "30 seconds");
    const d1 = new DostawcaAtrapa();
    const d2 = new DostawcaAtrapa();
    const [w1, w2] = await Promise.all([
      uruchomAutomatyzacje(tenantId, { dostawca: d1 }),
      uruchomAutomatyzacje(tenantId, { dostawca: d2 }),
    ]);
    expect(w1.wejscia + w2.wejscia).toBe(1);
    expect(w1.zbudowane + w2.zbudowane).toBe(1);
    expect([...d1.wyslane, ...d2.wyslane]).toEqual(["flow-bartek@example.test"]);
    const { rows } = await getPool().query(
      "select count(*)::int as n from flow_transitions where tenant_id = $1 and flow_id = $2 and kind = 'wyslano'",
      [tenantId, f.id],
    );
    expect(rows[0].n).toBe(1);

    // drugi etap: oba workery probuja przesunac te sama osobe po opoznieniu
    await przesunCzas(f.id, "bartek");
    const d3 = new DostawcaAtrapa();
    const d4 = new DostawcaAtrapa();
    const [w3, w4] = await Promise.all([
      uruchomAutomatyzacje(tenantId, { dostawca: d3 }),
      uruchomAutomatyzacje(tenantId, { dostawca: d4 }),
    ]);
    expect(w3.przesunieci + w4.przesunieci).toBe(1);
    expect([...d3.wyslane, ...d4.wyslane]).toEqual(["flow-bartek@example.test"]);
    const { rows: m2 } = await getPool().query(
      "select count(*)::int as n from messages where tenant_id = $1 and profile_id = $2 and source_type = 'journey' and source_id = $3",
      [tenantId, profile.bartek, f.e2],
    );
    expect(m2[0].n).toBe(1);
  });

  it("wstrzymany flow nie przesuwa nikogo i nie wysyła; wznowienie rusza osoby w toku, ale nie wpuszcza zdarzeń z czasu wstrzymania", async () => {
    const f = await powitalny("FLOW wstrzymanie");
    await wlacz(f.id);
    await zdarzenie("anna", "popup.submitted", "30 seconds");
    await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    expect((await uczestnik(f.id, "anna")).node_id).toBe("op");

    const w = await zmienStatus(tenantId, f.id, "wstrzymany");
    expect(w.ok).toBe(true);
    await przesunCzas(f.id, "anna");
    await zdarzenie("bartek", "popup.submitted", "5 seconds");
    const d = new DostawcaAtrapa();
    const tik = await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(tik.wejscia).toBe(0);
    expect(tik.przesunieci).toBe(0);
    expect(d.wyslane).toEqual([]);
    expect((await uczestnik(f.id, "anna")).node_id).toBe("op");

    const wznow = await zmienStatus(tenantId, f.id, "wlaczony");
    expect(wznow.ok).toBe(true);
    const d2 = new DostawcaAtrapa();
    const tik2 = await uruchomAutomatyzacje(tenantId, { dostawca: d2 });
    expect(tik2.wejscia).toBe(0); // zdarzenie Bartka sprzed wznowienia milczy
    expect(tik2.przesunieci).toBe(1);
    expect(d2.wyslane).toEqual(["flow-anna@example.test"]);
    expect((await uczestnik(f.id, "anna")).status).toBe("zakonczony");
  });

  it("wersjonowanie: osoba w toku kończy na wersji, z którą weszła, nowe wejścia idą po nowej", async () => {
    const f = await powitalny("FLOW wersje");
    await wlacz(f.id);
    await zdarzenie("anna", "popup.submitted", "30 seconds");
    await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    expect((await uczestnik(f.id, "anna")).version).toBe(1);

    // wersja 2: wyrzucamy warunek i mail 2 - po opoznieniu od razu koniec
    const widok = (await pobierzAutomatyzacje(tenantId, f.id))!;
    const g2: Graf = { ...widok.graf, wezly: widok.graf.wezly.filter((w) => !["w", "m2"].includes(w.id) && w.id !== "koniec" || w.id === "koniec").map((w) => (w.id === "op" ? ({ ...w, links: { next: "koniec" } } as Wezel) : w)).filter((w) => w.typ !== "koniec" || w.id === "koniec") };
    const zapis = await zapisz(f.id, g2);
    if (!zapis.ok) throw new Error(zapis.blad);
    const pub = await opublikuj(tenantId, f.id);
    expect(pub.ok).toBe(true);
    expect((pub as any).wersja).toBe(2);

    await zdarzenie("bartek", "popup.submitted", "5 seconds");
    await przesunCzas(f.id, "anna");
    const d = new DostawcaAtrapa();
    await uruchomAutomatyzacje(tenantId, { dostawca: d });
    // Anna (wersja 1) przeszla przez warunek i dostala mail 2; Bartek wszedl jako wersja 2
    expect(await uczestnik(f.id, "anna")).toMatchObject({ status: "zakonczony", version: 1 });
    expect(d.wyslane).toEqual(expect.arrayContaining(["flow-anna@example.test", "flow-bartek@example.test"]));
    expect((await uczestnik(f.id, "bartek")).version).toBe(2);
    await przesunCzas(f.id, "bartek");
    const d2 = new DostawcaAtrapa();
    await uruchomAutomatyzacje(tenantId, { dostawca: d2 });
    expect(d2.wyslane).toEqual([]);
    expect(await uczestnik(f.id, "bartek")).toMatchObject({ status: "zakonczony", node_id: "koniec" });
  });

  it("osoba bez zgody wychodzi z automatyzacji na kroku e-mail z jawnym powodem, bez wiadomości", async () => {
    const f = await powitalny("FLOW zgody");
    await wlacz(f.id);
    await zdarzenie("bez_zgody", "popup.submitted", "30 seconds");
    const d = new DostawcaAtrapa();
    const tik = await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(tik.wejscia).toBe(1);
    expect(tik.zbudowane).toBe(0);
    expect(d.wyslane).toEqual([]);
    expect(await uczestnik(f.id, "bez_zgody")).toMatchObject({ status: "wyszedl", exit_reason: "brak_zgody" });
    expect(await wiadomosciOsoby("bez_zgody")).toEqual([]);
    const sciezka = (await sciezkaOsobyWeFlow(tenantId, profile.bez_zgody)).find((s) => s.flowId === f.id)!;
    expect(sciezka.powodWyjscia).toBe("brak zgody na e-mail");
  });

  it("wyłączenie przerywa osoby w toku, a ponowne włączenie nie sięga po stare zdarzenia", async () => {
    const f = await powitalny("FLOW wyłączenie");
    await wlacz(f.id);
    await zdarzenie("anna", "popup.submitted", "30 seconds");
    await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    const wyl = await zmienStatus(tenantId, f.id, "szkic");
    expect(wyl.ok).toBe(true);
    expect(await uczestnik(f.id, "anna")).toMatchObject({ status: "przerwany", exit_reason: "automatyzacja wyłączona" });
    await zmienStatus(tenantId, f.id, "wlaczony");
    await zdarzenie("bartek", "popup.submitted", "2 hours");
    const tik = await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    expect(tik.wejscia).toBe(0);
  });

  it("szkic odrzuca krok e-mail wskazujący cudzą wiadomość", async () => {
    const f1 = await powitalny("FLOW swoje");
    const f2 = await utworzAutomatyzacje(tenantId, { name: "FLOW cudze", zdarzenie: "popup.submitted" });
    if (!f2.ok) throw new Error(f2.blad);
    const g = wstawWezel((await pobierzAutomatyzacje(tenantId, f2.id))!.graf, { po: "wyzwalacz", port: "next" }, { id: "obcy", typ: "email", emailId: f1.e1, links: { next: null } });
    const zapis = await zapisz(f2.id, g);
    expect(zapis).toEqual({ ok: false, blad: "Krok e-mail wskazuje wiadomość spoza tej automatyzacji." });
  });

  it("czekaj do: termin to najbliższy wskazany dzień tygodnia o wskazanej godzinie po chwili wejścia w krok", async () => {
    const f = await utworzAutomatyzacje(tenantId, { name: "FLOW czekaj", zdarzenie: "popup.submitted" });
    if (!f.ok) throw new Error(f.blad);
    const e = await wiadomosc(f.id, "Poniedziałkowy", "W poniedziałek rano");
    let g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "cz", typ: "czekaj_do", dni: [1], godzina: "09:00", links: { next: null } });
    g = wstawWezel(g, { po: "cz", port: "next" }, { id: "m", typ: "email", emailId: e, links: { next: null } });
    await zapisz(f.id, g);
    await wlacz(f.id);
    await zdarzenie("anna", "popup.submitted", "1 second");
    await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    const u = await uczestnik(f.id, "anna");
    expect(u.node_id).toBe("cz");
    const { rows } = await getPool().query(
      `select extract(isodow from ($1::timestamptz at time zone 'Europe/Warsaw'))::int as dow,
              to_char($1::timestamptz at time zone 'Europe/Warsaw', 'HH24:MI') as godz,
              ($1::timestamptz > now()) as w_przyszlosci`,
      [u.resume_at],
    );
    expect(rows[0]).toMatchObject({ dow: 1, godz: "09:00", w_przyszlosci: true });
  });
  // ── Review: znaleziska z obu list ──────────────────────────────────────────

  it("P1: temat wyczyszczony w szkicu włączonej automatyzacji nie dociera do ludzi; wysyłka idzie z migawki wersji, a publikacja pustego tematu jest zablokowana", async () => {
    const f = await powitalny("FLOW migawka");
    await wlacz(f.id);
    await zdarzenie("bartek", "popup.submitted", "30 seconds");
    await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    // operator czyści temat i treść maila 2 w trakcie, gdy Bartek czeka w opóźnieniu
    const z = await zapiszWiadomosc(tenantId, f.id, f.e2, { temat: "", dokumentJson: dokument("<p>półgotowe</p>") });
    expect(z.ok && z.niepublikowane).toBe(true);
    await przesunCzas(f.id, "bartek");
    const d = new DostawcaAtrapa();
    await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(d.wyslane).toEqual(["flow-bartek@example.test"]);
    expect(await uczestnik(f.id, "bartek")).toMatchObject({ status: "zakonczony" });
    const { rows } = await getPool().query(
      "select subject, body_html from messages where tenant_id = $1 and source_id = $2 and profile_id = $3",
      [tenantId, f.e2, profile.bartek],
    );
    expect(rows[0].subject).toBe("Nie kupiłeś? Zobacz to");
    expect(rows[0].body_html).toContain("Mail 2");
    expect(rows[0].body_html).not.toContain("półgotowe");
    const pub = await opublikuj(tenantId, f.id);
    expect(pub.ok).toBe(false);
    expect((pub as any).bledy.map((b: any) => b.tresc)).toContain("Wiadomość nie ma tematu.");
  });

  it("P1: poprawiona treść dociera do ludzi dopiero po „Opublikuj”, jako nowa wersja", async () => {
    const f = await powitalny("FLOW publikacja treści");
    await wlacz(f.id);
    await zapiszWiadomosc(tenantId, f.id, f.e1, { temat: "Nowy temat powitania" });
    expect((await pobierzAutomatyzacje(tenantId, f.id))!.niepublikowane).toBe(true);
    await zdarzenie("anna", "popup.submitted", "30 seconds");
    await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    const temat = async (klucz: string) => (await getPool().query(
      "select subject from messages where tenant_id = $1 and source_id = $2 and profile_id = $3", [tenantId, f.e1, profile[klucz]])).rows[0]?.subject;
    expect(await temat("anna")).toBe("Witaj!");
    const pub = await opublikuj(tenantId, f.id);
    expect(pub).toMatchObject({ ok: true, wersja: 2 });
    expect((await pobierzAutomatyzacje(tenantId, f.id))!.niepublikowane).toBe(false);
    const { rows } = await getPool().query("select emails from flow_versions where tenant_id = $1 and flow_id = $2 and version = 2", [tenantId, f.id]);
    expect(rows[0].emails[f.e1].subject).toBe("Nowy temat powitania");
    await zdarzenie("bartek", "popup.submitted", "5 seconds");
    await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    expect(await temat("bartek")).toBe("Nowy temat powitania");
    // drugie „Opublikuj” bez zmian nie tworzy wersji
    expect(await opublikuj(tenantId, f.id)).toMatchObject({ ok: true, wersja: 2 });
  });

  it("#2: zapis szkicu ze starą wersją (druga karta) jest odrzucany, a nie nadpisuje cudzej zmiany", async () => {
    const f = await powitalny("FLOW współbieżność");
    const widok = (await pobierzAutomatyzacje(tenantId, f.id))!;
    const pierwsza = await zapiszSzkic(tenantId, f.id, { graf: widok.graf, oczekiwanaWersja: widok.draftVersion });
    expect(pierwsza.ok).toBe(true);
    const druga = await zapiszSzkic(tenantId, f.id, { graf: widok.graf, oczekiwanaWersja: widok.draftVersion });
    expect(druga).toMatchObject({ ok: false, konflikt: true });
  });

  it("#3: „Wznów” nie publikuje szkicu i nie zależy od jego błędów", async () => {
    const f = await powitalny("FLOW wznów bez szkicu");
    await wlacz(f.id);
    await zmienStatus(tenantId, f.id, "wstrzymany");
    // szkic zepsuty w trakcie przerwy: gałąź bez końca
    const g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    await zapisz(f.id, { ...g, wezly: g.wezly.map((w) => (w.id === "m2" ? ({ ...w, links: { next: null } } as Wezel) : w)) });
    const w = await zmienStatus(tenantId, f.id, "wlaczony");
    expect(w).toMatchObject({ ok: true, status: "wlaczony", wersja: 1 });
    expect((await pobierzAutomatyzacje(tenantId, f.id))!.liveVersion).toBe(1);
  });

  it("#4: duplikat nazwy to czytelna odmowa, a graf dalej się zapisuje", async () => {
    const f = await powitalny("FLOW nazwa A");
    await powitalny("FLOW nazwa B");
    expect(await zmienNazwe(tenantId, f.id, "FLOW nazwa B")).toMatchObject({ ok: false, blad: expect.stringContaining("już istnieje") });
    expect(await zmienNazwe(tenantId, f.id, 42)).toMatchObject({ ok: false });
    expect((await zapisz(f.id, f.graf)).ok).toBe(true);
  });

  it("#6/B#8: orderId spoza UUID w zdarzeniu nie wywraca tiku; warunek wartości zamówienia liczy się bez niego", async () => {
    const f = await utworzAutomatyzacje(tenantId, { name: "FLOW zły orderId", zdarzenie: "order.created" });
    if (!f.ok) throw new Error(f.blad);
    const e = await wiadomosc(f.id, "Duże zamówienie", "Dzięki za duże zamówienie");
    let g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "w", typ: "warunek", regula: { rodzaj: "wartosc_zamowienia", minMinor: 100 }, links: { next_if_true: null, next_if_false: null } });
    g = wstawWezel(g, { po: "w", port: "next_if_true" }, { id: "m", typ: "email", emailId: e, links: { next: null } });
    await zapisz(f.id, g);
    await wlacz(f.id);
    await zdarzenie("anna", "order.created", "10 seconds", { orderId: "12345-nie-uuid", totalMinor: 999 });
    const tik = await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    expect(tik.wejscia).toBe(1);
    expect(tik.bledyUczestnikow).toBe(0);
    expect(await uczestnik(f.id, "anna")).toMatchObject({ status: "zakonczony" });
  });

  it("B#11: usunięty segment w warunku przerywa ścieżkę z powodem i alertem zamiast po cichu wybierać „Nie”", async () => {
    const seg = await getPool().query("insert into segments (tenant_id, name, rules) values ($1, 'FLOW seg', '[]') returning id", [tenantId]);
    const f = await utworzAutomatyzacje(tenantId, { name: "FLOW segment", zdarzenie: "popup.submitted" });
    if (!f.ok) throw new Error(f.blad);
    const e = await wiadomosc(f.id, "Dla segmentu", "Dla segmentu");
    let g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "w", typ: "warunek", regula: { rodzaj: "w_segmencie", segmentId: seg.rows[0].id }, links: { next_if_true: null, next_if_false: null } });
    g = wstawWezel(g, { po: "w", port: "next_if_false" }, { id: "m", typ: "email", emailId: e, links: { next: null } });
    await zapisz(f.id, g);
    await wlacz(f.id);
    await getPool().query("delete from segments where id = $1", [seg.rows[0].id]);
    await zdarzenie("anna", "popup.submitted", "10 seconds");
    const d = new DostawcaAtrapa();
    const tik = await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(d.wyslane).toEqual([]);
    expect(await uczestnik(f.id, "anna")).toMatchObject({ status: "przerwany", exit_reason: "segment z warunku nie istnieje" });
    expect(tik.alerty.some((a) => a.includes("nie istnieje"))).toBe(true);
  });

  it("B#1: import na listę nie uruchamia powitania; dodanie ręczne tak; masowe tylko po jawnym przełączniku", async () => {
    const l = await getPool().query("insert into lists (tenant_id, name) values ($1, 'FLOW lista') returning id", [tenantId]);
    const listId = l.rows[0].id;
    const f = await utworzAutomatyzacje(tenantId, { name: "FLOW lista", zdarzenie: "list.joined", listId });
    if (!f.ok) throw new Error(f.blad);
    const e = await wiadomosc(f.id, "Witaj na liście", "Witaj na liście");
    let g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "m", typ: "email", emailId: e, links: { next: null } });
    await zapisz(f.id, g);
    await wlacz(f.id);
    await getPool().query(
      `insert into list_members (tenant_id, list_id, profile_id, source, added_at)
       values ($1, $2, $3, 'import_klaviyo:operator@midrev.pl', now()), ($1, $2, $4, 'reczny', now())`,
      [tenantId, listId, profile.anna, profile.bartek],
    );
    const d = new DostawcaAtrapa();
    await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(d.wyslane).toEqual(["flow-bartek@example.test"]);
    expect(await uczestnik(f.id, "anna")).toBeUndefined();
    // operator świadomie włącza masowe: nowa wersja wpuszcza też import
    const g2 = { ...g, wezly: g.wezly.map((w) => (w.typ === "wyzwalacz" && w.zrodlo.rodzaj === "lista" ? ({ ...w, zrodlo: { ...w.zrodlo, takzeMasowe: true } } as Wezel) : w)) };
    await zapisz(f.id, g2);
    expect((await opublikuj(tenantId, f.id)).ok).toBe(true);
    const d2 = new DostawcaAtrapa();
    await uruchomAutomatyzacje(tenantId, { dostawca: d2 });
    expect(d2.wyslane).toEqual(["flow-anna@example.test"]);
  });

  it("B#14: zamówienie z importu historii nie uruchamia automatyzacji po zakupie", async () => {
    const f = await utworzAutomatyzacje(tenantId, { name: "FLOW import zamówień", zdarzenie: "order.created" });
    if (!f.ok) throw new Error(f.blad);
    const e = await wiadomosc(f.id, "Dzięki", "Dzięki za zakup");
    let g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "m", typ: "email", emailId: e, links: { next: null } });
    await zapisz(f.id, g);
    await wlacz(f.id);
    await zdarzenie("anna", "order.created", "10 seconds", { kanal: "import" });
    await zdarzenie("bartek", "order.created", "10 seconds", { kanal: "webhook" });
    const d = new DostawcaAtrapa();
    await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(d.wyslane).toEqual(["flow-bartek@example.test"]);
  });

  it("B#4: opóźnienie przeterminowane o ponad dobę (automatyzacja stała) kończy ścieżkę z powodem zamiast wysyłać falą", async () => {
    const f = await powitalny("FLOW przeterminowane");
    await wlacz(f.id);
    await zdarzenie("anna", "popup.submitted", "30 seconds");
    await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    await getPool().query("update flow_participants set resume_at = now() - interval '3 days' where tenant_id = $1 and flow_id = $2", [tenantId, f.id]);
    const d = new DostawcaAtrapa();
    await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(d.wyslane).toEqual([]);
    expect(await uczestnik(f.id, "anna")).toMatchObject({ status: "przerwany", exit_reason: "opóźnienie przeterminowane (automatyzacja stała)" });
  });

  it("#9: osierocona wiadomość (usunięta z kanwy ponad godzinę temu) jest sprzątana; wskazana przez wersję zostaje", async () => {
    const f = await powitalny("FLOW sieroty");
    await wlacz(f.id);
    const sierota = await utworzWiadomosc(tenantId, f.id, "Sierota");
    if (!sierota.ok) throw new Error(sierota.blad);
    await getPool().query("update journeys set created_at = now() - interval '2 hours' where tenant_id = $1 and flow_id = $2", [tenantId, f.id]);
    // szkic bez maila 2: e2 jest w wersji 1, więc zostaje; sierota znika
    const g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    const bezM2: Graf = { ...g, wezly: g.wezly.filter((w) => w.id !== "m2").map((w) => (w.id === "w" ? ({ ...w, links: { next_if_true: (w as any).links.next_if_true, next_if_false: (w as any).links.next_if_true } } as Wezel) : w)) };
    expect((await zapisz(f.id, bezM2)).ok).toBe(true);
    const { rows } = await getPool().query("select id from journeys where tenant_id = $1 and flow_id = $2", [tenantId, f.id]);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(f.e2);
    expect(ids).not.toContain(sierota.id);
  });

  it("#12: dwa równoczesne „Użyj szablonu” dają dwie automatyzacje z różnymi nazwami, bez wyjątku", async () => {
    const [a, b] = await Promise.all([
      utworzZBiblioteki(tenantId, "powitanie", { sklepUrl: "https://sklep.example.test" }),
      utworzZBiblioteki(tenantId, "powitanie", { sklepUrl: "https://sklep.example.test" }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const { rows } = await getPool().query("select name from flows where tenant_id = $1 and name like 'Powitanie: 3 maile%'", [tenantId]);
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
  });
  // ── Review runda 2 ─────────────────────────────────────────────────────────

  /** limit dobowy wyczerpany: limit 1 i jedno miejsce już zużyte dzisiaj */
  async function wyczerpLimit() {
    await getPool().query("insert into tenant_send_limits (tenant_id, daily_limit) values ($1, 1) on conflict (tenant_id) do update set daily_limit = 1", [tenantId]);
    await getPool().query("insert into tenant_send_usage (tenant_id, day, used) values ($1, current_date, 1) on conflict (tenant_id, day) do update set used = greatest(tenant_send_usage.used, 1)", [tenantId]);
  }
  async function przywrocLimit() {
    await getPool().query("delete from tenant_send_limits where tenant_id = $1", [tenantId]);
    await getPool().query("delete from tenant_send_usage where tenant_id = $1", [tenantId]);
  }
  async function stanWiadomosci(klucz: string, emailId: string) {
    const { rows } = await getPool().query(
      `select m.current_state, e.payload->>'powod' as powod from messages m
         left join message_events e on e.tenant_id = m.tenant_id and e.message_id = m.id and e.event_type = 'suppressed'
        where m.tenant_id = $1 and m.profile_id = $2 and m.source_id = $3`,
      [tenantId, profile[klucz], emailId],
    );
    return rows[0];
  }

  it("R2#1: wyłączenie gasi maile czekające w kolejce (limit dobowy) i nie wychodzą po ponownym włączeniu", async () => {
    const f = await powitalny("FLOW gaszenie kolejki");
    await wlacz(f.id);
    await wyczerpLimit();
    try {
      await zdarzenie("anna", "popup.submitted", "30 seconds");
      const d = new DostawcaAtrapa();
      await uruchomAutomatyzacje(tenantId, { dostawca: d });
      expect(d.wyslane).toEqual([]);
      expect((await stanWiadomosci("anna", f.e1)).current_state).toBe("queued");
      await zmienStatus(tenantId, f.id, "szkic");
      expect(await stanWiadomosci("anna", f.e1)).toMatchObject({ current_state: "suppressed", powod: "automatyzacja_wylaczona" });
    } finally {
      await przywrocLimit();
    }
    await wlacz(f.id);
    const d2 = new DostawcaAtrapa();
    await uruchomAutomatyzacje(tenantId, { dostawca: d2 });
    expect(d2.wyslane).toEqual([]);
  });

  it("R2#2: „Wznów” gasi maile z kolejki starsze niż doba, świeże wychodzą", async () => {
    const f = await powitalny("FLOW pauza kolejka");
    await wlacz(f.id);
    await wyczerpLimit();
    try {
      await zdarzenie("anna", "popup.submitted", "30 seconds");
      await zdarzenie("bartek", "popup.submitted", "20 seconds");
      await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
      await zmienStatus(tenantId, f.id, "wstrzymany");
      await getPool().query("update messages set created_at = now() - interval '2 days' where tenant_id = $1 and profile_id = $2 and source_id = $3", [tenantId, profile.anna, f.e1]);
    } finally {
      await przywrocLimit();
    }
    expect((await zmienStatus(tenantId, f.id, "wlaczony")).ok).toBe(true);
    expect(await stanWiadomosci("anna", f.e1)).toMatchObject({ current_state: "suppressed", powod: "przeterminowane_po_pauzie" });
    const d = new DostawcaAtrapa();
    await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(d.wyslane).toEqual(["flow-bartek@example.test"]);
  });

  it("R2#3 / AD-39: zdarzenie spóźnione o ponad 4 h i zdarzenie sprzed zaległego skanu nie wchodzą; „czekaj do” liczy się od teraz", async () => {
    // (a) webhook dotarl po 3 dniach (zaszlo 3 dni temu, zarejestrowane teraz): regula 4 h,
    //     wejscia nie ma wcale, wiec tym bardziej maila fala (wczesniej: wejscie + przerwanie)
    const f = await utworzAutomatyzacje(tenantId, { name: "FLOW stare zdarzenie", zdarzenie: "popup.submitted" });
    if (!f.ok) throw new Error(f.blad);
    const e = await wiadomosc(f.id, "Po godzinie", "Po godzinie");
    let g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "op", typ: "opoznienie", ilosc: 1, jednostka: "godziny", links: { next: null } });
    g = wstawWezel(g, { po: "op", port: "next" }, { id: "m", typ: "email", emailId: e, links: { next: null } });
    await zapisz(f.id, g);
    await wlacz(f.id);
    await getPool().query("update flows set active_since = now() - interval '5 days' where tenant_id = $1 and id = $2", [tenantId, f.id]);
    await zdarzenie("anna", "popup.submitted", "3 days");
    const d = new DostawcaAtrapa();
    const w1 = await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(d.wyslane).toEqual([]);
    expect(w1.wejscia).toBe(0);
    expect(await uczestnik(f.id, "anna")).toBeUndefined();

    // (b) worker lezal 3 dni: zdarzenie zaszlo i zarejestrowalo sie 3 dni temu, znacznik skanu
    //     stoi na wlaczeniu sprzed 5 dni. Zdarzen starszych niz doba nie wpuszczamy; idzie alert.
    await getPool().query("delete from events where tenant_id = $1", [tenantId]);
    await getPool().query("delete from flow_trigger_state where tenant_id = $1 and flow_id = $2", [tenantId, f.id]);
    await getPool().query(
      `insert into events (tenant_id, profile_id, event_type, payload, occurred_at, recorded_at)
       values ($1, $2, 'popup.submitted', '{}', now() - interval '3 days', now() - interval '3 days')`,
      [tenantId, profile.anna],
    );
    const w2 = await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    expect(w2.wejscia).toBe(0);
    expect(w2.alerty.some((a) => a.includes("zaległy o ponad dobę"))).toBe(true);
    // znacznik przesunal sie na teraz: kolejny tik nie powtarza alertu
    const w3 = await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    expect(w3.alerty.some((a) => a.includes("zaległy"))).toBe(false);

    // (c) "czekaj do" po zdarzeniu sprzed 3 godzin (w oknie 4 h): termin od max(wejscie, teraz - 1 h)
    const f2 = await utworzAutomatyzacje(tenantId, { name: "FLOW stare czekaj do", zdarzenie: "popup.submitted" });
    if (!f2.ok) throw new Error(f2.blad);
    const e2 = await wiadomosc(f2.id, "W poniedziałek", "W poniedziałek");
    let g2 = (await pobierzAutomatyzacje(tenantId, f2.id))!.graf;
    g2 = wstawWezel(g2, { po: "wyzwalacz", port: "next" }, { id: "cz", typ: "czekaj_do", dni: [1, 2, 3, 4, 5, 6, 7], godzina: "03:00", links: { next: null } });
    g2 = wstawWezel(g2, { po: "cz", port: "next" }, { id: "m", typ: "email", emailId: e2, links: { next: null } });
    await zapisz(f2.id, g2);
    await wlacz(f2.id);
    await getPool().query("update flows set active_since = now() - interval '5 days' where tenant_id = $1 and id = $2", [tenantId, f2.id]);
    await zdarzenie("bartek", "popup.submitted", "3 hours");
    const d2 = new DostawcaAtrapa();
    await uruchomAutomatyzacje(tenantId, { dostawca: d2 });
    const u = await uczestnik(f2.id, "bartek");
    // najbliższa 3:00 po (teraz - 1 h), a nie po dacie sprzed trzech godzin
    const { rows } = await getPool().query("select ($1::timestamptz > now() - interval '1 hour') as swiezy", [u.resume_at ?? "1970-01-01"]);
    expect(u.status === "w_toku" ? rows[0].swiezy : u.status === "zakonczony").toBe(true);
  });

  it("bez MIDREV_GRAF_V2 szkicu z filtrem wyzwalacza nie da się zapisać (rollback kodu czyta tylko v1)", async () => {
    const f = await utworzAutomatyzacje(tenantId, { name: "FLOW v2 zablokowane", zdarzenie: "popup.submitted" });
    if (!f.ok) throw new Error(f.blad);
    const g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    const zFiltrem = { ...g, wezly: g.wezly.map((w) => (w.typ === "wyzwalacz" && w.zrodlo.rodzaj === "metryka"
      ? ({ ...w, zrodlo: { ...w.zrodlo, filtr: { grupy: [{ warunki: [{ typ: "wlasciwosc_zdarzenia", pole: "popup_id", typPola: "string", operator: "rowna", wartosc: "x" }] }] } } } as Wezel)
      : w)) };
    const z = await zapisz(f.id, zFiltrem as Graf);
    expect(z.ok).toBe(false);
    const { rows } = await getPool().query("select draft->>'wersja' as w from flows where tenant_id = $1 and id = $2", [tenantId, f.id]);
    expect(rows[0].w).toBe("1");
    expect((await utworzAutomatyzacje(tenantId, { name: "FLOW metryka api", metryka: "api|Cokolwiek" })).ok).toBe(false);
  });

  it("R2#4: błędy systemowe są rozpoznawane, a alert o nich idzie najwyżej raz na godzinę", () => {
    expect(jestBledemSystemowym(Object.assign(new Error("column x does not exist"), { code: "42703" }))).toBe(true);
    expect(jestBledemSystemowym(Object.assign(new Error("conn"), { code: "08006" }))).toBe(true);
    expect(jestBledemSystemowym(Object.assign(new Error("deadlock"), { code: "40P01" }))).toBe(true);
    expect(jestBledemSystemowym(Object.assign(new Error("invalid input"), { code: "22P02" }))).toBe(false);
    const t = 1_000_000;
    expect(alertSystemowy("baza leży X", t)).toBe("baza leży X");
    expect(alertSystemowy("baza leży X", t + 60_000)).toBeNull();
    expect(alertSystemowy("baza leży X", t + 3_700_000)).toBe("baza leży X");
  });

  it("R2#6: publikacja wersji, której operator nie widział (zmiana w innej karcie), jest odrzucana; zapis wiadomości z nieaktualną wersją też", async () => {
    const f = await powitalny("FLOW widziane wersje");
    await wlacz(f.id);
    const widok = (await pobierzAutomatyzacje(tenantId, f.id))!;
    const widziane = { draft: widok.draftVersion, emaile: Object.fromEntries(Object.values(widok.emaile).map((e) => [e.id, e.wersja])) };
    // ktoś w innej karcie zmienia temat maila 1
    const obca = await zapiszWiadomosc(tenantId, f.id, f.e1, { temat: "Zmiana z innej karty", oczekiwanaWersja: widok.emaile[f.e1].wersja });
    expect(obca.ok).toBe(true);
    const pub = await opublikuj(tenantId, f.id, widziane);
    expect(pub).toMatchObject({ ok: false, blad: expect.stringContaining("zmienił") });
    const stara = await zapiszWiadomosc(tenantId, f.id, f.e1, { temat: "Moja zmiana", oczekiwanaWersja: widok.emaile[f.e1].wersja });
    expect(stara).toMatchObject({ ok: false, konflikt: true });
    // po odświeżeniu (aktualne wersje) publikacja przechodzi
    const swiezy = (await pobierzAutomatyzacje(tenantId, f.id))!;
    const ok = await opublikuj(tenantId, f.id, { draft: swiezy.draftVersion, emaile: Object.fromEntries(Object.values(swiezy.emaile).map((e) => [e.id, e.wersja])) });
    expect(ok).toMatchObject({ ok: true, wersja: 2 });
  });

  it("R2#9: udany ruch zeruje licznik błędów silnika uczestnika", async () => {
    const f = await powitalny("FLOW zerowanie błędów");
    await wlacz(f.id);
    await zdarzenie("anna", "popup.submitted", "30 seconds");
    await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    await getPool().query(
      `update flow_participants set context = context || '{"bledySilnika": 2}', resume_at = now() - interval '1 minute'
        where tenant_id = $1 and flow_id = $2`,
      [tenantId, f.id],
    );
    await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    const { rows } = await getPool().query("select context from flow_participants where tenant_id = $1 and flow_id = $2", [tenantId, f.id]);
    expect(rows[0].context.bledySilnika).toBeUndefined();
  });

  it("R2#10: zepsuta definicja jednej automatyzacji daje alert, a wejścia do pozostałych działają", async () => {
    const zepsuta = await powitalny("FLOW zepsuta");
    const dobra = await powitalny("FLOW dobra");
    await wlacz(zepsuta.id);
    await getPool().query("update flows set status = 'wlaczony', active_since = now() - interval '1 hour' where tenant_id = $1 and id = $2", [tenantId, dobra.id]);
    const v = await zmienStatus(tenantId, dobra.id, "wlaczony");
    expect(v.ok).toBe(true);
    // dobra była już oznaczona jako włączona bez wersji: publikujemy ją jawnie
    await getPool().query("update flows set status = 'szkic' where tenant_id = $1 and id = $2", [tenantId, dobra.id]);
    expect((await zmienStatus(tenantId, dobra.id, "wlaczony")).ok).toBe(true);
    await getPool().query("update flows set active_since = now() - interval '1 hour' where tenant_id = $1 and id = $2", [tenantId, dobra.id]);
    await getPool().query(`update flows set live = '{"zepsute": true}' where tenant_id = $1 and id = $2`, [tenantId, zepsuta.id]);
    await zdarzenie("anna", "popup.submitted", "30 seconds");
    const tik = await uruchomAutomatyzacje(tenantId, { dostawca: new DostawcaAtrapa() });
    expect(tik.wejscia).toBe(1);
    expect(tik.alerty.some((a) => a.includes(zepsuta.id))).toBe(true);
    expect((await uczestnik(dobra.id, "anna")).version).toBe(1);
  });

  it("R2#13: dodanie na listę bez jawnego źródła (domyślne „nieznane”) nie uruchamia automatyzacji", async () => {
    const l = await getPool().query("insert into lists (tenant_id, name) values ($1, 'FLOW lista domyślna') returning id", [tenantId]);
    const f = await utworzAutomatyzacje(tenantId, { name: "FLOW lista domyślna", zdarzenie: "list.joined", listId: l.rows[0].id });
    if (!f.ok) throw new Error(f.blad);
    const e = await wiadomosc(f.id, "Lista", "Lista");
    let g = (await pobierzAutomatyzacje(tenantId, f.id))!.graf;
    g = wstawWezel(g, { po: "wyzwalacz", port: "next" }, { id: "m", typ: "email", emailId: e, links: { next: null } });
    await zapisz(f.id, g);
    await wlacz(f.id);
    await getPool().query("insert into list_members (tenant_id, list_id, profile_id) values ($1, $2, $3)", [tenantId, l.rows[0].id, profile.anna]);
    const { rows } = await getPool().query("select source from list_members where list_id = $1", [l.rows[0].id]);
    expect(rows[0].source).toBe("nieznane");
    const d = new DostawcaAtrapa();
    await uruchomAutomatyzacje(tenantId, { dostawca: d });
    expect(d.wyslane).toEqual([]);
  });
});
