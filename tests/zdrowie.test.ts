import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Healthcheck /api/zdrowie (audyt 28.09, P1-7/P1-11): 200 tylko gdy baza odpowiada I żyje
 * worker (świeży heartbeat, nie w trakcie zamykania). Trasa publiczna, więc bez tokenu
 * zwraca wyłącznie flagi — żadnych liczb, identyfikatorów tenantów ani adresów.
 */
const TOKEN = "t".repeat(40);
process.env.ZDROWIE_TOKEN = TOKEN; // przed pierwszym config()

const { closePool, getPool } = await import("../src/adapters/db/pool");
const { GET } = await import("../src/app/api/zdrowie/route");

const ID = "worker-0ddba11a";

function zadanie(sciezka: string, token?: string) {
  return new NextRequest(new URL(sciezka, "https://link.midrev.test"), { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

describe("GET /api/zdrowie", () => {
  let zapisane: { worker_id: string; stopping_at: Date | null }[] = [];

  beforeAll(async () => {
    // inne pliki testów mogły zostawić wiersze heartbeatów: odkładamy je na bok na czas testu
    const pool = getPool();
    zapisane = (await pool.query("select worker_id, stopping_at from worker_heartbeats")).rows;
    await pool.query("update worker_heartbeats set stopping_at = coalesce(stopping_at, now())");
    await pool.query("delete from worker_heartbeats where worker_id = $1", [ID]);
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from worker_heartbeats where worker_id = $1", [ID]);
    for (const w of zapisane) await pool.query("update worker_heartbeats set stopping_at = $2 where worker_id = $1", [w.worker_id, w.stopping_at]);
    await closePool();
  });

  it("bez żywego workera: 503, baza ok, worker false, bez szczegółów", async () => {
    const odp = await GET(zadanie("/api/zdrowie"));
    expect(odp.status).toBe(503);
    expect(odp.headers.get("cache-control")).toBe("no-store");
    // bez tokenu wyłącznie status: który komponent leży, to informacja o infrastrukturze
    expect(await odp.json()).toEqual({ status: "blad" });
  });

  it("świeży heartbeat: 200; szczegóły wyłącznie z poprawnym tokenem", async () => {
    await getPool().query("insert into worker_heartbeats (worker_id, started_at, last_seen_at) values ($1, now(), now())", [ID]);
    const odp = await GET(zadanie("/api/zdrowie"));
    expect(odp.status).toBe(200);
    expect(await odp.json()).toEqual({ status: "ok" });

    const zlyToken = await (await GET(zadanie("/api/zdrowie?szczegoly=1", "x".repeat(40)))).json();
    expect(zlyToken).toEqual({ status: "ok" });

    const z = await (await GET(zadanie("/api/zdrowie?szczegoly=1", TOKEN))).json();
    expect(z).toMatchObject({ status: "ok", baza: true, worker: true });
    expect(z.szczegoly).toMatchObject({
      wiekHeartbeatuS: expect.any(Number),
      zadaniaGotowe: expect.any(Number),
      zadaniaWDefault: expect.any(Number),
      wiadomosciHeld: expect.any(Number),
    });
    // same liczby: w odpowiedzi nie ma żadnego UUID (tenant) ani adresu e-mail
    const tekst = JSON.stringify(z);
    expect(tekst).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(tekst).not.toContain("@");
  });

  it("stary heartbeat albo worker w trakcie zamykania = 503", async () => {
    const pool = getPool();
    await pool.query("update worker_heartbeats set last_seen_at = now() - interval '10 minutes' where worker_id = $1", [ID]);
    expect((await GET(zadanie("/api/zdrowie"))).status).toBe(503);
    await pool.query("update worker_heartbeats set last_seen_at = now(), stopping_at = now() where worker_id = $1", [ID]);
    expect((await GET(zadanie("/api/zdrowie"))).status).toBe(503);
  });
});
