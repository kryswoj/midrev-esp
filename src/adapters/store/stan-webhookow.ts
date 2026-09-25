import { getPool } from "../db/pool";
import type { StanWebhookow } from "./webhooki";

/**
 * Zapis i odczyt stanu webhooków sklepu.
 *
 * DŁUG DO SPŁACENIA: cały SQL projektu mieszka w `adapters/db/repozytoria.ts`
 * (AD-18), a te funkcje powinny być tam. Leżą tutaj, bo `repozytoria.ts` należy
 * w tej rundzie do innego agenta i równoległa edycja skończyłaby się konfliktem.
 * Przy przenoszeniu nic się nie zmienia poza miejscem - zapytania są gotowe.
 *
 * DŁUG DRUGI: stan siedzi w `stores.capabilities` pod kluczem `webhooki_stan`,
 * bo migracje są zamrożone na czas równoległej pracy (powstaje 0014). Docelowo
 * to jest osobna tabela `store_webhooks` - uzasadnienie i kształt w raporcie.
 * Każde zapytanie ma predykat `tenant_id` (AD-2), niezależnie od miejsca.
 */

const KLUCZ = "webhooki_stan";

export async function zapiszStanWebhookow(
  tenantId: string,
  storeId: string,
  stan: StanWebhookow,
): Promise<void> {
  await getPool().query(
    `update stores
        set capabilities = jsonb_set(coalesce(capabilities, '{}'::jsonb), $3::text[], $4::jsonb, true)
      where tenant_id = $1 and id = $2`,
    [tenantId, storeId, `{${KLUCZ}}`, JSON.stringify(stan)],
  );
}

export async function odczytajStanWebhookow(
  tenantId: string,
  storeId: string,
): Promise<StanWebhookow | null> {
  const { rows } = await getPool().query<{ stan: StanWebhookow | null }>(
    `select capabilities -> $3 as stan from stores where tenant_id = $1 and id = $2`,
    [tenantId, storeId, KLUCZ],
  );
  return rows[0]?.stan ?? null;
}

export interface SklepZeStanem {
  id: string;
  base_url: string;
  platform: string;
  status: string;
  created_at: Date;
  capabilities: Record<string, unknown>;
  stan: StanWebhookow | null;
  /** Ostatnie zdarzenie PRZYSŁANE przez sklep. Null = nic nigdy nie przyszło. */
  ostatnie_zdarzenie_at: Date | null;
  zdarzen_24h: number;
}

/**
 * Sklepy tenanta razem ze stanem webhooków i datą ostatniego przysłanego zdarzenia.
 * Data liczona z `raw_events` kanału WEBHOOK (moment odebrania), a nie z `orders` ani
 * z importu: import historyczny też tworzy surowe zdarzenia (`channel = 'import'`, 0023)
 * i przez dobę maskowałby fakt, że sklep milczy (review #5).
 */
export async function sklepyZeStanemWebhookow(tenantId: string): Promise<SklepZeStanem[]> {
  const { rows } = await getPool().query<SklepZeStanem>(
    `select s.id, s.base_url, s.platform, s.status, s.created_at, s.capabilities,
            s.capabilities -> $2 as stan,
            z.ostatnie as ostatnie_zdarzenie_at,
            coalesce(z.doba, 0)::int as zdarzen_24h
       from stores s
       left join lateral (
         select max(received_at) as ostatnie,
                count(*) filter (where received_at > now() - interval '24 hours') as doba
           from raw_events r
          where r.tenant_id = s.tenant_id and r.store_id = s.id and r.channel = 'webhook'
       ) z on true
      where s.tenant_id = $1
      order by s.created_at desc`,
    [tenantId, KLUCZ],
  );
  return rows;
}

/**
 * Sklep po adresie, jeszcze przed zapisem. Ponowne podłączenie tego samego sklepu
 * musi ODZYSKAĆ dotychczasowy sekret webhooka: nowy sekret przy starych webhookach
 * oznacza, że sklep dalej podpisuje po staremu, a endpoint odrzuca każdą dostawę
 * jako zły podpis - awaria bez sygnału, czyli dokładnie to, co naprawiamy.
 */
export async function znajdzSklepPoAdresie(
  tenantId: string,
  platform: string,
  baseUrl: string,
): Promise<{ id: string; credentials_encrypted: Buffer } | null> {
  const { rows } = await getPool().query<{ id: string; credentials_encrypted: Buffer }>(
    `select id, credentials_encrypted from stores
      where tenant_id = $1 and platform = $2 and base_url = $3`,
    [tenantId, platform, baseUrl],
  );
  return rows[0] ?? null;
}

export async function sklepDoRejestracji(
  tenantId: string,
  storeId: string,
): Promise<{ id: string; base_url: string; platform: string; credentials_encrypted: Buffer } | null> {
  const { rows } = await getPool().query<{
    id: string;
    base_url: string;
    platform: string;
    credentials_encrypted: Buffer;
  }>(
    `select id, base_url, platform, credentials_encrypted from stores
      where tenant_id = $1 and id = $2`,
    [tenantId, storeId],
  );
  return rows[0] ?? null;
}

/**
 * Dopisanie sekretu webhooka do poświadczeń sklepu podłączonego przed B3. Osobna
 * funkcja, bo use-case nie ma prawa pisać SQL-a (AD-18), a szyfrogram składa wołający.
 */
export async function zapiszPoswiadczenia(
  tenantId: string,
  storeId: string,
  credentialsEncrypted: Buffer,
): Promise<void> {
  await getPool().query(
    "update stores set credentials_encrypted = $3 where tenant_id = $1 and id = $2",
    [tenantId, storeId, credentialsEncrypted],
  );
}

/** Znacznik ostatniego alertu o rozjeździe danych sklepu (dedup w jobie `zgodnosc_danych`). */
export interface ZnacznikZgodnosci {
  roznica: number;
  alertAt: string;
}

const KLUCZ_ZGODNOSCI = "zgodnosc_alert";

export async function odczytajZnacznikZgodnosci(tenantId: string, storeId: string): Promise<ZnacznikZgodnosci | null> {
  const { rows } = await getPool().query<{ z: ZnacznikZgodnosci | null }>(
    "select capabilities -> $3 as z from stores where tenant_id = $1 and id = $2",
    [tenantId, storeId, KLUCZ_ZGODNOSCI],
  );
  return rows[0]?.z ?? null;
}

export async function zapiszZnacznikZgodnosci(tenantId: string, storeId: string, z: ZnacznikZgodnosci): Promise<void> {
  await getPool().query(
    `update stores
        set capabilities = jsonb_set(coalesce(capabilities, '{}'::jsonb), $3::text[], $4::jsonb, true)
      where tenant_id = $1 and id = $2`,
    [tenantId, storeId, `{${KLUCZ_ZGODNOSCI}}`, JSON.stringify(z)],
  );
}
