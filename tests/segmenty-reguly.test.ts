import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { utworzSegment } from "../src/adapters/db/repozytoria";
import { policzSegment, profileSegmentu, skompiluj } from "../src/adapters/db/segmenty";
import { opiszRegule, parsujReguly, TYPY_REGUL } from "../src/domain/segmenty";

// Audyt #12 / S2: nieznany typ reguly tworzyl regule ignorowana przez kompilator,
// czyli segment bez warunkow = cala baza tenanta. Tu: walidacja rzuca, kompilator rzuca,
// a nowe reguly mailowe licza sie na `clicks` (kliknieciach uznanych za ludzkie).

const PREFIKS = "SEGMENTY REGULY ";

describe("Walidacja regul", () => {
  it("nieznany typ jest bledem z nazwa, nie regula do zignorowania", () => {
    expect(() => parsujReguly([{ typ: "kupil_w_ostatnich_dniach", dni: 30 }])).toThrow(/Nieznany typ reguły segmentu: "kupil_w_ostatnich_dniach"/);
    expect(() => parsujReguly([{ typ: "kupil_w_ostatnich", dni: 30 }, { typ: "", dni: 1 }])).toThrow(/Nieznany typ/);
    expect(() => parsujReguly([{ dni: 30 }])).toThrow(/Nieznany typ/);
  });

  it("pusta lista i zle wartosci tez sa bledem", () => {
    expect(() => parsujReguly([])).toThrow(/co najmniej jedną regułę/);
    expect(() => parsujReguly("nie lista")).toThrow(/co najmniej jedną regułę/);
    expect(() => parsujReguly([{ typ: "kupil_w_ostatnich", dni: 0 }])).toThrow(/"kupil_w_ostatnich": dni/);
    expect(() => parsujReguly([{ typ: "kupil_w_ostatnich", dni: "30" }])).toThrow(/dni/);
    expect(() => parsujReguly([{ typ: "ma_zgode", kanal: "fax" }])).toThrow(/"ma_zgode": kanal/);
  });

  it("poprawne reguly przechodza i maja opis po polsku", () => {
    const reguly = parsujReguly([
      { typ: "kupil_w_ostatnich", dni: 90 },
      { typ: "kliknal_w_ostatnich", dni: 30 },
      { typ: "nie_kliknal_od", dni: 180 },
      { typ: "ma_zgode", kanal: "email" },
    ]);
    expect(reguly).toHaveLength(4);
    expect(reguly.map(opiszRegule)).toEqual([
      "kupił w ostatnich 90 dniach",
      "kliknął w mailu w ostatnich 30 dniach",
      "dostał od nas maila co najmniej 180 dni temu i od tego czasu nie kliknął",
      "ma zgodę na e-mail",
    ]);
    expect(TYPY_REGUL).toContain("kliknal_w_ostatnich");
    expect(TYPY_REGUL).toContain("nie_kliknal_od");
  });

  it("kompilator rzuca przy nieznanym typie i przy pustej liscie zamiast oddac pusty warunek", () => {
    expect(() => skompiluj([{ typ: "literowka", dni: 1 }], "t")).toThrow(/Nieznany typ/);
    expect(() => skompiluj([], "t")).toThrow(/całą bazę/);
  });
});

describe("Reguly mailowe na bazie", () => {
  let tenantId = "";
  let obcyTenant = "";
  const profile: Record<string, string> = {};

  /** dniTemu = klik; wiadomosc wyslana dzien wczesniej. dniTemu null + wiadomoscDniTemu = dostal, nie kliknal. */
  async function profilZKlikiem(tenant: string, nazwa: string, dniTemu: number | null, zgoda: boolean, wiadomoscDniTemu?: number) {
    const pool = getPool();
    const id = (
      await pool.query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenant, `${nazwa}-${tenant.slice(0, 8)}@example.test`])
    ).rows[0].id;
    if (zgoda) {
      await pool.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email', 'granted', 'test', now() - interval '400 days')`,
        [tenant, id],
      );
    }
    const dniWiadomosci = wiadomoscDniTemu ?? (dniTemu !== null ? dniTemu + 1 : null);
    if (dniWiadomosci !== null) {
      const wiadomosc = (
        await pool.query(
          `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token, created_at)
           values ($1, $2, 'campaign', $3, 'x@example.test', 't', '<p/>', $4, $5, now() - make_interval(days => $6::int)) returning id`,
          [tenant, id, tenant, `k-${nazwa}-${tenant}`, `u-${nazwa}-${tenant}`, dniWiadomosci],
        )
      ).rows[0].id;
      if (dniTemu !== null) await pool.query(
        `insert into clicks (tenant_id, message_id, profile_id, url, occurred_at) values ($1, $2, $3, 'https://x', now() - make_interval(days => $4::int))`,
        [tenant, wiadomosc, id, dniTemu],
      );
    }
    return id as string;
  }

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"])).rows[0].id;
    obcyTenant = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "Obcy"])).rows[0].id;
    profile.swiezy = await profilZKlikiem(tenantId, "swiezy", 2, true);
    profile.dawny = await profilZKlikiem(tenantId, "dawny", 100, true);
    profile.nigdy = await profilZKlikiem(tenantId, "nigdy", null, false);
    // dostal maila 200 dni temu, nigdy nie kliknal, ma zgode: kandydat do sunsetu
    profile.dostal = await profilZKlikiem(tenantId, "dostal", null, true, 200);
    profile.obcy = await profilZKlikiem(obcyTenant, "obcy", 1, true);
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  it("kliknal_w_ostatnich N dni trafia tylko w swiezy klik, nie_kliknal_od w reszte", async () => {
    const kliknal = await profileSegmentu(tenantId, [{ typ: "kliknal_w_ostatnich", dni: 30 }], 100);
    expect(kliknal.map((p) => p.id)).toEqual([profile.swiezy]);

    // "nie kliknal od N dni" = dostal maila co najmniej N dni temu i od tej pory nie kliknal;
    // profil, do ktorego nic nie poszlo ("nigdy"), NIE jest nieaktywny - nie mial w co kliknac
    const nieKliknal = await profileSegmentu(tenantId, [{ typ: "nie_kliknal_od", dni: 30 }], 100);
    expect(new Set(nieKliknal.map((p) => p.id))).toEqual(new Set([profile.dawny, profile.dostal]));

    const sunset = await profileSegmentu(tenantId, [{ typ: "nie_kliknal_od", dni: 30 }, { typ: "ma_zgode", kanal: "email" }], 100);
    expect(new Set(sunset.map((p) => p.id))).toEqual(new Set([profile.dawny, profile.dostal]));
    expect(await policzSegment(tenantId, [{ typ: "nie_kliknal_od", dni: 30 }])).toBe(2);
    // dostal maila dopiero wczoraj: za wczesnie na sunset 30-dniowy
    expect(await policzSegment(tenantId, [{ typ: "nie_kliknal_od", dni: 250 }])).toBe(0);
  });

  it("klik z innego tenanta nie liczy sie, a limit idzie parametrem", async () => {
    // obcy tenant ma jeden profil z klikiem wczoraj: w tenancie A nie ma go w ogole
    const wA = await profileSegmentu(tenantId, [{ typ: "kliknal_w_ostatnich", dni: 30 }], 100);
    expect(wA.map((p) => p.id)).not.toContain(profile.obcy);
    expect(await policzSegment(obcyTenant, [{ typ: "kliknal_w_ostatnich", dni: 30 }])).toBe(1);
    const ograniczone = await profileSegmentu(tenantId, [{ typ: "nie_kliknal_od", dni: 30 }], 1);
    expect(ograniczone).toHaveLength(1);
  });

  it("zapis segmentu waliduje reguly i odrzuca duplikat nazwy", async () => {
    await expect(utworzSegment(tenantId, "Zly", [{ typ: "kupil_w_ostatnich", dni: null }])).rejects.toThrow(/"kupil_w_ostatnich": dni/);
    await expect(utworzSegment(tenantId, "Zly", [{ typ: "literowka", dni: 3 }])).rejects.toThrow(/Nieznany typ/);
    const id = await utworzSegment(tenantId, "Dobry", [{ typ: "kupil_w_ostatnich", dni: 30 }]);
    expect(id).toBeTruthy();
    // duplikat nazwy NIE podmienia regul segmentu, na ktory moga wskazywac kampanie
    await expect(utworzSegment(tenantId, "Dobry", [{ typ: "nie_kupil_od", dni: 1 }])).rejects.toThrow(/już istnieje/);
    const { rows } = await getPool().query("select rules from segments where tenant_id = $1 and name = 'Dobry'", [tenantId]);
    expect(rows[0].rules).toEqual([{ typ: "kupil_w_ostatnich", dni: 30 }]);
  });

  it("segment z nieznanym typem NIE obejmuje calej bazy - liczenie rzuca", async () => {
    await expect(policzSegment(tenantId, [{ typ: "wszyscy", dni: 1 }])).rejects.toThrow(/Nieznany typ/);
    await expect(profileSegmentu(tenantId, [{ typ: "wszyscy", dni: 1 }])).rejects.toThrow(/Nieznany typ/);
  });
});
