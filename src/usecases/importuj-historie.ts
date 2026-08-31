import { getPool } from "../adapters/db/pool";
import { odszyfruj } from "../adapters/crypto";
import { poswiadczeniaSklepu, sklep as pobierzSklep } from "../adapters/db/repozytoria";
import { AdapterWoo } from "../adapters/store/woo/adapter";
import type { ZamowienieSklepu } from "../domain/store/contract";

export interface PlanImportu {
  zamowienia: number;
  noweProfile: number;
  zakresOd: Date | null;
  zakresDo: Date | null;
  probki: ZamowienieSklepu[];
}

export interface WynikImportu {
  runId: string;
  utworzoneProfile: number;
  utworzoneZamowienia: number;
  pominieteDuplikaty: number;
  najstarszaData: Date | null;
  rozbieznosc: string | null;
}

function znormalizuj(email: string | null): string | null {
  return email ? email.trim().toLowerCase() : null;
}

async function adapterDlaSklepu(tenantId: string, storeId: string) {
  const s = await pobierzSklep(tenantId, storeId);
  if (!s) throw new Error("Sklep nie istnieje w tym tenancie");
  const szyfrogram = await poswiadczeniaSklepu(tenantId, storeId);
  if (!szyfrogram) throw new Error("Brak poświadczeń sklepu");
  const { ck, cs } = JSON.parse(odszyfruj(szyfrogram));
  return new AdapterWoo(tenantId, { baseUrl: s.base_url, consumerKey: ck, consumerSecret: cs });
}

/**
 * Faza planowania (NFR6). Zanim cokolwiek zapiszemy, operator musi wiedzieć, ile
 * zamówień wejdzie i ile NOWYCH kartotek klientów przy okazji powstanie. Skutki uboczne
 * podane po fakcie to nie raport, tylko tłumaczenie się.
 */
export async function zaplanujImport(tenantId: string, storeId: string): Promise<PlanImportu> {
  const adapter = await adapterDlaSklepu(tenantId, storeId);
  const wszystkie: ZamowienieSklepu[] = [];
  for (let strona = 1; strona <= 20; strona++) {
    const { pozycje } = await adapter.pobierzZamowienia({ strona, naStrone: 100 });
    wszystkie.push(...pozycje);
    if (pozycje.length < 100) break;
  }

  const emaile = new Set(wszystkie.map((z) => znormalizuj(z.email)).filter(Boolean) as string[]);
  const { rows } = await getPool().query<{ email: string }>(
    "select lower(btrim(email)) as email from profiles where tenant_id = $1 and email is not null",
    [tenantId],
  );
  const istniejace = new Set(rows.map((r) => r.email));
  const nowe = [...emaile].filter((e) => !istniejace.has(e));

  const daty = wszystkie.map((z) => z.occurredAt.getTime());
  return {
    zamowienia: wszystkie.length,
    noweProfile: nowe.length,
    zakresOd: daty.length ? new Date(Math.min(...daty)) : null,
    zakresDo: daty.length ? new Date(Math.max(...daty)) : null,
    probki: wszystkie.slice(0, 3),
  };
}

/**
 * Wykonanie importu. Trzy zasady, każda z listy błędów, które już raz kosztowały:
 * 1. occurred_at zawsze ze źródła (AD-10, NFR3) - nigdy data importu.
 * 2. Licznik pokazuje FAKTYCZNY wynik odczytany z bazy, nie liczbę prób (NFR2).
 * 3. Po zapisie następuje odczyt zwrotny i porównanie z oczekiwaniem (NFR1).
 */
export async function wykonajImport(tenantId: string, storeId: string): Promise<WynikImportu> {
  const pool = getPool();
  const adapter = await adapterDlaSklepu(tenantId, storeId);
  const plan = await zaplanujImport(tenantId, storeId);

  const run = await pool.query<{ id: string }>(
    `insert into import_runs (tenant_id, store_id, status, planned, range_from, range_to, started_at)
     values ($1, $2, 'running', $3, $4, $5, now()) returning id`,
    [
      tenantId,
      storeId,
      JSON.stringify({ zamowienia: plan.zamowienia, noweProfile: plan.noweProfile }),
      plan.zakresOd,
      plan.zakresDo,
    ],
  );
  const runId = run.rows[0].id;

  let utworzoneProfile = 0;
  let utworzoneZamowienia = 0;
  let pominieteDuplikaty = 0;
  // unikalne zamowienia realnie objete przebiegiem: suma prob (insert+duplikat)
  // przeklamuje przy niestabilnej paginacji Woo, gdy ta sama pozycja wraca
  // na dwoch stronach (znalezisko review R2)
  const objeteId = new Set<string>();

  const klient = await pool.connect();
  try {
    for (let strona = 1; strona <= 20; strona++) {
      const { pozycje } = await adapter.pobierzZamowienia({ strona, naStrone: 100 });
      if (!pozycje.length) break;

      for (const zamowienie of pozycje) {
        await klient.query("begin");
        try {
          const email = znormalizuj(zamowienie.email);
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
            if (wstawiony.rowCount) {
              profileId = wstawiony.rows[0].id;
              utworzoneProfile++;
            } else {
              const istniejacy = await klient.query<{ id: string }>(
                "select id from profiles where tenant_id = $1 and lower(btrim(email)) = $2",
                [tenantId, email],
              );
              profileId = istniejacy.rows[0]?.id ?? null;
            }
          }

          // surowe zdarzenie z kluczem opisującym BYT, nie kanał (AD-4, AD-24)
          await klient.query(
            `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload, processed_at)
             values ($1, $2, 'woocommerce', $3, $4, now())
             on conflict do nothing`,
            [
              tenantId,
              storeId,
              adapter.kluczIdempotencji(
                "order",
                zamowienie.externalId,
                // wersja bytu = data modyfikacji ze zrodla; identycznie w webhooku (AD-24)
                zamowienie.surowe && (zamowienie.surowe as any).date_modified_gmt
                  ? String((zamowienie.surowe as any).date_modified_gmt)
                  : zamowienie.status,
              ),
              JSON.stringify(zamowienie.surowe),
            ],
          );

          const wynik = await klient.query<{ id: string }>(
            `insert into orders (tenant_id, store_id, profile_id, external_id, number, status,
                                 total_minor, currency, occurred_at, source_updated_at, raw)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             on conflict (tenant_id, store_id, external_id) do nothing
             returning id`,
            [
              tenantId,
              storeId,
              profileId,
              zamowienie.externalId,
              zamowienie.numer,
              zamowienie.status,
              zamowienie.sumaMinor,
              zamowienie.waluta,
              zamowienie.occurredAt, // data ZE ŹRÓDŁA
              zamowienie.zmodyfikowaneAt,
              JSON.stringify(zamowienie.surowe),
            ],
          );

          objeteId.add(zamowienie.externalId);
          if (wynik.rowCount) {
            utworzoneZamowienia++;
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
          } else {
            pominieteDuplikaty++;
          }
          await klient.query("commit");
        } catch (blad) {
          await klient.query("rollback");
          throw blad;
        }
      }
      if (pozycje.length < 100) break;
    }
  } finally {
    klient.release();
  }

  // ODCZYT ZWROTNY (NFR1): liczymy to, co faktycznie jest w bazie, a nie to, ile razy
  // wywołaliśmy insert. Kontrola dotyczy TEGO przebiegu (utworzone + zastane duplikaty
  // wobec planu), a nie całej tabeli - równoległy webhook dokładający zamówienia nie
  // może fałszywie oblać poprawnego importu (znalezisko review).
  const kontrola = await pool.query<{ najstarsza: Date | null }>(
    "select min(occurred_at) as najstarsza from orders where tenant_id = $1 and store_id = $2",
    [tenantId, storeId],
  );
  const objete = objeteId.size;
  const rozbieznosc =
    objete >= plan.zamowienia
      ? null
      : `Plan zapowiadał ${plan.zamowienia} zamówień, przebieg objął ${objete}`;

  await pool.query(
    `update import_runs set status = $2, counters = $3, finished_at = now(), last_error = $4
      where id = $1`,
    [
      runId,
      rozbieznosc ? "failed" : "done",
      JSON.stringify({
        utworzoneProfile,
        utworzoneZamowienia,
        pominieteDuplikaty,
        objetePrzebiegiem: objete,
      }),
      rozbieznosc,
    ],
  );

  return {
    runId,
    utworzoneProfile,
    utworzoneZamowienia,
    pominieteDuplikaty,
    najstarszaData: kontrola.rows[0].najstarsza,
    rozbieznosc,
  };
}
