import type { PoolClient } from "pg";
import { getPool } from "../adapters/db/pool";
import { adapterSklepu } from "../adapters/store/fabryka";
import type { DefinicjaPlatformy } from "../adapters/store/rejestr";
import type { ZamowienieSklepu } from "../domain/store/contract";
import { upsertProfilKlienta, upsertZamowienie, ZASLEPKA_PAYLOADU } from "./przetworz-zdarzenie";
import { emitujKlienta } from "./zdarzenia/emisja-sklepu";

export interface PlanImportu {
  /** Zamówienia w sklepie w zakresie (nagłówek X-WP-Total), nie "ile udało się pobrać". */
  zamowienia: number;
  /** Konta klientów w sklepie (X-WP-Total). Idą do profili BEZ zgody (FR27). */
  klienci: number;
  /** Ile NOWYCH kartotek powstanie: e-maile z kont i z zamówień, których tenant jeszcze nie ma. */
  noweProfile: number;
  /**
   * Skutek uboczny do pokazania PRZED startem: zamówienia z ostatnich 7 dni wchodzą do
   * włączonych automatyzacji na `order.created`, chyba że silnik pomija `kanal: import`.
   * Liczba = zamówienia w oknie × włączone flowy na tym zdarzeniu (0, gdy flowów nie ma).
   */
  wejdaDoAutomatyzacji: number;
  zakresOd: Date | null;
  zakresDo: Date | null;
  probki: ZamowienieSklepu[];
}

export interface WynikImportu {
  runId: string;
  /** Wszystko poniżej odczytane ZWROTNIE z bazy po zapisie, nie zliczone z prób. */
  utworzoneProfile: number;
  utworzoneZamowienia: number;
  pominieteDuplikaty: number;
  /** zastane zamówienia, którym import nadpisał status/kwotę nowszą wersją ze sklepu */
  zaktualizowaneZamowienia: number;
  /** zamówienia i konta pominięte, bo osoba ma nagrobek RODO (zamówienie zapisane bez osoby) */
  pominieteRodo: number;
  /** Unikalne zamówienia, które przebieg realnie objął (nowe + zastane). */
  objeteZamowienia: number;
  /** Unikalne konta klientów objęte przebiegiem. */
  objeciKlienci: number;
  najstarszaData: Date | null;
  rozbieznosc: string | null;
}

export interface OpcjeImportu {
  /** Tylko zamówienia złożone od tej daty. Bez wartości = cała historia. */
  od?: Date;
  /** Rozmiar strony. Domyślnie 100 (maksimum Woo); mniejszy tylko w testach paginacji. */
  naStrone?: number;
  /** Postęp do paska w kreatorze (po każdej stronie): objęte / zaplanowane. */
  postep?: (p: { etap: "klienci" | "zamowienia"; objete: number; plan: number; runId: string }) => Promise<void> | void;
}

const NA_STRONE = 100;
/**
 * Sufit stron to BEZPIECZNIK przeciw sklepowi, który w nieskończoność oddaje
 * `X-WP-TotalPages` większe od bieżącej strony, nie limit importu: 100 000 stron
 * po 100 to 10 mln zamówień. Przekroczenie go jest błędem z nazwą, nie cichym końcem.
 */
const BEZPIECZNIK_STRON = 100_000;

function znormalizuj(email: string | null): string | null {
  return email ? email.trim().toLowerCase() : null;
}

/** Adapter z fabryki portu „Sklep” (E.1): platforma z `stores.platform`, nie zaszyta. */
async function adapterDlaSklepu(tenantId: string, storeId: string) {
  return (await adapterSklepu(tenantId, storeId)).adapter;
}

/**
 * Paginacja do KOŃCA: rozstrzyga nagłówek X-WP-TotalPages ze sklepu albo pusta strona,
 * nigdy zaszyty sufit. Poprzedni sufit 20 × 100 ucinał sklep z 8 tys. zamówień na
 * 2 tys. i raportował sukces (audyt #13, S5).
 */
async function* strony<T>(
  pobierz: (strona: number) => Promise<{ pozycje: T[]; stron: number; lacznie: number }>,
): AsyncGenerator<{ strona: number; pozycje: T[]; stron: number; lacznie: number }> {
  for (let strona = 1; ; strona++) {
    if (strona > BEZPIECZNIK_STRON) {
      throw new Error(`Sklep oddaje więcej niż ${BEZPIECZNIK_STRON} stron - przerwane, to nie wygląda na prawdziwą paginację`);
    }
    const wynik = await pobierz(strona);
    if (!wynik.pozycje.length) return;
    yield { strona, ...wynik };
    if (strona >= wynik.stron) return;
  }
}

/**
 * Faza planowania (NFR6). Zanim cokolwiek zapiszemy, operator musi wiedzieć, ile
 * zamówień wejdzie, ile kont klientów i ile NOWYCH kartotek przy okazji powstanie.
 * Skutki uboczne podane po fakcie to nie raport, tylko tłumaczenie się.
 *
 * Liczba zamówień pochodzi z nagłówka sklepu (jedno zapytanie), a nie z "ile udało
 * się pobrać": plan liczony tym samym sufitem co wykonanie nie umiał wykryć ucięcia
 * (audyt #13). E-maile do policzenia nowych profili idą w trybie lekkim (bez pozycji).
 */
export async function zaplanujImport(
  tenantId: string,
  storeId: string,
  opcje: OpcjeImportu = {},
): Promise<PlanImportu> {
  const adapter = await adapterDlaSklepu(tenantId, storeId);
  const naStrone = opcje.naStrone ?? NA_STRONE;

  const [zamowienia, klienci] = await Promise.all([
    adapter.policzZamowienia(opcje.od),
    adapter.policzKlientow(),
  ]);

  const emaile = new Set<string>();
  // min/max liczone w pętli, nie `Math.min(...tablica)`: spread 150 tys. dat przepełnia stos
  let najstarsza = Number.POSITIVE_INFINITY;
  let najnowsza = Number.NEGATIVE_INFINITY;
  const oknoAutomatyzacji = Date.now() - 7 * 24 * 3600 * 1000;
  let wOknieAutomatyzacji = 0;
  let probki: ZamowienieSklepu[] = [];
  for await (const strona of strony((s) =>
    adapter.pobierzZamowienia({ strona: s, naStrone, od: opcje.od, lekko: true }),
  )) {
    for (const z of strona.pozycje) {
      const e = znormalizuj(z.email);
      if (e) emaile.add(e);
      const t = z.occurredAt.getTime();
      if (t < najstarsza) najstarsza = t;
      if (t > najnowsza) najnowsza = t;
      if (t >= oknoAutomatyzacji && e) wOknieAutomatyzacji++;
    }
    if (strona.strona === 1) probki = strona.pozycje.slice(0, 3);
  }
  for await (const strona of strony((s) => adapter.pobierzKlientow(s, naStrone))) {
    for (const k of strona.pozycje) {
      const e = znormalizuj(k.email);
      if (e) emaile.add(e);
    }
  }

  const { rows } = await getPool().query<{ email: string }>(
    "select lower(btrim(email)) as email from profiles where tenant_id = $1 and email is not null",
    [tenantId],
  );
  const istniejace = new Set(rows.map((r) => r.email));
  const nowe = [...emaile].filter((e) => !istniejace.has(e));
  const { rows: flowy } = await getPool().query<{ ile: number }>(
    "select count(*)::int as ile from flows where tenant_id = $1 and status = 'wlaczony' and trigger_event = 'order.created'",
    [tenantId],
  );

  return {
    zamowienia,
    klienci,
    noweProfile: nowe.length,
    wejdaDoAutomatyzacji: flowy[0].ile > 0 ? wOknieAutomatyzacji : 0,
    zakresOd: Number.isFinite(najstarsza) ? new Date(najstarsza) : null,
    zakresDo: Number.isFinite(najnowsza) ? new Date(najnowsza) : null,
    probki,
  };
}

/**
 * Wykonanie importu. Zasady, każda z listy błędów, które już raz kosztowały:
 * 1. occurred_at zawsze ze źródła (AD-10, NFR3) - nigdy data importu.
 * 2. Licznik pokazuje FAKTYCZNY wynik odczytany z bazy, nie liczbę prób (NFR2).
 * 3. Po zapisie następuje odczyt zwrotny i porównanie z planem (NFR1) - plan liczony
 *    NIEZALEŻNIE (nagłówek sklepu), więc rozbieżność jest prawdziwa, nie tautologią.
 * 4. Klienci wchodzą jako profile BEZ zgody (FR27): konto w sklepie to nie zgoda.
 *
 * Kolejność: najpierw konta klientów (mają imię, nazwisko, telefon z konta), potem
 * zamówienia (uzupełniają tylko brakujące pola, nie nadpisują).
 */
export async function wykonajImport(
  tenantId: string,
  storeId: string,
  opcje: OpcjeImportu = {},
): Promise<WynikImportu> {
  const pool = getPool();
  const { adapter, definicja } = await adapterSklepu(tenantId, storeId);
  const naStrone = opcje.naStrone ?? NA_STRONE;
  const plan = await zaplanujImport(tenantId, storeId, opcje);
  const postep = opcje.postep;

  // jeden trwający import na sklep: unikalny indeks częściowy (0024) odrzuca drugi
  // przebieg, zanim cokolwiek zapisze - dwóch operatorów naraz to nie dwa importy
  let runId: string;
  try {
    const run = await pool.query<{ id: string }>(
      `insert into import_runs (tenant_id, store_id, status, planned, range_from, range_to, started_at)
       values ($1, $2, 'running', $3, $4, $5, now()) returning id`,
      [
        tenantId,
        storeId,
        JSON.stringify({
          zamowienia: plan.zamowienia,
          klienci: plan.klienci,
          noweProfile: plan.noweProfile,
          wejdaDoAutomatyzacji: plan.wejdaDoAutomatyzacji,
          od: opcje.od ? opcje.od.toISOString() : null,
        }),
        plan.zakresOd,
        plan.zakresDo,
      ],
    );
    runId = run.rows[0].id;
  } catch (blad) {
    if ((blad as { code?: string }).code === "23505") {
      throw new Error("Import tego sklepu już trwa - poczekaj, aż się skończy, zamiast uruchamiać drugi");
    }
    throw blad;
  }

  // identyfikatory z TEGO przebiegu - liczniki czytamy zwrotnie po nich, a nie po całej
  // tabeli, żeby równoległy webhook dokładający zamówienia nie fałszował wyniku
  const objeteZamowienia = new Set<string>();
  const objeciKlienci = new Set<string>();
  const utworzoneProfileId = new Set<string>();
  const utworzoneZamowieniaId = new Set<string>();
  const zaktualizowaneZamowieniaId = new Set<string>();
  let pominieteDuplikaty = 0;
  let pominieteRodo = 0;

  const klient = await pool.connect();
  try {
    for await (const strona of strony((s) => adapter.pobierzKlientow(s, naStrone))) {
      for (const k of strona.pozycje) {
        // niestabilna paginacja Woo: ta sama pozycja potrafi wrócić na dwóch stronach
        if (objeciKlienci.has(k.externalId)) continue;
        await wTransakcji(klient, async () => {
          const klucz = adapter.kluczIdempotencji("customer", k.externalId, definicja.wersjaBytu(k));
          await zapiszSuroweZdarzenie(klient, tenantId, storeId, definicja, klucz, k.surowe);
          const wynik = await upsertProfilKlienta(klient, tenantId, k, storeId);
          if (wynik?.nagrobek) {
            pominieteRodo++;
            await zaslepSurowe(klient, tenantId, storeId, klucz);
            return;
          }
          if (wynik?.nowy) {
            utworzoneProfileId.add(wynik.profileId);
            await emitujKlienta(klient, tenantId, {
              profileId: wynik.profileId,
              typ: "customer.created",
              kiedy: k.occurredAt,
              storeId,
              klientSklepu: k,
              kanal: "import",
            });
          }
        });
        objeciKlienci.add(k.externalId);
      }
      await postep?.({ etap: "klienci", objete: objeciKlienci.size, plan: plan.klienci, runId });
    }

    for await (const strona of strony((s) =>
      adapter.pobierzZamowienia({ strona: s, naStrone, od: opcje.od }),
    )) {
      for (const zamowienie of strona.pozycje) {
        if (objeteZamowienia.has(zamowienie.externalId)) continue;
        await wTransakcji(klient, async () => {
          // surowe zdarzenie z kluczem opisującym BYT, nie kanał (AD-4, AD-24)
          const klucz = adapter.kluczIdempotencji("order", zamowienie.externalId, definicja.wersjaBytu(zamowienie));
          await zapiszSuroweZdarzenie(klient, tenantId, storeId, definicja, klucz, zamowienie.surowe);

          // TEN SAM upsert co faza 2 webhooka (osłona source_updated_at): zastane
          // zamówienie dostaje nowszy status i kwotę, starsza wersja jest pomijana
          const wynik = await upsertZamowienie(klient, tenantId, storeId, zamowienie, { kanal: "import", platforma: definicja.platforma });
          if (wynik.nagrobek) {
            pominieteRodo++;
            await zaslepSurowe(klient, tenantId, storeId, klucz);
          }
          if (wynik.nowe && wynik.orderId) utworzoneZamowieniaId.add(wynik.orderId);
          else if (wynik.zaktualizowane && wynik.orderId) zaktualizowaneZamowieniaId.add(wynik.orderId);
          else pominieteDuplikaty++;
        });
        objeteZamowienia.add(zamowienie.externalId);
      }
      await postep?.({ etap: "zamowienia", objete: objeteZamowienia.size, plan: plan.zamowienia, runId });
    }
  } catch (blad) {
    // przebieg przerwany (np. 5xx sklepu na 37. stronie): status 'failed' z nazwą
    // przyczyny i licznikami tego, co zdążyło wejść - nie "running" na zawsze
    const tresc = blad instanceof Error ? blad.message : String(blad);
    await pool
      .query(
        `update import_runs set status = 'failed', finished_at = now(), last_error = $2, counters = $3
          where id = $1`,
        [
          runId,
          tresc,
          JSON.stringify({
            objeteZamowienia: objeteZamowienia.size,
            objeciKlienci: objeciKlienci.size,
            przerwanyWTrakcie: true,
          }),
        ],
      )
      .catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }

  // ODCZYT ZWROTNY (NFR1, NFR2): liczymy to, co faktycznie jest w bazie po identyfikatorach
  // TEGO przebiegu, a nie to, ile razy wywołaliśmy insert. Profile z zamówień gości nie
  // wracają z upsertu jako "nowe", więc liczymy je po `created_at` od startu przebiegu -
  // równoległy webhook w tym oknie zawyży licznik o siebie, co jest mniejszym złem niż
  // licznik z pamięci procesu.
  const [profile, zamowienia, objete, kontrola] = await Promise.all([
    pool.query<{ ile: number }>(
      `select count(*)::int as ile from profiles p
        where p.tenant_id = $1
          and (p.id = any($2::uuid[])
               or p.created_at >= (select started_at from import_runs where id = $3))`,
      [tenantId, [...utworzoneProfileId], runId],
    ),
    pool.query<{ ile: number }>(
      "select count(*)::int as ile from orders where tenant_id = $1 and store_id = $2 and id = any($3::uuid[])",
      [tenantId, storeId, [...utworzoneZamowieniaId]],
    ),
    pool.query<{ ile: number }>(
      "select count(*)::int as ile from orders where tenant_id = $1 and store_id = $2 and external_id = any($3::text[])",
      [tenantId, storeId, [...objeteZamowienia]],
    ),
    pool.query<{ najstarsza: Date | null }>(
      "select min(occurred_at) as najstarsza from orders where tenant_id = $1 and store_id = $2",
      [tenantId, storeId],
    ),
  ]);

  const utworzoneProfile = profile.rows[0].ile;
  const utworzoneZamowienia = zamowienia.rows[0].ile;
  const rozbieznosci: string[] = [];
  // plan z nagłówka sklepu vs to, co przebieg realnie objął; MNIEJ = ucięcie albo
  // sklep coś zgubił między stronami. Więcej jest w porządku: w trakcie importu
  // mogły dojść nowe zamówienia.
  if (objeteZamowienia.size < plan.zamowienia) {
    rozbieznosci.push(`sklep zgłaszał ${plan.zamowienia} zamówień, przebieg objął ${objeteZamowienia.size}`);
  }
  if (objeciKlienci.size < plan.klienci) {
    rozbieznosci.push(`sklep zgłaszał ${plan.klienci} klientów, przebieg objął ${objeciKlienci.size}`);
  }
  // każde objęte zamówienie musi po zapisie ISTNIEĆ w bazie (nowe albo zastane)
  if (objete.rows[0].ile !== objeteZamowienia.size) {
    rozbieznosci.push(`w bazie jest ${objete.rows[0].ile} z ${objeteZamowienia.size} objętych zamówień`);
  }
  if (utworzoneZamowienia !== utworzoneZamowieniaId.size) {
    rozbieznosci.push(`wstawiono ${utworzoneZamowieniaId.size} zamówień, w bazie odnaleziono ${utworzoneZamowienia}`);
  }
  const rozbieznosc = rozbieznosci.length ? rozbieznosci.join("; ") : null;

  await pool.query(
    `update import_runs set status = $2, counters = $3, finished_at = now(), last_error = $4
      where id = $1`,
    [
      runId,
      rozbieznosc ? "failed" : "done",
      JSON.stringify({
        utworzoneProfile,
        utworzoneZamowienia,
        zaktualizowaneZamowienia: zaktualizowaneZamowieniaId.size,
        pominieteDuplikaty,
        pominieteRodo,
        objeteZamowienia: objeteZamowienia.size,
        objeciKlienci: objeciKlienci.size,
      }),
      rozbieznosc,
    ],
  );

  return {
    runId,
    utworzoneProfile,
    utworzoneZamowienia,
    zaktualizowaneZamowienia: zaktualizowaneZamowieniaId.size,
    pominieteRodo,
    pominieteDuplikaty,
    objeteZamowienia: objeteZamowienia.size,
    objeciKlienci: objeciKlienci.size,
    najstarszaData: kontrola.rows[0].najstarsza,
    rozbieznosc,
  };
}

async function zapiszSuroweZdarzenie(
  klient: PoolClient,
  tenantId: string,
  storeId: string,
  definicja: DefinicjaPlatformy,
  klucz: string,
  payload: unknown,
) {
  // `channel = import`: ocena ciszy sklepu liczy wyłącznie kanał webhook (0023), więc
  // import 8 tys. zamówień nie udaje przez dobę, że sklep dosyła dane.
  // Wersja bytu w kluczu = `definicja.wersjaBytu`, identycznie jak w webhooku (AD-24).
  await klient.query(
    `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload, processed_at, channel)
     values ($1, $2, $3, $4, $5, now(), 'import')
     on conflict do nothing`,
    [tenantId, storeId, definicja.zrodloSurowych, klucz, JSON.stringify(payload)],
  );
}

/** Nagrobek RODO: surowy dokument tej osoby nie ma prawa zostać w bazie nawet na chwilę. */
async function zaslepSurowe(klient: PoolClient, tenantId: string, storeId: string, klucz: string) {
  await klient.query(
    `update raw_events set payload = ${ZASLEPKA_PAYLOADU}, process_error = 'rodo:nagrobek'
      where tenant_id = $1 and store_id = $2 and idempotency_key = $3 and not (payload ? 'anonimizowano')`,
    [tenantId, storeId, klucz],
  );
}

async function wTransakcji(klient: PoolClient, praca: () => Promise<void>) {
  await klient.query("begin");
  try {
    await praca();
    await klient.query("commit");
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  }
}
