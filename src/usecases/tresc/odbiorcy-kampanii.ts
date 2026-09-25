import { getPool } from "../../adapters/db/pool";
import { STATUSY_ZAMROZONE } from "./zapisz-tresc";

/**
 * Krok 1 kreatora: wybór list i segmentów (dodaj / odejmij) do `campaign_audience`.
 *
 * Liczenie odbiorców zostaje tam, gdzie było (`policz-odbiorcow.ts`) — ten plik tylko
 * zapisuje wybór. `campaign_audience.source_id` nie ma klucza obcego, więc przynależność
 * listy i segmentu do tenanta sprawdzamy tutaj; bez tego spreparowany POST dopiąłby do
 * kampanii cudzy segment, a silnik policzyłby z niego odbiorców (AD-2).
 *
 * Zmiana odbiorców NIE cofa akceptacji: klient akceptuje treść (strona akceptacji
 * pokazuje temat i maila, nie listę odbiorców). Po starcie wysyłki wybór jest zamrożony
 * tak samo jak treść — kolejka jest już zbudowana.
 */

export type TypZrodla = "list" | "segment";
export interface Zrodlo {
  typ: TypZrodla;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "list:<uuid>" / "segment:<uuid>" z formularza. Śmieć = null (i błąd u wołającego). */
export function zrodloZPola(surowe: string): Zrodlo | null {
  const [typ, id] = String(surowe).split(":");
  if ((typ !== "list" && typ !== "segment") || !UUID.test(id ?? "")) return null;
  return { typ, id: id.toLowerCase() };
}

type Wynik<T = object> = ({ ok: true } & T) | { ok: false; blad: string };

export async function ustawOdbiorcow(
  tenantId: string,
  campaignId: string,
  wlaczone: Zrodlo[],
  wylaczone: Zrodlo[],
): Promise<Wynik<{ zmieniono: boolean }>> {
  const klucz = (z: Zrodlo) => `${z.typ}:${z.id}`;
  const w = new Map(wlaczone.map((z) => [klucz(z), z]));
  const o = new Map(wylaczone.map((z) => [klucz(z), z]));
  for (const k of w.keys()) {
    if (o.has(k)) return { ok: false, blad: "To samo źródło nie może jednocześnie dodawać i odejmować odbiorców." };
  }
  const wszystkie = [...w.values(), ...o.values()];
  if (wszystkie.length > 50) return { ok: false, blad: "Za dużo źródeł odbiorców w jednej kampanii (maks. 50)." };

  const pool = getPool();
  const idsList = wszystkie.filter((z) => z.typ === "list").map((z) => z.id);
  const idsSeg = wszystkie.filter((z) => z.typ === "segment").map((z) => z.id);
  const { rows: znane } = await pool.query(
    `select 'list' as typ, id::text from lists where tenant_id = $1 and id = any($2::uuid[])
     union all
     select 'segment' as typ, id::text from segments where tenant_id = $1 and id = any($3::uuid[])`,
    [tenantId, idsList, idsSeg],
  );
  const istnieja = new Set(znane.map((r) => `${r.typ}:${r.id}`));
  if (wszystkie.some((z) => !istnieja.has(klucz(z)))) {
    return { ok: false, blad: "Któraś lista albo segment nie istnieje na tym koncie. Odśwież stronę." };
  }

  const klient = await pool.connect();
  try {
    await klient.query("begin");
    // blokada wiersza kampanii: worker przechodzący w `sending` czeka na koniec zapisu
    const { rows } = await klient.query(
      "select status from campaigns where tenant_id = $1 and id = $2 for update",
      [tenantId, campaignId],
    );
    if (!rows[0]) {
      await klient.query("rollback");
      return { ok: false, blad: "Nie znaleziono kampanii." };
    }
    if ((STATUSY_ZAMROZONE as readonly string[]).includes(String(rows[0].status))) {
      await klient.query("rollback");
      return { ok: false, blad: "Wysyłka już ruszyła — odbiorcy są zamrożeni razem z treścią." };
    }
    const { rows: obecne } = await klient.query(
      "select mode, source_type, source_id::text from campaign_audience where tenant_id = $1 and campaign_id = $2",
      [tenantId, campaignId],
    );
    const przed = new Set(obecne.map((r) => `${r.mode}|${r.source_type}:${r.source_id}`));
    const po = new Set([...[...w.keys()].map((k) => `include|${k}`), ...[...o.keys()].map((k) => `exclude|${k}`)]);
    const zmieniono = przed.size !== po.size || [...po].some((k) => !przed.has(k));
    if (!zmieniono) {
      await klient.query("rollback");
      return { ok: true, zmieniono: false };
    }
    await klient.query("delete from campaign_audience where tenant_id = $1 and campaign_id = $2", [tenantId, campaignId]);
    for (const [mode, mapa] of [["include", w], ["exclude", o]] as const) {
      for (const z of mapa.values()) {
        await klient.query(
          `insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id)
           values ($1, $2, $3, $4, $5)`,
          [tenantId, campaignId, mode, z.typ, z.id],
        );
      }
    }
    await klient.query("update campaigns set updated_at = now() where tenant_id = $1 and id = $2", [tenantId, campaignId]);
    // odczyt zwrotny w tej samej transakcji: zapisany zestaw = żądany zestaw
    const { rows: zapisane } = await klient.query(
      "select mode, source_type, source_id::text from campaign_audience where tenant_id = $1 and campaign_id = $2",
      [tenantId, campaignId],
    );
    const zapisanyZestaw = new Set(zapisane.map((r) => `${r.mode}|${r.source_type}:${r.source_id}`));
    if (zapisanyZestaw.size !== po.size || [...po].some((k) => !zapisanyZestaw.has(k))) {
      await klient.query("rollback");
      return { ok: false, blad: "Zapis odbiorców nie zgadza się z odczytem z bazy — nic nie zmieniono." };
    }
    await klient.query("commit");
    return { ok: true, zmieniono: true };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}
