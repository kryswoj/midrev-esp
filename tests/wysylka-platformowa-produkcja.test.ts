import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DostawcaWysylki, Wiadomosc, WynikWysylki } from "../src/domain/email/port";

/**
 * Bramka wysyłki platformowej POZA sandboksem (review Codeksa r1, P1): bez potwierdzonego
 * celu zdarzeń SNS w configuration secie TEGO tenanta nic nie wychodzi — odbicia i skargi
 * nie miałyby którędy wrócić. Tryb produkcyjny symulowany jak w przekaznik-ses.test.ts.
 */
const stan = vi.hoisted(() => {
  process.env.SES_ZDARZENIA_SNS = "1";
  process.env.SES_SNS_TOPIC_ARN = "arn:aws:sns:eu-north-1:509758189751:midrev-esp-ses-zdarzenia";
  return { sandbox: false };
});
vi.mock("../src/config", async (oryginal) => {
  const m = await oryginal<typeof import("../src/config")>();
  return { ...m, trybSandbox: () => stan.sandbox };
});

const { closePool, getPool } = await import("../src/adapters/db/pool");
const { wybierzWysylke } = await import("../src/usecases/wysylka-konfiguracja/nadawca");

class Atrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  async wyslij(w: Wiadomosc): Promise<WynikWysylki> {
    return { providerId: w.idempotencyKey };
  }
}

describe("Wysyłka platformowa w produkcji", () => {
  let tenantId: string;
  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name = 'WPP produkcja'");
    tenantId = (await pool.query(
      "insert into tenants (name, ses_configuration_set, sender_postal_address) values ('WPP produkcja', 'midrev-t-wpp', 'ul. A 1, 00-001 W') returning id",
    )).rows[0].id;
    const d = await pool.query(
      `insert into sending_domains (tenant_id, domain, managed_by, zone_apex, status, ses_verified_for_sending, last_checked_at)
       values ($1, 'news.wpp.test', 'platforma', 'wpp.test', 'verified', true, now()) returning id`,
      [tenantId],
    );
    await pool.query(
      "insert into tenant_platform_senders (tenant_id, sending_domain_id, from_name, from_email) values ($1, $2, 'WPP', 'newsletter@news.wpp.test')",
      [tenantId, d.rows[0].id],
    );
  });
  afterAll(async () => {
    await getPool().query("delete from tenants where name = 'WPP produkcja'");
    await closePool();
  });

  it("gotowa domena, ale cel zdarzeń tenanta niepotwierdzony = blokada bez żargonu", async () => {
    const w = await wybierzWysylke(tenantId, { dostawca: new Atrapa() });
    expect(w.rodzaj).toBe("blokada");
    if (w.rodzaj === "blokada") expect(w.powod).not.toMatch(/SES|SNS|SMTP/);
  });

  it("po potwierdzeniu celu zdarzeń wysyłka rusza z nadawcą z bazy", async () => {
    await getPool().query("update tenants set ses_events_destination_at = now() where id = $1", [tenantId]);
    const w = await wybierzWysylke(tenantId, { dostawca: new Atrapa() });
    expect(w.rodzaj).toBe("platforma");
    if (w.rodzaj !== "blokada") expect(w.nadawca.od).toBe("newsletter@news.wpp.test");
  });
});
