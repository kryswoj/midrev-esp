import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { hashAdresu } from "../src/adapters/hash-adresu";
import { mapujKlientaWoo } from "../src/adapters/store/woo/adapter";
import { anonimizujProfil, eksportujProfil, sprawdzPowodRodo } from "../src/usecases/profil-rodo";
import { przetworzZdarzenie, upsertProfilKlienta } from "../src/usecases/przetworz-zdarzenie";
import { canSendTo } from "../src/usecases/wysylka/can-send-to";

// Audyt #10: po "usunieciu" pelne dane osoby lezaly w raw_events.payload, message_engagement
// (ip, user agent) i tenant_suppressions.email, a eksport ich nie wydawal. Ten test po
// anonimizacji przeszukuje CALA baze po e-mailu i nazwisku osoby i wymaga zera trafien
// poza logiem RODO.

const PREFIKS = "RODO PELNE ";
const znacznik = randomBytes(4).toString("hex");
// osobny znacznik do rzeczy, ktore NIE sa danymi osoby (nazwa listy, tokeny wiadomosci):
// grep po `znacznik` ma trafiac wylacznie w dane osoby
const techniczny = randomBytes(4).toString("hex");
const EMAIL = `rodo-${znacznik}@example.test`;
const NAZWISKO = `Zanonimizowska${znacznik}`;
const IMIE = `Imie${znacznik}`;
const TELEFON = `+48 ${znacznik}`;

async function trafieniaWCalejBazie(fraza: string): Promise<Array<{ tabela: string; ile: number }>> {
  const pool = getPool();
  const { rows: tabele } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
        and table_name not like 'jobs_%' -- partycje sa widoczne przez tabele-rodzica
      order by table_name`,
  );
  const trafienia: Array<{ tabela: string; ile: number }> = [];
  for (const { table_name } of tabele) {
    const wykluczLog =
      table_name === "events" ? " and event_type not in ('rodo.anonimizacja', 'rodo.eksport')" : "";
    const { rows } = await pool.query<{ ile: number }>(
      `select count(*)::int as ile from "${table_name}" t where t::text ilike $1${wykluczLog}`,
      [`%${fraza}%`],
    );
    if (rows[0].ile > 0) trafienia.push({ tabela: table_name, ile: rows[0].ile });
  }
  return trafienia;
}

describe("RODO: eksport i anonimizacja obejmuja KAZDE miejsce z danymi osoby", () => {
  let tenantId = "";
  let storeId = "";
  let profileId = "";
  let messageId = "";

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"])).rows[0].id;
    storeId = (
      await pool.query(
        `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
         values ($1, 'woocommerce', 'https://rodo.example', decode('00', 'hex'), 'connected') returning id`,
        [tenantId],
      )
    ).rows[0].id;
    profileId = (
      await pool.query(
        `insert into profiles (tenant_id, email, phone, first_name, last_name, properties) values ($1, $2, $3, $4, $5, $6) returning id`,
        [tenantId, EMAIL, TELEFON, IMIE, NAZWISKO, JSON.stringify({ miasto: `Miasto ${znacznik}`, tagi: [NAZWISKO] })],
      )
    ).rows[0].id;

    const zamowienieWoo = {
      id: 4242,
      status: "completed",
      total: "249.00",
      currency: "PLN",
      date_created_gmt: "2026-05-10T09:00:00",
      date_modified_gmt: "2026-05-11T09:00:00",
      billing: { first_name: IMIE, last_name: NAZWISKO, email: EMAIL, phone: TELEFON, address_1: `Kwiatowa ${znacznik}` },
      shipping: { first_name: IMIE, last_name: NAZWISKO, address_1: `Kwiatowa ${znacznik}` },
    };
    await pool.query(
      `insert into orders (tenant_id, store_id, profile_id, external_id, number, status, total_minor, currency, occurred_at, raw)
       values ($1, $2, $3, '4242', '4242', 'completed', 24900, 'PLN', '2026-05-10T09:00:00Z', $4)`,
      [tenantId, storeId, profileId, JSON.stringify(zamowienieWoo)],
    );
    // surowe zdarzenia: zamowienie (webhook) i klient (customer.created) - pelne JSON-y ze sklepu
    await pool.query(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload, processed_at)
       values ($1, $2, 'woocommerce', $3, $4, now()), ($1, $2, 'woocommerce', $5, $6, now())`,
      [
        tenantId,
        storeId,
        `woocommerce:${tenantId}:order:4242:2026-05-11T09:00:00`,
        JSON.stringify(zamowienieWoo),
        `woocommerce:${tenantId}:customer:77:2026-05-01T08:00:00`,
        JSON.stringify({ id: 77, email: EMAIL, first_name: IMIE, last_name: NAZWISKO, date_created_gmt: "2026-05-01T08:00:00", billing: { phone: TELEFON } }),
      ],
    );
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, wording, occurred_at)
       values ($1, $2, 'email', 'granted', 'popup:Rabat', 'Zgoda', '2026-05-01T08:00:00Z')`,
      [tenantId, profileId],
    );
    messageId = (
      await pool.query(
        `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token, current_state, current_rank)
         values ($1, $2, 'campaign', $3, $4, 'Temat', '<p>tresc</p>', $5, $6, 'sent', 3) returning id`,
        [tenantId, profileId, storeId, EMAIL, `klik-${techniczny}`, `wypis-${techniczny}`],
      )
    ).rows[0].id;
    await pool.query(
      `insert into clicks (tenant_id, message_id, profile_id, url, occurred_at, user_agent)
       values ($1, $2, $3, 'https://sklep.example/p', '2026-05-12T11:00:00Z', $4)`,
      [tenantId, messageId, profileId, `Mozilla/5.0 (${NAZWISKO})`],
    );
    await pool.query(
      `insert into message_engagement (tenant_id, message_id, source_type, source_id, kind, source, automat, automat_powod, url, ip, user_agent, occurred_at)
       values ($1, $2, 'campaign', $3, 'click', 'wlasne', false, 'brak_przeslanek', 'https://sklep.example/p', '203.0.113.42', $4, '2026-05-12T11:00:00Z'),
              ($1, $2, 'campaign', $3, 'open', 'wlasne', true, 'apple_mpp', null, '203.0.113.43', $4, '2026-05-12T10:30:00Z')`,
      [tenantId, messageId, storeId, `Mozilla/5.0 (${NAZWISKO})`],
    );
    await pool.query(
      `insert into message_events (tenant_id, message_id, event_type, occurred_at, provider_reason)
       values ($1, $2, 'failed', '2026-05-12T10:05:00Z', $3)`,
      [tenantId, messageId, `550 5.1.1 <${EMAIL}>: user unknown`],
    );
    await pool.query(
      `insert into bounce_reports (tenant_id, imap_uidvalidity, imap_uid, kind, outcome, received_at, recipient, subject, matched_message_id, matched_by)
       values ($1, 1, $4, 'dsn', 'test', now(), $2, $3, $5, 'message_id')`,
      [tenantId, EMAIL, `Undelivered: ${EMAIL}`, Math.floor(Math.random() * 1e9), messageId],
    );
    const jobImportu = (
      await pool.query(
        `insert into import_jobs (tenant_id, file_name, file_size, sample) values ($1, 'klaviyo.csv', 10, $2) returning id`,
        [tenantId, JSON.stringify([["Email", "Last Name"], ["inny@example.test", "Obcy"], [EMAIL, NAZWISKO]])],
      )
    ).rows[0].id;
    await pool.query(
      `insert into import_job_errors (tenant_id, job_id, file, line_no, reason, email) values ($1, $2, 'profiles', 7, 'zly wiersz', $3)`,
      [tenantId, jobImportu, EMAIL],
    );
    await pool.query(
      `insert into tenant_suppressions (tenant_id, email, action, reason, actor) values ($1, $2, 'suppressed', 'wypis z linku', 'system')`,
      [tenantId, EMAIL],
    );
    await pool.query(`insert into suppressions (email, reason) values ($1, 'hard_bounce')`, [EMAIL]);
    const lista = (await pool.query("insert into lists (tenant_id, name) values ($1, $2) returning id", [tenantId, `Lista ${techniczny}`])).rows[0].id;
    await pool.query("insert into list_members (tenant_id, list_id, profile_id) values ($1, $2, $3)", [tenantId, lista, profileId]);
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from suppressions where email = $1 or email_hash = $2", [EMAIL, hashAdresu(EMAIL)]);
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  it("przed anonimizacja dane osoby siedza w KAZDEJ tabeli, do ktorej kod pisze adres (sanity: test ma co sprawdzac)", async () => {
    const tabele = (await trafieniaWCalejBazie(EMAIL)).map((t) => t.tabela).sort();
    // pelna lista, nie arrayContaining: nowa tabela z adresem ma tu wypasc jako roznica
    expect(tabele).toEqual(
      [
        "bounce_reports",
        "import_job_errors",
        "import_jobs",
        "message_events",
        "messages",
        "orders",
        "profiles",
        "raw_events",
        "suppressions",
        "tenant_suppressions",
      ].sort(),
    );
    const poNazwisku = (await trafieniaWCalejBazie(NAZWISKO)).map((t) => t.tabela).sort();
    expect(poNazwisku).toEqual(["clicks", "import_jobs", "message_engagement", "orders", "profiles", "raw_events"].sort());
  });

  it("powod zadania nie moze niesc adresu ani telefonu - to pole zostaje w logu", async () => {
    expect(sprawdzPowodRodo(`mail od ${EMAIL} z 24.09`)).toMatch(/adresu e-mail/);
    expect(sprawdzPowodRodo("dzwonila z +48 600 700 800")).toMatch(/telefonu/);
    expect(sprawdzPowodRodo("zgloszenie z formularza, ticket 4412")).toBeNull();
    await expect(anonimizujProfil(tenantId, profileId, { aktor: "x", powod: `prosba ${EMAIL}` })).rejects.toThrow(/adresu e-mail/);
  });

  it("eksport wydaje surowe zdarzenia, zaangazowanie z IP i wykluczenia", async () => {
    const dane = await eksportujProfil(tenantId, profileId);
    expect(dane).not.toBeNull();
    expect(dane!.suroweZdarzenia).toHaveLength(2);
    expect(JSON.stringify(dane!.suroweZdarzenia)).toContain(`Kwiatowa ${znacznik}`);
    expect(dane!.zaangazowanie).toHaveLength(2);
    expect((dane!.zaangazowanie[0] as { ip: string }).ip).toMatch(/^203\.0\.113\./);
    expect(dane!.wykluczenia.sklepu).toHaveLength(1);
    expect(dane!.wykluczenia.globalne).toHaveLength(1);
    expect(dane!.klikniecia).toHaveLength(1);
    expect(dane!.odbicia).toHaveLength(1);
    expect(dane!.bledyImportu).toHaveLength(1);
    expect((dane!.profil as { properties: { miasto: string } }).properties.miasto).toBe(`Miasto ${znacznik}`);
    expect(JSON.stringify(dane!.wiadomosci)).toContain("user unknown");
  });

  it("po anonimizacji: zero trafien w calej bazie poza logiem RODO, przychod zostaje", async () => {
    const pool = getPool();
    const wynik = await anonimizujProfil(tenantId, profileId, { aktor: "operator@midrev.pl", powod: "mail z 24.09" });
    expect(wynik).not.toBeNull();
    expect(wynik!.zamowien).toBe(1);
    expect(wynik!.przychodMinor).toBe("24900");
    expect(wynik!.suroweZdarzenia).toBe(2);
    expect(wynik!.zaangazowanie).toBe(2);
    expect(wynik!.wykluczeniaSklepu).toBe(1);
    expect(wynik!.wykluczeniaGlobalne).toBe(1);
    expect(wynik!.odpowiedziDostawcy).toBe(1);
    expect(wynik!.odbicia).toBe(1);
    expect(wynik!.bledyImportu).toBe(1);
    expect(wynik!.probkiImportu).toBeGreaterThanOrEqual(1);
    // probka importu traci WYLACZNIE wiersz tej osoby; naglowek i cudzy wiersz zostaja
    const { rows: [probka] } = await getPool().query("select sample from import_jobs where tenant_id = $1", [tenantId]);
    expect(probka.sample).toEqual([["Email", "Last Name"], ["inny@example.test", "Obcy"]]);
    expect(wynik!.zgodyWycofane).toBe(1);
    expect(wynik!.usunieteZList).toBe(1);
    expect(wynik!.danePozostaly).toBe(false);

    for (const fraza of [EMAIL, NAZWISKO, IMIE, znacznik]) {
      const trafienia = await trafieniaWCalejBazie(fraza);
      expect(trafienia, `fraza "${fraza}" dalej w bazie`).toEqual([]);
    }

    // surowe zdarzenie zamowienia zachowuje id i kwote do raportow, klient tylko id
    const { rows: surowe } = await pool.query(
      "select idempotency_key, payload from raw_events where tenant_id = $1 order by idempotency_key",
      [tenantId],
    );
    expect(surowe.find((r) => r.idempotency_key.includes(":order:"))!.payload).toEqual({ anonimizowano: true, order_id: "4242", total: "249.00" });
    expect(surowe.find((r) => r.idempotency_key.includes(":customer:"))!.payload).toEqual({ anonimizowano: true, customer_id: "77" });

    // zaangazowanie: werdykt zostaje (statystyka), IP i UA znikaja
    const { rows: zaang } = await pool.query("select automat, ip, user_agent from message_engagement where tenant_id = $1 and message_id = $2", [tenantId, messageId]);
    expect(zaang).toHaveLength(2);
    expect(zaang.every((z) => z.ip === null && z.user_agent === null)).toBe(true);
    expect(zaang.some((z) => z.automat === true)).toBe(true);

    // przychod tenanta bez zmian
    const { rows: [suma] } = await pool.query("select coalesce(sum(total_minor), 0)::text as suma from orders where tenant_id = $1", [tenantId]);
    expect(suma.suma).toBe("24900");

    // log RODO: kto, na czyje zadanie, i ze usunieto wpis z globalnej listy (powod bez adresu)
    const { rows: log } = await pool.query(
      "select payload from events where tenant_id = $1 and profile_id = $2 and event_type = 'rodo.anonimizacja'",
      [tenantId, profileId],
    );
    expect(log).toHaveLength(1);
    expect(log[0].payload.aktor).toBe("operator@midrev.pl");
    expect(log[0].payload.zamaskowaneWykluczeniaGlobalne).toEqual([{ powod: "hard_bounce" }]);
    // nagrobek: hasz adresu + id konta w sklepie z surowych zdarzen customer.*
    const { rows: nagrobki } = await pool.query("select store_id, external_customer_ids from rodo_nagrobki where tenant_id = $1 and email_hash = $2", [tenantId, hashAdresu(EMAIL)]);
    expect(nagrobki).toHaveLength(1);
    expect(nagrobki[0].store_id).toBe(storeId);
    expect(nagrobki[0].external_customer_ids).toEqual(["77"]);
    // profil.properties wyzerowane, surowe zdarzenia z process_error
    const { rows: [prof] } = await pool.query("select properties from profiles where id = $1", [profileId]);
    expect(prof.properties).toEqual({});

    // globalne wykluczenie ZOSTAJE, bez adresu, z haszem
    const { rows: globalne } = await pool.query("select email, email_hash, reason from suppressions where email_hash = $1", [hashAdresu(EMAIL)]);
    expect(globalne).toHaveLength(1);
    expect(globalne[0].email).toBe(`anonimizowano:${hashAdresu(EMAIL).slice(0, 16)}`);
    expect(globalne[0].reason).toBe("hard_bounce");
  });

  it("anonimizacja NIE odwraca sie: customer.updated, order.updated i ponowny import po nagrobku nie odtwarzaja osoby", async () => {
    const pool = getPool();
    // webhook customer.updated z tym samym adresem i id konta 77 (sklep dalej ma konto)
    const { rows: [rc] } = await pool.query(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload) values ($1, $2, 'woocommerce', $3, $4) returning id`,
      [tenantId, storeId, `woocommerce:${tenantId}:customer:77:2026-09-24T12:00:00`,
       JSON.stringify({ id: 77, email: EMAIL, first_name: IMIE, last_name: NAZWISKO, date_created_gmt: "2026-05-01T08:00:00", date_modified_gmt: "2026-09-24T12:00:00", billing: { phone: TELEFON } })],
    );
    await przetworzZdarzenie(tenantId, rc.id);
    // order.updated z nowsza wersja, z pelnym adresem dostawy
    const { rows: [ro] } = await pool.query(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload) values ($1, $2, 'woocommerce', $3, $4) returning id`,
      [tenantId, storeId, `woocommerce:${tenantId}:order:4242:2026-09-24T12:30:00`,
       JSON.stringify({ id: 4242, status: "completed", total: "249.00", currency: "PLN", date_created_gmt: "2026-05-10T09:00:00", date_modified_gmt: "2026-09-24T12:30:00",
         billing: { first_name: IMIE, last_name: NAZWISKO, email: EMAIL, phone: TELEFON, address_1: `Kwiatowa ${znacznik}` } })],
    );
    await przetworzZdarzenie(tenantId, ro.id);
    // ponowny import /customers (ta sama funkcja, ktorej uzywa import)
    const klient = await pool.connect();
    try {
      await klient.query("begin");
      const w = await upsertProfilKlienta(klient, tenantId, mapujKlientaWoo({ id: 77, email: EMAIL.toUpperCase(), first_name: IMIE, last_name: NAZWISKO, date_created_gmt: "2026-05-01T08:00:00", date_modified_gmt: null }), storeId);
      expect(w).toEqual({ nagrobek: true });
      // konto o INNYM id, ale z tym samym adresem tez trafia w nagrobek (po haszu)
      const w2 = await upsertProfilKlienta(klient, tenantId, mapujKlientaWoo({ id: 9999, email: EMAIL, first_name: IMIE, date_created_gmt: "2026-09-01T08:00:00", date_modified_gmt: null }), storeId);
      expect(w2).toEqual({ nagrobek: true });
      await klient.query("commit");
    } finally {
      klient.release();
    }

    const { rows: profile } = await pool.query("select id from profiles where tenant_id = $1 and email is not null", [tenantId]);
    expect(profile).toHaveLength(0);
    const { rows: [zam] } = await pool.query("select status, raw, profile_id from orders where tenant_id = $1 and external_id = '4242'", [tenantId]);
    expect(zam.status).toBe("completed"); // przychod i status dalej sie aktualizuja
    expect(zam.raw).toEqual({ zanonimizowane: true });
    for (const fraza of [EMAIL, NAZWISKO, IMIE, znacznik]) {
      expect(await trafieniaWCalejBazie(fraza), `fraza "${fraza}" wrocila do bazy`).toEqual([]);
    }
    const { rows: surowe } = await pool.query("select processed_at, process_error from raw_events where id in ($1, $2)", [rc.id, ro.id]);
    expect(surowe.every((r) => r.processed_at !== null && r.process_error === "rodo:nagrobek")).toBe(true);
  });

  it("drugie zadanie RODO na ten sam adres (nowe odbicie po pierwszej anonimizacji) nie wywraca sie na unikalnosci", async () => {
    const pool = getPool();
    // kolejne odbicie dopisalo jawny wiersz obok zaslepki z haszem
    await pool.query("insert into suppressions (email, reason) values ($1, 'hard_bounce') on conflict do nothing", [EMAIL]);
    const tenantB = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "B"])).rows[0].id;
    const profilB = (await pool.query("insert into profiles (tenant_id, email, last_name) values ($1, $2, $3) returning id", [tenantB, EMAIL, NAZWISKO])).rows[0].id;
    const wynik = await anonimizujProfil(tenantB, profilB, { aktor: "x", powod: null });
    expect(wynik!.wykluczeniaGlobalne).toBe(2); // zaslepka zastana + jawny duplikat usuniety
    const { rows } = await pool.query("select email from suppressions where email_hash = $1 or lower(btrim(email)) = $2", [hashAdresu(EMAIL), EMAIL]);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toMatch(/^anonimizowano:/);
  });

  it("po powrocie tej samej osoby z nowa zgoda wysylka na odbity adres jest ZABLOKOWANA", async () => {
    const pool = getPool();
    // "ponowny import ze zgoda": nowy profil z tym samym adresem (inna wielkosc liter), zgoda granted
    const nowy = (
      await pool.query("insert into profiles (tenant_id, email, first_name) values ($1, $2, 'Powrot') returning id", [tenantId, EMAIL.toUpperCase()])
    ).rows[0].id;
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email', 'granted', 'import:klaviyo', now())`,
      [tenantId, nowy],
    );
    const bramka = await canSendTo(pool, tenantId, nowy);
    expect(bramka).toEqual({ wolno: false, powod: "wykluczenie_globalne" });

    // a inny adres z ta sama zgoda przechodzi - blokada jest po haszu TEGO adresu, nie globalnie
    const inny = (
      await pool.query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantId, `inny-${znacznik}@example.test`])
    ).rows[0].id;
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email', 'granted', 'import:klaviyo', now())`,
      [tenantId, inny],
    );
    expect((await canSendTo(pool, tenantId, inny)).wolno).toBe(true);

    // grep po adresie dalej zero trafien (nowy profil wlasnie dodany - wylaczamy go z porownania przez usuniecie)
    await pool.query("delete from profiles where id in ($1, $2)", [nowy, inny]);
    expect(await trafieniaWCalejBazie(EMAIL)).toEqual([]);
  });

  it("nie rusza osoby o tym samym nazwisku w innym tenancie", async () => {
    const pool = getPool();
    const obcy = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "Obcy"])).rows[0].id;
    const obcyEmail = `obcy-${znacznik}@example.test`;
    const obcyProfil = (
      await pool.query("insert into profiles (tenant_id, email, first_name, last_name) values ($1, $2, 'Obca', $3) returning id", [obcy, obcyEmail, NAZWISKO])
    ).rows[0].id;
    await pool.query(
      `insert into raw_events (tenant_id, source, idempotency_key, payload, processed_at)
       values ($1, 'woocommerce', $2, $3, now())`,
      [obcy, `woocommerce:${obcy}:customer:1:v`, JSON.stringify({ id: 1, email: obcyEmail, last_name: NAZWISKO })],
    );
    // anonimizacja cudzym tenantem = null i zero zmian
    expect(await anonimizujProfil(tenantId, obcyProfil, { aktor: "x", powod: null })).toBeNull();
    const { rows } = await pool.query("select payload from raw_events where tenant_id = $1", [obcy]);
    expect(rows[0].payload.last_name).toBe(NAZWISKO);
  });
});
