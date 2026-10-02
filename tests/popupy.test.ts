import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import {
  przyjmijZgloszenie,
  schematZgloszenia,
} from "../src/usecases/popupy/zglos-popup";
import { aktywnyPopup, domyslnaKlauzula, popupyTenanta, ustawAktywnosc, utworzPopup } from "../src/usecases/popupy/zarzadzaj";

// Wykonywalna specyfikacja Epiku F: zgloszenie z popupu to profil + zgoda + event,
// bez wlasnej tabeli zgloszen. Baza jest prawdziwa (AD-20), a kazdy scenariusz
// cross-tenantowy jest tu obowiazkowy (AD-2), bo endpoint jest publiczny.

describe("Popupy (Epik F)", () => {
  let tenantA: string;
  let tenantB: string;
  let popupA: string;
  let popupB: string;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'POP %'");
    const a = await pool.query("insert into tenants (name) values ('POP tenant A') returning id");
    const b = await pool.query("insert into tenants (name) values ('POP tenant B') returning id");
    tenantA = a.rows[0].id;
    tenantB = b.rows[0].id;

    popupA = await utworzPopup(tenantA, {
      name: "POP powitalny",
      headline: "-10% na start",
      bodyText: "Zostaw adres, wyslemy kod.",
      buttonText: "Odbieram",
      discountCode: "POP10",
      delaySeconds: 3,
    });
    popupB = await utworzPopup(tenantB, {
      name: "POP cudzy",
      headline: "Inny sklep",
      bodyText: "Inna tresc.",
      buttonText: "Zapisz",
      discountCode: null,
      delaySeconds: 0,
    });
    await ustawAktywnosc(tenantA, popupA, true);
    await ustawAktywnosc(tenantB, popupB, true);
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'POP %'");
    await closePool();
  });

  it("zgłoszenie tworzy profil, zgodę ze źródłem popup i event popup.submitted", async () => {
    const pool = getPool();
    const wynik = await przyjmijZgloszenie(popupA, {
      zgoda: true, wersjaKlauzuli: 1, email: "pop-lead@example.test",
      imie: "Ala",
    });
    expect(wynik).not.toBeNull();
    expect(wynik!.discountCode).toBe("POP10");

    const { rows: profile } = await pool.query(
      "select id, first_name from profiles where tenant_id = $1 and email = 'pop-lead@example.test'",
      [tenantA],
    );
    expect(profile).toHaveLength(1);
    expect(profile[0].first_name).toBe("Ala");

    const { rows: zgody } = await pool.query(
      `select state, source, wording, occurred_at from consents
        where tenant_id = $1 and profile_id = $2 and channel = 'email'`,
      [tenantA, profile[0].id],
    );
    expect(zgody).toHaveLength(1);
    expect(zgody[0].state).toBe("granted");
    expect(zgody[0].source).toBe("popup:POP powitalny");
    // dowod = tekst klauzuli, ktora popup pokazuje (0041), z polskimi znakami
    expect(zgody[0].wording).toBe(domyslnaKlauzula("POP tenant A"));
    // occurred_at = teraz, bo to zdarzenie na zywo, nie import historii (AD-10)
    expect(Date.now() - new Date(zgody[0].occurred_at).getTime()).toBeLessThan(60_000);

    const { rows: zdarzenia } = await pool.query(
      `select payload, occurred_at from events
        where tenant_id = $1 and profile_id = $2 and event_type = 'popup.submitted'`,
      [tenantA, profile[0].id],
    );
    expect(zdarzenia).toHaveLength(1);
    expect(zdarzenia[0].payload.popup_id).toBe(popupA);
    expect(zdarzenia[0].occurred_at).not.toBeNull();
  });

  it("drugi zapis tego samego adresu nie duplikuje profilu, ale dopisuje event", async () => {
    const pool = getPool();
    // ten sam adres w innym zapisie: wielkosc liter i spacje nie tworza drugiej osoby
    const wynik = await przyjmijZgloszenie(popupA, { zgoda: true, wersjaKlauzuli: 1, email: "  POP-Lead@Example.test " });
    expect(wynik).not.toBeNull();

    const { rows: profile } = await pool.query(
      "select id from profiles where tenant_id = $1 and lower(btrim(email)) = 'pop-lead@example.test'",
      [tenantA],
    );
    expect(profile).toHaveLength(1);

    const { rows: zdarzenia } = await pool.query(
      `select count(*)::int as ile from events
        where tenant_id = $1 and event_type = 'popup.submitted'
          and payload->>'popup_id' = $2`,
      [tenantA, popupA],
    );
    expect(zdarzenia[0].ile).toBe(2);

    // zgoda jest append-only (AD-16): drugi zapis to drugi wpis w historii, nie nadpisanie
    const { rows: zgody } = await pool.query(
      "select count(*)::int as ile from consents where tenant_id = $1 and profile_id = $2",
      [tenantA, profile[0].id],
    );
    expect(zgody[0].ile).toBe(2);

    // licznik zgloszen w panelu liczy zdarzenia, nie profile
    const lista = await popupyTenanta(tenantA);
    expect(lista.find((p) => p.id === popupA)?.zgloszen).toBe(2);
  });

  it("walidacja odrzuca zły e-mail, zanim cokolwiek dotknie bazy", () => {
    expect(schematZgloszenia.safeParse({ email: "nie-email" }).success).toBe(false);
    expect(schematZgloszenia.safeParse({ email: "" }).success).toBe(false);
    expect(schematZgloszenia.safeParse({}).success).toBe(false);
    expect(schematZgloszenia.safeParse({ email: "a@b.test", imie: "x".repeat(500) }).success).toBe(
      false,
    );
    expect(schematZgloszenia.safeParse({ email: "ok@example.test" }).success).toBe(false);
    expect(schematZgloszenia.safeParse({ email: "ok@example.test", zgoda: false, wersjaKlauzuli: 1 }).success).toBe(false);
    expect(schematZgloszenia.safeParse({ email: "ok@example.test", zgoda: true, wersjaKlauzuli: 1 }).success).toBe(true);
  });

  it("zgłoszenie do popupu innego tenanta nie miesza danych między tenantami", async () => {
    const pool = getPool();
    // ten sam adres co u tenanta A, ale popup nalezy do tenanta B
    const wynik = await przyjmijZgloszenie(popupB, { zgoda: true, wersjaKlauzuli: 1, email: "pop-lead@example.test" });
    expect(wynik).not.toBeNull();
    expect(wynik!.discountCode).toBeNull();

    // u tenanta B powstal WLASNY profil z tym adresem, a nie odwolanie do profilu A
    const { rows: profileB } = await pool.query(
      "select id from profiles where tenant_id = $1 and email = 'pop-lead@example.test'",
      [tenantB],
    );
    expect(profileB).toHaveLength(1);

    // u tenanta A nadal jeden profil i nadal dwa zgloszenia; nic nie doszlo
    const { rows: profileA } = await pool.query(
      "select count(*)::int as ile from profiles where tenant_id = $1",
      [tenantA],
    );
    expect(profileA[0].ile).toBe(1);
    const listaA = await popupyTenanta(tenantA);
    expect(listaA.find((p) => p.id === popupA)?.zgloszen).toBe(2);

    // zgoda tenanta B wskazuje zrodlo JEGO popupu i JEGO profil
    const { rows: zgodyB } = await pool.query(
      "select source from consents where tenant_id = $1 and profile_id = $2",
      [tenantB, profileB[0].id],
    );
    expect(zgodyB).toHaveLength(1);
    expect(zgodyB[0].source).toBe("popup:POP cudzy");
  });

  it("nieistniejący popup daje null zamiast zapisu w ciemno", async () => {
    const wynik = await przyjmijZgloszenie("00000000-0000-7000-8000-000000000000", {
      zgoda: true, wersjaKlauzuli: 1, email: "pop-nikt@example.test",
    });
    expect(wynik).toBeNull();
  });

  it("adres wykluczony nie dostaje nowego wpisu granted, ale odpowiedź tego nie zdradza", async () => {
    const pool = getPool();
    // osoba wypisala sie ze sklepu tenanta A; publiczny POST nie moze jej z powrotem "zapisac"
    await pool.query(
      `insert into tenant_suppressions (tenant_id, email, action, reason)
       values ($1, 'pop-wypisany@example.test', 'suppressed', 'test wypisania')`,
      [tenantA],
    );
    const wynik = await przyjmijZgloszenie(popupA, { zgoda: true, wersjaKlauzuli: 1, email: "pop-wypisany@example.test" });
    // ok jak przy kazdym zgloszeniu: odpowiedz nie moze byc wyrocznia "czy ten adres jest wypisany"
    expect(wynik).not.toBeNull();

    const { rows: profile } = await pool.query(
      "select id from profiles where tenant_id = $1 and email = 'pop-wypisany@example.test'",
      [tenantA],
    );
    expect(profile).toHaveLength(1);
    const { rows: zgody } = await pool.query(
      "select count(*)::int as ile from consents where tenant_id = $1 and profile_id = $2",
      [tenantA, profile[0].id],
    );
    expect(zgody[0].ile).toBe(0);
    // event zostaje: zgloszenie sie wydarzylo, tylko zgoda nie ma prawa powstac
    const { rows: zdarzenia } = await pool.query(
      `select count(*)::int as ile from events
        where tenant_id = $1 and profile_id = $2 and event_type = 'popup.submitted'`,
      [tenantA, profile[0].id],
    );
    expect(zdarzenia[0].ile).toBe(1);

    // to samo dla wykluczenia GLOBALNEGO: adres spalony u innego tenanta
    // nie dostaje zgody nigdzie na platformie
    await pool.query(
      `insert into suppressions (email, reason) values ('pop-spalony@example.test', 'hard bounce')
       on conflict do nothing`,
    );
    try {
      const wynikG = await przyjmijZgloszenie(popupA, { zgoda: true, wersjaKlauzuli: 1, email: "pop-spalony@example.test" });
      expect(wynikG).not.toBeNull();
      const { rows: zgodyG } = await pool.query(
        `select count(*)::int as ile from consents c
          join profiles p on p.tenant_id = c.tenant_id and p.id = c.profile_id
         where c.tenant_id = $1 and p.email = 'pop-spalony@example.test'`,
        [tenantA],
      );
      expect(zgodyG[0].ile).toBe(0);
    } finally {
      // suppressions jest globalna, wiec nie sprzata jej kasowanie tenantow 'POP %'
      await pool.query("delete from suppressions where email = 'pop-spalony@example.test'");
    }
  });

  it("popup wyłączony przestaje przyjmować zgłoszenia", async () => {
    const pool = getPool();
    await ustawAktywnosc(tenantB, popupB, false);
    const wynik = await przyjmijZgloszenie(popupB, { zgoda: true, wersjaKlauzuli: 1, email: "pop-spozniony@example.test" });
    expect(wynik).toBeNull();
    const { rows } = await pool.query(
      "select count(*)::int as ile from profiles where tenant_id = $1 and email = 'pop-spozniony@example.test'",
      [tenantB],
    );
    expect(rows[0].ile).toBe(0);
    await ustawAktywnosc(tenantB, popupB, true);
  });

  it("skrypt on-site dostaje najnowszy WŁĄCZONY popup tenanta", async () => {
    // kazdy tenant widzi wylacznie wlasny popup
    expect((await aktywnyPopup(tenantA))?.id).toBe(popupA);
    expect((await aktywnyPopup(tenantB))?.id).toBe(popupB);
    await ustawAktywnosc(tenantA, popupA, false);
    expect(await aktywnyPopup(tenantA)).toBeNull();
    // przelaczenie cudzym tenantem nie moze niczego wlaczyc ani udawac, ze wlaczylo
    expect(await ustawAktywnosc(tenantB, popupA, true)).toBe(false);
    expect(await aktywnyPopup(tenantA)).toBeNull();
  });
});
