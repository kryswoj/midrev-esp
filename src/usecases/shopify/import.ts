import { getPool } from "../../adapters/db/pool";
import { pobierzWynikBulk, stanBulk, uruchomBulk, zapytanieBulk, zlozJsonl, type EtapBulk } from "../../adapters/store/shopify/bulk";
import { BladDostepuShopify, BladShopify } from "../../adapters/store/shopify/graphql";
import { klientZBulk, produktZBulk, zamowienieZBulk } from "../../adapters/store/shopify/mapowanie";
import { dodajZadanie } from "../../jobs/kolejka";
import { wyslijAlert } from "../../jobs/alerty";
import { profilPoEmailu, upsertProfilKlienta, upsertZamowienie } from "../przetworz-zdarzenie";
import { produktSklepuZShopify } from "../../adapters/store/shopify/definicja";
import { zapiszZgodeSklepu } from "../integracja/zgody-sklepu";
import { zapiszProduktySklepu } from "../katalog/katalog-sklepu";
import { OPCJE_UPSERTU_SHOPIFY } from "./przetwarzanie";
import { fetchShopify, klientDla, sklepShopify } from "./sklep";

/**
 * Import historii Shopify (plan A.3, F.1 krok 4) przez Bulk Operations, jako job wznawialny:
 *
 *   plan (liczności ze sklepu, skutki uboczne) → produkty → klienci ze zgodą → zamówienia
 *   z ostatnich N miesięcy (domyślnie 24) → odczyt zwrotny z bazy.
 *
 * Każde wywołanie joba robi JEDEN krok i, jeśli operacja bulk po stronie Shopify jeszcze trwa,
 * dodaje siebie ponownie z opóźnieniem (żaden worker nie wisi minutami na odpytywaniu). Stan
 * w `import_runs.progress`; pad workera = następny job czyta etap i id operacji i kontynuuje.
 *
 * Zasady z listy kontrolnej zapisu (CLAUDE.md, pkt 2–4, 6, 7):
 *   - daty ZE ŹRÓDŁA (createdAt/updatedAt), kanał `import` = backfill (nie wyzwala flow,
 *     nie wysyła maili po zakupie sprzed miesięcy),
 *   - plan PRZED startem mówi, ile zamówień, klientów ze zgodą i produktów wejdzie,
 *   - liczniki z faktycznych wyników (rowCount/odczyt zwrotny), nie z liczby prób,
 *   - zakres zapisu ograniczony do sklepu tego przebiegu (`store_id`).
 */

export const ODSTEP_ODPYTYWANIA_SEK = 10;
const ETAPY: EtapBulk[] = ["produkty", "klienci", "zamowienia"];
const PACZKA = 200;

export interface PlanImportuShopify {
  zamowienia: number | null;
  klienci: number | null;
  produkty: number | null;
  od: string;
  /** bez read_all_orders Shopify oddaje tylko ostatnie 60 dni */
  tylko60Dni: boolean;
  wejdaDoAutomatyzacji: 0;
}

const LICZNIKI = `query ($q: String!) {
  ordersCount(query: $q) { count }
  customersCount { count }
  productsCount { count }
}`;

export async function zaplanujImportShopify(tenantId: string, storeId: string, miesiace = 24): Promise<PlanImportuShopify> {
  const sklep = await sklepShopify(tenantId, storeId);
  if (!sklep) throw new Error("sklep Shopify nie istnieje w tym tenancie");
  const od = new Date();
  od.setUTCMonth(od.getUTCMonth() - miesiace);
  const tylko60Dni = !sklep.poswiadczenia.zakresy.includes("read_all_orders");
  let d: { ordersCount: { count: number } | null; customersCount: { count: number } | null; productsCount: { count: number } | null } | null = null;
  try {
    d = await klientDla(sklep).zapytanie(LICZNIKI, { q: `created_at:>='${od.toISOString()}'` }, 5);
  } catch (b) {
    if (b instanceof BladDostepuShopify) throw b;
  }
  return {
    zamowienia: d?.ordersCount?.count ?? null,
    klienci: d?.customersCount?.count ?? null,
    produkty: d?.productsCount?.count ?? null,
    od: od.toISOString(),
    tylko60Dni,
    wejdaDoAutomatyzacji: 0,
  };
}

/** Start przebiegu. Jeden trwający import na sklep (indeks z 0024): drugi start oddaje istniejący. */
export async function rozpocznijImportShopify(tenantId: string, storeId: string, plan: PlanImportuShopify): Promise<string> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    // blokada (tenant, sklep): dwa kliknięcia naraz nie założą dwóch przebiegów (review r1;
    // indeks z 0024 obejmuje tylko 'running', a nowy przebieg startuje jako 'planned')
    await klient.query("select pg_advisory_xact_lock(hashtextextended('import-shopify:' || $1::text || ':' || $2::text, 0))", [tenantId, storeId]);
    const { rows: trwa } = await klient.query<{ id: string }>(
      "select id from import_runs where tenant_id = $1 and store_id = $2 and status in ('planned', 'running') order by created_at desc limit 1",
      [tenantId, storeId],
    );
    if (trwa[0]) {
      await klient.query("commit");
      return trwa[0].id;
    }
    const { rows } = await klient.query<{ id: string }>(
      `insert into import_runs (tenant_id, store_id, status, planned, range_from, range_to, progress)
       values ($1, $2, 'planned', $3, $4, now(), '{"etap": null}'::jsonb) returning id`,
      [tenantId, storeId, JSON.stringify(plan), plan.od],
    );
    await dodajZadanie(tenantId, "import_shopify", { runId: rows[0].id }, { przez: klient });
    await klient.query("commit");
    return rows[0].id;
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}

export interface PostepImportu {
  etap: EtapBulk | "koniec" | null;
  bulkId?: string | null;
  obiekty?: number;
  zakonczoneEtapy?: EtapBulk[];
  liczniki?: Record<string, number>;
}

/** Jeden krok przebiegu. Zwraca, czy trzeba wrócić (job dodaje się sam ponownie). */
export async function krokImportuShopify(tenantId: string, runId: string): Promise<"dalej" | "koniec" | "pominiete"> {
  const pool = getPool();
  const { rows } = await pool.query<{ store_id: string; status: string; progress: PostepImportu; range_from: Date | null }>(
    "select store_id, status, progress, range_from from import_runs where tenant_id = $1 and id = $2",
    [tenantId, runId],
  );
  const run = rows[0];
  if (!run || (run.status !== "planned" && run.status !== "running")) return "pominiete";
  const sklep = await sklepShopify(tenantId, run.store_id);
  if (!sklep) return "pominiete";
  const postep: PostepImportu = { zakonczoneEtapy: [], liczniki: {}, ...run.progress };
  const zapiszPostep = (status = "running") =>
    pool.query(
      `update import_runs set status = $3, progress = $4::jsonb, started_at = coalesce(started_at, now()) where tenant_id = $1 and id = $2`,
      [tenantId, runId, status, JSON.stringify(postep)],
    );

  try {
    const klient = klientDla(sklep);
    if (!postep.etap) postep.etap = ETAPY[0];
    if (postep.etap === "koniec") return "koniec";
    if (!postep.bulkId) {
      try {
        postep.bulkId = await uruchomBulk(klient, zapytanieBulk(postep.etap, run.range_from ?? undefined));
      } catch (b) {
        // inna operacja bulk w toku (np. aplikacja sama coś eksportuje): spróbuj za chwilę
        if (b instanceof BladShopify && /already in progress|w toku/i.test(b.message)) {
          await zapiszPostep();
          await dodajZadanie(tenantId, "import_shopify", { runId }, { opoznienieSek: 30 });
          return "dalej";
        }
        throw b;
      }
      postep.obiekty = 0;
      await zapiszPostep();
      await dodajZadanie(tenantId, "import_shopify", { runId }, { opoznienieSek: ODSTEP_ODPYTYWANIA_SEK });
      return "dalej";
    }
    const stan = await stanBulk(klient, postep.bulkId);
    postep.obiekty = stan.obiekty;
    if (stan.status === "CREATED" || stan.status === "RUNNING" || stan.status === "CANCELING") {
      await zapiszPostep();
      await dodajZadanie(tenantId, "import_shopify", { runId }, { opoznienieSek: ODSTEP_ODPYTYWANIA_SEK });
      return "dalej";
    }
    if (stan.status !== "COMPLETED") throw new BladShopify(`operacja bulk (${postep.etap}) zakończona stanem ${stan.status}${stan.kodBledu ? ` / ${stan.kodBledu}` : ""}`);

    const jsonl = stan.url ? await pobierzWynikBulk(stan.url, fetchShopify()) : "";
    const wezly = zlozJsonl(jsonl);
    const liczniki = await zapiszEtap(tenantId, run.store_id, postep.etap, wezly, sklep.domena, run.range_from);
    for (const [k, v] of Object.entries(liczniki)) postep.liczniki![k] = (postep.liczniki![k] ?? 0) + v;
    postep.zakonczoneEtapy = [...(postep.zakonczoneEtapy ?? []), postep.etap];
    const nastepny = ETAPY[ETAPY.indexOf(postep.etap) + 1];
    postep.bulkId = null;
    if (nastepny) {
      postep.etap = nastepny;
      await zapiszPostep();
      await dodajZadanie(tenantId, "import_shopify", { runId });
      return "dalej";
    }
    postep.etap = "koniec";
    await zakonczPrzebieg(tenantId, runId, run.store_id, postep, run.range_from);
    return "koniec";
  } catch (b) {
    const tresc = (b instanceof Error ? b.message : String(b)).slice(0, 500);
    await pool.query(
      `update import_runs set status = 'failed', finished_at = now(), last_error = $3, progress = $4::jsonb where tenant_id = $1 and id = $2`,
      [tenantId, runId, tresc, JSON.stringify(postep)],
    );
    await wyslijAlert(`Shopify: import historii sklepu ${sklep.domena} przerwany na etapie ${postep.etap}: ${tresc}`, { poziom: "uwaga", tenantId });
    return "koniec";
  }
}

async function zapiszEtap(
  tenantId: string,
  storeId: string,
  etap: EtapBulk,
  wezly: { wezel: any; dzieci: any[] }[],
  domena: string,
  od: Date | null,
): Promise<Record<string, number>> {
  const pool = getPool();
  const { rows: t } = await pool.query<{ currency: string | null; caps: any }>(
    "select t.currency, s.capabilities as caps from tenants t join stores s on s.tenant_id = t.id and s.id = $2 where t.id = $1",
    [tenantId, storeId],
  );
  const waluta = t[0]?.caps?.shopify?.waluta ?? t[0]?.currency ?? "PLN";
  const l: Record<string, number> = {};
  const znacznik = new Date();
  for (let i = 0; i < wezly.length; i += PACZKA) {
    const paczka = wezly.slice(i, i + PACZKA);
    const klient = await pool.connect();
    try {
      await klient.query("begin");
      if (etap === "produkty") {
        const produkty = paczka.map((x) => produktSklepuZShopify(produktZBulk(x.wezel, x.dzieci, waluta), waluta));
        const w = await zapiszProduktySklepu(klient, tenantId, storeId, produkty, "api");
        // produkt jest w źródle, nawet gdy zapis go pominął (nowsza wersja z webhooka): znacznik
        // przebiegu się przesuwa, inaczej wyłączenie „czego nie ma w pełnej liście” trafiłoby w niego
        await klient.query(
          "update products set synced_at = greatest(synced_at, $3) where tenant_id = $1 and store_id = $2 and external_id = any($4::text[])",
          [tenantId, storeId, znacznik, produkty.map((x) => x.externalId)],
        );
        l.produkty = (l.produkty ?? 0) + w.produkty;
        l.warianty = (l.warianty ?? 0) + w.warianty;
      } else if (etap === "klienci") {
        for (const x of paczka) {
          const { klient: k, zgoda } = klientZBulk(x.wezel);
          if (!k.email || !zgoda.stan) continue;
          if (zgoda.stan === "granted") {
            const p = await upsertProfilKlienta(klient, tenantId, k, storeId);
            if (!p || p.nagrobek) {
              l.pominieteRodo = (l.pominieteRodo ?? 0) + (p ? 1 : 0);
              continue;
            }
            if (p.nowy) l.noweProfile = (l.noweProfile ?? 0) + 1;
            const z = await zapiszZgodeSklepu(klient, tenantId, p.profileId, {
              email: k.email,
              stan: "granted",
              zrodlo: "shopify",
              kiedy: zgoda.kiedy ?? k.zmodyfikowaneAt,
              szczegol: `import Shopify: emailMarketingConsent subscribed${zgoda.poziom ? `, ${zgoda.poziom}` : ""}, klient ${k.externalId}`,
            });
            if (z === "zapisana") l.zgody = (l.zgody ?? 0) + 1;
          } else {
            // wypis ze sklepu: tylko dla osób, które już mamy (nie zakładamy profilu po to, żeby zapisać „nie”)
            const { rows } = await klient.query<{ id: string }>("select id from profiles where tenant_id = $1 and lower(btrim(email)) = lower(btrim($2))", [tenantId, k.email]);
            if (!rows[0]) continue;
            const z = await zapiszZgodeSklepu(klient, tenantId, rows[0].id, {
              email: k.email,
              stan: "withdrawn",
              zrodlo: "shopify",
              kiedy: zgoda.kiedy ?? k.zmodyfikowaneAt,
              szczegol: `import Shopify: emailMarketingConsent unsubscribed, klient ${k.externalId}`,
            });
            if (z === "zapisana") l.wypisy = (l.wypisy ?? 0) + 1;
          }
        }
      } else {
        for (const x of paczka) {
          const z = zamowienieZBulk(x.wezel, x.dzieci);
          if (od && z.occurredAt.getTime() < od.getTime()) continue;
          const w = await upsertZamowienie(klient, tenantId, storeId, z, { kanal: "import", ...OPCJE_UPSERTU_SHOPIFY });
          if (w.nowe) l.noweZamowienia = (l.noweZamowienia ?? 0) + 1;
          else if (w.zaktualizowane) l.zaktualizowaneZamowienia = (l.zaktualizowaneZamowienia ?? 0) + 1;
          else l.duplikaty = (l.duplikaty ?? 0) + 1;
          if (w.nagrobek) l.pominieteRodo = (l.pominieteRodo ?? 0) + 1;
        }
      }
      await klient.query("commit");
    } catch (b) {
      await klient.query("rollback").catch(() => {});
      throw b;
    } finally {
      klient.release();
    }
  }
  if (etap === "produkty" && wezly.length > 0) {
    // pełna lista produktów: czego w niej nie ma, to nieaktywne (tylko ten sklep, tylko starsze od przebiegu)
    const { rowCount } = await pool.query(
      `update products set active = false where tenant_id = $1 and store_id = $2 and active and synced_at < $3`,
      [tenantId, storeId, znacznik],
    );
    l.wylaczone = rowCount ?? 0;
  }
  void domena;
  return l;
}

async function zakonczPrzebieg(tenantId: string, runId: string, storeId: string, postep: PostepImportu, od: Date | null) {
  const pool = getPool();
  // ODCZYT ZWROTNY: co jest w bazie dla TEGO sklepu w zakresie przebiegu
  const { rows } = await pool.query<{ zamowienia: number; najstarsza: Date | null; produkty: number }>(
    `select (select count(*)::int from orders where tenant_id = $1 and store_id = $2 and ($3::timestamptz is null or occurred_at >= $3)) as zamowienia,
            (select min(occurred_at) from orders where tenant_id = $1 and store_id = $2) as najstarsza,
            (select count(*)::int from products where tenant_id = $1 and store_id = $2 and active) as produkty`,
    [tenantId, storeId, od],
  );
  await pool.query(
    `update import_runs set status = 'done', finished_at = now(), progress = $3::jsonb, counters = $4::jsonb where tenant_id = $1 and id = $2`,
    [
      tenantId,
      runId,
      JSON.stringify(postep),
      JSON.stringify({ ...postep.liczniki, wBazieZamowien: rows[0].zamowienia, wBazieProduktow: rows[0].produkty, najstarszaData: rows[0].najstarsza }),
    ],
  );
}

export interface StanImportuShopify {
  id: string;
  status: string;
  postep: PostepImportu;
  plan: PlanImportuShopify | null;
  liczniki: Record<string, unknown>;
  blad: string | null;
  utworzono: Date;
  zakonczono: Date | null;
}

export async function ostatniImportShopify(tenantId: string, storeId: string): Promise<StanImportuShopify | null> {
  const { rows } = await getPool().query(
    `select id, status, progress, planned, counters, last_error, created_at, finished_at from import_runs
      where tenant_id = $1 and store_id = $2 order by created_at desc limit 1`,
    [tenantId, storeId],
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, status: r.status, postep: r.progress ?? {}, plan: r.planned ?? null, liczniki: r.counters ?? {}, blad: r.last_error, utworzono: r.created_at, zakonczono: r.finished_at };
}
