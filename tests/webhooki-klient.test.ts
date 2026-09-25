// Adres, pod ktory sandboxowy WooCommerce ma dosylac webhooki (patrz tests/sklepy.test.ts).
process.env.APP_URL = process.env.APP_URL ?? "http://172.22.0.1:3005";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { adresDostawy, bytTematu, bytZKlucza, kluczZdarzeniaWebhooka, tematObslugiwany } from "../src/adapters/store/webhooki";
import { podlaczSklepWoo } from "../src/usecases/podlacz-sklep";
import { przetworzZdarzenie } from "../src/usecases/przetworz-zdarzenie";
import { czekajNaSurowe, usunWebhookiPodAdresem, wczytajKlucze, woo } from "./pomoc-woo";

// Audyt #4: tematy customer.* rozbijaly faze 2 (kazdy payload mapowany jako zamowienie),
// a klucz idempotencji z zaszytym "order" dawal klientowi 8 i zamowieniu 8 ten sam klucz.
// Ten plik jest wykonywalna specyfikacja poprawki: czesc na zywym sklepie, czesc na bazie.

const klucze = wczytajKlucze();
const APP_URL = process.env.APP_URL!;
const PREFIKS = "WEBHOOKI KLIENT ";

describe("Klucz idempotencji niesie byt z tematu", () => {
  it("rozpoznaje byt z tematu webhooka i odrzuca nieznany", () => {
    expect(bytTematu("order.created")).toBe("order");
    expect(bytTematu("order.updated")).toBe("order");
    expect(bytTematu("customer.created")).toBe("customer");
    expect(bytTematu("customer.updated")).toBe("customer");
    expect(bytTematu("coupon.created")).toBeNull();
    expect(bytTematu("")).toBeNull();
    // endpoint zapisuje WYLACZNIE subskrybowane tematy: order.deleted ma byt, ale nie ma obslugi
    expect(tematObslugiwany("order.deleted")).toBe(false);
    expect(tematObslugiwany("customer.deleted")).toBe(false);
    expect(tematObslugiwany("order.created")).toBe(true);
  });

  it("klient nr 8 i zamowienie nr 8 z ta sama data maja ROZNE klucze", () => {
    const dane = { id: 8, date_modified_gmt: "2026-09-24T10:00:00" };
    const zamowienie = kluczZdarzeniaWebhooka("t", "order", dane);
    const klient = kluczZdarzeniaWebhooka("t", "customer", dane);
    expect(zamowienie).toBe("woocommerce:t:order:8:2026-09-24T10:00:00");
    expect(klient).toBe("woocommerce:t:customer:8:2026-09-24T10:00:00");
    expect(zamowienie).not.toBe(klient);
    expect(bytZKlucza(zamowienie)).toBe("order");
    expect(bytZKlucza(klient)).toBe("customer");
    expect(bytZKlucza("cos:bez:sensu")).toBeNull();
  });

  it("klient bez modyfikacji (date_modified_gmt null) dostaje wersje z daty utworzenia", () => {
    expect(
      kluczZdarzeniaWebhooka("t", "customer", { id: 3, date_modified_gmt: null, date_created_gmt: "2026-01-01T00:00:00" }),
    ).toBe("woocommerce:t:customer:3:2026-01-01T00:00:00");
  });
});

describe("Kolizja kluczy w bazie", () => {
  let tenantId = "";
  let storeId = "";

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like $1", [PREFIKS + "%"]);
    tenantId = (await pool.query("insert into tenants (name) values ($1) returning id", [PREFIKS + "Baza"])).rows[0].id;
    storeId = (
      await pool.query(
        `insert into stores (tenant_id, platform, base_url, credentials_encrypted, status)
         values ($1, 'woocommerce', 'https://kolizja.example', decode('00', 'hex'), 'connected') returning id`,
        [tenantId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "Baza"]);
  });

  it("zamowienie 8 i klient 8 o tej samej wersji wchodza OBA do raw_events", async () => {
    const pool = getPool();
    const dane = { id: 8, date_modified_gmt: "2026-09-24T10:00:00" };
    for (const byt of ["order", "customer"] as const) {
      const wynik = await pool.query(
        `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
         values ($1, $2, 'woocommerce', $3, $4)
         on conflict (tenant_id, store_id, source, idempotency_key) do nothing returning id`,
        [tenantId, storeId, kluczZdarzeniaWebhooka(tenantId, byt, dane), JSON.stringify(dane)],
      );
      expect(wynik.rowCount, `${byt} 8 odrzucone jako duplikat`).toBe(1);
    }
    // a powtorka TEGO SAMEGO klienta z ta sama wersja dalej jest duplikatem
    const powtorka = await pool.query(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
       values ($1, $2, 'woocommerce', $3, $4)
       on conflict (tenant_id, store_id, source, idempotency_key) do nothing returning id`,
      [tenantId, storeId, kluczZdarzeniaWebhooka(tenantId, "customer", dane), JSON.stringify(dane)],
    );
    expect(powtorka.rowCount).toBe(0);
  });

  it("faza 2 odmawia zdarzenia bez rozpoznawalnego bytu w kluczu zamiast zgadywac zamowienie", async () => {
    const { rows } = await getPool().query(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
       values ($1, $2, 'woocommerce', 'legacy-klucz-bez-bytu', '{"id": 1}') returning id`,
      [tenantId, storeId],
    );
    await expect(przetworzZdarzenie(tenantId, rows[0].id)).rejects.toThrow(/bez rozpoznawalnego bytu/);
  });
});

describe.skipIf(!klucze)("Webhooki customer.* na zywym Woo", () => {
  let tenantId = "";
  let storeId = "";
  let adres = "";
  let customerId = 0;
  let orderId = 0;
  const email = `klient-webhook-${Date.now()}@example.test`;

  beforeAll(async () => {
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "Woo%"]);
    tenantId = (await getPool().query("insert into tenants (name) values ($1) returning id", [PREFIKS + "Woo"])).rows[0].id;
    const wynik = await podlaczSklepWoo(tenantId, { baseUrl: klucze!.url, consumerKey: klucze!.ck, consumerSecret: klucze!.cs });
    if (!wynik.ok) throw new Error(wynik.blad);
    storeId = wynik.storeId;
    adres = adresDostawy(APP_URL, storeId);
  }, 60_000);

  afterAll(async () => {
    if (orderId) await woo(klucze!, `orders/${orderId}?force=true`, { method: "DELETE" }).catch(() => {});
    if (customerId) await woo(klucze!, `customers/${customerId}?force=true&reassign=1`, { method: "DELETE" }).catch(() => {});
    if (adres) await usunWebhookiPodAdresem(klucze!, adres);
    await getPool().query("delete from tenants where name like $1", [PREFIKS + "%"]);
    await closePool();
  });

  it(
    "nowy klient w sklepie staje sie profilem BEZ zgody, ze zdarzeniem customer.created z data ze zrodla",
    async () => {
      const { dane: klient } = await woo(klucze!, "customers", {
        method: "POST",
        body: JSON.stringify({
          email,
          first_name: "Webhook",
          last_name: "Klientowy",
          password: "haslo-testowe-123",
          billing: { first_name: "Webhook", last_name: "Klientowy", email, phone: "+48 600 700 800" },
        }),
      });
      customerId = klient.id;

      const surowe = await czekajNaSurowe(klucze!, tenantId, storeId, { byt: "customer", externalId: klient.id });
      expect(surowe, "sklep nie dostarczyl webhooka customer.created - czy aplikacja slucha na " + APP_URL).toBeTruthy();
      expect(surowe!.idempotency_key).toContain(`:customer:${klient.id}:`);

      // faza 2 wprost (worker z tej rundy moze stac na starym kodzie); powtorka jest nieszkodliwa
      await przetworzZdarzenie(tenantId, surowe!.id);

      const { rows: profile } = await getPool().query(
        "select id, email, first_name, last_name, phone from profiles where tenant_id = $1 and lower(btrim(email)) = $2",
        [tenantId, email],
      );
      expect(profile).toHaveLength(1);
      expect(profile[0].first_name).toBe("Webhook");
      expect(profile[0].last_name).toBe("Klientowy");
      expect(profile[0].phone).toBe("+48 600 700 800");

      // ZERO zgod: konto w sklepie to nie zgoda marketingowa (FR27)
      const { rows: zgody } = await getPool().query("select count(*)::int as ile from consents where tenant_id = $1", [tenantId]);
      expect(zgody[0].ile).toBe(0);

      const { rows: zdarzenia } = await getPool().query(
        `select event_type, occurred_at, payload from events where tenant_id = $1 and profile_id = $2 order by occurred_at`,
        [tenantId, profile[0].id],
      );
      expect(zdarzenia.map((z) => z.event_type)).toEqual(["customer.created"]);
      expect(new Date(zdarzenia[0].occurred_at).toISOString()).toBe(new Date(klient.date_created_gmt + "Z").toISOString());
      expect(zdarzenia[0].payload.externalId).toBe(String(klient.id));

      const { rows: przetworzone } = await getPool().query("select processed_at from raw_events where id = $1", [surowe!.id]);
      expect(przetworzone[0].processed_at).not.toBeNull();
    },
    300_000,
  );

  it(
    "zmiana danych klienta daje zdarzenie customer.updated i aktualizuje profil, bez drugiego profilu",
    async () => {
      const { rows: przed } = await getPool().query(
        "select idempotency_key from raw_events where tenant_id = $1 and split_part(idempotency_key, ':', 4) = $2 and split_part(idempotency_key, ':', 3) = 'customer' order by received_at desc limit 1",
        [tenantId, String(customerId)],
      );
      // Woo trzyma date_modified z dokladnoscia do sekundy: odczekaj, zeby wersja klucza sie zmienila
      await new Promise((r) => setTimeout(r, 1500));
      const { dane: klient } = await woo(klucze!, `customers/${customerId}`, {
        method: "PUT",
        body: JSON.stringify({ first_name: "Zmieniony" }),
      });

      const surowe = await czekajNaSurowe(klucze!, tenantId, storeId, {
        byt: "customer",
        externalId: customerId,
        wersjaInnaNiz: przed[0]?.idempotency_key ?? null,
      });
      expect(surowe, "sklep nie dostarczyl webhooka customer.updated").toBeTruthy();
      await przetworzZdarzenie(tenantId, surowe!.id);

      const { rows: profile } = await getPool().query(
        "select id, first_name from profiles where tenant_id = $1 and lower(btrim(email)) = $2",
        [tenantId, email],
      );
      expect(profile).toHaveLength(1);
      expect(profile[0].first_name).toBe("Zmieniony");

      const { rows: zdarzenia } = await getPool().query(
        "select event_type, occurred_at from events where tenant_id = $1 and profile_id = $2 order by recorded_at",
        [tenantId, profile[0].id],
      );
      expect(zdarzenia.map((z) => z.event_type)).toEqual(["customer.created", "customer.updated"]);
      expect(new Date(zdarzenia[1].occurred_at).toISOString()).toBe(new Date(klient.date_modified_gmt + "Z").toISOString());
      expect((await getPool().query("select count(*)::int as ile from consents where tenant_id = $1", [tenantId])).rows[0].ile).toBe(0);
    },
    300_000,
  );

  it(
    "zamowienie tego klienta laczy sie z istniejacym profilem i idzie sciezka zamowienia",
    async () => {
      const { dane: [produkt] } = await woo(klucze!, "products?per_page=1");
      const { dane: zamowienie } = await woo(klucze!, "orders", {
        method: "POST",
        body: JSON.stringify({
          status: "processing",
          customer_id: customerId,
          billing: { first_name: "Zmieniony", last_name: "Klientowy", email },
          line_items: [{ product_id: produkt.id, quantity: 1 }],
        }),
      });
      orderId = zamowienie.id;

      const surowe = await czekajNaSurowe(klucze!, tenantId, storeId, { byt: "order", externalId: zamowienie.id });
      expect(surowe, "sklep nie dostarczyl webhooka order.created").toBeTruthy();
      expect(surowe!.idempotency_key).toContain(`:order:${zamowienie.id}:`);
      await przetworzZdarzenie(tenantId, surowe!.id);

      const { rows: profile } = await getPool().query(
        "select id from profiles where tenant_id = $1 and lower(btrim(email)) = $2",
        [tenantId, email],
      );
      expect(profile).toHaveLength(1);
      const { rows: zamowienia } = await getPool().query(
        // po id: sklep dosyła też zaległe dostawy o innych zamówieniach (kolejka Action
        // Schedulera obsługuje wszystkie aktywne webhooki), więc liczba wierszy nie jest wyrocznią
        "select external_id, profile_id, total_minor::text as total, occurred_at from orders where tenant_id = $1 and store_id = $2 and external_id = $3",
        [tenantId, storeId, String(zamowienie.id)],
      );
      expect(zamowienia).toHaveLength(1);
      expect(zamowienia[0].external_id).toBe(String(zamowienie.id));
      expect(zamowienia[0].profile_id).toBe(profile[0].id);
      expect(new Date(zamowienia[0].occurred_at).toISOString()).toBe(new Date(zamowienie.date_created_gmt + "Z").toISOString());
      const { rows: zdarzenia } = await getPool().query(
        "select event_type from events where tenant_id = $1 and profile_id = $2 and event_type = 'order.created'",
        [tenantId, profile[0].id],
      );
      expect(zdarzenia).toHaveLength(1);
    },
    300_000,
  );
});
