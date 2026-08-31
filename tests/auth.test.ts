import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, closePool } from "../src/adapters/db/pool";
import { nadajDostep, utworzUzytkownika } from "../src/adapters/db/auth";
import { zahaszujHaslo, zweryfikujHaslo } from "../src/usecases/auth/hasla";
import { zaloguj } from "../src/usecases/auth/zaloguj";
import { wyloguj } from "../src/usecases/auth/wyloguj";
import { zahaszujToken, zweryfikujTokenSesji } from "../src/usecases/auth/sesja";

// Wykonywalna specyfikacja Story 1.4. Sprzatamy WYLACZNIE po sobie: userzy tego
// pliku maja email z prefiksem 'auth-test-', tenanci nazwe z prefiksem 'AuthTest '.
// Kaskada z users sprzata sesje i membershipy.
//
// scrypt z produkcyjnymi parametrami (N=2^17) kosztuje ~150 ms na hash, wiec
// testy haszuja raz w beforeAll i dziela hash miedzy konta, zamiast liczyc go
// w kazdym tescie od nowa.

const HASLO = "auth-test-poprawne-haslo-7";
const ADMIN = "auth-test-admin@example.test";
const KLIENT = "auth-test-klient@example.test";

describe("Story 1.4: konta, sesje, kontekst dzialajacego", () => {
  let tenantA: string;
  let tenantB: string;
  let hashHasla: string;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from users where email like 'auth-test-%'");
    await pool.query("delete from tenants where name like 'AuthTest %'");

    const t = await pool.query(
      "insert into tenants (name) values ($1), ($2) returning id",
      ["AuthTest tenant A", "AuthTest tenant B"],
    );
    tenantA = t.rows[0].id;
    tenantB = t.rows[1].id;

    hashHasla = await zahaszujHaslo(HASLO);
    const admin = await utworzUzytkownika(ADMIN, hashHasla, "Admin testowy", "admin");
    const klient = await utworzUzytkownika(KLIENT, hashHasla, "Klient testowy", "client");
    // klient dostaje membership WYLACZNIE do tenanta A - tenant B jest proba izolacji
    await nadajDostep(klient.id, tenantA, "client");
    void admin;
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from users where email like 'auth-test-%'");
    await pool.query("delete from tenants where name like 'AuthTest %'");
    await closePool();
  });

  describe("hasla: scrypt z sola (NFR12)", () => {
    it("weryfikuje poprawne haslo wobec hashu", async () => {
      await expect(zweryfikujHaslo(HASLO, hashHasla)).resolves.toBe(true);
    });

    it("odrzuca bledne haslo", async () => {
      await expect(zweryfikujHaslo("auth-test-zle-haslo", hashHasla)).resolves.toBe(false);
    });

    it("hash niesie parametry i sol, nie zawiera hasla jawnie", () => {
      expect(hashHasla.startsWith("scrypt$17$8$1$")).toBe(true);
      expect(hashHasla).not.toContain(HASLO);
    });

    it("dwa hashe tego samego hasla roznia sie (sol losowa per hash)", async () => {
      const drugi = await zahaszujHaslo(HASLO);
      expect(drugi).not.toBe(hashHasla);
      await expect(zweryfikujHaslo(HASLO, drugi)).resolves.toBe(true);
    });

    it("odrzuca uszkodzony rekord hashu zamiast rzucac", async () => {
      await expect(zweryfikujHaslo(HASLO, "nie-scrypt$x$y")).resolves.toBe(false);
    });
  });

  describe("logowanie i sesja", () => {
    it("poprawne dane daja token, a w bazie lezy wylacznie jego hash", async () => {
      const wynik = await zaloguj(ADMIN, HASLO);
      expect(wynik.ok).toBe(true);
      if (!wynik.ok) return;

      const pool = getPool();
      // jawny token nie ma prawa istniec w bazie - wyciek zrzutu nie daje ciasteczek
      const jawny = await pool.query("select 1 from sessions where token_hash = $1", [
        wynik.token,
      ]);
      expect(jawny.rowCount).toBe(0);
      const zahaszowany = await pool.query("select 1 from sessions where token_hash = $1", [
        zahaszujToken(wynik.token),
      ]);
      expect(zahaszowany.rowCount).toBe(1);
    });

    it("zly adres i zle haslo daja IDENTYCZNA odmowe (formularz nie jest wyrocznia kont)", async () => {
      const zleHaslo = await zaloguj(ADMIN, "auth-test-zle");
      const zlyAdres = await zaloguj("auth-test-nie-istnieje@example.test", HASLO);
      expect(zleHaslo).toEqual({ ok: false, blad: "Nieprawidłowy adres albo hasło" });
      expect(zlyAdres).toEqual(zleHaslo);
    });

    it("email loguje niezaleznie od wielkosci liter i spacji brzegowych", async () => {
      const wynik = await zaloguj("  AUTH-TEST-ADMIN@example.test ", HASLO);
      expect(wynik.ok).toBe(true);
    });

    it("wazna sesja zwraca pelny kontekst dzialajacego", async () => {
      const wynik = await zaloguj(ADMIN, HASLO);
      if (!wynik.ok) throw new Error("logowanie mialo sie udac");
      const sesja = await zweryfikujTokenSesji(wynik.token);
      expect(sesja).not.toBeNull();
      expect(sesja?.email).toBe(ADMIN);
      expect(sesja?.displayName).toBe("Admin testowy");
      expect(sesja?.role).toBe("admin");
    });

    it("sesja wygasla jest odrzucana", async () => {
      const wynik = await zaloguj(ADMIN, HASLO);
      if (!wynik.ok) throw new Error("logowanie mialo sie udac");
      // przesuniecie waznosci w przeszlosc zamiast czekania: stala data, zero snu
      await getPool().query(
        "update sessions set expires_at = '2025-01-01T00:00:00Z' where token_hash = $1",
        [zahaszujToken(wynik.token)],
      );
      await expect(zweryfikujTokenSesji(wynik.token)).resolves.toBeNull();
    });

    it("token po wylogowaniu jest natychmiast uniewazniony", async () => {
      const wynik = await zaloguj(ADMIN, HASLO);
      if (!wynik.ok) throw new Error("logowanie mialo sie udac");
      await expect(zweryfikujTokenSesji(wynik.token)).resolves.not.toBeNull();
      await wyloguj(wynik.token);
      await expect(zweryfikujTokenSesji(wynik.token)).resolves.toBeNull();
    });

    it("smieciowy token nie przechodzi", async () => {
      await expect(zweryfikujTokenSesji("nie-token")).resolves.toBeNull();
      await expect(zweryfikujTokenSesji("")).resolves.toBeNull();
    });
  });

  describe("limit prob logowania", () => {
    it(
      "po 10 nieudanych probach odmawia nawet przy poprawnym hasle, nie ruszajac innych kont",
      async () => {
        const email = "auth-test-limit@example.test";
        await utworzUzytkownika(email, hashHasla, "Limit testowy", "client");

        for (let i = 0; i < 10; i++) {
          const proba = await zaloguj(email, "auth-test-zle-haslo");
          expect(proba.ok).toBe(false);
        }

        // poprawne haslo juz nie pomaga - okno kwadransa musi minac
        const zablokowane = await zaloguj(email, HASLO);
        expect(zablokowane.ok).toBe(false);
        if (!zablokowane.ok) expect(zablokowane.blad).toContain("Za dużo");

        // limit jest per konto: inne konto loguje sie normalnie
        const inne = await zaloguj(KLIENT, HASLO);
        expect(inne.ok).toBe(true);
      },
      // 11 wywolan scryptu po ~150 ms kazde; domyslne 5 s to za malo
      30_000,
    );
  });

  describe("tenant z sesji, nigdy z zadania (AD-21, NFR9)", () => {
    it("client dostaje wylacznie tenanty ze swoich membershipow", async () => {
      const wynik = await zaloguj(KLIENT, HASLO);
      if (!wynik.ok) throw new Error("logowanie mialo sie udac");
      const sesja = await zweryfikujTokenSesji(wynik.token);
      expect(sesja?.role).toBe("client");
      expect(sesja?.tenantIds).toContain(tenantA);
      // sedno izolacji: tenant B istnieje, ale nie ma go w sesji klienta,
      // wiec identyfikator B podany w zadaniu nie ma sie do czego dopasowac
      expect(sesja?.tenantIds).not.toContain(tenantB);
    });

    it("admin ma w sesji dostep do wszystkich tenantow bez membershipow", async () => {
      const wynik = await zaloguj(ADMIN, HASLO);
      if (!wynik.ok) throw new Error("logowanie mialo sie udac");
      const sesja = await zweryfikujTokenSesji(wynik.token);
      expect(sesja?.tenantIds).toContain(tenantA);
      expect(sesja?.tenantIds).toContain(tenantB);
    });
  });
});
