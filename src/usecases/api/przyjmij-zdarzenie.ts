import { createHash } from "node:crypto";
import { getPool } from "../../adapters/db/pool";
import { dodajZadanie } from "../../jobs/kolejka";
import { wyslijAlert } from "../../jobs/alerty";
import { identyfikujProfil } from "../zdarzenia/identyfikacja";
import { zapewnijPartycjeMiesiaca } from "../zdarzenia/partycje";
import { BladZdarzenia, zapiszZdarzenie } from "../zdarzenia/zapisz-zdarzenie";
import { LimitMetryk } from "../zdarzenia/metryki";
import { zwalidujZdarzenieApi, type ZdarzenieApi } from "./zdarzenie-api";

/**
 * `POST /api/events` w dwóch fazach (AD-4, plan 2.3):
 *
 * Faza 1 (trasa, synchronicznie): walidacja schematu i limitów, zapis surowego żądania
 * do `raw_events` (channel 'api') RAZEM z jobem w jednej transakcji, odpowiedź 202.
 * Surowe żądanie w bazie PRZED odpowiedzią = 202 nigdy nie gubi zdarzenia: awaria
 * workera zostawia wiersz, który podejmie ponowienie (handlery-zdarzenia.ts).
 *
 * Faza 2 (worker, job `przetworz_zdarzenie_api`): identyfikacja profilu, upsert atrybutów
 * i właściwości, `zapiszZdarzenie` (dedup AD-38, reguła backfill/4 h), oznaczenie surowego
 * wiersza jako przetworzonego - wszystko w jednej transakcji.
 *
 * Klucz idempotencji w `raw_events` to wczesne sito (ten sam retry n8n nie tworzy drugiego
 * joba); wiążąca deduplikacja jest w `event_keys`.
 */

export const RODZAJ_JOBA = "przetworz_zdarzenie_api";

function sha256(t: string): string {
  return createHash("sha256").update(t, "utf8").digest("hex");
}

/** Klucz idempotencji surowego żądania (plan 2.3). Nie zawiera danych osobowych jawnym tekstem. */
export function kluczIdempotencjiApi(dane: ZdarzenieApi, surowe: string, przyjeto: Date): string {
  const i = dane.identyfikatory;
  const identyfikator = i.id ?? (i.email ? i.email.toLowerCase() : null) ?? i.telefon ?? i.externalId ?? i.anonymousId ?? "";
  if (dane.uniqueId) {
    return `api:${sha256(JSON.stringify(["api", dane.nazwaMetryki, identyfikator, dane.uniqueId]))}`;
  }
  return `api:req:${sha256(surowe)}:${Math.floor(przyjeto.getTime() / 1000)}`;
}

export type WynikPrzyjecia =
  | { ok: true; nowe: boolean; rawEventId: string | null }
  | { ok: false; bledy: { wskaznik: string; opis: string }[] };

export async function przyjmijZdarzenieApi(
  tenantId: string,
  kontekst: { kluczId: string; revision: string },
  surowe: string,
  cialo: unknown,
  przyjeto = new Date(),
): Promise<WynikPrzyjecia> {
  const w = zwalidujZdarzenieApi(cialo, przyjeto);
  if (!w.ok) return { ok: false, bledy: w.bledy };
  const klucz = kluczIdempotencjiApi(w.dane, surowe, przyjeto);

  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query<{ id: string }>(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload, received_at, channel)
       values ($1, null, 'api', $2, $3::jsonb, $4, 'api')
       on conflict (tenant_id, store_id, source, idempotency_key) do nothing
       returning id`,
      [
        tenantId,
        klucz,
        JSON.stringify({ body: cialo, meta: { api_key_id: kontekst.kluczId, revision: kontekst.revision.slice(0, 32), body_sha256: sha256(surowe) } }),
        przyjeto,
      ],
    );
    const rawEventId = rows[0]?.id ?? null;
    if (!rawEventId) {
      // Powtórka pod tym samym kluczem (ten sam unique_id, metryka i osoba). Jak w Klaviyo
      // (AD-38) pierwsze zdarzenie wygrywa, a odpowiedź to 202. Gdy ciało RÓŻNI się od
      // zapisanego, zostawiamy ślad w logu (bez treści i bez danych osoby), żeby rozjazd
      // dało się znaleźć (review Codeksa R2a).
      const { rows: zapisane } = await klient.query<{ hash: string | null }>(
        "select payload -> 'meta' ->> 'body_sha256' as hash from raw_events where tenant_id = $1 and store_id is null and source = 'api' and idempotency_key = $2",
        [tenantId, klucz],
      );
      if (zapisane[0]?.hash && zapisane[0].hash !== sha256(surowe)) {
        console.warn(`[api/events] tenant ${tenantId}: powtórzony unique_id z INNĄ treścią - zachowane pierwsze zdarzenie (klucz ${klucz.slice(0, 16)}…)`);
      }
    }
    if (rawEventId) {
      await dodajZadanie(tenantId, RODZAJ_JOBA, { rawEventId }, { przez: klient });
    }
    await klient.query("commit");
    return { ok: true, nowe: rawEventId !== null, rawEventId };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

export interface WynikPrzetworzenia {
  status: "zapisane" | "duplikat" | "pominiete" | "odrzucone";
  eventId?: string;
  profileId?: string;
  powod?: string;
}

/**
 * Faza 2. Błąd deterministyczny (złe dane, limit 200 metryk, nagrobek RODO) NIE wraca do
 * kolejki: dostaje `process_error` + `processed_at` i (poza RODO) alert. Błąd przejściowy
 * (baza, blokada) rzuca: job wraca z odstępem.
 */
export async function przetworzZdarzenieApi(tenantId: string, rawEventId: string): Promise<WynikPrzetworzenia> {
  const pool = getPool();
  // Partycja PRZED transakcją zapisu (osobne połączenie, ta transakcja nie trzyma jeszcze
  // blokad profilu ani metryki - patrz partycje.ts).
  const { rows: podglad } = await pool.query<{ payload: { body?: unknown }; received_at: Date }>(
    "select payload, received_at from raw_events where tenant_id = $1 and id = $2 and channel = 'api' and processed_at is null",
    [tenantId, rawEventId],
  );
  if (!podglad[0]) return { status: "pominiete" };
  const wstepnie = zwalidujZdarzenieApi(podglad[0].payload?.body, podglad[0].received_at);
  if (wstepnie.ok) {
    await zapewnijPartycjeMiesiaca(wstepnie.dane.czas ?? podglad[0].received_at).catch(() => {
      /* zapiszZdarzenie założy ją w transakcji */
    });
  }

  const klient = await pool.connect();
  let alert: string | null = null;
  try {
    await klient.query("begin");
    const { rows } = await klient.query<{ payload: { body?: unknown; anonimizowano?: boolean }; received_at: Date; processed_at: Date | null }>(
      `select payload, received_at, processed_at from raw_events
        where tenant_id = $1 and id = $2 and channel = 'api' for update`,
      [tenantId, rawEventId],
    );
    const r = rows[0];
    if (!r || r.processed_at) {
      await klient.query("rollback");
      return { status: "pominiete" };
    }
    const zakoncz = async (blad: string | null, meta: Record<string, unknown> = {}, zaslep = false) => {
      await klient.query(
        `update raw_events set processed_at = now(), process_error = $3,
                payload = case when $5::boolean then jsonb_build_object('anonimizowano', true)
                               else jsonb_set(payload, '{meta}', coalesce(payload -> 'meta', '{}'::jsonb) || $4::jsonb) end
          where tenant_id = $1 and id = $2`,
        [tenantId, rawEventId, blad, JSON.stringify(meta), zaslep],
      );
    };
    if (r.payload?.anonimizowano) {
      await zakoncz("anonimizowano");
      await klient.query("commit");
      return { status: "pominiete", powod: "anonimizowano" };
    }

    const w = zwalidujZdarzenieApi(r.payload?.body, r.received_at);
    if (!w.ok) {
      const opis = w.bledy.map((b) => `${b.wskaznik}: ${b.opis}`).join("; ").slice(0, 500);
      await zakoncz(`niepoprawne:${opis}`);
      await klient.query("commit");
      alert = `zdarzenie API (raw_event ${rawEventId}) odrzucone przy przetwarzaniu: ${opis}`;
      return { status: "odrzucone", powod: opis };
    }
    const d = w.dane;

    const ident = await identyfikujProfil(klient, tenantId, d.identyfikatory, d.atrybuty);
    if (ident.odrzucone) {
      // Nagrobek RODO: surowe ciało (adres, właściwości) od razu zaślepione, bez alertu
      // z danymi osoby. Złe właściwości profilu: odrzucenie z alertem.
      await zakoncz(
        ident.powod === "rodo" ? "rodo:nagrobek" : ident.powod === "nie_znaleziono" ? "profil:nie_znaleziono" : `niepoprawne:${ident.opis}`,
        {},
        ident.powod === "rodo",
      );
      await klient.query("commit");
      if (ident.powod !== "rodo") alert = `zdarzenie API (raw_event ${rawEventId}) odrzucone: ${ident.opis}`;
      else console.warn(`[api] raw_event ${rawEventId}: profil po art. 17 (nagrobek), zdarzenie odrzucone`);
      return { status: "odrzucone", powod: ident.powod };
    }

    const properties =
      d.wartosc !== null && d.properties.$value === undefined ? { ...d.properties, $value: d.wartosc } : d.properties;
    let wynik;
    try {
      await klient.query("savepoint zdarzenie_api");
      wynik = await zapiszZdarzenie(klient, {
        tenantId,
        metryka: { integracja: "api", nazwa: d.nazwaMetryki },
        profileId: ident.profileId,
        occurredAt: d.czas ?? r.received_at,
        ingestedAt: r.received_at,
        uniqueId: d.uniqueId,
        properties,
        valueCurrency: d.waluta,
        source: "api",
        backfill: d.backfill,
      });
      await klient.query("release savepoint zdarzenie_api");
    } catch (b) {
      if (!(b instanceof BladZdarzenia) && !(b instanceof LimitMetryk)) throw b;
      await klient.query("rollback to savepoint zdarzenie_api");
      await zakoncz(`niepoprawne:${b.message}`.slice(0, 500), { profile_id: ident.profileId });
      await klient.query("commit");
      alert = `zdarzenie API (raw_event ${rawEventId}) odrzucone: ${b.message}`;
      return { status: "odrzucone", powod: b.message };
    }

    await zakoncz(null, {
      profile_id: ident.profileId,
      event_id: wynik.id,
      duplikat: wynik.duplikat,
      ...(ident.konflikty.length ? { konflikty: ident.konflikty.map((k) => k.rodzaj) } : {}),
    });
    await klient.query("commit");
    if (ident.konflikty.length) {
      // bez wartości identyfikatorów (dane osobowe): rodzaje i id profili wystarczą do analizy
      alert = `konflikt identyfikatorów profilu w zdarzeniu API (raw_event ${rawEventId}): zdarzenie przypisane do ${ident.profileId}, ` +
        ident.konflikty.map((k) => `${k.rodzaj} wskazuje ${k.innyProfil}`).join(", ") + "; identyfikatory drugiego profilu nie zostały nadpisane";
    }
    return { status: wynik.duplikat ? "duplikat" : "zapisane", eventId: wynik.id, profileId: ident.profileId };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
    if (alert) await wyslijAlert(alert, { poziom: "uwaga", tenantId });
  }
}
