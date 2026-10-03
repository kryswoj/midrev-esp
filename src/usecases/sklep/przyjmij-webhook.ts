import { z } from "zod";
import { getPool } from "../../adapters/db/pool";
import { odszyfrujPoswiadczenia } from "../../adapters/store/fabryka";
import { definicjaPlatformy } from "../../adapters/store/rejestr";
import { dodajZadanie } from "../../jobs/kolejka";

const schematId = z.string().uuid();

/** Odpowiedź fazy 1 w postaci niezależnej od frameworka (trasa zamienia ją na NextResponse). */
export interface OdpowiedzWebhooka {
  status: number;
  tresc: string;
}

/**
 * Faza 1 ingestu webhooków sklepu (FR12, FR13, AD-4) dla KAŻDEJ platformy portu „Sklep”:
 * weryfikacja podpisu, zapis surowego zdarzenia i joba w jednej transakcji, odpowiedź
 * w ułamku sekundy. Faza 2 (worker): `przetworzZdarzenie` z mapowaniem platformy.
 *
 * Zachowanie wyciągnięte 1:1 z trasy Woo (`/api/webhooks/woo/[storeId]`), z dwiema zasadami
 * wspólnymi dla platform:
 *  - sklep z innej platformy niż trasa = 404 (sekret Woo nie weryfikuje dostawy „Shopify”),
 *  - temat spoza subskrypcji = 200 bez zapisu (4xx kazałby platformie ponawiać i w końcu
 *    wyłączyć webhooka), temat bez bytu = 400, payload bez id/daty ze źródła = 400.
 *
 * Klucz idempotencji opisuje BYT, nie kanał (AD-24): to samo zamówienie z webhooka i z importu
 * ma ten sam klucz i nie wejdzie dwa razy. Kształt klucza daje definicja platformy.
 */
export async function przyjmijWebhookSklepu(
  platforma: string,
  storeId: string,
  naglowki: Headers,
  cialo: string | null,
): Promise<OdpowiedzWebhooka> {
  // zly format uuid w zapytaniu pg konczy sie bledem skladni i piecsetka;
  // dla nadawcy to po prostu nieznany sklep
  if (!schematId.safeParse(storeId).success) return { status: 404, tresc: "nieznany sklep" };
  if (cialo === null) return { status: 413, tresc: "za duże ciało" };
  const definicja = definicjaPlatformy(platforma);
  const webhooki = definicja?.webhooki;
  if (!definicja || !webhooki) return { status: 404, tresc: "nieznany sklep" };
  const pool = getPool();

  const { rows } = await pool.query<{ tenant_id: string; platform: string; status: string; credentials_encrypted: Buffer }>(
    "select tenant_id, platform, status, credentials_encrypted from stores where id = $1",
    [storeId],
  );
  const sklep = rows[0];
  // sklep odłączony (wtyczka „Odłącz”, odinstalowanie aplikacji) nie przyjmuje dostaw (review r1)
  if (!sklep || sklep.platform !== definicja.platforma || sklep.status === "disconnected") {
    return { status: 404, tresc: "nieznany sklep" };
  }

  let sekret: string | null;
  try {
    sekret = definicja.sekretWebhooka(odszyfrujPoswiadczenia(sklep.credentials_encrypted));
  } catch {
    sekret = null;
  }
  // sklep bez sekretu nie moze niczego zweryfikowac: odpowiedz jak przy zlym
  // podpisie, a nie 500 - wyjatek zdradzalby, ze cos jest nie tak z konfiguracja
  if (!sekret) return { status: 401, tresc: "zły podpis" };
  if (!webhooki.zweryfikujPodpis(naglowki, cialo, sekret)) {
    if (webhooki.ping?.(naglowki, cialo)) return { status: 200, tresc: "ping" };
    return { status: 401, tresc: "zły podpis" };
  }

  let dane: any;
  try {
    dane = JSON.parse(cialo);
  } catch {
    return { status: 400, tresc: "nieczytelne ciało" };
  }
  // temat jest OBOWIĄZKOWY: bez nagłówka nie wiadomo, czy payload to zamówienie, czy
  // klient, a zgadywanie "order" mapowało klienta jako zamówienie (audyt #4)
  const temat = webhooki.temat(naglowki);
  if (!webhooki.obslugiwany(temat)) return { status: 200, tresc: "temat pominięty" };
  const byt = webhooki.bytTematu(temat);
  if (!byt) return { status: 400, tresc: "nieobsługiwany temat" };
  const k = webhooki.klucz(sklep.tenant_id, byt, dane);
  if ("blad" in k) return { status: 400, tresc: k.blad };

  // Zapis zdarzenia i job w JEDNEJ transakcji: gdyby job powstawał osobno i padł,
  // retry nadawcy trafiłby w idempotencję zapisu (duplikat) i zdarzenie zostałoby
  // nieprzetworzone na zawsze (znalezisko review). Duplikat jeszcze NIEPRZETWORZONY
  // też dostaje job - drugi job jest nieszkodliwy, bo handler sprawdza processed_at.
  const klient = await pool.connect();
  let nowe = false;
  try {
    await klient.query("begin");
    const wynik = await klient.query<{ id: string }>(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, store_id, source, idempotency_key) do nothing
       returning id`,
      [sklep.tenant_id, storeId, definicja.zrodloSurowych, k.klucz, cialo],
    );
    nowe = wynik.rowCount === 1;
    let rawEventId = wynik.rows[0]?.id;
    if (!rawEventId) {
      const zastane = await klient.query<{ id: string }>(
        `select id from raw_events
          where tenant_id = $1 and store_id = $2 and source = $3
            and idempotency_key = $4 and processed_at is null`,
        [sklep.tenant_id, storeId, definicja.zrodloSurowych, k.klucz],
      );
      rawEventId = zastane.rows[0]?.id;
    }
    if (rawEventId) {
      await dodajZadanie(sklep.tenant_id, "przetworz_zdarzenie", { rawEventId, storeId, temat }, { przez: klient });
    }
    await klient.query("commit");
  } catch (blad) {
    await klient.query("rollback");
    throw blad;
  } finally {
    klient.release();
  }
  return { status: 200, tresc: nowe ? "przyjęte" : "duplikat" };
}
