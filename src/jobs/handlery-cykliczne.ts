import { getPool } from "../adapters/db/pool";
import { sklepyTenanta } from "../adapters/db/repozytoria";
import { odczytajZnacznikZgodnosci, zapiszZnacznikZgodnosci } from "../adapters/store/stan-webhookow";
import { sprawdzCiszeSklepow } from "../usecases/cisza-sklepow";
import { sprawdzZgodnosc } from "../usecases/sprawdz-zgodnosc";
import { wyslijAlert } from "./alerty";
import type { Zadanie } from "./kolejka";

/**
 * Joby cykliczne, ktorych do tej pory nikt nie kolejkowal (audyt #18, #19):
 *
 *  - `atrybucja`        co godzine, per tenant, TYLKO gdy od ostatniego zakonczonego
 *                       przebiegu doszlo albo zmienilo sie jakies oplacone zamowienie;
 *                       handler juz istnieje w worker.ts (przeliczAtrybucje), tu jest
 *                       wylacznie planowanie
 *  - `cisza_sklepow`    co godzine, per tenant (sprawdzCiszeSklepow ma wlasny dedup
 *                       alertow: raz na 12 h per sklep)
 *  - `zgodnosc_danych`  raz na dobe, per tenant: liczby w sklepie vs w bazie z ostatnich
 *                       30 dni; rozjazd powyzej 0,5% (NFR5) idzie alertem do czlowieka
 *  - zalegle surowe     raw_events bez processed_at starsze niz 15 min, ktorych job
 *                       wyczerpal proby (np. worker na starym kodzie) dostaja nowy job
 *                       `przetworz_zdarzenie` - najwyzej raz na dobe per zdarzenie, zeby
 *                       zatruty payload nie budzil czlowieka co godzine
 *
 * worker.ts nalezy w tej rundzie do innego wlasciciela, wiec ten modul eksportuje
 * mape handlerow i funkcje rejestrujaca; wpiecie to trzy linie (patrz raport).
 *
 * DWA WORKERY NARAZ: planowanie idzie przez `dodajJesliBrak`, ktore pod blokada
 * doradcza (tenant + rodzaj) sprawdza, czy w oknie rytmu job juz istnieje. Bez tego
 * kazdy worker kolejkowalby wlasny komplet co tik, a atrybucja liczylaby sie dwa razy.
 * Sama blokada nie wystarcza przeciw ponownemu uruchomieniu procesu - dlatego okno
 * liczy sie od `created_at` istniejacego joba, nie od startu workera.
 */

/** Ile czasu musi minac od ostatniego joba danego rodzaju, zeby zaplanowac nastepny. */
export const RYTM = {
  atrybucja: { godziny: 1 },
  cisza_sklepow: { godziny: 1 },
  zgodnosc_danych: { doba: true },
} as const;

export const OKNO_ZGODNOSCI_DNI = 30;
/** Prog rozjazdu z NFR5: powyzej idzie alert, nie wpis w logu. */
export const PROG_ROZJAZDU = 0.005;
/** Ten sam rozjazd (ta sama roznica) nie alarmuje czesciej niz raz na tyle dni. */
export const ODSTEP_ALERTU_ZGODNOSCI_DNI = 7;
/** Ile razy zalegle surowe zdarzenie dostaje nowy job, zanim zostanie odlozone na stale. */
export const MAKS_PONOWIEN_SUROWYCH = 3;

export const HANDLERY_CYKLICZNE: Record<string, (z: Zadanie) => Promise<void>> = {
  async cisza_sklepow(z) {
    const wynik = await sprawdzCiszeSklepow(z.tenant_id);
    if (wynik.zgloszone.length) {
      console.warn(
        `[cisza] tenant ${z.tenant_id}: ${wynik.zgloszone.length} z ${wynik.ocenione.length} sklepów milczy, alert wysłany`,
      );
    }
  },
  async zgodnosc_danych(z) {
    const wyniki = await sprawdzZgodnoscTenanta(z.tenant_id);
    for (const w of wyniki) {
      if (w.stan === "rozjazd") {
        const brakuje = (w.roznica ?? 0) > 0;
        // dedup: ta sama roznica alarmuje raz na tydzien, zmiana roznicy - od razu
        const znacznik = await odczytajZnacznikZgodnosci(z.tenant_id, w.storeId);
        const swiezy =
          znacznik &&
          znacznik.roznica === w.roznica &&
          Date.now() - new Date(znacznik.alertAt).getTime() < ODSTEP_ALERTU_ZGODNOSCI_DNI * 86_400_000;
        if (swiezy) continue;
        await wyslijAlert(
          brakuje
            ? `zgodność danych: sklep ${w.baseUrl} ma w ostatnich ${OKNO_ZGODNOSCI_DNI} dniach ${w.wSklepie} zamówień, ` +
                `w bazie jest ${w.wBazie} (brakuje ${w.roznica}, ${((w.procent ?? 0) * 100).toFixed(1)}%). ` +
                "Webhooki gubią zamówienia albo import nie objął całości - przegląd i atrybucja liczą na niepełnych danych."
            : `zgodność danych: w bazie jest ${w.wBazie} zamówień z ostatnich ${OKNO_ZGODNOSCI_DNI} dni, a sklep ${w.baseUrl} zgłasza ${w.wSklepie} ` +
                `(o ${-(w.roznica ?? 0)} mniej) - najpewniej zamówienia skasowane w sklepie; przychód w przeglądzie może być zawyżony.`,
          { poziom: !brakuje ? "info" : (w.procent ?? 0) >= 0.05 ? "krytyczny" : "uwaga", tenantId: z.tenant_id },
        );
        await zapiszZnacznikZgodnosci(z.tenant_id, w.storeId, { roznica: w.roznica ?? 0, alertAt: new Date().toISOString() });
      } else if (w.stan === "nieustalone") {
        await wyslijAlert(
          `zgodność danych: sklep ${w.baseUrl} nie odpowiada na pytanie o liczbę zamówień - nie da się sprawdzić, czy dane są kompletne.`,
          { poziom: "uwaga", tenantId: z.tenant_id },
        );
      }
    }
    console.log(
      `[zgodnosc] tenant ${z.tenant_id}: ${wyniki.filter((w) => w.stan === "zgodne").length} zgodne, ` +
        `${wyniki.filter((w) => w.stan === "rozjazd").length} rozjazd, ` +
        `${wyniki.filter((w) => w.stan === "nieustalone").length} nieustalone`,
    );
  },
};

/** Zgodnosc kazdego PODLACZONEGO sklepu tenanta. Eksportowane, bo test sprawdza to samo, co job. */
export async function sprawdzZgodnoscTenanta(tenantId: string) {
  const sklepy = (await sklepyTenanta(tenantId)).filter((s) => s.status === "connected");
  const wyniki = [];
  for (const s of sklepy) {
    const w = await sprawdzZgodnosc(tenantId, s.id, OKNO_ZGODNOSCI_DNI);
    wyniki.push({ ...w, baseUrl: s.base_url });
  }
  return wyniki;
}

/**
 * Kolejkuje job, jesli w oknie rytmu nie ma jeszcze zadnego (w dowolnym stanie) tego
 * rodzaju dla tenanta. Blokada doradcza w transakcji: dwa workery planujace naraz
 * nie zobacza obaj "brak" i nie wstawia po jednym.
 */
export async function dodajJesliBrak(
  tenantId: string,
  kind: keyof typeof RYTM,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  const rytm = RYTM[kind];
  const godziny = "doba" in rytm ? null : rytm.godziny;
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    await klient.query("select pg_advisory_xact_lock(hashtextextended('cykliczne:' || $1::text || ':' || $2::text, 0))", [
      tenantId,
      kind,
    ]);
    const { rowCount } = await klient.query(
      `insert into jobs (tenant_id, kind, payload)
       select $1, $2, $3::jsonb
        where not exists (
          select 1 from jobs j
           where j.tenant_id = $1 and j.kind = $2
             and j.created_at >= case when $4::int is null then date_trunc('day', now())
                                      else now() - make_interval(hours => $4::int) end
        )`,
      [tenantId, kind, JSON.stringify(payload), godziny],
    );
    await klient.query("commit");
    return (rowCount ?? 0) > 0;
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

/**
 * Czy od ostatniego zakonczonego przebiegu atrybucji doszlo albo zmienilo sie oplacone
 * zamowienie. Porownanie ze `started_at` (moment snapshotu zapytania atrybucji), nie
 * `finished_at`: zamowienie zacommitowane miedzy snapshotem a koncem przebiegu nie weszlo
 * do niego i musi wyzwolic nastepny (review #9). `source_updated_at` clampowane do now():
 * zegar sklepu przestawiony w przod nie moze planowac przeliczenia co godzine bez konca.
 */
export async function atrybucjaDoPrzeliczenia(tenantId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ trzeba: boolean }>(
    `select exists (
       select 1 from orders o
        where o.tenant_id = $1
          and o.profile_id is not null
          and o.status in ('completed', 'processing')
          and greatest(o.recorded_at, least(coalesce(o.source_updated_at, '-infinity'::timestamptz), now()))
              > coalesce((select max(r.started_at) from attribution_runs r
                           where r.tenant_id = $1 and r.finished_at is not null),
                         '-infinity'::timestamptz)
     ) as trzeba`,
    [tenantId],
  );
  return rows[0].trzeba;
}

export interface WynikPlanowania {
  atrybucja: number;
  ciszaSklepow: number;
  zgodnoscDanych: number;
  zalegleSurowe: number;
  porzuconeImporty: number;
}

/** Ile zaleglych surowych zdarzen ponawiamy w jednym tiku - reszta w nastepnym. */
const LIMIT_ZALEGLYCH = 500;

/**
 * Surowe zdarzenia, ktore lezą nieprzetworzone (processed_at null) od co najmniej 15 minut
 * i nie maja zadnego joba z ostatniej doby. Webhook zapisuje raw_event i job w jednej
 * transakcji, wiec "brak joba" znaczy: job wyczerpal proby i zostal 'failed'. Bez tego
 * zdarzenie po awarii przetwarzania znika na zawsze, a sklep dalej mysli, ze dostarczyl.
 *
 * Nie ponawiamy: zaslepek po RODO (nie ma czego mapowac), zdarzen sklepow poza
 * `connected`, zdarzen z `process_error` (dead-letter z fazy 2) ani takich, ktore
 * dostaly juz MAKS_PONOWIEN_SUROWYCH nowych jobow (licznik w process_error jako
 * `ponowiono:N`) - zatruty payload nie ma budzic czlowieka co dobe (review #4).
 * Cala operacja pod blokada doradcza: dwa workery nie wstawia dwoch jobow (review #8).
 */
export async function ponowZalegleSurowe(): Promise<number> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    await klient.query("select pg_advisory_xact_lock(hashtextextended('cykliczne:ponow-zalegle', 0))");
    const { rows } = await klient.query<{ id: string; tenant_id: string; store_id: string | null; ile: number }>(
      `select r.id, r.tenant_id, r.store_id,
              coalesce(nullif(split_part(r.process_error, ':', 2), '')::int, 0) as ile
         from raw_events r
         join stores s on s.tenant_id = r.tenant_id and s.id = r.store_id and s.status = 'connected'
        where r.processed_at is null
          and r.received_at < now() - interval '15 minutes'
          and not (r.payload ? 'anonimizowano')
          and (r.process_error is null or r.process_error like 'ponowiono:%')
          and coalesce(nullif(split_part(r.process_error, ':', 2), '')::int, 0) < $2
          and not exists (
            select 1 from jobs j
             where j.tenant_id = r.tenant_id and j.kind = 'przetworz_zdarzenie'
               and j.created_at >= now() - interval '24 hours'
               and j.payload ->> 'rawEventId' = r.id::text
          )
        order by r.received_at
        limit $1`,
      [LIMIT_ZALEGLYCH, MAKS_PONOWIEN_SUROWYCH],
    );
    for (const r of rows) {
      await klient.query(
        `insert into jobs (tenant_id, store_id, kind, payload)
         values ($1, $2, 'przetworz_zdarzenie', $3::jsonb)`,
        [r.tenant_id, r.store_id, JSON.stringify({ rawEventId: r.id, storeId: r.store_id, ponowienie: r.ile + 1 })],
      );
      await klient.query("update raw_events set process_error = $3 where tenant_id = $1 and id = $2", [
        r.tenant_id,
        r.id,
        `ponowiono:${r.ile + 1}`,
      ]);
    }
    await klient.query("commit");
    return rows.length;
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

/**
 * Import, ktory trwa ponad godzine bez konca, to import zabity razem z procesem
 * (timeout akcji, restart) - oznaczamy 'failed', zeby unikalny indeks "jeden trwajacy
 * na sklep" (0024) nie blokowal nastepnego przebiegu na zawsze (review #7).
 */
export async function domknijPorzuconeImporty(): Promise<number> {
  const { rowCount } = await getPool().query(
    `update import_runs set status = 'failed', finished_at = now(),
            last_error = 'przebieg porzucony: brak zakonczenia po godzinie (proces importu zostal przerwany)'
      where status = 'running' and started_at < now() - interval '1 hour'`,
  );
  return rowCount ?? 0;
}

export interface WynikPlanowania {
  atrybucja: number;
  ciszaSklepow: number;
  zgodnoscDanych: number;
  zalegleSurowe: number;
  porzuconeImporty: number;
}

/** Jeden tik planowania: przechodzi tenantow i kolejkuje to, czego brakuje w oknie rytmu. */
export async function planujCykliczne(): Promise<WynikPlanowania> {
  const wynik: WynikPlanowania = { atrybucja: 0, ciszaSklepow: 0, zgodnoscDanych: 0, zalegleSurowe: 0, porzuconeImporty: 0 };
  const { rows } = await getPool().query<{ id: string }>("select id from tenants");
  for (const t of rows) {
    if (await dodajJesliBrak(t.id, "cisza_sklepow")) wynik.ciszaSklepow++;
    if (await dodajJesliBrak(t.id, "zgodnosc_danych")) wynik.zgodnoscDanych++;
    if ((await atrybucjaDoPrzeliczenia(t.id)) && (await dodajJesliBrak(t.id, "atrybucja"))) wynik.atrybucja++;
  }
  wynik.zalegleSurowe = await ponowZalegleSurowe();
  wynik.porzuconeImporty = await domknijPorzuconeImporty();
  return wynik;
}

/**
 * Rejestracja w workerze: tik planowania na start i co 5 minut. Rytm faktyczny
 * trzyma `dodajJesliBrak` (okno od ostatniego joba), wiec czestszy tik jest tani
 * i odporny na restart procesu w polowie godziny. Zwraca funkcje zatrzymujaca.
 */
export function zarejestrujCykliczne(
  worker: { workerId: string },
  opcje: { coMs?: number } = {},
): () => void {
  const tik = () =>
    planujCykliczne()
      .then((w) => {
        if (w.atrybucja || w.ciszaSklepow || w.zgodnoscDanych || w.zalegleSurowe || w.porzuconeImporty) {
          console.log(
            `[${worker.workerId}] cykliczne: zaplanowano atrybucja ${w.atrybucja}, cisza ${w.ciszaSklepow}, ` +
              `zgodność ${w.zgodnoscDanych}, ponowione surowe zdarzenia ${w.zalegleSurowe}, porzucone importy ${w.porzuconeImporty}`,
          );
        }
      })
      .catch((b) => console.error(`[${worker.workerId}] cykliczne:`, b));
  tik();
  const uchwyt = setInterval(tik, opcje.coMs ?? 300_000);
  return () => clearInterval(uchwyt);
}
