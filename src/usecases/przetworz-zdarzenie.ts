import type { PoolClient } from "pg";
import { getPool } from "../adapters/db/pool";
import { hashAdresu } from "../adapters/hash-adresu";
import { definicjaPlatformy, definicjaPoZrodle } from "../adapters/store/rejestr";
import { DEFINICJA_WOO } from "../adapters/store/woo/definicja";
import { bytZKlucza } from "../adapters/store/webhooki";
import type { KlientSklepu, PlatformaSklepu, ZamowienieSklepu } from "../domain/store/contract";
import { wyslijAlert } from "../jobs/alerty";
import { zapiszProduktySklepu } from "./katalog/katalog-sklepu";
import { zamknijKoszykiZamowieniem } from "./katalog/koszyki";
import { emitujKlienta, emitujStatusZamowienia, emitujZamowienie } from "./zdarzenia/emisja-sklepu";

/**
 * Faza 2 ingestu webhooków (AD-4): surowe zdarzenie z raw_events zamienia się
 * w profil + zamówienie (order.*) albo w profil (customer.*) w modelu domenowym.
 * Idempotentne w dwóch warstwach: processed_at odcina powtórne przetworzenie tego
 * samego zdarzenia (wiersz zajmowany `for update`, żeby dwa workery nie przetworzyły
 * go naraz), a upsert po (tenant_id, store_id, external_id) / e-mailu czyni powtórkę
 * nieszkodliwą.
 *
 * Co mapować, mówi BYT zapisany w kluczu idempotencji (`woocommerce:{tenant}:{byt}:...`),
 * nie zgadywanie po kształcie payloadu: klient Woo mapowany jako zamówienie wywracał
 * joba pięć razy z rzędu na `naGrosze(undefined)` (audyt #4).
 *
 * order.updated NADPISUJE status i kwotę (zamówienie mogło przejść pending→completed),
 * ale nigdy occurred_at - data złożenia pochodzi ze źródła i się nie zmienia (AD-10).
 *
 * customer.* zakłada albo uzupełnia profil BEZ zgody marketingowej: konto w sklepie
 * to nie zgoda na newsletter (FR27). Zgoda wchodzi wyłącznie z rejestru zgód
 * (checkout, popup, import zgód), więc bramka wysyłki takich profili nie wpuści.
 *
 * NAGROBKI RODO (0024): osoba, której dane zanonimizowano, nie wraca do bazy przez
 * webhook ani import. Trafienie w nagrobek (hasz adresu albo id konta w sklepie) =
 * brak profilu, payload surowego zdarzenia od razu zaślepiony, zamówienie zapisane
 * bez osoby (przychód w raportach zostaje).
 *
 * Payload, którego nie da się zmapować (błąd deterministyczny: brak daty, kwoty), NIE
 * wraca do kolejki: dostaje `process_error`, `processed_at` i jeden alert. Pięć prób
 * i alert co dobę bez końca niczego by nie naprawiły (review, dead-letter).
 */
export async function przetworzZdarzenie(tenantId: string, rawEventId: string): Promise<void> {
  const pool = getPool();
  // Shopify (0047) ma tematy spoza bytów portu (checkouty z linkiem powrotu, zgody, zwroty, RODO,
  // odinstalowanie) i własną fazę 2 po TEMACIE; ten sam rodzaj joba, więc ponawianie zaległych
  // działa dla obu platform. Zamówienia i klienci Shopify i tak idą przez wspólny upsert portu.
  const { rows: zrodlo } = await pool.query<{ source: string }>("select source from raw_events where tenant_id = $1 and id = $2", [tenantId, rawEventId]);
  if (zrodlo[0]?.source === "shopify") {
    const { przetworzZdarzenieShopify } = await import("./shopify/przetwarzanie");
    await przetworzZdarzenieShopify(tenantId, rawEventId);
    return;
  }
  const klient = await pool.connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query(
      `select store_id, source, payload, processed_at, idempotency_key
         from raw_events where tenant_id = $1 and id = $2
         for update`,
      [tenantId, rawEventId],
    );
    const zdarzenie = rows[0];
    if (!zdarzenie || zdarzenie.processed_at) {
      await klient.query("rollback");
      return;
    }

    // platforma z `raw_events.source` (port „Sklep”); surowe zdarzenia sprzed portu to Woo
    const definicja = definicjaPoZrodle(String(zdarzenie.source ?? "")) ?? DEFINICJA_WOO;
    const byt = bytZKlucza(String(zdarzenie.idempotency_key));
    if (byt === null) {
      throw new Error(`raw_event ${rawEventId}: klucz idempotencji bez rozpoznawalnego bytu`);
    }

    let zaslep = false;
    let blad: string | null = null;
    if (zdarzenie.payload && typeof zdarzenie.payload === "object" && "anonimizowano" in zdarzenie.payload) {
      // zaślepka po RODO: nie ma czego przetwarzać, nie ma czego ponawiać
      blad = "anonimizowano";
    } else if (byt === "customer") {
      try {
        const dane = mapujAlboOdloz(() => definicja.mapujKlienta(zdarzenie.payload));
        zaslep = await przetworzKlienta(klient, tenantId, zdarzenie.store_id, dane);
      } catch (b) {
        if (!(b instanceof BladMapowania)) throw b;
        blad = b.message;
      }
    } else if (byt === "order") {
      try {
        const zamowienie = mapujAlboOdloz(() => definicja.mapujZamowienie(zdarzenie.payload));
        zaslep = await przetworzZamowienie(klient, tenantId, zdarzenie.store_id, zamowienie, definicja.platforma);
      } catch (b) {
        if (!(b instanceof BladMapowania)) throw b;
        blad = b.message;
      }
    } else if (byt === "product" && definicja.mapujProdukt) {
      // product.*: katalog (E.4). Produkt usunięty/wycofany = active=false, nigdy kasowanie.
      try {
        const produkt = mapujAlboOdloz(() => definicja.mapujProdukt!(zdarzenie.payload));
        await zapiszProduktySklepu(klient, tenantId, zdarzenie.store_id, [produkt], "webhook");
      } catch (b) {
        if (!(b instanceof BladMapowania)) throw b;
        blad = b.message;
      }
    } else {
      // byt bez mapowania na tej platformie: klucz jest poprawny - zdarzenie oznaczamy
      // jako przetworzone, żeby nie krążyło w kolejce do wyczerpania prób
    }

    if (zaslep) {
      await klient.query(
        `update raw_events set payload = ${ZASLEPKA_PAYLOADU}, process_error = 'rodo:nagrobek'
          where tenant_id = $1 and id = $2`,
        [tenantId, rawEventId],
      );
    }
    await klient.query(
      `update raw_events set processed_at = now(), process_error = coalesce($3, process_error)
        where tenant_id = $1 and id = $2`,
      [tenantId, rawEventId, blad],
    );
    await klient.query("commit");
    if (blad && blad !== "anonimizowano") {
      await wyslijAlert(
        `webhook ${byt} (raw_event ${rawEventId}) nie da się przetworzyć: ${blad}. Zdarzenie odłożone z process_error, nie wróci do kolejki.`,
        { poziom: "uwaga", tenantId },
      );
    }
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

/** Zaślepka payloadu surowego zdarzenia - ta sama co przy anonimizacji (profil-rodo.ts). */
export const ZASLEPKA_PAYLOADU = `case split_part(idempotency_key, ':', 3)
  when 'order' then jsonb_build_object('anonimizowano', true, 'order_id', payload ->> 'id', 'total', payload ->> 'total')
  else jsonb_build_object('anonimizowano', true, 'customer_id', payload ->> 'id') end`;

/** Błąd deterministyczny mapowania: ponawianie niczego nie zmieni. */
export class BladMapowania extends Error {}

function mapujAlboOdloz<T>(mapuj: () => T): T {
  try {
    return mapuj();
  } catch (b) {
    throw new BladMapowania(b instanceof Error ? b.message : String(b));
  }
}

/**
 * Czy dla tego adresu / konta sklepu istnieje nagrobek RODO w tenancie.
 * Sprawdzane PRZED każdym utworzeniem profilu z danych sklepu.
 */
export async function nagrobek(
  klient: PoolClient,
  tenantId: string,
  dane: { email?: string | null; storeId?: string | null; externalCustomerId?: string | null },
): Promise<boolean> {
  const hash = dane.email ? hashAdresu(dane.email) : null;
  const { rows } = await klient.query<{ jest: boolean }>(
    `select exists (
       select 1 from rodo_nagrobki n
        where n.tenant_id = $1
          and (($2::text is not null and n.email_hash = $2)
               or ($3::uuid is not null and $4::text is not null
                   and n.store_id = $3 and n.external_customer_ids @> array[$4::text]))
     ) as jest`,
    [tenantId, hash, dane.storeId ?? null, dane.externalCustomerId ?? null],
  );
  return rows[0].jest;
}

/**
 * Profil po e-mailu z danych ZAMÓWIENIA: wstawienie albo odnalezienie istniejącego.
 * Imię i nazwisko uzupełniamy tylko tam, gdzie profil ich nie ma - zamówienie nie ma
 * prawa nadpisać danych, które klient podał później przy koncie (od tego jest
 * `customer.updated`). Null przy nagrobku RODO.
 */
export async function profilPoEmailu(
  klient: PoolClient,
  tenantId: string,
  email: string,
  dane: { imie: string | null; nazwisko: string | null },
): Promise<{ profileId: string; nowy: boolean } | null> {
  if (await nagrobek(klient, tenantId, { email })) return null;
  const wstawiony = await klient.query<{ id: string; nowy: boolean }>(
    `insert into profiles (tenant_id, email, first_name, last_name)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, (lower(btrim(email)))) where email is not null
     do update set first_name = coalesce(profiles.first_name, excluded.first_name),
                   last_name = coalesce(profiles.last_name, excluded.last_name)
     returning id, (xmax = 0) as nowy`,
    [tenantId, email, dane.imie, dane.nazwisko],
  );
  return { profileId: wstawiony.rows[0].id, nowy: wstawiony.rows[0].nowy };
}

export interface WynikUpsertuZamowienia {
  orderId: string | null;
  /** zamówienie pojawiło się PIERWSZY raz (zdarzenie `order.created` wystawione) */
  nowe: boolean;
  /** istniało, a payload był nie starszy niż zapisany: status/kwota/raw nadpisane */
  zaktualizowane: boolean;
  /** istniało z nowszą wersją: payload pominięty */
  pominiete: boolean;
  /** profil osoby (null: gość bez e-maila albo nagrobek RODO) */
  profileId: string | null;
  /** trafienie w nagrobek RODO: zamówienie zapisane bez osoby i bez surowego dokumentu */
  nagrobek: boolean;
}

/**
 * JEDEN upsert zamówienia dla webhooka i importu. Kolejność dostarczania webhooków nie
 * jest gwarantowana: nadpisujemy tylko payloadem nie starszym od zapisanego
 * (source_updated_at ze źródła, 0013); wiersz sprzed migracji (null) jest dowolnie stary.
 * Import używa TEJ SAMEJ funkcji: `on conflict do nothing` w imporcie zostawiał status
 * `pending`, a późniejszy webhook z tą samą wersją odpadał jako duplikat (review #2).
 */
export async function upsertZamowienie(
  klient: PoolClient,
  tenantId: string,
  storeId: string,
  zamowienie: ZamowienieSklepu,
  opcje: { kanal?: "webhook" | "import"; platforma?: Exclude<PlatformaSklepu, "custom"> } = {},
): Promise<WynikUpsertuZamowienia> {
  const platforma = opcje.platforma ?? "woocommerce";
  const definicja = definicjaPlatformy(platforma);
  const email = zamowienie.email ? zamowienie.email.trim().toLowerCase() : null;
  let profileId: string | null = null;
  let trafionyNagrobek = false;
  if (email) {
    const profil = await profilPoEmailu(klient, tenantId, email, { imie: zamowienie.imie, nazwisko: zamowienie.nazwisko });
    if (profil) profileId = profil.profileId;
    else trafionyNagrobek = true;
  }
  const surowe = trafionyNagrobek ? { zanonimizowane: true } : zamowienie.surowe;

  // status sprzed zapisu: metryka statusu (Fulfilled/Cancelled/Refunded) tylko przy ZMIANIE roli
  const { rows: poprzedni } = await klient.query<{ status: string }>(
    "select status from orders where tenant_id = $1 and store_id = $2 and external_id = $3 for update",
    [tenantId, storeId, zamowienie.externalId],
  );

  // osłona `>` (nie `>=`): ta sama wersja ze źródła nie jest aktualizacją, tylko powtórką
  // (ponowny import po webhooku) i liczy się jako duplikat, nie "zaktualizowane"
  const wynik = await klient.query<{ id: string; nowe: boolean }>(
    `insert into orders (tenant_id, store_id, profile_id, external_id, number, status,
                         total_minor, currency, occurred_at, source_updated_at, raw)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (tenant_id, store_id, external_id) do update
       set status = excluded.status,
           total_minor = excluded.total_minor,
           currency = excluded.currency,
           raw = excluded.raw,
           source_updated_at = excluded.source_updated_at,
           profile_id = coalesce(orders.profile_id, excluded.profile_id)
       where excluded.source_updated_at
             > coalesce(orders.source_updated_at, '-infinity'::timestamptz)
     returning id, (xmax = 0) as nowe`,
    [
      tenantId,
      storeId,
      profileId,
      zamowienie.externalId,
      zamowienie.numer,
      zamowienie.status,
      zamowienie.sumaMinor,
      zamowienie.waluta,
      zamowienie.occurredAt,
      zamowienie.zmodyfikowaneAt,
      JSON.stringify(surowe),
    ],
  );
  const wiersz = wynik.rows[0];
  if (!wiersz) {
    return { orderId: null, nowe: false, zaktualizowane: false, pominiete: true, profileId, nagrobek: trafionyNagrobek };
  }

  // zdarzenie domenowe tylko przy PIERWSZYM pojawieniu się zamówienia: na nim
  // wiszą automatyzacje post-purchase, a zmiana statusu nie jest nowym zakupem.
  // `kanal: import` pozwala silnikowi automatyzacji pominąć zamówienia z importu
  // historii - hurtowe "dziękujemy za zakup" tydzień po fakcie to nie automatyzacja
  if (wiersz.nowe) {
    // metryki „Placed Order” + „Ordered Product” na pozycję (plan 1.3) przez jedyny punkt
    // zapisu strumienia; lustro `order.created` w starej tabeli events dla obecnego silnika
    await emitujZamowienie(klient, tenantId, {
      orderId: wiersz.id,
      profileId,
      zamowienie,
      kanal: opcje.kanal ?? "webhook",
      platforma,
    });
    // zakup zamyka koszyk (E.5): po tokenie koszyka z zamówienia i koszyki tej osoby sprzed zakupu
    await zamknijKoszykiZamowieniem(klient, tenantId, {
      storeId,
      profileId,
      token: zamowienie.tokenKoszyka ?? null,
      orderExternalId: zamowienie.externalId,
      kiedy: zamowienie.occurredAt,
    });
  }
  const rolaNowa = definicja?.rolaStatusu(zamowienie.status) ?? null;
  const rolaStara = poprzedni[0] ? (definicja?.rolaStatusu(poprzedni[0].status) ?? null) : null;
  if (rolaNowa && rolaNowa !== rolaStara) {
    await emitujStatusZamowienia(klient, tenantId, {
      orderId: wiersz.id,
      profileId,
      zamowienie,
      rola: rolaNowa,
      kanal: opcje.kanal ?? "webhook",
      platforma,
    });
  }
  return {
    orderId: wiersz.id,
    nowe: wiersz.nowe,
    zaktualizowane: !wiersz.nowe,
    pominiete: false,
    profileId,
    nagrobek: trafionyNagrobek,
  };
}

async function przetworzZamowienie(
  klient: PoolClient,
  tenantId: string,
  storeId: string,
  zamowienie: ZamowienieSklepu,
  platforma: Exclude<PlatformaSklepu, "custom">,
): Promise<boolean> {
  const wynik = await upsertZamowienie(klient, tenantId, storeId, zamowienie, { kanal: "webhook", platforma });
  return wynik.nagrobek;
}

/**
 * Upsert profilu z danych KLIENTA sklepu. Wspólny dla webhooka `customer.*` i importu
 * `/customers`, żeby oba kanały pisały profil tak samo. Zwraca id profilu i czy powstał
 * teraz; null, gdy klient nie ma e-maila (Woo dopuszcza konto bez adresu - nie mamy
 * po czym go rozpoznać) albo trafił w nagrobek RODO (`nagrobek: true`).
 *
 * Bez wpisu do `consents` - CELOWO (FR27). Dane z konta są świeższe niż imię z dawnego
 * zamówienia, więc nadpisują niepuste pola - ale tylko payloadem nie starszym od
 * zapisanego (`source_updated_at`, 0024): zaległe zdarzenie odtworzone po dobie nie
 * cofa nowszych danych.
 */
export async function upsertProfilKlienta(
  klient: PoolClient,
  tenantId: string,
  dane: KlientSklepu,
  storeId: string | null = null,
): Promise<{ profileId: string; nowy: boolean; zaktualizowany: boolean; nagrobek: false } | { nagrobek: true } | null> {
  const email = dane.email ? dane.email.trim().toLowerCase() : null;
  if (!email) return null;
  if (await nagrobek(klient, tenantId, { email, storeId, externalCustomerId: dane.externalId })) {
    return { nagrobek: true };
  }
  const { rows } = await klient.query<{ id: string; nowy: boolean; zaktualizowany: boolean }>(
    `insert into profiles (tenant_id, email, first_name, last_name, phone, source_updated_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, (lower(btrim(email)))) where email is not null
     do update set first_name = coalesce(excluded.first_name, profiles.first_name),
                   last_name = coalesce(excluded.last_name, profiles.last_name),
                   phone = coalesce(excluded.phone, profiles.phone),
                   source_updated_at = excluded.source_updated_at
       where excluded.source_updated_at >= coalesce(profiles.source_updated_at, '-infinity'::timestamptz)
     returning id, (xmax = 0) as nowy, (xmax <> 0) as zaktualizowany`,
    [tenantId, email, dane.imie, dane.nazwisko, dane.telefon, dane.zmodyfikowaneAt],
  );
  if (rows[0]) {
    return { profileId: rows[0].id, nowy: rows[0].nowy, zaktualizowany: rows[0].zaktualizowany, nagrobek: false };
  }
  // payload starszy niż zapisany: profil zostaje, jak jest
  const { rows: zastany } = await klient.query<{ id: string }>(
    "select id from profiles where tenant_id = $1 and lower(btrim(email)) = $2",
    [tenantId, email],
  );
  return { profileId: zastany[0].id, nowy: false, zaktualizowany: false, nagrobek: false };
}

async function przetworzKlienta(
  klient: PoolClient,
  tenantId: string,
  storeId: string,
  dane: KlientSklepu,
): Promise<boolean> {
  const wynik = await upsertProfilKlienta(klient, tenantId, dane, storeId);
  if (!wynik) return false;
  if (wynik.nagrobek) return true;
  // zdarzenie w strumieniu: `customer.created` przy pierwszym pojawieniu się profilu,
  // `customer.updated` przy każdej PRZYJĘTEJ zmianie danych (zaległy, starszy payload
  // nie zmienia nic i nie generuje zdarzenia). Data ZE ŹRÓDŁA (AD-10).
  if (!wynik.nowy && !wynik.zaktualizowany) return false;
  const typ = wynik.nowy ? "customer.created" : "customer.updated";
  const kiedy = wynik.nowy ? dane.occurredAt : dane.zmodyfikowaneAt;
  await emitujKlienta(klient, tenantId, {
    profileId: wynik.profileId,
    typ,
    kiedy,
    storeId,
    klientSklepu: dane,
    kanal: "webhook",
  });
  return false;
}
