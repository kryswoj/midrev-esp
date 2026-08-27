import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, closePool } from "../src/db.js";

// Integration test against the local sandbox (docker compose up -d).
// This is the executable spec for Epik A2 (CDP core) from
// clients/midrev/research/wlasny-esp/PLAN-SAAS-ARCHITEKTURA-2026-08-27.md.

describe("CDP core: tenants -> profiles -> events", () => {
  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from events");
    await pool.query("delete from profiles");
    await pool.query("delete from tenants");
  });

  afterAll(async () => {
    await closePool();
  });

  it("creates a tenant, a profile scoped to that tenant, and an event tied to both", async () => {
    const pool = getPool();

    const tenant = await pool.query(
      "insert into tenants (name) values ($1) returning id",
      ["Sklep Testowy"],
    );
    const tenantId = tenant.rows[0].id;

    const profile = await pool.query(
      "insert into profiles (tenant_id, email) values ($1, $2) returning id",
      [tenantId, "klient@example.com"],
    );
    const profileId = profile.rows[0].id;

    await pool.query(
      "insert into events (tenant_id, profile_id, event_type, payload) values ($1, $2, $3, $4)",
      [tenantId, profileId, "order_placed", JSON.stringify({ total: 12900 })],
    );

    const events = await pool.query(
      "select event_type, payload from events where tenant_id = $1",
      [tenantId],
    );

    expect(events.rowCount).toBe(1);
    expect(events.rows[0].event_type).toBe("order_placed");
    expect(events.rows[0].payload.total).toBe(12900);
  });

  it("does not allow duplicate emails within the same tenant", async () => {
    const pool = getPool();
    const tenant = await pool.query(
      "insert into tenants (name) values ($1) returning id",
      ["Sklep Testowy 2"],
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
