import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, closePool } from "../src/adapters/db/pool";

// Integration test against the local sandbox (docker compose up -d).
// This is the executable spec for Epik A2 (CDP core) from
// clients/midrev/research/wlasny-esp/PLAN-SAAS-ARCHITEKTURA-2026-08-27.md.

describe("CDP core: tenants -> profiles -> events", () => {
  // Testy sprzątają WYŁĄCZNIE po sobie. Globalne "delete from tenants" kasowało dane
  // wszystkich innych plików testowych i dane demonstracyjne w sandboxie, przez co panel
  // pokazywał 404 dla klienta, który przed chwilą istniał. Kaskada kluczy obcych sprząta
  // profile, zdarzenia, sklepy i zadania należące do tych tenantów.
  const PREFIKS = "CDP ";

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
  });

  afterAll(async () => {
    await closePool();
  });

  it("creates a tenant, a profile scoped to that tenant, and an event tied to both", async () => {
    const pool = getPool();

    const tenant = await pool.query(
      "insert into tenants (name) values ($1) returning id",
      [PREFIKS + "Sklep Testowy"],
    );
    const tenantId = tenant.rows[0].id;

    const profile = await pool.query(
      "insert into profiles (tenant_id, email) values ($1, $2) returning id",
      [tenantId, "klient@example.com"],
    );
    const profileId = profile.rows[0].id;

    await pool.query(
      // occurred_at jest teraz obowiazkowe (AD-10): baza nie podstawi daty importu
      `insert into events (tenant_id, profile_id, event_type, payload, occurred_at)
       values ($1, $2, $3, $4, $5)`,
      [tenantId, profileId, "order_placed", JSON.stringify({ total: 12900 }), "2026-01-15T10:00:00Z"],
    );

    const events = await pool.query(
      "select event_type, payload from events where tenant_id = $1",
      [tenantId],
    );

    expect(events.rowCount).toBe(1);
    expect(events.rows[0].event_type).toBe("order_placed");
    expect(events.rows[0].payload.total).toBe(12900);
  });

  it("rejects an event whose profile belongs to a different tenant", async () => {
    const pool = getPool();

    const tenantA = await pool.query(
      "insert into tenants (name) values ($1) returning id",
      [PREFIKS + "Tenant A"],
    );
    const tenantB = await pool.query(
      "insert into tenants (name) values ($1) returning id",
      [PREFIKS + "Tenant B"],
    );
    const profileInTenantA = await pool.query(
      "insert into profiles (tenant_id, email) values ($1, $2) returning id",
      [tenantA.rows[0].id, "nalezy-do-a@example.com"],
    );

    // event zgłoszony pod tenant_id B, ale wskazujący profil należący do tenanta A
    await expect(
      pool.query(
        `insert into events (tenant_id, profile_id, event_type, occurred_at)
         values ($1, $2, $3, '2026-02-01T09:30:00Z')`,
        [tenantB.rows[0].id, profileInTenantA.rows[0].id, "order_placed"],
      ),
    ).rejects.toThrow();
  });

  it("treats emails as case-insensitive when checking uniqueness per tenant", async () => {
    const pool = getPool();
    const tenant = await pool.query(
      "insert into tenants (name) values ($1) returning id",
      [PREFIKS + "Sklep Testowy Case"],
    );
    const tenantId = tenant.rows[0].id;

    await pool.query("insert into profiles (tenant_id, email) values ($1, $2)", [
      tenantId,
      "klient@example.com",
    ]);

    await expect(
      pool.query("insert into profiles (tenant_id, email) values ($1, $2)", [
        tenantId,
        "Klient@Example.com",
      ]),
    ).rejects.toThrow();
  });

  it("allows multiple profiles without an email within the same tenant", async () => {
    const pool = getPool();
    const tenant = await pool.query(
      "insert into tenants (name) values ($1) returning id",
      [PREFIKS + "Sklep Testowy Anon"],
    );
    const tenantId = tenant.rows[0].id;

    await pool.query("insert into profiles (tenant_id, email) values ($1, $2)", [
      tenantId,
      null,
    ]);
    await pool.query("insert into profiles (tenant_id, email) values ($1, $2)", [
      tenantId,
      null,
    ]);

    const count = await pool.query(
      "select count(*)::int from profiles where tenant_id = $1",
      [tenantId],
    );
    expect(count.rows[0].count).toBe(2);
  });

  it("nulls only profile_id (not tenant_id) on an event when its profile is deleted", async () => {
    const pool = getPool();
    const tenant = await pool.query(
      "insert into tenants (name) values ($1) returning id",
      [PREFIKS + "Sklep Testowy Delete"],
    );
    const tenantId = tenant.rows[0].id;
    const profile = await pool.query(
      "insert into profiles (tenant_id, email) values ($1, $2) returning id",
      [tenantId, "do-usuniecia@example.com"],
    );
    const event = await pool.query(
      `insert into events (tenant_id, profile_id, event_type, occurred_at)
       values ($1, $2, $3, '2026-02-01T09:30:00Z') returning id`,
      [tenantId, profile.rows[0].id, "order_placed"],
    );

    await pool.query("delete from profiles where id = $1", [profile.rows[0].id]);

    const result = await pool.query(
      "select tenant_id, profile_id from events where id = $1",
      [event.rows[0].id],
    );
    expect(result.rows[0].tenant_id).toBe(tenantId);
    expect(result.rows[0].profile_id).toBeNull();
  });

  it("does not allow duplicate emails within the same tenant", async () => {
    const pool = getPool();
    const tenant = await pool.query(
      "insert into tenants (name) values ($1) returning id",
      [PREFIKS + "Sklep Testowy 2"],
    );
    const tenantId = tenant.rows[0].id;

    await pool.query("insert into profiles (tenant_id, email) values ($1, $2)", [
      tenantId,
      "duplikat@example.com",
    ]);

    await expect(
      pool.query("insert into profiles (tenant_id, email) values ($1, $2)", [
        tenantId,
        "duplikat@example.com",
      ]),
    ).rejects.toThrow();
  });
});
