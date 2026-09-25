import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { GET, POST } from "../src/app/u/[token]/route";

/**
 * Wypis (FR50, FR51, RFC 8058), audyt 24.09 #8: GET nie wypisuje (skanery prefetchują
 * linki), POST one-click z klienta pocztowego wypisuje natychmiast bez strony, POST
 * z przycisku wypisuje i pokazuje potwierdzenie. Każda asercja czyta ZAPISANY rejestr.
 */
const TOKEN = "wypis-test-token-ABCDEFGH";

describe("Wypis: GET pokazuje, POST wypisuje", () => {
  let tenantId: string;
  const url = `http://panel.test/u/${TOKEN}`;
  const ctx = { params: Promise.resolve({ token: TOKEN }) };

  async function wpisy() {
    const { rows } = await getPool().query("select action, reason, actor from tenant_suppressions where tenant_id = $1 and email = 'wypis@example.test' order by occurred_at", [tenantId]);
    return rows;
  }

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'WYP %'");
    tenantId = (await pool.query("insert into tenants (name) values ('WYP Sklep <Zażółć> & Spółka') returning id")).rows[0].id;
    await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
       values ($1, null, 'test', gen_random_uuid(), 'wypis@example.test', 'T', '<p>x</p>', 'wypis-klik-token-1', $2)`,
      [tenantId, TOKEN],
    );
  });
  afterAll(async () => {
    await getPool().query("delete from tenants where name like 'WYP %'");
    await closePool();
  });

  it("GET: strona z nazwą sklepu i przyciskiem, adres zamaskowany, NIC nie zapisane", async () => {
    const odp = await GET(new NextRequest(url), ctx);
    expect(odp.status).toBe(200);
    expect(odp.headers.get("cache-control")).toBe("no-store");
    const html = await odp.text();
    expect(html).toContain("Wypisz mnie");
    expect(html).toContain('method="post"');
    expect(html).toContain('name="potwierdzam" value="tak"');
    // nazwa sklepu escapowana, bez surowych identyfikatorów
    expect(html).toContain("WYP Sklep &lt;Zażółć&gt; &amp; Spółka");
    expect(html).not.toContain(tenantId);
    expect(html).toContain("wy•••@example.test");
    expect(html).not.toContain("wypis@example.test");
    expect(await wpisy()).toEqual([]);
  });

  it("POST bez potwierdzenia (skaner próbujący formularza) NIE wypisuje", async () => {
    const odp = await POST(new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "x=1" }), ctx);
    expect(odp.status).toBe(200);
    expect(await odp.text()).toContain("Wypisz mnie");
    expect(await wpisy()).toEqual([]);
  });

  it("POST one-click (RFC 8058, body List-Unsubscribe=One-Click) wypisuje i odpowiada gołym 200", async () => {
    const odp = await POST(
      new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }),
      ctx,
    );
    expect(odp.status).toBe(200);
    expect(odp.headers.get("content-type") ?? "").not.toContain("text/html");
    expect(await odp.text()).toBe("OK");
    const w = await wpisy();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ action: "suppressed", actor: "odbiorca" });
    expect(w[0].reason).toContain("List-Unsubscribe");
  });

  it("POST one-click BEZ nagłówka content-type (część klientów pocztowych) też wypisuje", async () => {
    // body jako bajty: NextRequest nie dopisuje wtedy content-type (przy stringu dodałby text/plain)
    const zadanie = new NextRequest(url, { method: "POST", body: new TextEncoder().encode("List-Unsubscribe=One-Click") });
    expect(zadanie.headers.get("content-type")).toBeNull();
    const odp = await POST(zadanie, ctx);
    expect(odp.status).toBe(200);
    expect(await odp.text()).toBe("OK");
    const w = await wpisy();
    expect(w).toHaveLength(2);
    expect(w[1]).toMatchObject({ action: "suppressed", actor: "odbiorca" });
  });

  it("POST z przycisku (potwierdzam=tak) wypisuje i pokazuje potwierdzenie ze sklepem", async () => {
    const odp = await POST(
      new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "potwierdzam=tak" }),
      ctx,
    );
    expect(odp.status).toBe(200);
    const html = await odp.text();
    expect(html).toContain("Wypisano");
    expect(html).toContain("WYP Sklep &lt;Zażółć&gt; &amp; Spółka");
    expect(await wpisy()).toHaveLength(3);
  });

  it("nieznany albo śmieciowy token: 404 ze stroną (GET/POST z przycisku) albo gołym 404 (one-click)", async () => {
    const zly = { params: Promise.resolve({ token: "nie-ma-takiego-tokenu-XYZ" }) };
    const zlyUrl = "http://panel.test/u/nie-ma-takiego-tokenu-XYZ";
    expect((await GET(new NextRequest(zlyUrl), zly)).status).toBe(404);
    expect((await GET(new NextRequest("http://panel.test/u/%27", { }), { params: Promise.resolve({ token: "'; drop--" }) })).status).toBe(404);
    const oneClick = await POST(new NextRequest(zlyUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }), zly);
    expect(oneClick.status).toBe(404);
    expect(await oneClick.text()).toBe("NOT FOUND");
  });
});
