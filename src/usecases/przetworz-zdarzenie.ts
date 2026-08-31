import { getPool } from "../adapters/db/pool";
import { mapujZamowienieWoo } from "../adapters/store/woo/adapter";

/**
 * Faza 2 ingestu webhooków (AD-4): surowe zdarzenie z raw_events zamienia się
 * w profil + zamówienie w modelu domenowym. Idempotentne w dwóch warstwach:
 * processed_at odcina powtórne przetworzenie tego samego zdarzenia, a upsert
 * po (tenant_id, store_id, external_id) czyni powtórkę nieszkodliwą.
 *
 * order.updated NADPISUJE status i kwotę (zamówienie mogło przejść pending→completed),
 * ale nigdy occurred_at - data złożenia pochodzi ze źródła i się nie zmienia (AD-10).
 */
export async function przetworzZdarzenie(tenantId: string, rawEventId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `select store_id, payload, processed_at
       from raw_events where tenant_id = $1 and id = $2`,
    [tenantId, rawEventId],
  );
  const zdarzenie = rows[0];
  if (!zdarzenie || zdarzenie.processed_at) return;

  const zamowienie = mapujZamowienieWoo(zdarzenie.payload);
  const email = zamowienie.email ? zamowienie.email.trim().toLowerCase() : null;

  const klient = await pool.connect();
  try {
    await klient.query("begin");

    let profileId: string | null = null;
    if (email) {
      const wstawiony = await klient.query<{ id: string }>(
        `insert into profiles (tenant_id, email, first_name, last_name)
         values ($1, $2, $3, $4)
         on conflict (tenant_id, (lower(btrim(email)))) where email is not null
         do nothing
         returning id`,
        [tenantId, email, zamowienie.imie, zamowienie.nazwisko],
      );
      profileId =
        wstawiony.rows[0]?.id ??
        (
          await klient.query<{ id: string }>(
            "select id from profiles where tenant_id = $1 and lower(btrim(email)) = $2",
            [tenantId, email],
          )
        ).rows[0]?.id ??
        null;
    }

    // kolejność dostarczania webhooków nie jest gwarantowana: nadpisujemy tylko
    // payloadem nie starszym od zapisanego (source_updated_at ze źródła, 0013).
    // Wiersz sprzed migracji (null) traktujemy jako dowolnie stary.
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
               >= coalesce(orders.source_updated_at, '-infinity'::timestamptz)
       returning id, (xmax = 0) as nowe`,
      [
        tenantId,
        zdarzenie.store_id,
        profileId,
        zamowienie.externalId,
        zamowienie.numer,
        zamowienie.status,
        zamowienie.sumaMinor,
        zamowienie.waluta,
        zamowienie.occurredAt,
        zamowienie.zmodyfikowaneAt,
        JSON.stringify(zamowienie.surowe),
      ],
    );

    // zdarzenie domenowe tylko przy PIERWSZYM pojawieniu się zamówienia: na nim
    // wiszą automatyzacje post-purchase, a zmiana statusu nie jest nowym zakupem
    if (wynik.rows[0]?.nowe) {
      await klient.query(
        `insert into events (tenant_id, profile_id, event_type, payload, occurred_at)
         values ($1, $2, 'order.created', $3, $4)`,
        [
          tenantId,
          profileId,
          JSON.stringify({ orderId: wynik.rows[0].id, totalMinor: zamowienie.sumaMinor }),
          zamowienie.occurredAt,
        ],
      );
    }

    await klient.query(
      "update raw_events set processed_at = now() where tenant_id = $1 and id = $2",
      [tenantId, rawEventId],
    );
    await klient.query("commit");
  } catch (blad) {
    await klient.query("rollback");
    throw blad;
  } finally {
    klient.release();
  }
}
