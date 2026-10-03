import { getPool } from "../../adapters/db/pool";
import { definicjaPlatformy } from "../../adapters/store/rejestr";
import { wszystkieAktywne, type StanWebhookow } from "../../adapters/store/webhooki";
import { dodajZadanie } from "../../jobs/kolejka";
import { sygnalyStrony } from "../integracja/podglad";
import { synchronizujKatalogSklepu } from "../katalog/katalog-sklepu";
import { wykonajImport } from "../importuj-historie";

/**
 * Kreator „Połącz sklep” (plan integracji F.1): stan połączenia na żywo, import historii
 * w tle z paskiem postępu i synchronizacja katalogu. Odczyty zawsze z predykatem tenant_id.
 */

export const RODZAJ_IMPORTU_SKLEPU = "import_sklepu";
export const RODZAJ_KATALOGU_SKLEPU = "katalog_sklepu";

export interface StanPolaczeniaSklepu {
  teraz: number;
  sklep: {
    id: string;
    adres: string;
    metoda: string | null;
    wersjaWtyczki: string | null;
    wtyczkaWidzianaAt: number | null;
    status: string;
  } | null;
  webhooki: { aktywne: number; wszystkie: number; ok: boolean; blad: string | null };
  /** ostatnie pobranie midrev.js przez stronę (sygnał w pamięci procesu) */
  skryptAt: number | null;
  /** ostatnie zdarzenie per metryka (24 h) */
  zdarzenia: Record<string, number | null>;
  katalog: { produkty: number; ostatnio: number | null };
  ostatnie: { id: string; metryka: string; kiedy: number; osoba: string | null; profileId: string | null }[];
}

const METRYKI_KONTROLI: [string, string][] = [
  ["midrev", "Viewed Product"],
  ["midrev", "Added to Cart"],
  ["midrev", "Started Checkout"],
  ["woocommerce", "Placed Order"],
];

/** Stan połączenia sklepu Woo tenanta (najnowszy sklep Woo). Tylko odczyt. */
export async function stanPolaczeniaWoo(tenantId: string, storeId?: string | null): Promise<StanPolaczeniaSklepu> {
  const pool = getPool();
  const { rows: s } = await pool.query<{
    id: string;
    base_url: string;
    connection_method: string | null;
    plugin_version: string | null;
    plugin_seen_at: Date | null;
    status: string;
    stan: StanWebhookow | null;
    produkty: number;
    katalog_ostatnio: string | null;
  }>(
    `select s.id, s.base_url, s.connection_method, s.plugin_version, s.plugin_seen_at, s.status,
            s.capabilities -> 'webhooki_stan' as stan,
            (select count(*)::int from products p where p.tenant_id = s.tenant_id and p.store_id = s.id and p.active) as produkty,
            s.sync_state #>> '{katalog,ostatnio}' as katalog_ostatnio
       from stores s
      where s.tenant_id = $1 and s.platform = 'woocommerce' and ($2::uuid is null or s.id = $2)
      order by (s.status = 'connected') desc, s.created_at desc limit 1`,
    [tenantId, storeId ?? null],
  );
  const sklep = s[0] ?? null;
  const { rows: k } = await pool.query<{ id: string }>("select id from site_keys where tenant_id = $1 and revoked_at is null", [tenantId]);
  const skrypt = k[0] ? sygnalyStrony(k[0].id).find((x) => x.rodzaj === "skrypt") : undefined;
  const { rows: z } = await pool.query<{ integration_key: string; name: string; ostatnie: Date | null }>(
    `select m.integration_key, m.name, (select max(e.recorded_at) from metric_events e
              where e.tenant_id = m.tenant_id and e.metric_id = m.id and e.occurred_at > now() - interval '1 day') as ostatnie
       from metrics m
      where m.tenant_id = $1 and (m.integration_key, m.name) in (('midrev','Viewed Product'),('midrev','Added to Cart'),('midrev','Started Checkout'),('woocommerce','Placed Order'))`,
    [tenantId],
  );
  const zdarzenia: Record<string, number | null> = {};
  for (const [i, n] of METRYKI_KONTROLI) {
    const w = z.find((r) => r.integration_key === i && r.name === n);
    zdarzenia[n] = w?.ostatnie ? w.ostatnie.getTime() : null;
  }
  const { rows: o } = await pool.query<{ id: string; name: string; recorded_at: Date; profile_id: string | null; email: string | null }>(
    `select e.id, m.name, e.recorded_at, e.profile_id, p.email
       from metric_events e
       join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
       left join profiles p on p.tenant_id = e.tenant_id and p.id = e.profile_id
      where e.tenant_id = $1 and e.occurred_at > now() - interval '1 day' and e.backfill = false
        and (m.integration_key, m.name) in (('midrev','Viewed Product'),('midrev','Added to Cart'),('midrev','Started Checkout'),('woocommerce','Placed Order'),('midrev','Submitted Form'))
      order by e.recorded_at desc limit 10`,
    [tenantId],
  );
  const stan = sklep?.stan ?? null;
  const definicja = definicjaPlatformy("woocommerce");
  return {
    teraz: Date.now(),
    sklep: sklep
      ? {
          id: sklep.id,
          adres: sklep.base_url,
          metoda: sklep.connection_method,
          wersjaWtyczki: sklep.plugin_version,
          wtyczkaWidzianaAt: sklep.plugin_seen_at ? sklep.plugin_seen_at.getTime() : null,
          status: sklep.status,
        }
      : null,
    webhooki: {
      aktywne: stan?.wpisy.filter((w) => w.stan === "aktywny").length ?? 0,
      wszystkie: definicja?.webhooki?.tematy.length ?? 0,
      ok: wszystkieAktywne(stan, definicja?.webhooki?.tematy),
      blad: stan?.blad ?? null,
    },
    skryptAt: skrypt?.kiedy ?? null,
    zdarzenia,
    katalog: { produkty: sklep?.produkty ?? 0, ostatnio: sklep?.katalog_ostatnio ? Date.parse(sklep.katalog_ostatnio) : null },
    ostatnie: o.map((r) => ({ id: r.id, metryka: r.name, kiedy: r.recorded_at.getTime(), osoba: r.email ? maskuj(r.email) : null, profileId: r.profile_id })),
  };
}

/** Adres w podglądzie maskowany (ekran bywa udostępniany na callu z klientem). */
function maskuj(email: string): string {
  const [u, d] = email.split("@");
  return `${u.slice(0, 2)}…@${d ?? ""}`;
}

// ── Import historii w tle ────────────────────────────────────────────────────────

export interface StanImportu {
  stan: "brak" | "w_kolejce" | "trwa" | "gotowe" | "blad";
  plan: { zamowienia: number; klienci: number; noweProfile: number } | null;
  postep: { etap: string; objete: number; plan: number } | null;
  wynik: Record<string, unknown> | null;
  blad: string | null;
  start: number | null;
  koniec: number | null;
}

/** Zlecenie importu historii (job w tle). Drugi import tego sklepu naraz = odmowa z powodem. */
export async function zlecImportSklepu(tenantId: string, storeId: string): Promise<{ ok: true } | { ok: false; blad: string }> {
  const pool = getPool();
  const { rows: s } = await pool.query("select 1 from stores where tenant_id = $1 and id = $2 and status = 'connected'", [tenantId, storeId]);
  if (!s[0]) return { ok: false, blad: "Sklep nie jest połączony." };
  const stan = await stanImportuSklepu(tenantId, storeId);
  if (stan.stan === "w_kolejce" || stan.stan === "trwa") return { ok: false, blad: "Import tego sklepu już trwa." };
  await dodajZadanie(tenantId, RODZAJ_IMPORTU_SKLEPU, { storeId });
  return { ok: true };
}

export async function stanImportuSklepu(tenantId: string, storeId: string): Promise<StanImportu> {
  const pool = getPool();
  const { rows: j } = await pool.query(
    `select 1 from jobs where tenant_id = $1 and kind = $2 and status in ('pending', 'running')
        and payload ->> 'storeId' = $3 and created_at > now() - interval '2 days' limit 1`,
    [tenantId, RODZAJ_IMPORTU_SKLEPU, storeId],
  );
  const { rows: r } = await pool.query(
    `select status, planned, counters, last_error, started_at, finished_at from import_runs
      where tenant_id = $1 and store_id = $2 order by started_at desc nulls last limit 1`,
    [tenantId, storeId],
  );
  const run = r[0];
  const planned = run?.planned ?? null;
  const counters = run?.counters ?? null;
  const pusty: StanImportu = { stan: "brak", plan: null, postep: null, wynik: null, blad: null, start: null, koniec: null };
  if (run?.status === "running") {
    return {
      ...pusty,
      stan: "trwa",
      plan: planned ? { zamowienia: planned.zamowienia, klienci: planned.klienci, noweProfile: planned.noweProfile } : null,
      postep: counters?.postep ?? null,
      start: run.started_at?.getTime() ?? null,
    };
  }
  if (j[0]) return { ...pusty, stan: "w_kolejce" };
  if (!run) return pusty;
  return {
    stan: run.status === "done" ? "gotowe" : "blad",
    plan: planned ? { zamowienia: planned.zamowienia, klienci: planned.klienci, noweProfile: planned.noweProfile } : null,
    postep: counters?.postep ?? null,
    wynik: counters,
    blad: run.last_error ?? null,
    start: run.started_at?.getTime() ?? null,
    koniec: run.finished_at?.getTime() ?? null,
  };
}

/** Handler joba: import historii z postępem w `import_runs.counters.postep`, potem pełny katalog. */
export async function wykonajImportSklepu(tenantId: string, storeId: string): Promise<void> {
  const pool = getPool();
  const wynik = await wykonajImport(tenantId, storeId, {
    postep: async (p) => {
      await pool.query(
        `update import_runs set counters = jsonb_set(coalesce(counters, '{}'::jsonb), '{postep}', $3::jsonb, true)
          where tenant_id = $1 and id = $2 and status = 'running'`,
        [tenantId, p.runId, JSON.stringify({ etap: p.etap, objete: p.objete, plan: p.plan })],
      );
    },
  });
  console.log(
    `[import-sklepu] tenant ${tenantId}: sklep ${storeId}: zamówienia nowe ${wynik.utworzoneZamowienia}, profile nowe ${wynik.utworzoneProfile}` +
      (wynik.rozbieznosc ? `, rozbieżność: ${wynik.rozbieznosc}` : ""),
  );
  await synchronizujKatalogSklepu(tenantId, storeId, { pelna: true }).catch((b) => {
    console.warn(`[import-sklepu] katalog: ${b instanceof Error ? b.message.replace(/(ck|cs)_[a-z0-9]+/gi, "$1_…") : "błąd"}`);
  });
}

/** Sklepy, którym należy się synchronizacja katalogu (co 6 h przyrostowo). */
export async function zaplanujKatalogiSklepow(): Promise<number> {
  const { rows } = await getPool().query<{ id: string; tenant_id: string }>(
    `select s.id, s.tenant_id from stores s
      where s.status = 'connected' and s.platform in ('woocommerce')
        and coalesce((s.sync_state #>> '{katalog,ostatnio}')::timestamptz, '-infinity') < now() - interval '6 hours'
        and not exists (select 1 from jobs j where j.tenant_id = s.tenant_id and j.kind = $1
                          and j.status in ('pending', 'running') and j.payload ->> 'storeId' = s.id::text
                          and j.created_at > now() - interval '1 day')
      limit 200`,
    [RODZAJ_KATALOGU_SKLEPU],
  );
  for (const s of rows) await dodajZadanie(s.tenant_id, RODZAJ_KATALOGU_SKLEPU, { storeId: s.id });
  return rows.length;
}
