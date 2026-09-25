import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { canSendTo } from "../src/usecases/wysylka/can-send-to";
import { widokProfilu, zanonimizowaneProfile } from "../src/usecases/profil";
import { anonimizujProfil, eksportujProfil } from "../src/usecases/profil-rodo";

// Wykonywalna specyfikacja ekranu profilu i obsługi żądań RODO (FR21, FR22).
// Baza jest prawdziwa (AD-20), nie mock: sprawdzamy stan PO zapisie, bo tylko to
// mówi prawdę o anonimizacji.
//
// Scenariusz cross-tenantowy jest tu obowiązkowy (AD-2): ekran profilu pokazuje
// dane osobowe, a w tym repo był realny wyciek między tenantami.

const PREFIKS = "PROFIL ";

async function zasiejProfil(
  tenantId: string,
  storeId: string,
  dane: { email: string; imie: string; zgoda: boolean },
) {
  const pool = getPool();
  const { rows } = await pool.query(
    `insert into profiles (tenant_id, email, phone, first_name, last_name)
     values ($1, $2, '+48111222333', $3, 'Testowa') returning id`,
    [tenantId, dane.email, dane.imie],
  );
  const profileId = rows[0].id as string;

  await pool.query(
    `insert into orders (tenant_id, store_id, profile_id, external_id, number, status,
                         total_minor, currency, occurred_at, raw)
     values ($1, $2, $3, 'zam-1', '1001', 'completed', 24900, 'PLN', '2026-05-10T09:00:00Z', $4)`,
    [
      tenantId,
      storeId,
      profileId,
      JSON.stringify({ billing: { email: dane.email, address_1: "Kwiatowa 1", phone: "+48111222333" } }),
    ],
  );
  await pool.query(
    `insert into events (tenant_id, profile_id, event_type, payload, occurred_at)
     values ($1, $2, 'popup.submitted', $3, '2026-05-01T08:00:00Z')`,
    [tenantId, profileId, JSON.stringify({ popup_name: "Rabat powitalny" })],
  );
  if (dane.zgoda) {
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, wording, occurred_at)
       values ($1, $2, 'email', 'granted', 'popup:Rabat powitalny', 'Zgoda na newsletter', '2026-05-01T08:00:00Z')`,
      [tenantId, profileId],
    );
  }

  const wiadomosc = await pool.query(
    `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html,
                           click_token, unsubscribe_token, current_state, current_rank)
     values ($1, $2, 'campaign', $3, $4, 'Temat testowy', '<p>tresc</p>', $5, $6, 'sent', 3)
     returning id`,
    [
      tenantId,
      profileId,
      storeId, // dowolny uuid źródła: test nie sprawdza kampanii, tylko historię wysyłek
      dane.email,
      `klik-${profileId}`,
      `wypis-${profileId}`,
    ],
  );
  await pool.query(
    `insert into message_events (tenant_id, message_id, event_type, occurred_at)
     values ($1, $2, 'sent', '2026-05-12T10:00:00Z')`,
    [tenantId, wiadomosc.rows[0].id],
  );
  await pool.query(
    `insert into clicks (tenant_id, message_id, profile_id, url, occurred_at, user_agent)
     values ($1, $2, $3, 'https://sklep.example/produkt', '2026-05-12T11:00:00Z', 'Mozilla/5.0 test')`,
    [tenantId, wiadomosc.rows[0].id, profileId],
  );

  const lista = await pool.query(
    "insert into lists (tenant_id, name) values ($1, $2) returning id",
    [tenantId, `Lista ${profileId.slice(0, 8)}`],
  );
  await pool.query(
    "insert into list_members (tenant_id, list_id, profile_id) values ($1, $2, $3)",
    [tenantId, lista.rows[0].id, profileId],
  );

  return profileId;
}

describe("Profil odbiorcy i żądania RODO", () => {
  let tenantA: string;
  let tenantB: string;
  let profilA: string;
  let profilB: string;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    const a = await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"]);
    const b = await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "B"]);
    tenantA = a.rows[0].id;
    tenantB = b.rows[0].id;

    const sklepA = await pool.query(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
       values ($1, 'woocommerce', 'https://a.example', decode('00', 'hex'), 'connected') returning id`,
      [tenantA],
    );
    const sklepB = await pool.query(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
       values ($1, 'woocommerce', 'https://b.example', decode('00', 'hex'), 'connected') returning id`,
      [tenantB],
    );

    profilA = await zasiejProfil(tenantA, sklepA.rows[0].id, {
      email: "anna.testowa@example.test",
      imie: "Anna",
      zgoda: true,
    });
    profilB = await zasiejProfil(tenantB, sklepB.rows[0].id, {
      email: "cudza.osoba@example.test",
      imie: "Cudza",
      zgoda: true,
    });
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  it("składa widok osoby: zgoda z datą i źródłem, oś czasu, wysyłki, listy", async () => {
    const widok = await widokProfilu(tenantA, profilA);
    expect(widok).not.toBeNull();

    const email = widok!.kanaly.find((k) => k.kanal === "email")!;
    expect(email.stan).toBe("granted");
    expect(email.zrodlo).toBe("popup:Rabat powitalny");
    expect(email.klauzula).toBe("Zgoda na newsletter");
    // SMS nie ma ani jednego wpisu w rejestrze: to brak stanu, nie "wycofana"
    expect(widok!.kanaly.find((k) => k.kanal === "sms")!.stan).toBeNull();

    // jedna oś czasu, nie pięć tabelek: zamówienie, wysyłka, kliknięcie, zgoda, zapis
    const rodzaje = widok!.os.map((z) => z.rodzaj);
    expect(new Set(rodzaje)).toEqual(
      new Set(["zamowienie", "wiadomosc", "klikniecie", "zgoda", "zdarzenie"]),
    );
    // chronologicznie malejąco
    const czasy = widok!.os.map((z) => new Date(z.occurred_at).getTime());
    expect([...czasy].sort((x, y) => y - x)).toEqual(czasy);

    expect(widok!.wysylki).toHaveLength(1);
    expect(widok!.wysylki[0].current_state).toBe("sent");
    expect(widok!.wysylki[0].klikniec).toBe(1);
    expect(widok!.listy).toHaveLength(1);
    expect(widok!.bramka.wolno).toBe(true);
  });

  it("nie pokazuje profilu z innego tenanta", async () => {
    expect(await widokProfilu(tenantB, profilA)).toBeNull();
    expect(await widokProfilu(tenantA, profilB)).toBeNull();
    expect(await eksportujProfil(tenantB, profilA)).toBeNull();
  });

  it("eksport daje komplet danych osoby", async () => {
    const dane = await eksportujProfil(tenantA, profilA);
    expect(dane).not.toBeNull();
    expect((dane!.profil as { email: string }).email).toBe("anna.testowa@example.test");
    expect(dane!.zgody).toHaveLength(1);
    expect(dane!.zamowienia).toHaveLength(1);
    expect(dane!.wiadomosci).toHaveLength(1);
    expect(dane!.klikniecia).toHaveLength(1);
    expect(dane!.listy).toHaveLength(1);
  });

  it("nie anonimizuje profilu z innego tenanta i nie tyka jego danych", async () => {
    const pool = getPool();
    const wynik = await anonimizujProfil(tenantB, profilA, { aktor: "test@midrev.pl", powod: null });
    expect(wynik).toBeNull();
    const { rows } = await pool.query("select email from profiles where id = $1", [profilA]);
    expect(rows[0].email).toBe("anna.testowa@example.test");
  });

  it("usunięcie danych anonimizuje osobę, ale zostawia przychód w raportach", async () => {
    const pool = getPool();
    const przedPrzychod = await pool.query(
      "select coalesce(sum(total_minor), 0)::text as suma from orders where tenant_id = $1",
      [tenantA],
    );

    const wynik = await anonimizujProfil(tenantA, profilA, {
      aktor: "operator@midrev.pl",
      powod: "mail z 22.09.2026",
    });
    expect(wynik).not.toBeNull();
    expect(wynik!.zamowien).toBe(1);
    expect(wynik!.przychodMinor).toBe("24900");
    expect(wynik!.zgodyWycofane).toBe(1);
    expect(wynik!.usunieteZList).toBe(1);

    const { rows: profil } = await pool.query(
      "select email, phone, first_name, last_name from profiles where id = $1",
      [profilA],
    );
    expect(profil[0]).toEqual({ email: null, phone: null, first_name: null, last_name: null });

    // przychód całego tenanta bez zmian - raport finansowy nie może się rozjechać
    const poPrzychod = await pool.query(
      "select coalesce(sum(total_minor), 0)::text as suma from orders where tenant_id = $1",
      [tenantA],
    );
    expect(poPrzychod.rows[0].suma).toBe(przedPrzychod.rows[0].suma);

    // surowy dokument ze sklepu (adres, telefon) wyczyszczony
    const { rows: zamowienia } = await pool.query(
      "select raw from orders where tenant_id = $1 and profile_id = $2",
      [tenantA, profilA],
    );
    expect(zamowienia[0].raw).toEqual({ zanonimizowane: true });

    // historia wysyłki zostaje, ale bez adresu odbiorcy
    const { rows: wiadomosci } = await pool.query(
      "select email, subject from messages where tenant_id = $1 and profile_id = $2",
      [tenantA, profilA],
    );
    expect(wiadomosci).toHaveLength(1);
    expect(wiadomosci[0].email).toBe("usuniety@rodo.invalid");
    expect(wiadomosci[0].subject).toBe("Temat testowy");

    const { rows: klikniecia } = await pool.query(
      "select user_agent from clicks where tenant_id = $1 and profile_id = $2",
      [tenantA, profilA],
    );
    expect(klikniecia[0].user_agent).toBeNull();

    // ślad operacji w logu: kto i na czyje żądanie
    const { rows: log } = await pool.query(
      `select payload from events
        where tenant_id = $1 and profile_id = $2 and event_type = 'rodo.anonimizacja'`,
      [tenantA, profilA],
    );
    expect(log).toHaveLength(1);
    expect(log[0].payload).toEqual({ aktor: "operator@midrev.pl", powod: "mail z 22.09.2026" });

    // rejestr zgód zostaje jako dowód, ale stan jest już "wycofana", więc bramka
    // wysyłki nie wpuści tej osoby do żadnej kampanii
    const bramka = await canSendTo(pool, tenantA, profilA);
    expect(bramka.wolno).toBe(false);

    expect((await zanonimizowaneProfile(tenantA)).has(profilA)).toBe(true);
  });
});
