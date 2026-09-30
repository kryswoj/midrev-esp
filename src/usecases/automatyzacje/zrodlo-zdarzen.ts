import { ETYKIETY_METRYK, METRYKI_BEZ_WYZWALANIA, METRYKI_Z_V1, kluczMetryki, zdarzenieV1, type MetrykaRef } from "../../domain/automatyzacje/graf";
import type { PoolClient } from "pg";
import { config } from "../../config";
import { METRYKI_WBUDOWANE, predykatWyzwalaniaSql } from "../../domain/zdarzenia/kontrakt";
import { metrykaPoKluczu } from "../zdarzenia/metryki";
import type {
  KatalogMetryk,
  MetrykaKatalogu,
  Wykonawca,
  ZapytanieKandydatow,
  ZdarzenieWyzwalajace,
  ZrodloZdarzenDoWyzwalaczy,
  ZrodloZdarzenia,
} from "../../domain/automatyzacje/wyzwalanie";

/**
 * Adaptery portow wyzwalaczy metrycznych.
 *
 * Dwa zrodla (po scaleniu strumieni A i B, integracja MVP):
 *  - `zrodloZdarzenEvents` (stara tabela `events`, nazwy v1 `popup.submitted`, `order.created`):
 *    domyslne, dopoki MIDREV_GRAF_V2 jest wylaczona. Istniejace flow biegna dokladnie tak jak
 *    przed tym wydaniem; strumien A pisze lustro do `events` z tym samym id.
 *  - `zrodloZdarzenMetricEvents` + `katalogMetrykTabela` (AD-36, metric_events + metrics):
 *    z MIDREV_GRAF_V2. Dopiero tu wyzwalaja metryki z API (np. „Lead z formularza” z n8n)
 *    i dziala filtr wyzwalacza po wlasciwosciach w ksztalcie Klaviyo.
 * Przelaczenie w jednym miejscu: `zrodloZdarzen()` / `katalogMetryk()` ponizej. Uzasadnienie
 * (brak podwojnego wejscia i luk kursora przy przejsciu) w raporcie integracji 06.
 */

const UUID_SQL = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wiersz(r: Record<string, unknown>, source: ZrodloZdarzenia, backfill: boolean): ZdarzenieWyzwalajace {
  const properties = r.properties && typeof r.properties === "object" && !Array.isArray(r.properties) ? (r.properties as Record<string, unknown>) : {};
  return {
    id: String(r.id),
    profileId: String(r.profile_id),
    occurredAt: String(r.occurred_at),
    recordedAt: String(r.recorded_at),
    occurredAtMs: Number(r.occurred_ms),
    recordedAtMs: Number(r.recorded_ms),
    properties,
    backfill,
    source,
    context: (r.context as Record<string, unknown>) ?? {},
  };
}

/**
 * Wspolny fragment: zakres rejestracji (`nowe` po kursorze albo `zakladka` przed nim)
 * i porzadek. Ten sam fragment ma adapter metric_events (kontrakt portu).
 */
/**
 * Porzadek: `nowe` rosnaco (kursor posuwa sie po kolei), `zakladka` MALEJACO - transakcja
 * zatwierdzona poza kolejnoscia ma recorded_at najwyzej ~60 s (statement_timeout) przed
 * kursorem, wiec lezy na KONCU zakladki; przy limicie czytamy najpierw wlasnie ten koniec.
 */
export function porzadekSkanu(alias: string, z: ZapytanieKandydatow): string {
  return z.zakres.rodzaj === "nowe" ? `${alias}.recorded_at, ${alias}.id` : `${alias}.recorded_at desc, ${alias}.id desc`;
}

export function zakresSkanu(alias: string, z: ZapytanieKandydatow, parametry: unknown[]): string {
  const p = (v: unknown) => {
    parametry.push(v);
    return `$${parametry.length}`;
  };
  if (z.zakres.rodzaj === "nowe") {
    const { kursor, nieWczesniejNiz } = z.zakres;
    return `(${alias}.recorded_at, ${alias}.id) > (${p(kursor.recordedAt)}::timestamptz, ${p(kursor.id)}::uuid)
            and ${alias}.recorded_at > ${p(nieWczesniejNiz)}::timestamptz`;
  }
  const { od, kursor, wlacznie } = z.zakres;
  return `${alias}.recorded_at > ${p(od)}::timestamptz
          and (${alias}.recorded_at, ${alias}.id) ${wlacznie === false ? "<" : "<="} (${p(kursor.recordedAt)}::timestamptz, ${p(kursor.id)}::uuid)`;
}

export const zrodloZdarzenEvents: ZrodloZdarzenDoWyzwalaczy = {
  nazwa: "events",
  obsluguje(m: MetrykaRef) {
    return zdarzenieV1(m) !== null;
  },
  async kandydaci(klient: Wykonawca, z: ZapytanieKandydatow) {
    const typ = zdarzenieV1(z.metryka);
    if (!typ) return [];
    const parametry: unknown[] = [z.tenantId, typ, z.zaszlePo, z.limit];
    const okno = zakresSkanu("e", z, parametry);
    const { rows } = await klient.query(
      `select e.id, e.profile_id, e.payload as properties,
              e.occurred_at::text as occurred_at, e.recorded_at::text as recorded_at,
              extract(epoch from e.occurred_at) * 1000 as occurred_ms,
              extract(epoch from e.recorded_at) * 1000 as recorded_ms,
              coalesce(e.payload->>'kanal', 'webhook') = 'import' as z_importu,
              jsonb_strip_nulls(jsonb_build_object(
                'orderId', case when e.payload->>'orderId' ~ '${UUID_SQL}' then e.payload->>'orderId' end,
                'totalMinor', e.payload->'totalMinor')) as context
         from events e
        where e.tenant_id = $1 and e.event_type = $2 and e.profile_id is not null
          and e.occurred_at >= $3::timestamptz
          and ${okno}
        order by ${porzadekSkanu("e", z)}
        limit $4`,
      parametry,
    );
    return rows.map((r) => wiersz(r, r.z_importu ? "import" : typ === "popup.submitted" ? "system" : "webhook", false));
  },
  async pobierzWlasciwosci(klient: Wykonawca, tenantId: string, eventId: string) {
    if (!UUID.test(eventId)) return null;
    const { rows } = await klient.query("select payload from events where tenant_id = $1 and id = $2", [tenantId, eventId]);
    const p = rows[0]?.payload;
    return p && typeof p === "object" && !Array.isArray(p) ? p : null;
  },
  async idMetryki() {
    return null;
  },
};

/**
 * Katalog metryk w stanie przejsciowym: metryki wbudowane v1. Po scaleniu A zastepuje go
 * `katalogMetrykTabela` (tabela `metrics`).
 */
export const katalogMetrykWbudowanych: KatalogMetryk = {
  async lista(): Promise<MetrykaKatalogu[]> {
    return Object.values(METRYKI_Z_V1).map((m) => ({ id: null, integracja: m.integracja, nazwa: m.nazwa, canTrigger: !METRYKI_BEZ_WYZWALANIA.has(kluczMetryki(m)) }));
  },
};

/** Etykieta metryki do list wyboru (PL dla wbudowanych, nazwa zrodlowa dla pozostalych). */
export function etykietaZKatalogu(m: MetrykaRef): string {
  return ETYKIETY_METRYK[kluczMetryki(m)] ?? m.nazwa;
}

// ── Adaptery na strumieniu A (metric_events, metrics; kontrakt A↔B) ─────────

/**
 * Zrodlo zdarzen na `metric_events` (kontrakt A↔B, src/domain/zdarzenia/kontrakt.ts).
 *
 * Nie korzysta z `zdarzeniaDoSkanu` strumienia A, bo ta funkcja przyjmuje tylko
 * `recorded_at > recordedPo` z limitem: przy wiekszej liczbie zdarzen w kwadransie niz limit
 * skan kreci sie w miejscu. Tu jest kursor (recorded_at, id) i osobna zakladka (patrz
 * `ZapytanieKandydatow`). Predykat wyzwalania (backfill, import, 4 h od ingested_at, profil)
 * pochodzi z kontraktu (`predykatWyzwalaniaSql`), wiec semantyka jest jedna.
 */
export const zrodloZdarzenMetricEvents: ZrodloZdarzenDoWyzwalaczy = {
  nazwa: "metric_events",
  async kandydaci(klient: Wykonawca, z: ZapytanieKandydatow) {
    const parametry: unknown[] = [z.tenantId, z.metryka.integracja, z.metryka.nazwa, z.zaszlePo, z.limit];
    const zakres = zakresSkanu("e", z, parametry);
    const { rows } = await klient.query(
      `select e.id, e.profile_id, e.properties, e.source, e.backfill, e.value_minor, e.unique_id,
              e.occurred_at::text as occurred_at, e.recorded_at::text as recorded_at,
              extract(epoch from e.occurred_at) * 1000 as occurred_ms,
              extract(epoch from e.recorded_at) * 1000 as recorded_ms,
              extract(epoch from e.ingested_at) * 1000 as ingested_ms
         from metric_events e
        where e.tenant_id = $1
          and e.metric_id = (select m.id from metrics m where m.tenant_id = $1 and m.integration_key = $2 and m.name = $3)
          and e.occurred_at >= $4::timestamptz
          and ${predykatWyzwalaniaSql("e")}
          and ${zakres}
        order by ${porzadekSkanu("e", z)}
        limit $5`,
      parametry,
    );
    // „Placed Order” ze sklepu: `OrderId` w properties to id zamowienia W SKLEPIE (parytet
    // Klaviyo, np. numer Woo), a nasze `orders.id` jest w `unique_id` (kontrakt A-B, §3).
    // Warunek „wartosc zamowienia” i regula wyjscia po zakupie potrzebuja `orders.id`.
    const zamowienieSklepu = kluczMetryki(z.metryka) === kluczMetryki(METRYKI_WBUDOWANE.zlozoneZamowienie);
    return rows.map((r) => {
      const w = wiersz(r, r.source as ZrodloZdarzenia, r.backfill === true);
      w.ingestedAtMs = Number(r.ingested_ms);
      // dotychczasowe warunki (wartosc zamowienia) czytaja orderId/totalMinor z kontekstu
      const orderId = zamowienieSklepu ? r.unique_id : null;
      w.context = {
        ...(typeof orderId === "string" && UUID.test(orderId) ? { orderId } : {}),
        ...(r.value_minor !== null && r.value_minor !== undefined ? { totalMinor: Number(r.value_minor) } : {}),
      };
      return w;
    });
  },
  async pobierzWlasciwosci(klient: Wykonawca, tenantId: string, eventId: string, occurredAt: string | null) {
    if (!UUID.test(eventId)) return null;
    // occurred_at = klucz partycji: z nim odczyt dotyka jednej partycji. W strumieniu czas jest
    // uciety do sekundy, a uczestnik wprowadzony ze starej tabeli `events` moze miec ulamki.
    const { rows } = await klient.query(
      `select properties from metric_events
        where tenant_id = $1 and id = $2 and ($3::timestamptz is null or occurred_at = date_trunc('second', $3::timestamptz))`,
      [tenantId, eventId, occurredAt],
    );
    const p = rows[0]?.properties;
    return p && typeof p === "object" && !Array.isArray(p) ? p : null;
  },
  async idMetryki(klient: Wykonawca, tenantId: string, m: MetrykaRef) {
    // Metryka wbudowana (formularz, zamowienie) moze jeszcze nie istniec w koncie, ktore
    // nie mialo zadnego zdarzenia: zaklada ja funkcja strumienia A (limit 200, blokada
    // tenanta). Metryk spoza wbudowanych NIE zakladamy przy publikacji: powstaja z pierwszym
    // zdarzeniem (walidacja grafu i tak wymaga metryki z katalogu).
    const { rows } = await klient.query(
      "select id from metrics where tenant_id = $1 and integration_key = $2 and name = $3",
      [tenantId, m.integracja, m.nazwa],
    );
    if (rows[0]) return rows[0].id;
    if (!WYZWALAJACE_WBUDOWANE.some((d) => kluczMetryki(d) === kluczMetryki(m))) return null;
    const metryka = await metrykaPoKluczu(klient as unknown as PoolClient, tenantId, { integracja: m.integracja as never, nazwa: m.nazwa }, { utworz: true });
    return metryka?.id ?? null;
  },
};

/** Metryki wbudowane, ktore moga wyzwalac flow (widoczne w katalogu, zanim przyjdzie pierwsze zdarzenie). */
const WYZWALAJACE_WBUDOWANE: MetrykaRef[] = Object.values(METRYKI_WBUDOWANE)
  .filter((d) => d.mozeWyzwalac && !d.ukryta)
  .map((d) => ({ integracja: d.integracja, nazwa: d.nazwa }));

/**
 * Katalog metryk na tabeli `metrics` (bez ukrytych technicznych), kontrakt A↔B. Metryki
 * wbudowane, ktore moga wyzwalac, sa w katalogu zawsze (id null, dopoki nie ma zdarzenia):
 * nowe konto musi moc zbudowac powitanie po formularzu przed pierwszym zgloszeniem.
 */
export const katalogMetrykTabela: KatalogMetryk = {
  async lista(klient: Wykonawca, tenantId: string): Promise<MetrykaKatalogu[]> {
    const { rows } = await klient.query(
      `select id, integration_key, name, can_trigger from metrics
        where tenant_id = $1 and not hidden order by name, integration_key`,
      [tenantId],
    );
    const lista: MetrykaKatalogu[] = rows.map((r) => ({ id: r.id, integracja: r.integration_key, nazwa: r.name, canTrigger: r.can_trigger === true && !METRYKI_BEZ_WYZWALANIA.has(`${r.integration_key}|${r.name}`) }));
    const sa = new Set(lista.map((m) => kluczMetryki(m)));
    for (const d of WYZWALAJACE_WBUDOWANE) {
      if (!sa.has(kluczMetryki(d))) lista.push({ id: null, integracja: d.integracja, nazwa: d.nazwa, canTrigger: true });
    }
    return lista;
  },
};

// ── Wybor implementacji (jedno miejsce do przelaczenia po scaleniu A) ─────────

let zrodloNadpisane: ZrodloZdarzenDoWyzwalaczy | null = null;
let katalogNadpisany: KatalogMetryk | null = null;

/**
 * Zrodlo wyzwalaczy metrycznych: z MIDREV_GRAF_V2 strumien `metric_events` (wszystkie
 * wyzwalajace metryki, takze z API), bez flagi stara tabela `events` jak przed wydaniem.
 *
 * Dlaczego przejscie nie daje podwojnego wejscia ani luki (raport 06):
 *  - kazde zdarzenie popupu i zamowienia ma w obu tabelach TO SAMO id (lustro A), a wejscie
 *    chroni unikalnosc (flow, profil, entry_key) z kluczem `raz` albo `e:<id>`;
 *  - jeden proces czyta tylko jedno zrodlo (flaga czytana raz, przy starcie);
 *  - kursor (recorded_at, id) jest wspolny: `metric_events.recorded_at` (clock_timestamp)
 *    >= `events.recorded_at` (now() tej samej transakcji), wiec zdarzenie widziane w starej
 *    tabeli przed kursorem jest w nowej najwyzej pozniej (ponowne przetworzenie = konflikt
 *    unikalnosci), a spoznione commity lapie 15-minutowa zakladka w obu zrodlach.
 */
export function zrodloZdarzen(): ZrodloZdarzenDoWyzwalaczy {
  return zrodloNadpisane ?? (config().MIDREV_GRAF_V2 ? zrodloZdarzenMetricEvents : zrodloZdarzenEvents);
}

export function katalogMetryk(): KatalogMetryk {
  return katalogNadpisany ?? (config().MIDREV_GRAF_V2 ? katalogMetrykTabela : katalogMetrykWbudowanych);
}

/**
 * Wlasciwosci zdarzenia, ktore wprowadzilo uczestnika ({{ event.X }}), NIEZALEZNIE od
 * biezacej flagi: najpierw strumien metric_events (ksztalt Klaviyo, jedyny dla metryk z API),
 * potem stara tabela `events` (uczestnicy sprzed backfillu). Lustro ma to samo id, wiec to
 * samo zdarzenie daje te same zmienne przed i po przelaczeniu flagi.
 */
export async function wlasciwosciWyzwalacza(klient: Wykonawca, tenantId: string, eventId: string, occurredAt: string | null): Promise<Record<string, unknown> | null> {
  // atrapa zrodla w testach ma wlasne dane; prawdziwe adaptery ida sciezka kanoniczna
  if (zrodloNadpisane && zrodloNadpisane !== zrodloZdarzenEvents && zrodloNadpisane !== zrodloZdarzenMetricEvents) {
    return zrodloNadpisane.pobierzWlasciwosci(klient, tenantId, eventId, occurredAt);
  }
  // Uczestnik sprzed 0035 nie ma occurred_at zdarzenia: bez klucza partycji odczyt strumienia
  // dotykalby wszystkich partycji, a takie zdarzenie i tak lezy w `events` (stary ksztalt,
  // ktorym ta wersja maila byla projektowana).
  if (!occurredAt) return zrodloZdarzenEvents.pobierzWlasciwosci(klient, tenantId, eventId, null);
  return (
    (await zrodloZdarzenMetricEvents.pobierzWlasciwosci(klient, tenantId, eventId, occurredAt)) ??
    (await zrodloZdarzenEvents.pobierzWlasciwosci(klient, tenantId, eventId, occurredAt))
  );
}

/** Wylacznie dla testow (atrapa zrodla na kontrakcie A). `null` przywraca domyslne. */
export function ustawZrodloZdarzen(z: ZrodloZdarzenDoWyzwalaczy | null, k: KatalogMetryk | null = null) {
  zrodloNadpisane = z;
  katalogNadpisany = k;
}
