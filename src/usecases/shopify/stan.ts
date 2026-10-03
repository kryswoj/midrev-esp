import { getPool } from "../../adapters/db/pool";
import { kluczStronyTenanta } from "../integracja/klucz-strony";
import { sygnalyStrony } from "../integracja/podglad";
import { ostatniImportShopify, type StanImportuShopify } from "./import";
import type { StanInstalacji } from "./instalacja";
import { sklepShopify } from "./sklep";

/**
 * „Sprawdź połączenie” dla Shopify (plan F.1 krok 3, F.2): jeden odczyt, z którego kreator
 * zapala kropki. Tylko odczyt, tylko własny tenant, bez danych osobowych (nazwy tematów,
 * metryk i czasy).
 */

export interface PunktKontroli {
  klucz: "instalacja" | "powiadomienia" | "zamowienia" | "checkout" | "piksel" | "skrypt" | "katalog";
  ok: boolean;
  /** ms od epoki: kiedy ostatnio coś przyszło (null = jeszcze nic) */
  ostatnio: number | null;
  opis: string;
}

export interface StanShopify {
  teraz: number;
  status: "pending" | "connected" | "error";
  blad: string | null;
  domena: string;
  clientId: string;
  punkty: PunktKontroli[];
  import: StanImportuShopify | null;
  linkMotywu: string;
  zakresy: string[];
}

/** Deep link aktywacji app embed (plan A.2): `activateAppId={client_id}/{nazwa bloku}`. */
export function linkAktywacjiEmbed(domena: string, clientId: string): string {
  return `https://${domena}/admin/themes/current/editor?context=apps&activateAppId=${encodeURIComponent(clientId)}/midrev-embed`;
}

export async function stanShopify(tenantId: string, storeId: string): Promise<StanShopify | null> {
  const s = await sklepShopify(tenantId, storeId);
  if (!s) return null;
  const pool = getPool();
  const [{ rows: caps }, { rows: surowe }, { rows: piksel }, { rows: katalog }, klucz, imp] = await Promise.all([
    pool.query<{ c: { shopify?: StanInstalacji } | null }>("select capabilities as c from stores where tenant_id = $1 and id = $2", [tenantId, storeId]),
    pool.query<{ byt: string; ostatnio: Date }>(
      `select split_part(idempotency_key, ':', 3) as byt, max(received_at) as ostatnio
         from raw_events where tenant_id = $1 and store_id = $2 and source = 'shopify' and received_at > now() - interval '30 days'
        group by 1`,
      [tenantId, storeId],
    ),
    pool.query<{ ostatnio: Date | null }>(
      `select max(e.recorded_at) as ostatnio from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
        where e.tenant_id = $1 and e.source = 'client' and m.integration_key = 'midrev'
          and m.name in ('Viewed Product', 'Added to Cart') and e.occurred_at > now() - interval '30 days'
          and e.properties ->> '$source' = 'shopify-pixel'`,
      [tenantId],
    ),
    pool.query<{ n: number; ostatnio: Date | null }>(
      "select count(*) filter (where active)::int as n, max(synced_at) as ostatnio from products where tenant_id = $1 and store_id = $2",
      [tenantId, storeId],
    ),
    kluczStronyTenanta(tenantId),
    ostatniImportShopify(tenantId, storeId),
  ]);
  const inst = caps[0]?.c?.shopify ?? null;
  const po = new Map(surowe.map((r) => [r.byt, r.ostatnio.getTime()]));
  const skrypt = klucz ? sygnalyStrony(klucz.id).find((x) => x.rodzaj === "skrypt") : undefined;
  const aktywne = inst?.webhooki.filter((w) => w.stan === "aktywny").length ?? 0;
  const wszystkie = inst?.webhooki.length ?? 0;
  const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
  const punkty: PunktKontroli[] = [
    {
      klucz: "instalacja",
      ok: s.status === "connected",
      ostatnio: ms(s.zainstalowanyAt),
      opis: s.status === "connected" ? "Aplikacja zainstalowana, dostęp potwierdzony" : s.status === "pending" ? "Czeka na instalację w sklepie" : (s.ostatniBlad ?? "Błąd połączenia"),
    },
    {
      klucz: "powiadomienia",
      ok: wszystkie > 0 && aktywne === wszystkie,
      ostatnio: inst ? Date.parse(inst.sprawdzonoAt) : null,
      opis: wszystkie ? `Powiadomienia o zamówieniach: ${aktywne} z ${wszystkie} aktywnych` : "Powiadomienia jeszcze nie założone",
    },
    { klucz: "zamowienia", ok: po.has("order"), ostatnio: po.get("order") ?? null, opis: "Zamówienie ze sklepu" },
    { klucz: "checkout", ok: po.has("checkout"), ostatnio: po.get("checkout") ?? null, opis: "Rozpoczęte zamówienie (checkout z e-mailem)" },
    {
      klucz: "piksel",
      ok: Boolean(inst?.piksel.id) && piksel[0]?.ostatnio != null,
      ostatnio: ms(piksel[0]?.ostatnio),
      opis: inst?.piksel.blad ? `Piksel: ${inst.piksel.blad}` : inst?.piksel.id ? "Oglądany produkt i koszyk z piksela" : "Piksel nie jest jeszcze włączony",
    },
    { klucz: "skrypt", ok: Boolean(skrypt), ostatnio: skrypt?.kiedy ?? null, opis: "Formularze w motywie (app embed)" },
    {
      klucz: "katalog",
      ok: (katalog[0]?.n ?? 0) > 0,
      ostatnio: ms(katalog[0]?.ostatnio),
      opis: katalog[0]?.n ? `Katalog: ${katalog[0].n} produktów` : "Katalog pusty (import albo pierwsza zmiana produktu)",
    },
  ];
  return {
    teraz: Date.now(),
    status: s.status,
    blad: s.ostatniBlad,
    domena: s.domena,
    clientId: s.poswiadczenia.clientId,
    punkty,
    import: imp,
    linkMotywu: linkAktywacjiEmbed(s.domena, s.poswiadczenia.clientId),
    zakresy: s.poswiadczenia.zakresy,
  };
}
