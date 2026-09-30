import { getPool } from "../adapters/db/pool";
import { przetworzZdarzenieApi, RODZAJ_JOBA } from "../usecases/api/przyjmij-zdarzenie";
import { dosynchronizujOknoDeployu, dosynchronizujStareZdarzenia } from "../usecases/zdarzenia/lustro";
import { utrzymajPartycjeMetryk } from "../usecases/zdarzenia/partycje";
import type { OpcjeAlertu } from "./alerty";
import type { Zadanie } from "./kolejka";

/**
 * Worker: strumień zdarzeń metryk i API zdarzeń (E1/E2).
 *
 *   przetworz_zdarzenie_api — faza 2 `POST /api/events` (usecases/api/przyjmij-zdarzenie.ts)
 *   partycje metryk (start + co dobę) — zapas partycji miesięcznych, alert krytyczny przy błędzie
 *   dosynchronizowanie `events` (start, potem co minutę przez 30 min) — okno deployu: stary
 *     kod pisał tylko do `events`, a deploy.sh restartuje panel PO starcie workera
 *   zaległe żądania API (co 15 min) — surowe żądanie bez przetworzenia i bez żywego joba
 *     (job wyczerpał próby) dostaje nowy job; najwyżej 3 razy, potem alert. Bez tego
 *     202 dane klientowi mogłoby skończyć się cichą utratą zdarzenia.
 */

export const HANDLERY_ZDARZEN: Record<string, (z: Zadanie) => Promise<void>> = {
  async [RODZAJ_JOBA](z) {
    await przetworzZdarzenieApi(z.tenant_id, String(z.payload.rawEventId));
  },
};

const MAKS_PONOWIEN = 3;
const LIMIT_ZALEGLYCH = 500;

export async function ponowZalegleZdarzeniaApi(): Promise<{ ponowione: number; porzucone: number }> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    await klient.query("select pg_advisory_xact_lock(hashtextextended('zdarzenia:ponow-zalegle-api', 0))");
    const { rows } = await klient.query<{ id: string; tenant_id: string; ile: number }>(
      `select r.id, r.tenant_id,
              coalesce(nullif(split_part(r.process_error, ':', 2), '')::int, 0) as ile
         from raw_events r
        where r.channel = 'api' and r.processed_at is null
          and r.received_at < now() - interval '15 minutes'
          and (r.process_error is null or r.process_error like 'ponowiono:%')
          and not exists (
            select 1 from jobs j
             where j.tenant_id = r.tenant_id and j.kind = $2
               and j.created_at >= now() - interval '15 days'
               and j.status in ('pending', 'running')
               and j.payload ->> 'rawEventId' = r.id::text
          )
        order by r.received_at
        limit $1`,
      [LIMIT_ZALEGLYCH, RODZAJ_JOBA],
    );
    let ponowione = 0;
    let porzucone = 0;
    for (const r of rows) {
      if (r.ile >= MAKS_PONOWIEN) {
        await klient.query(
          "update raw_events set process_error = $3 where tenant_id = $1 and id = $2",
          [r.tenant_id, r.id, `porzucone:po ${MAKS_PONOWIEN} ponowieniach`],
        );
        porzucone++;
        continue;
      }
      await klient.query(
        `insert into jobs (tenant_id, kind, payload) values ($1, $2, $3::jsonb)`,
        [r.tenant_id, RODZAJ_JOBA, JSON.stringify({ rawEventId: r.id, ponowienie: r.ile + 1 })],
      );
      await klient.query("update raw_events set process_error = $3 where tenant_id = $1 and id = $2", [
        r.tenant_id,
        r.id,
        `ponowiono:${r.ile + 1}`,
      ]);
      ponowione++;
    }
    await klient.query("commit");
    return { ponowione, porzucone };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

/** Jak długo po starcie workera działa cykliczne dosynchronizowanie okna deployu. */
export const OKNO_DEPLOYU_MS = 30 * 60_000;

export function zaplanujZdarzenia(opcje: {
  workerId: string;
  wyslijAlert: (tresc: string, o?: OpcjeAlertu) => Promise<void>;
  /** zegar (testy) */
  teraz?: () => number;
}) {
  const { workerId, wyslijAlert } = opcje;
  async function partycje() {
    const w = await utrzymajPartycjeMetryk();
    if (w.zalozone) console.log(`[${workerId}] partycje metryk: założone ${w.zalozone}`);
    if (w.blad) await wyslijAlert(`utrzymanie partycji strumienia metric_events: ${w.blad}`, { poziom: "krytyczny" });
  }
  async function zalegle() {
    const w = await ponowZalegleZdarzeniaApi();
    if (w.ponowione) console.warn(`[${workerId}] zdarzenia API: ${w.ponowione} zaległych żądań dostało nowy job`);
    if (w.porzucone) {
      await wyslijAlert(`zdarzenia API: ${w.porzucone} żądań nie dało się przetworzyć po ${MAKS_PONOWIEN} ponowieniach (raw_events.process_error = porzucone)`, {
        poziom: "krytyczny",
      });
    }
  }
  const start = opcje.teraz?.() ?? Date.now();
  async function oknoDeployu() {
    // tylko przez pierwsze 30 min pracy workera: potem stary kod już nie działa, a przebieg
    // (skan `events` z ostatniej godziny) byłby czystym kosztem
    if ((opcje.teraz?.() ?? Date.now()) - start > OKNO_DEPLOYU_MS) return;
    const n = await dosynchronizujOknoDeployu();
    if (n) console.warn(`[${workerId}] strumień: dosynchronizowano ${n} zdarzeń zapisanych przez poprzednią wersję (okno deployu)`);
  }
  return {
    async start() {
      await partycje();
      const n = await dosynchronizujStareZdarzenia();
      if (n) console.warn(`[${workerId}] strumień: dosynchronizowano ${n} zdarzeń zapisanych przez poprzednią wersję`);
    },
    cykliczne: [
      { nazwa: "partycje metryk", ms: 24 * 3600_000, praca: partycje },
      { nazwa: "zaległe zdarzenia API", ms: 15 * 60_000, praca: zalegle },
      { nazwa: "strumień: okno deployu", ms: 60_000, praca: oknoDeployu },
    ],
  };
}
