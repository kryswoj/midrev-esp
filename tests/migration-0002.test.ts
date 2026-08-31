import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, closePool } from "../src/adapters/db/pool";

// Wykonywalna specyfikacja Story 1.1 (Epik 1).
// Kazdy test odpowiada kryterium akceptacji i kazdy PRZED migracja 0002 zachowywalby sie
// inaczej. To jest sedno: 0001 przepuszczalo zapis bez daty zdarzenia, a testy tego nie
// widzialy, bo baza po cichu podstawiala date importu.
//
// Daty w testach sa STALE, nie `now()`. Test uzywajacy `now()` do zapisu daty zdarzenia
// utrwala dokladnie ten nawyk, ktory kiedys sfalszowal raporty przychodu.

const DATA_ZDARZENIA = "2025-07-23T12:40:12.000Z";
const TABELE_Z_UUIDV7 = ["tenants", "profiles", "events", "suppressions", "stores", "raw_events", "jobs"];

describe("Migracja 0002: fundament", () => {
  let tenantId: string;
  let innyTenantId: string;
  let storeId: string;

  beforeAll(async () => {
    const pool = getPool();
    // Sprzatamy wylacznie po sobie: globalny "delete from tenants" kasowal dane innego
    // pliku testowego. Kaskada kluczy obcych sprzata profile, zdarzenia, sklepy i zadania.
    await pool.query("delete from tenants where name like 'M0002 %'");

    const t = await pool.query(
      "insert into tenants (name) values ($1), ($2) returning id",
      ["M0002 tenant glowny", "M0002 tenant obcy"],
    );
    tenantId = t.rows[0].id;
    innyTenantId = t.rows[1].id;

    const s = await pool.query(
      `insert into stores (tenant_id, platform, base_url, credentials_encrypted)
       values ($1, $2, $3, $4) returning id`,
      [tenantId, "woocommerce", "http://localhost:8091", Buffer.from("szyfrogram")],
    );
    storeId = s.rows[0].id;
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'M0002 %'");
    await closePool();
  });

  describe("data zdarzenia pochodzi ze zrodla (AD-10, NFR3)", () => {
    it("odrzuca zapis zdarzenia bez jawnej daty", async () => {
      const pool = getPool();
      await expect(
        pool.query("insert into events (tenant_id, event_type) values ($1, $2)", [
          tenantId,
          "order_placed",
        ]),
      ).rejects.toThrow(/occurred_at/);
    });

    it("zapisuje date historyczna dokladnie taka, jaka podano, i osobno date zapisu", async () => {
      const pool = getPool();
      const wynik = await pool.query(
        `insert into events (tenant_id, event_type, occurred_at)
         values ($1, $2, $3) returning occurred_at, recorded_at`,
        [tenantId, "order_placed", DATA_ZDARZENIA],
      );
      // odczyt zwrotny zapisanego rekordu, nie zaufanie do tego, co wyslalismy (NFR1)
      expect(new Date(wynik.rows[0].occurred_at).toISOString()).toBe(DATA_ZDARZENIA);
      // data zapisu to dzis, czyli obie daty realnie sie roznia i da sie je rozroznic
      const roznica = Date.now() - new Date(wynik.rows[0].recorded_at).getTime();
      expect(roznica).toBeLessThan(60_000);
    });
  });

  describe("klucze glowne w UUID v7 (AD-15)", () => {
    it.each(TABELE_Z_UUIDV7)("tabela %s ma domyslny klucz uuidv7()", async (tabela) => {
      const pool = getPool();
      const wynik = await pool.query(
        `select pg_get_expr(d.adbin, d.adrelid) as domyslna
           from pg_attrdef d
           join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
          where d.adrelid = $1::regclass and a.attname = 'id'`,
        [tabela],
      );
      expect(wynik.rows[0]?.domyslna).toContain("uuidv7()");
    });

    it("nadaje identyfikator faktycznie w wersji 7, sprawdzony przez baze", async () => {
      const pool = getPool();
      const wynik = await pool.query(
        `insert into profiles (tenant_id, email) values ($1, $2)
         returning uuid_extract_version(id) as wersja`,
        [tenantId, "wersja7@example.test"],
      );
      expect(wynik.rows[0].wersja).toBe(7);
    });

    it("nadaje identyfikatory rosnace w czasie, zeby nie niszczyc lokalnosci indeksu", async () => {
      const pool = getPool();
      const pierwszy = await pool.query(
        "insert into profiles (tenant_id, email) values ($1, $2) returning id",
        [tenantId, "pierwszy@example.test"],
      );
      await new Promise((r) => setTimeout(r, 5));
      const drugi = await pool.query(
        "insert into profiles (tenant_id, email) values ($1, $2) returning id",
        [tenantId, "drugi@example.test"],
      );
      expect(pierwszy.rows[0].id < drugi.rows[0].id).toBe(true);
    });
  });

  describe("izolacja tenantow (AD-2, NFR9)", () => {
    it("nie pozwala podpiac sklepu pod nieistniejacego tenanta", async () => {
      const pool = getPool();
      await expect(
        pool.query(
          `insert into stores (tenant_id, platform, base_url, credentials_encrypted)
           values ($1, $2, $3, $4)`,
          ["00000000-0000-7000-8000-000000000000", "woocommerce", "http://x.test", Buffer.from("s")],
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it("nie pozwala przypiac zdarzenia tenanta do sklepu innego tenanta", async () => {
      const pool = getPool();
      // To jest sedno zlozonego klucza obcego: identyfikator sklepu istnieje, ale nalezy
      // do kogos innego. Bez tego ograniczenia baza przyjelaby taki zapis bez slowa.
      await expect(
        pool.query(
          `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
           values ($1, $2, $3, $4, $5)`,
          [innyTenantId, storeId, "woocommerce", "woo:obcy:order:1:v1", JSON.stringify({})],
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it("nie pozwala przypiac zadania tenanta do sklepu innego tenanta", async () => {
      const pool = getPool();
      await expect(
        pool.query(
          "insert into jobs (tenant_id, store_id, kind) values ($1, $2, $3)",
          [innyTenantId, storeId, "import_history"],
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it("usuwa sklepy, zdarzenia i zadania razem z tenantem", async () => {
      const pool = getPool();
      const t = await pool.query("insert into tenants (name) values ($1) returning id", [
        "M0002 tenant do skasowania",
      ]);
      const doSkasowania = t.rows[0].id;
      const s = await pool.query(
        `insert into stores (tenant_id, platform, base_url, credentials_encrypted)
         values ($1, $2, $3, $4) returning id`,
        [doSkasowania, "woocommerce", "http://sklep.test", Buffer.from("s")],
      );
      await pool.query(
        `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
         values ($1, $2, $3, $4, $5)`,
        [doSkasowania, s.rows[0].id, "woocommerce", "woo:x:order:1:v1", JSON.stringify({})],
      );
      await pool.query("insert into jobs (tenant_id, store_id, kind) values ($1, $2, $3)", [
        doSkasowania,
        s.rows[0].id,
        "import_history",
      ]);

      await pool.query("delete from tenants where id = $1", [doSkasowania]);

      for (const tabela of ["stores", "raw_events", "jobs"]) {
        const zostalo = await pool.query(
          `select 1 from ${tabela} where tenant_id = $1`,
          [doSkasowania],
        );
        expect(zostalo.rowCount, `${tabela} po usunieciu tenanta`).toBe(0);
      }
    });
  });

  describe("idempotencja ingestu (AD-24, NFR28)", () => {
    it("nie przyjmuje dwa razy tego samego zdarzenia zrodlowego", async () => {
      const pool = getPool();
      const klucz = "woocommerce:" + tenantId + ":order:1234:2026-08-27T10:00:00Z";
      await pool.query(
        `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
         values ($1, $2, $3, $4, $5)`,
        [tenantId, storeId, "woocommerce", klucz, JSON.stringify({ id: 1234 })],
      );
      await expect(
        pool.query(
          `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
           values ($1, $2, $3, $4, $5)`,
          [tenantId, storeId, "woocommerce", klucz, JSON.stringify({ id: 1234 })],
        ),
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it("nie myli zdarzen dwoch sklepow tego samego tenanta o tym samym numerze zamowienia", async () => {
      const pool = getPool();
      const drugiSklep = await pool.query(
        `insert into stores (tenant_id, platform, base_url, credentials_encrypted)
         values ($1, $2, $3, $4) returning id`,
        [tenantId, "woocommerce", "http://drugi-sklep.test", Buffer.from("s")],
      );
      const klucz = "woocommerce:" + tenantId + ":order:555:v1";
      await pool.query(
        `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
         values ($1, $2, $3, $4, $5)`,
        [tenantId, storeId, "woocommerce", klucz, JSON.stringify({})],
      );
      // Numery zamowien sa unikalne w obrebie sklepu, nie tenanta. Bez sklepu w kluczu
      // drugie zamowienie zostaloby po cichu uznane za duplikat i zgubione.
      const drugie = await pool.query(
        `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
         values ($1, $2, $3, $4, $5) returning id`,
        [tenantId, drugiSklep.rows[0].id, "woocommerce", klucz, JSON.stringify({})],
      );
      expect(drugie.rowCount).toBe(1);
    });

    it("nie pozwala jednemu tenantowi zablokowac zdarzenia drugiego tym samym kluczem", async () => {
      const pool = getPool();
      // Baza nie ma prawa ufac, ze tekst klucza zawiera identyfikator tenanta.
      // Unikalnosc jest zlozona, wiec kolizja miedzy tenantami jest niemozliwa.
      const kolidujacy = "woocommerce:podszywka:order:999:v1";
      await pool.query(
        `insert into raw_events (tenant_id, source, idempotency_key, payload)
         values ($1, $2, $3, $4)`,
        [tenantId, "woocommerce", kolidujacy, JSON.stringify({})],
      );
      const drugi = await pool.query(
        `insert into raw_events (tenant_id, source, idempotency_key, payload)
         values ($1, $2, $3, $4) returning id`,
        [innyTenantId, "woocommerce", kolidujacy, JSON.stringify({})],
      );
      expect(drugi.rowCount).toBe(1);
    });
  });

  describe("kolejka zadan (AD-5, AD-31)", () => {
    it("zajmuje zadanie atomowo, a drugi worker nie dostaje niczego", async () => {
      const pool = getPool();
      // zajmowanie jest globalne, wiec kolejka musi byc pusta poza zadaniem tego testu
      await pool.query("delete from jobs");
      await pool.query("insert into jobs (tenant_id, kind) values ($1, $2)", [
        tenantId,
        "import_history",
      ]);

      // Docelowy ksztalt zajmowania: jeden atomowy UPDATE, nie select a potem update.
      // Ksztalt jak w produkcji: worker zajmuje zadania GLOBALNIE, bez filtra po tenancie,
      // wiec test uzywa dokladnie tego zapytania, ktore pojdzie do kodu, a nie latwiejszego.
      const zajmij = `
        update jobs set status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
         where (id, created_at) in (
           select id, created_at from jobs
            where status = 'pending' and run_after <= now()
            order by run_after
            for update skip locked
            limit 1
         )
        returning id, created_at, attempts, tenant_id`;

      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query("begin");
        const pierwszy = await a.query(zajmij, ["worker-a"]);
        expect(pierwszy.rowCount).toBe(1);
        expect(pierwszy.rows[0].attempts).toBe(1);
        expect(pierwszy.rows[0].tenant_id).toBe(tenantId);

        await b.query("begin");
        const drugi = await b.query(zajmij, ["worker-b"]);
        // drugi worker nie widzi zajetego zadania - to jest cala istota SKIP LOCKED
        expect(drugi.rowCount).toBe(0);
        await b.query("commit");
        await a.query("commit");
      } finally {
        // Blad asercji przerywa blok przed commitem i zostawilby polaczenie z otwarta
        // transakcja, ktora zatrulaby kolejne testy uzywajace tego samego polaczenia.
        for (const klient of [a, b]) {
          await klient.query("rollback").catch(() => {});
          klient.release();
        }
      }
    });

    it("ponowienie z odstepem nie zmienia tozsamosci zadania ani jego partycji", async () => {
      const pool = getPool();
      // PULAPKA, ktora ten test utrwala: created_at ma w Postgresie mikrosekundy,
      // a Date w JavaScripcie tylko milisekundy. Odeslanie wartosci jako obiektu Date
      // gubi precyzje i klucz zlozony przestaje pasowac, czyli worker nie domyka zadania.
      // Dlatego token zadania jest tekstem prosto z bazy i nigdy nie przechodzi przez Date.
      const utworzone = await pool.query(
        `insert into jobs (tenant_id, kind) values ($1, $2)
         returning id, created_at::text as token, tableoid::regclass as partycja`,
        [tenantId, "wysylka"],
      );
      const { id, token, partycja } = utworzone.rows[0];

      // odlozenie zadania o godzine: zwykla operacja przy bledzie i ponowieniu
      const po = await pool.query(
        `update jobs set run_after = run_after + interval '1 hour', status = 'pending'
          where id = $1 and created_at = $2::timestamptz
        returning id, created_at::text as token, tableoid::regclass as partycja`,
        [id, token],
      );

      expect(po.rowCount).toBe(1);
      expect(po.rows[0].id).toBe(id);
      expect(po.rows[0].token).toBe(token);
      // partycjonowanie po dacie utworzenia, nie po run_after: inaczej ponowienie
      // przenioslo by wiersz do innej partycji i zmienilo jego tozsamosc
      expect(po.rows[0].partycja).toBe(partycja);
    });

    it("zadanie odlozone o dwa tygodnie zostaje w partycji z dnia utworzenia", async () => {
      const pool = getPool();
      const utworzone = await pool.query(
        `insert into jobs (tenant_id, kind) values ($1, $2)
         returning id, created_at::text as token, tableoid::regclass as partycja`,
        [tenantId, "warmup"],
      );
      const po = await pool.query(
        `update jobs set run_after = now() + interval '14 days'
          where id = $1 and created_at = $2::timestamptz
        returning tableoid::regclass as partycja`,
        [utworzone.rows[0].id, utworzone.rows[0].token],
      );
      // To jest warunek operacyjny, nie ciekawostka: zadanie zyje w partycji z dnia
      // utworzenia, wiec sprzatanie partycji po samym wieku skasowalo by je, zanim
      // stanie sie wykonywalne. Zadanie utrzymaniowe musi sprawdzac aktywne zadania.
      expect(po.rows[0].partycja).toBe(utworzone.rows[0].partycja);

      const aktywne = await pool.query(
        `select count(*)::int as ile from jobs
          where tableoid = $1::regclass and status in ('pending', 'running')`,
        [String(utworzone.rows[0].partycja)],
      );
      expect(aktywne.rows[0].ile).toBeGreaterThan(0);
    });

    it("nowe zadania trafiaja do partycji dziennej, a nie do domyslnej", async () => {
      const pool = getPool();
      const wynik = await pool.query(
        "insert into jobs (tenant_id, kind) values ($1, $2) returning tableoid::regclass as partycja",
        [tenantId, "kontrola_zgodnosci"],
      );
      expect(String(wynik.rows[0].partycja)).toMatch(/^jobs_\d{4}_\d{2}_\d{2}$/);

      // Partycja domyslna jest siatka bezpieczenstwa, nie miejscem zapisu. Wiersz w niej
      // oznacza brak partycji dziennej, czyli awarie utrzymania.
      const domyslna = await pool.query("select count(*)::int as ile from jobs_default");
      expect(domyslna.rows[0].ile).toBe(0);
    });

    it("kazda tabela o duzym obrocie wierszy ma zaostrzone OBA progi autovacuum", async () => {
      const pool = getPool();
      const wynik = await pool.query(
        `select relname, reloptions from pg_class
          where relname in (
            'jobs_' || to_char(current_date, 'YYYY_MM_DD'),
            'jobs_' || to_char(current_date + 1, 'YYYY_MM_DD'),
            'jobs_default',
            'raw_events'
          )`,
      );
      expect(wynik.rowCount).toBe(4);
      for (const wiersz of wynik.rows) {
        const ustawienia = (wiersz.reloptions ?? []).join(",");
        expect(ustawienia, `${wiersz.relname} vacuum`).toContain("autovacuum_vacuum_scale_factor=0.02");
        expect(ustawienia, `${wiersz.relname} analyze`).toContain("autovacuum_analyze_scale_factor=0.01");
      }
    });
  });
});
