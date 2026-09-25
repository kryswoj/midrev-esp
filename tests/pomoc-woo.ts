// Wspolne narzedzia testow na ZYWYM sandboxie WooCommerce (sandbox/woo, :8091).
// Nie jest to plik testowy (brak *.test.ts), vitest go nie uruchamia sam.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool } from "../src/adapters/db/pool";

const PLIK_KLUCZY = join(import.meta.dirname, "..", "sandbox", "woo", ".woo-credentials");

export interface KluczeWoo {
  url: string;
  ck: string;
  cs: string;
}

export function wczytajKlucze(): KluczeWoo | null {
  if (!existsSync(PLIK_KLUCZY)) return null;
  const pary = new Map<string, string>();
  for (const linia of readFileSync(PLIK_KLUCZY, "utf-8").split("\n")) {
    const i = linia.indexOf("=");
    if (i > 0) pary.set(linia.slice(0, i).trim(), linia.slice(i + 1).trim());
  }
  const url = pary.get("WOO_URL");
  const ck = pary.get("WOO_CONSUMER_KEY");
  const cs = pary.get("WOO_CONSUMER_SECRET");
  return url && ck && cs ? { url, ck, cs } : null;
}

/** Surowe wywolanie REST Woo - niezalezna wyrocznia obok adaptera, nie przez adapter. */
export async function woo(klucze: KluczeWoo, sciezka: string, init: RequestInit = {}): Promise<{ dane: any; naglowki: Headers }> {
  const auth = Buffer.from(`${klucze.ck}:${klucze.cs}`).toString("base64");
  const odpowiedz = await fetch(new URL(`/wp-json/wc/v3/${sciezka}`, klucze.url), {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!odpowiedz.ok) throw new Error(`Woo ${sciezka}: HTTP ${odpowiedz.status} ${await odpowiedz.text()}`);
  return { dane: await odpowiedz.json(), naglowki: odpowiedz.headers };
}

/** Wszystkie pozycje listy, strona po stronie, po nagłówku X-WP-TotalPages. */
export async function wszystkieWoo(klucze: KluczeWoo, sciezka: string, parametry = ""): Promise<any[]> {
  const wynik: any[] = [];
  for (let strona = 1; ; strona++) {
    const { dane, naglowki } = await woo(klucze, `${sciezka}?per_page=100&page=${strona}${parametry ? "&" + parametry : ""}`);
    wynik.push(...dane);
    const stron = Number(naglowki.get("x-wp-totalpages") ?? 1);
    if (strona >= stron || dane.length === 0) break;
  }
  return wynik;
}

export async function webhookiPodAdresem(klucze: KluczeWoo, adres: string): Promise<any[]> {
  const wszystkie = await wszystkieWoo(klucze, "webhooks", "status=all");
  return wszystkie.filter((w) => w.delivery_url === adres);
}

export async function usunWebhookiPodAdresem(klucze: KluczeWoo, adres: string) {
  for (const w of await webhookiPodAdresem(klucze, adres).catch(() => [])) {
    await woo(klucze, `webhooks/${w.id}?force=true`, { method: "DELETE" }).catch(() => {});
  }
}

/**
 * Czeka na surowe zdarzenie z Woo w raw_events, tykajac wp-crona (Woo dostarcza
 * webhooki wlasnie z niego). Zwraca wiersz albo null po wyczerpaniu prob.
 */
export async function czekajNaSurowe(
  klucze: KluczeWoo,
  tenantId: string,
  storeId: string,
  warunek: { byt: "order" | "customer"; externalId: string | number; wersjaInnaNiz?: string | null },
  prob = 70,
): Promise<{ id: string; idempotency_key: string; payload: any; processed_at: Date | null } | null> {
  for (let proba = 0; proba < prob; proba++) {
    await fetch(`${klucze.url}/wp-cron.php?doing_wp_cron`).catch(() => {});
    const { rows } = await getPool().query(
      `select id, idempotency_key, payload, processed_at from raw_events
        where tenant_id = $1 and store_id = $2
          and split_part(idempotency_key, ':', 3) = $3
          and split_part(idempotency_key, ':', 4) = $4
          and ($5::text is null or idempotency_key <> $5)
        order by received_at desc limit 1`,
      [tenantId, storeId, warunek.byt, String(warunek.externalId), warunek.wersjaInnaNiz ?? null],
    );
    if (rows[0]) return rows[0];
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}
