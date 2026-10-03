process.env.MIDREV_GRAF_V2 = "1";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import type { DostawcaWysylki } from "../src/domain/email/port";
import { pobierzAutomatyzacje, SZABLONY_SKLEPU, utworzZBiblioteki, zmienStatus } from "../src/usecases/automatyzacje/journeye";
import { uruchomAutomatyzacje } from "../src/usecases/automatyzacje/przetworz-zdarzenia";
import { ustawRoleMetrykStrony, ustawRoleSklepu } from "../src/usecases/integracja/role-metryk";
import { renderujDokument } from "../src/usecases/tresc/render-blokow";
import { zapiszZdarzenie } from "../src/usecases/zdarzenia/zapisz-zdarzenie";
import { nowyBlok, pustyDokument } from "../src/domain/email/bloki";

// Szablony flow „jednym kliknięciem” (plan integracji, szablony) na metrykach wspólnych dla
// platform: wyzwalacz z ROLI, warunki E4b, blok „Produkty z koszyka” z linkiem powrotu.

const PREFIKS = "SZABLONY SKLEPU ";

class Atrapa implements DostawcaWysylki {
  readonly nazwa = "atrapa";
  wyslane: string[] = [];
  async wyslij(w: { do: string; idempotencyKey: string }) {
    this.wyslane.push(w.do);
    return { providerId: `atrapa-${w.idempotencyKey}` };
  }
}

describe("Blok „Produkty z koszyka”", () => {
  it("w kampanii znika z uwagą (bez liquid u odbiorcy), w automatyzacji niesie pętlę po koszyku", () => {
    const d = { ...pustyDokument(), bloki: [nowyBlok("koszyk")] };
    const kampania = renderujDokument(d);
    expect(kampania.html).not.toContain("{%");
    expect(kampania.uwagi.join(" ")).toContain("tylko w mailach automatyzacji");
    const flow = renderujDokument(d, { dynamiczne: true });
    expect(flow.html).toContain("{% for p in cart.items limit:5 %}");
    expect(flow.html).toContain('href="{{ cart.url }}"');
  });
});

describe("Szablony sklepu: porzucone zamówienie na roli started_checkout", () => {
  let tenantId = "";
  const profil: Record<string, string> = {};
  const d = new Atrapa();

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "A"])).rows[0].id;
    await pool.query("insert into tenant_send_limits (tenant_id, daily_limit) values ($1, 1000) on conflict (tenant_id) do update set daily_limit = 1000", [tenantId]);
    for (const k of ["ola", "kupila", "bezzgody"]) {
      profil[k] = (await pool.query("insert into profiles (tenant_id, email) values ($1, $2) returning id", [tenantId, `${k}@szablony.test`])).rows[0].id;
      if (k !== "bezzgody") {
        await pool.query(
          `insert into consents (tenant_id, profile_id, channel, state, source, occurred_at) values ($1, $2, 'email', 'granted', 'test', now() - interval '10 days')`,
          [tenantId, profil[k]],
        );
      }
    }
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  it("bez roli szablon odmawia z powodem; z rolą każdy z 6 szablonów przechodzi bramkę", async () => {
    const bez = await utworzZBiblioteki(tenantId, "porzucony_checkout", { sklepUrl: "https://sklep.example" });
    expect(bez).toMatchObject({ ok: false });
    await ustawRoleMetrykStrony(tenantId);
    await ustawRoleSklepu(getPool(), tenantId, "woocommerce");
    for (const s of [...SZABLONY_SKLEPU.map((x) => x.klucz), "powitanie"]) {
      const w = await utworzZBiblioteki(tenantId, s, { sklepUrl: "https://sklep.example" });
      expect(w, s).toMatchObject({ ok: true });
    }
    const { rows } = await getPool().query("select id, name from flows where tenant_id = $1 and name = 'Porzucone zamówienie'", [tenantId]);
    const widok = await pobierzAutomatyzacje(tenantId, rows[0].id);
    const wyzw = widok!.graf.wezly.find((w) => w.typ === "wyzwalacz") as { zrodlo: { metryka: unknown } };
    expect(wyzw.zrodlo.metryka).toEqual({ integracja: "midrev", nazwa: "Started Checkout" });
    expect(widok!.graf.ustawienia.filtrProfilu?.grupy.length).toBe(2);
  });

  async function zdarzenie(klucz: string, nazwa: string, integracja: string, properties: Record<string, unknown>, temu = "5 seconds") {
    const klient = await getPool().connect();
    try {
      await klient.query("begin");
      const { rows: t } = await klient.query("select date_trunc('second', now() - $1::interval) as kiedy", [temu]);
      await zapiszZdarzenie(klient, { tenantId, metryka: { integracja: integracja as never, nazwa }, profileId: profil[klucz], occurredAt: t[0].kiedy, uniqueId: randomUUID(), properties, source: "webhook" });
      await klient.query("commit");
    } finally {
      klient.release();
    }
  }

  it("mail z koszykiem i linkiem powrotu; kto kupił w trakcie i kto nie ma zgody, nie dostaje", async () => {
    const pool = getPool();
    const { rows: f } = await pool.query("select id from flows where tenant_id = $1 and name = 'Porzucone zamówienie'", [tenantId]);
    const flowId = f[0].id;
    const w = await zmienStatus(tenantId, flowId, "wlaczony");
    expect(w.ok, JSON.stringify(w)).toBe(true);
    await pool.query("update flows set active_since = now() - interval '1 hour' where tenant_id = $1 and id = $2", [tenantId, flowId]);
    await pool.query("update flow_trigger_state set scanned_to = now() - interval '1 hour' where tenant_id = $1 and flow_id = $2", [tenantId, flowId]);
    for (const k of ["ola", "kupila", "bezzgody"]) {
      await pool.query(
        `insert into carts (tenant_id, store_id, platform_token, profile_id, stage, items, value_minor, currency, recovery_url, source_updated_at)
         values ($1, null, $2, $3, 'checkout', $4::jsonb, 12900, 'PLN', $5, now())`,
        [tenantId, `TOK${k}`.padEnd(20, "0"), profil[k], JSON.stringify([{ product_id: "10", variant_id: null, title: "Serum <witaminowe>", qty: 1, price_minor: "12900", image_url: "https://sklep.example/s.jpg", url: "https://sklep.example/serum" }]), `https://sklep.example/?mrv_cart=TOK${k}`],
      );
      await zdarzenie(k, "Started Checkout", "midrev", { $cart_token: `TOK${k}`.padEnd(20, "0"), $value: 129 });
    }
    await uruchomAutomatyzacje(tenantId, { dostawca: d });
    // zakup w trakcie oczekiwania (Placed Order z dowolnej integracji)
    await zdarzenie("kupila", "Placed Order", "woocommerce", { OrderId: "1" });
    await pool.query("update flow_participants set resume_at = now() - interval '1 second' where tenant_id = $1 and flow_id = $2 and resume_at is not null", [tenantId, flowId]);
    await uruchomAutomatyzacje(tenantId, { dostawca: d });
    const { rows: m } = await pool.query(
      `select p.email, m.body_html, m.links::text as linki from messages m join profiles p on p.id = m.profile_id join journeys j on j.tenant_id = m.tenant_id and j.id = m.source_id
        where m.tenant_id = $1 and j.flow_id = $2`,
      [tenantId, flowId],
    );
    expect(m.map((x) => x.email)).toEqual(["ola@szablony.test"]);
    expect(m[0].body_html).toContain("Serum &lt;witaminowe&gt;");
    expect(m[0].body_html).toContain("129,00");
    // przycisk powrotu: link śledzony (/r/…), cel w migawce linków = link odtwarzający koszyk
    expect(m[0].linki, m[0].linki).toContain("mrv_cart=TOKola");
    expect(m[0].body_html).not.toContain("{%");
  });
});
