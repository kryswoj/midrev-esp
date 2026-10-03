import type { PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";
import {
  BladMapowaniaShopify,
  checkoutZWebhooka,
  idZGid,
  klientZWebhooka,
  koszykZWebhooka,
  produktZWebhooka,
  zamowienieZWebhooka,
  zgodaZWebhooka,
  type CheckoutShopify,
} from "../../adapters/store/shopify/mapowanie";
import { TEMATY_RODO, type TematShopify } from "../../adapters/store/shopify/webhooki";
import type { ZamowienieSklepu } from "../../domain/store/contract";
import { naMinor, wykladnikWaluty } from "../../domain/zdarzenia/limity";
import { produktSklepuZShopify } from "../../adapters/store/shopify/definicja";
import { zapiszZgodeSklepu } from "../integracja/zgody-sklepu";
import { zapiszProduktySklepu } from "../katalog/katalog-sklepu";
import { zapiszKoszykSklepu } from "../katalog/koszyki";
import { wyslijAlert } from "../../jobs/alerty";
import { nagrobek, profilPoEmailu, upsertProfilKlienta, upsertZamowienie } from "../przetworz-zdarzenie";
import { emitujKlienta } from "../zdarzenia/emisja-sklepu";
import { zapiszZdarzenie } from "../zdarzenia/zapisz-zdarzenie";
import { oznaczOdinstalowanie } from "./instalacja";
import { METRYKI_SHOPIFY } from "./metryki";
import { obsluzZadanieRodo } from "./rodo";

/**
 * Faza 2 webhooków Shopify. Wołana z `przetworzZdarzenie` (ten sam rodzaj joba co Woo), gdy
 * `raw_events.source = 'shopify'`: dzięki temu ponawianie zaległych (`ponowZalegleSurowe`)
 * działa dla obu platform bez zmian.
 *
 * Każdy temat to jedna transakcja z blokadą wiersza surowego zdarzenia (`for update`) i
 * `processed_at` na końcu: dwa workery nie przetworzą tego samego zdarzenia, a powtórka po
 * awarii jest nieszkodliwa (upserty, unique_id metryk). Błąd mapowania (brak daty, id) nie
 * wraca do kolejki: `process_error` + jeden alert (dead-letter, jak w Woo).
 *
 * Tematy RODO idą osobną ścieżką (`obsluzZadanieRodo`), bo anonimizacja ma własną transakcję.
 */

/** Port „Sklep”: zamówienia Shopify zapisuje wspólny upsert z metrykami `shopify/*`. */
export const OPCJE_UPSERTU_SHOPIFY = { platforma: "shopify" } as const;

interface Kontekst {
  klient: PoolClient;
  tenantId: string;
  storeId: string;
  waluta: string;
  domenaPubliczna: string | null;
  domenaSklepu: string;
  /** czas z X-Shopify-Triggered-At albo czas przyjęcia */
  wyzwolono: Date;
}

export async function przetworzZdarzenieShopify(tenantId: string, rawEventId: string): Promise<void> {
  const pool = getPool();
  const { rows: podglad } = await pool.query<{ temat: string | null; byt: string }>(
    `select payload -> '_midrev' ->> 'temat' as temat, split_part(idempotency_key, ':', 3) as byt from raw_events
      where tenant_id = $1 and id = $2 and source = 'shopify' and processed_at is null`,
    [tenantId, rawEventId],
  );
  if (!podglad[0]) return;
  // byt `gdpr` z klucza: także wtedy, gdy payload jest już zaślepiony (ponowienie po awarii)
  if (podglad[0].byt === "gdpr" || (TEMATY_RODO as readonly string[]).includes(podglad[0].temat ?? "")) {
    await obsluzZadanieRodo(tenantId, rawEventId);
    return;
  }

  const klient = await pool.connect();
  let alert: string | null = null;
  try {
    await klient.query("begin");
    const { rows } = await klient.query<{ store_id: string; payload: any; processed_at: Date | null; received_at: Date; capabilities: any; currency: string | null; shop_domain: string }>(
      `select r.store_id, r.payload, r.processed_at, r.received_at, s.capabilities, t.currency, s.shop_domain
         from raw_events r
         join stores s on s.tenant_id = r.tenant_id and s.id = r.store_id
         join tenants t on t.id = r.tenant_id
        where r.tenant_id = $1 and r.id = $2 and r.source = 'shopify'
        for update of r`,
      [tenantId, rawEventId],
    );
    const r = rows[0];
    if (!r || r.processed_at) {
      await klient.query("rollback");
      return;
    }
    let blad: string | null = null;
    let zaslep = false;
    if (r.payload?.anonimizowano) {
      blad = "anonimizowano";
    } else {
      const temat = r.payload?._midrev?.temat as TematShopify;
      const wyz = r.payload?._midrev?.wyzwolono ? new Date(r.payload._midrev.wyzwolono) : r.received_at;
      const k: Kontekst = {
        klient,
        tenantId,
        storeId: r.store_id,
        waluta: r.capabilities?.shopify?.waluta ?? r.currency ?? "PLN",
        domenaPubliczna: r.capabilities?.shopify?.domenaPubliczna ?? null,
        domenaSklepu: r.shop_domain,
        wyzwolono: Number.isNaN(wyz.getTime()) ? r.received_at : wyz,
      };
      try {
        await klient.query("savepoint temat");
        zaslep = await obsluzTemat(k, temat, r.payload);
        await klient.query("release savepoint temat");
      } catch (b) {
        if (!(b instanceof BladMapowaniaShopify)) throw b;
        await klient.query("rollback to savepoint temat");
        blad = b.message.slice(0, 500);
        alert = `Shopify: webhook ${temat} (raw_event ${rawEventId}) nie da się przetworzyć: ${blad}. Odłożony z process_error.`;
      }
    }
    if (zaslep) {
      await klient.query(
        `update raw_events set payload = jsonb_build_object('anonimizowano', true, 'temat', payload -> '_midrev' ->> 'temat'),
                process_error = 'rodo:nagrobek' where tenant_id = $1 and id = $2`,
        [tenantId, rawEventId],
      );
    }
    await klient.query(
      `update raw_events set processed_at = now(), process_error = coalesce($3, process_error) where tenant_id = $1 and id = $2`,
      [tenantId, rawEventId, blad],
    );
    await klient.query("commit");
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
  if (alert) await wyslijAlert(alert, { poziom: "uwaga", tenantId });
}

/** Zwraca true, gdy payload trafił w nagrobek RODO (do zaślepienia). */
async function obsluzTemat(k: Kontekst, temat: TematShopify, p: any): Promise<boolean> {
  switch (temat) {
    case "orders/create":
    case "orders/updated":
    case "orders/paid":
    case "orders/fulfilled":
    case "orders/cancelled":
      return zamowienie(k, p);
    case "refunds/create":
      await zwrot(k, p);
      return false;
    case "checkouts/create":
    case "checkouts/update":
      return checkout(k, checkoutZWebhooka(p));
    case "carts/create":
    case "carts/update":
      await koszyk(k, p);
      return false;
    case "customers/create":
    case "customers/update":
      return klientSklepu(k, p);
    case "customers_email_marketing_consent/update":
      return zgoda(k, p);
    case "products/create":
    case "products/update":
      await zapiszProduktySklepu(k.klient, k.tenantId, k.storeId, [produktSklepuZShopify(produktZWebhooka(p, k.waluta, k.domenaPubliczna), k.waluta)], "webhook");
      return false;
    case "products/delete": {
      const id = idZGid(p?.id);
      if (!id) throw new BladMapowaniaShopify("products/delete bez id");
      // usunięty w Shopify = nieaktywny u nas, nigdy DELETE (stare maile i zdarzenia go wskazują)
      await k.klient.query(
        "update products set active = false, synced_at = now() where tenant_id = $1 and store_id = $2 and external_id = $3 and active",
        [k.tenantId, k.storeId, id],
      );
      return false;
    }
    case "app/uninstalled":
      // osobne połączenie: alert i zapis stanu sklepu niezależnie od tej transakcji
      await oznaczOdinstalowanie(k.tenantId, k.storeId);
      return false;
    default:
      return false;
  }
}

// ── zamówienia ────────────────────────────────────────────────────────────────────────

async function zamowienie(k: Kontekst, p: any): Promise<boolean> {
  const z = zamowienieZWebhooka(p);
  // wspólny upsert portu: Placed/Ordered przy pierwszym pojawieniu, Fulfilled/Cancelled przy zmianie
  // roli statusu (DEFINICJA_SHOPIFY.rolaStatusu), zamknięcie koszyka po tokenie checkoutu
  const w = await upsertZamowienie(k.klient, k.tenantId, k.storeId, z, { kanal: "webhook", ...OPCJE_UPSERTU_SHOPIFY });
  // id zamówienia także wtedy, gdy payload był starszy od zapisanego (pominięty)
  const { rows } = await k.klient.query<{ id: string; profile_id: string | null }>(
    "select id, profile_id from orders where tenant_id = $1 and store_id = $2 and external_id = $3",
    [k.tenantId, k.storeId, z.externalId],
  );
  const orderId = rows[0]?.id ?? null;
  const profileId = rows[0]?.profile_id ?? w.profileId;
  // dodatkowo: koszyk z carts/* (token `cart:`) i koszyk piksela (bez sklepu) z tym samym tokenem,
  // także przy kolejnych aktualizacjach zamówienia (upsert zamyka tylko przy pierwszym pojawieniu)
  if (orderId) await zamknijKoszyki(k, z, profileId, p);
  return w.nagrobek;
}

/**
 * Zakup zamyka koszyk: po tokenach checkoutu/koszyka z zamówienia (webhook checkoutu i piksel)
 * oraz każdy otwarty koszyk tej osoby sprzed zamówienia. To szybkie wyjście z flow porzuconych
 * obok filtra „nie złożył zamówienia od startu flow” (E4b).
 */
async function zamknijKoszyki(k: Kontekst, z: ZamowienieSklepu, profileId: string | null, p: any) {
  const tokeny = [typeof p?.checkout_token === "string" ? p.checkout_token : null, typeof p?.cart_token === "string" ? `cart:${p.cart_token}` : null].filter(
    (x): x is string => Boolean(x),
  );
  const tokenKoszyka = typeof p?.cart_token === "string" ? p.cart_token : null;
  await k.klient.query(
    `update carts set stage = 'ordered', order_external_id = $4, updated_at = now()
      where tenant_id = $1 and stage <> 'ordered' and (
            (store_id = $2 and platform_token = any($3::text[]))
         or (store_id is null and $5::text is not null and platform_token = $5)
         or ($6::uuid is not null and store_id = $2 and profile_id = $6 and source_updated_at <= $7::timestamptz + interval '5 minutes'))`,
    [k.tenantId, k.storeId, tokeny, z.externalId, tokenKoszyka, profileId, z.occurredAt],
  );
}

function glowne(minor: number, waluta: string): number {
  const e = wykladnikWaluty(waluta);
  return Number((minor / 10 ** e).toFixed(e));
}

/** refunds/create → Refunded Order (unique_id = id zwrotu). Kwota z transakcji zwrotu. */
async function zwrot(k: Kontekst, p: any) {
  const id = idZGid(p?.id);
  const zamowienieId = idZGid(p?.order_id);
  if (!id || !zamowienieId) throw new BladMapowaniaShopify("zwrot bez id albo order_id");
  if (typeof p.created_at !== "string") throw new BladMapowaniaShopify(`zwrot ${id}: brak created_at`);
  const kiedy = new Date(p.created_at);
  if (Number.isNaN(kiedy.getTime())) throw new BladMapowaniaShopify(`zwrot ${id}: nieczytelne created_at`);
  const { rows } = await k.klient.query<{ id: string; profile_id: string | null; currency: string }>(
    "select id, profile_id, currency from orders where tenant_id = $1 and store_id = $2 and external_id = $3",
    [k.tenantId, k.storeId, zamowienieId],
  );
  const waluta = rows[0]?.currency ?? k.waluta;
  let suma = 0n;
  for (const t of Array.isArray(p.transactions) ? p.transactions : []) {
    if (t?.kind === "refund" && (t?.status ?? "success") === "success") suma += naMinor(t.amount, waluta) ?? 0n;
  }
  await zapiszZdarzenie(k.klient, {
    tenantId: k.tenantId,
    metryka: METRYKI_SHOPIFY.zwroconeZamowienie,
    profileId: rows[0]?.profile_id ?? null,
    occurredAt: kiedy,
    uniqueId: `ref:${id}`,
    valueMinor: suma,
    valueCurrency: waluta,
    properties: { OrderId: zamowienieId, RefundId: id, $value: glowne(Number(suma), waluta) },
    source: "webhook",
  });
}

// ── checkout i koszyk ─────────────────────────────────────────────────────────────────

/**
 * checkouts/create|update → stan `carts` (link powrotu `abandoned_checkout_url`) i, gdy checkout
 * zna już e-mail, „Started Checkout” (integracja `shopify`) raz na checkout. Profil powstaje
 * BEZ zgody (konto/checkout to nie zgoda, FR27); zgoda tylko z jawnego checkboxa marketingu
 * w checkoucie (`buyer_accepts_marketing`) i z webhooka zgód. To, czy mail o porzuconym
 * checkoucie wyjdzie, rozstrzyga i tak `canSendTo` (D6: tylko osoby ze zgodą).
 */
function linkNaDomenieSklepu(k: Kontekst, link: string | null): string | null {
  if (!link) return null;
  try {
    const host = new URL(link).hostname.toLowerCase();
    const dozwolone = [k.domenaSklepu, k.domenaPubliczna ? new URL(k.domenaPubliczna).hostname.toLowerCase() : null];
    return dozwolone.includes(host) ? link : null;
  } catch {
    return null;
  }
}

async function checkout(k: Kontekst, c: CheckoutShopify): Promise<boolean> {
  if (c.zakonczony) {
    await k.klient.query(
      `update carts set stage = 'ordered', updated_at = now()
        where tenant_id = $1 and store_id = $2 and platform_token = $3 and stage <> 'ordered'`,
      [k.tenantId, k.storeId, c.token],
    );
    return false;
  }
  let profileId: string | null = null;
  if (c.email) {
    if (await nagrobek(k.klient, k.tenantId, { email: c.email, storeId: k.storeId, externalCustomerId: c.customerId })) return true;
    const profil = await profilPoEmailu(k.klient, k.tenantId, c.email.trim().toLowerCase(), { imie: c.imie, nazwisko: c.nazwisko });
    if (!profil) return true;
    profileId = profil.profileId;
  }
  const wartosc = c.wartoscMinor ?? c.pozycje.reduce((s, x) => s + Number(x.price_minor ?? 0) * x.qty, 0);
  // link powrotu tylko na domenie TEGO sklepu (myshopify albo domena główna): obcy link w mailu
  // „wróć do checkoutu” to phishing nawet przy podpisanym webhooku
  const link = linkNaDomenieSklepu(k, c.linkPowrotu);
  const { zapisany } = await zapiszKoszykSklepu(k.klient, {
    tenantId: k.tenantId,
    storeId: k.storeId,
    profileId,
    email: c.email ? c.email.trim().toLowerCase() : null,
    koszyk: { token: c.token, etap: "checkout", pozycje: c.pozycje, wartoscMinor: wartosc, waluta: c.waluta, linkPowrotu: link, zmodyfikowaneAt: c.zmieniony },
    hostSklepu: link ? new URL(link).hostname : k.domenaSklepu,
  });
  if (!profileId) return false;
  if (c.zgodaMarketingowa && c.email) {
    await zapiszZgodeSklepu(k.klient, k.tenantId, profileId, {
      email: c.email.trim().toLowerCase(),
      stan: "granted",
      zrodlo: "shopify",
      kiedy: c.zmieniony,
      szczegol: "checkout Shopify: zaznaczona zgoda na e-maile marketingowe (buyer_accepts_marketing)",
    });
  }
  // payload starszy od zapisanego albo checkout już kupiony: bez zdarzenia
  if (!zapisany) return false;
  await zapiszZdarzenie(k.klient, {
    tenantId: k.tenantId,
    metryka: METRYKI_SHOPIFY.rozpoczetyCheckout,
    profileId,
    occurredAt: c.zmieniony,
    uniqueId: `sc:${c.token}`,
    valueMinor: wartosc,
    valueCurrency: c.waluta,
    properties: {
      $value: glowne(wartosc, c.waluta),
      CheckoutURL: link,
      CheckoutToken: c.token,
      ItemNames: c.pozycje.map((x) => x.title),
      Items: c.pozycje.map((x) => ({
        ProductID: x.product_id,
        VariantID: x.variant_id,
        ProductName: x.title,
        Quantity: x.qty,
        ItemPrice: x.price_minor === null ? null : glowne(Number(x.price_minor), c.waluta),
        ImageURL: x.image_url,
      })),
    },
    source: "webhook",
  });
  return false;
}

/** carts/create|update: stan koszyka (bez e-maila; profil tylko z koszyka piksela o tym samym tokenie). */
async function koszyk(k: Kontekst, p: any) {
  const kz = koszykZWebhooka(p, k.waluta);
  const { rows } = await k.klient.query<{ profile_id: string | null }>(
    `select profile_id from carts where tenant_id = $1 and store_id is null and platform_token = $2`,
    [k.tenantId, kz.token],
  );
  const wartosc = kz.pozycje.reduce((s, x) => s + Number(x.price_minor ?? 0) * x.qty, 0);
  await zapiszKoszykSklepu(k.klient, {
    tenantId: k.tenantId,
    storeId: k.storeId,
    profileId: rows[0]?.profile_id ?? null,
    email: null,
    koszyk: { token: `cart:${kz.token}`, etap: "cart", pozycje: kz.pozycje, wartoscMinor: wartosc, waluta: k.waluta, linkPowrotu: null, zmodyfikowaneAt: kz.zmieniony },
    hostSklepu: k.domenaSklepu,
  });
}

// ── klienci i zgody ───────────────────────────────────────────────────────────────────

async function klientSklepu(k: Kontekst, p: any): Promise<boolean> {
  const dane = klientZWebhooka(p);
  const w = await upsertProfilKlienta(k.klient, k.tenantId, dane, k.storeId);
  if (!w) return false;
  if (w.nagrobek) return true;
  if (w.nowy || w.zaktualizowany) {
    await emitujKlienta(k.klient, k.tenantId, {
      profileId: w.profileId,
      typ: w.nowy ? "customer.created" : "customer.updated",
      kiedy: w.nowy ? dane.occurredAt : dane.zmodyfikowaneAt,
      storeId: k.storeId,
      klientSklepu: dane,
      kanal: "webhook",
    });
  }
  // nowsze wersje API niosą zgodę także w customers/update
  if (p?.email_marketing_consent && typeof p.email_marketing_consent === "object") {
    await zgodaDlaProfilu(k, w.profileId, zgodaZWebhooka({ ...p, customer_id: p.id, email_address: p.email }));
  }
  return false;
}

async function zgoda(k: Kontekst, p: any): Promise<boolean> {
  const z = zgodaZWebhooka(p);
  if (!z.email || !z.stan) return false;
  const email = z.email.trim().toLowerCase();
  if (await nagrobek(k.klient, k.tenantId, { email, storeId: k.storeId, externalCustomerId: z.customerId })) return true;
  let profileId: string | null = null;
  if (z.stan === "granted") {
    profileId = (await profilPoEmailu(k.klient, k.tenantId, email, { imie: null, nazwisko: null }))?.profileId ?? null;
  } else {
    const { rows } = await k.klient.query<{ id: string }>("select id from profiles where tenant_id = $1 and lower(btrim(email)) = $2", [k.tenantId, email]);
    profileId = rows[0]?.id ?? null;
  }
  if (profileId) await zgodaDlaProfilu(k, profileId, z);
  return false;
}

async function zgodaDlaProfilu(k: Kontekst, profileId: string, z: ReturnType<typeof zgodaZWebhooka>) {
  if (!z.stan || !z.email) return;
  await zapiszZgodeSklepu(k.klient, k.tenantId, profileId, {
    email: z.email.trim().toLowerCase(),
    stan: z.stan,
    zrodlo: "shopify",
    // brak daty zmiany w Shopify (np. stary klient): czas wyzwolenia webhooka, nie now() zapisu
    kiedy: z.kiedy ?? k.wyzwolono,
    szczegol: `Shopify emailMarketingConsent: ${z.stan === "granted" ? "subscribed" : "unsubscribed"}${z.poziom ? `, ${z.poziom}` : ""}${z.customerId ? `, klient ${z.customerId}` : ""}`,
  });
}
