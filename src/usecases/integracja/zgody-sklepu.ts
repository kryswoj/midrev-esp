import type { PoolClient } from "pg";
import { jestWykluczonyGlobalnie } from "../../adapters/db/wykluczenia";
import type { ZgodaSklepu } from "../../domain/store/contract";

/**
 * Zgody marketingowe e-mail ze sklepu → rejestr `consents` (port „Sklep”, plan integracji E.6).
 * Wspólne reguły dla każdej platformy:
 *   1. Nowszy wypis wygrywa: zapis ze sklepu z datą równą albo starszą od ostatniego wycofania
 *      u nas NIE przywraca zgody (osoba wypisała się z maila, a sklep dalej ma „subscribed”).
 *   2. Konto w sklepie albo zakup to NIE zgoda (FR27): tę funkcję woła wyłącznie jawny sygnał
 *      zgody (checkbox w checkoucie, `emailMarketingConsent` Shopify).
 *   3. Adres wykluczony (w tym sklepie albo globalnie) nie dostaje nowej zgody.
 *   4. Idempotencja: ten sam fakt (źródło, stan, czas) zapisany drugi raz nie dubluje wpisu.
 * Rejestr jest append-only (AD-16).
 */
export type WynikZgody = "zapisana" | "pominieta_nowszy_wypis" | "pominieta_wykluczony" | "duplikat" | "bez_zmian";

export async function zapiszZgodeSklepu(
  klient: PoolClient,
  tenantId: string,
  profileId: string,
  z: ZgodaSklepu,
): Promise<WynikZgody> {
  const kiedy = new Date(Math.min(z.kiedy.getTime(), Date.now()));
  const { rows: ost } = await klient.query<{ state: string; occurred_at: Date; source: string }>(
    `select state, occurred_at, source from consents
      where tenant_id = $1 and profile_id = $2 and channel = 'email'
      order by occurred_at desc, recorded_at desc limit 1`,
    [tenantId, profileId],
  );
  const ostatnia = ost[0];
  if (ostatnia && ostatnia.source === z.zrodlo && ostatnia.state === z.stan && ostatnia.occurred_at.getTime() === kiedy.getTime()) {
    return "duplikat";
  }
  if (z.stan === "granted") {
    if (ostatnia && ostatnia.state === "withdrawn" && ostatnia.occurred_at.getTime() >= kiedy.getTime()) {
      return "pominieta_nowszy_wypis";
    }
    const { rows: wykl } = await klient.query<{ sklepowe: boolean }>(
      `select coalesce((select ts.action = 'suppressed' from tenant_suppressions ts
                         join profiles p on p.tenant_id = ts.tenant_id and p.id = $2
                        where ts.tenant_id = $1 and lower(btrim(ts.email)) = lower(btrim(p.email))
                        order by ts.occurred_at desc limit 1), false) as sklepowe`,
      [tenantId, profileId],
    );
    if (wykl[0]?.sklepowe || (await jestWykluczonyGlobalnie(z.email, klient))) return "pominieta_wykluczony";
  } else if (!ostatnia || ostatnia.state === "withdrawn" || ostatnia.occurred_at.getTime() > kiedy.getTime()) {
    // wycofanie ze sklepu starsze niż nasza ostatnia zgoda (albo brak zgody) niczego nie zmienia
    return "bez_zmian";
  }
  await klient.query(
    `insert into consents (tenant_id, profile_id, channel, state, source, wording, method_detail, occurred_at, store_consent_version_id)
     values ($1, $2, 'email', $3, $4, $5, $6, $7, $8)`,
    [tenantId, profileId, z.stan, z.zrodlo, z.tresc ?? null, z.szczegol ?? null, kiedy, z.storeConsentVersionId ?? null],
  );
  return "zapisana";
}
