import type pg from "pg";
import { skompiluj } from "../../adapters/db/segmenty";
import type { Regula } from "../../domain/segmenty";
import type { RegulaWarunku } from "../../domain/automatyzacje/graf";
import { opiszFiltr } from "../../domain/filtry";
import { profilSpelnia } from "./bramka-filtrow";

type Klient = pg.PoolClient | pg.Pool;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wynik warunku. `przerwij` = warunku NIE da sie rzetelnie policzyc (segment usuniety albo
 * z regulami, ktorych kompilator nie przyjmuje). Wtedy osoba NIE idzie po cichu galezia
 * "Nie" (to bylaby decyzja podjeta za operatora), tylko konczy sciezke z powodem, a
 * operator dostaje alert.
 */
export type WynikWarunku =
  | { wynik: boolean; szczegol: Record<string, unknown> }
  | { przerwij: string; alert: string };

export interface KontekstUczestnika {
  profileId: string;
  enteredAt: string;
  /** dane przebiegu (context jsonb uczestnika) */
  context: Record<string, unknown>;
  /** E4b: warunek z filtrem ("od startu flow", "ta automatyzacja") */
  flowId?: string;
  uczestnikId?: string | null;
  triggerEventId?: string | null;
}

/**
 * Warunek liczony na DANYCH Z BAZY w chwili, w ktorej osoba dochodzi do wezla
 * (Klaviyo: "a split is a point-in-time evaluation"). Kazda regula to jedno
 * zapytanie z predykatem tenant_id w kazdym zlaczeniu (AD-2).
 */
export async function ocenWarunek(
  klient: Klient,
  tenantId: string,
  regula: RegulaWarunku,
  u: KontekstUczestnika,
): Promise<WynikWarunku> {
  switch (regula.rodzaj) {
    case "kupil_w_dniach": {
      const { rows } = await klient.query(
        `select exists (
           select 1 from orders o
            where o.tenant_id = $1 and o.profile_id = $2
              and o.status in ('completed', 'processing')
              and o.occurred_at >= now() - make_interval(days => $3::int)
         ) as wynik`,
        [tenantId, u.profileId, regula.dni],
      );
      return { wynik: rows[0].wynik, szczegol: { dni: regula.dni } };
    }
    case "kupil_od_wejscia": {
      const { rows } = await klient.query(
        `select exists (
           select 1 from orders o
            where o.tenant_id = $1 and o.profile_id = $2
              and o.status in ('completed', 'processing')
              and o.occurred_at > $3::timestamptz
         ) as wynik`,
        [tenantId, u.profileId, u.enteredAt],
      );
      return { wynik: rows[0].wynik, szczegol: { od: u.enteredAt } };
    }
    case "kliknal_poprzedni": {
      const messageId = typeof u.context.ostatniaWiadomoscId === "string" ? u.context.ostatniaWiadomoscId : null;
      if (!messageId) return { wynik: false, szczegol: { powod: "brak wcześniejszego maila w tej ścieżce" } };
      const { rows } = await klient.query(
        `select exists (
           select 1 from clicks c
            where c.tenant_id = $1 and c.message_id = $2 and c.profile_id = $3
         ) as wynik`,
        [tenantId, messageId, u.profileId],
      );
      return { wynik: rows[0].wynik, szczegol: { messageId } };
    }
    case "ma_zgode": {
      const { rows } = await klient.query(
        `select coalesce((
           select c.state from consents c
            where c.tenant_id = $1 and c.profile_id = $2 and c.channel = 'email'
            order by c.occurred_at desc, c.recorded_at desc limit 1
         ), 'brak') = 'granted' as wynik`,
        [tenantId, u.profileId],
      );
      return { wynik: rows[0].wynik, szczegol: {} };
    }
    case "w_segmencie": {
      const { rows: seg } = await klient.query(
        "select rules from segments where tenant_id = $1 and id = $2",
        [tenantId, regula.segmentId],
      );
      if (!seg[0]) {
        return { przerwij: "segment z warunku nie istnieje", alert: `automatyzacja: segment ${regula.segmentId} z warunku nie istnieje` };
      }
      let skompilowany: ReturnType<typeof skompiluj>;
      try {
        skompilowany = skompiluj(seg[0].rules as Regula[], tenantId);
      } catch (blad) {
        return {
          przerwij: "segment nieprawidłowy",
          alert: `automatyzacja: segment ${regula.segmentId} ma reguły, których nie da się policzyć (${blad instanceof Error ? blad.message : String(blad)})`,
        };
      }
      const { gdzie, parametry } = skompilowany;
      const nr = parametry.push(u.profileId);
      const { rows } = await klient.query(
        `select exists (select 1 from profiles pr where pr.tenant_id = $1 and pr.id = $${nr} ${gdzie}) as wynik`,
        parametry,
      );
      return { wynik: rows[0].wynik, szczegol: { segmentId: regula.segmentId } };
    }
    case "wartosc_zamowienia": {
      // Zamowienie z wyzwalacza (order.created niesie orderId); bez niego najnowsze OPLACONE
      // zamowienie tej osoby zlozone od wejscia do automatyzacji, a nie dowolne sprzed lat.
      // orderId pochodzi z payloadu zdarzenia: bez sprawdzenia UUID smiec w payloadzie rzucalby
      // w Postgresie i cofal transakcje, a tik calego tenanta stawalby co minute (review).
      const orderId = typeof u.context.orderId === "string" && UUID.test(u.context.orderId) ? u.context.orderId : null;
      const { rows } = await klient.query(
        orderId
          ? `select total_minor::text as kwota from orders
              where tenant_id = $1 and id = $2 and profile_id = $3 and status in ('completed', 'processing')`
          : `select total_minor::text as kwota from orders
              where tenant_id = $1 and profile_id = $2 and status in ('completed', 'processing')
                and occurred_at >= $3::timestamptz
              order by occurred_at desc limit 1`,
        orderId ? [tenantId, orderId, u.profileId] : [tenantId, u.profileId, u.enteredAt],
      );
      const kwota = rows[0] ? Number(rows[0].kwota) : null;
      return { wynik: kwota !== null && kwota >= regula.minMinor, szczegol: { kwotaMinor: kwota, minMinor: regula.minMinor } };
    }
    case "filtr": {
      if (!u.flowId) return { przerwij: "warunek bez kontekstu automatyzacji", alert: "automatyzacja: warunek z filtrem liczony bez kontekstu przebiegu" };
      const wynik = await profilSpelnia(klient, tenantId, u.profileId, regula.filtr, {
        flowId: u.flowId, start: u.enteredAt, zdarzenieWyzwalajaceId: u.triggerEventId ?? null, uczestnikId: u.uczestnikId ?? null,
      });
      return { wynik, szczegol: { filtr: opiszFiltr(regula.filtr) } };
    }
  }
}

/**
 * Najblizszy moment "dzien tygodnia + godzina" PO chwili `od`, w strefie Europe/Warsaw
 * (sklepy agencji sa w Polsce; strefa per profil to przyszla praca). Liczone w bazie,
 * bo Postgres zna zmiany czasu, a recznie liczona arytmetyka dat w JS ich nie zna.
 */
export async function najblizszyTermin(
  klient: Klient,
  od: string,
  dni: number[],
  godzina: string,
): Promise<string> {
  const { rows } = await klient.query(
    `select min(k)::text as k from (
       select ((d::date)::timestamp + $2::time) at time zone 'Europe/Warsaw' as k
         from generate_series(
           ($1::timestamptz at time zone 'Europe/Warsaw')::date,
           ($1::timestamptz at time zone 'Europe/Warsaw')::date + 7,
           interval '1 day'
         ) d
     ) x
     where k > $1::timestamptz
       and extract(isodow from (k at time zone 'Europe/Warsaw'))::int = any($3::int[])`,
    [od, godzina, dni],
  );
  if (!rows[0]?.k) throw new Error("czekaj_do: nie znaleziono terminu w ciągu 8 dni");
  return rows[0].k;
}
