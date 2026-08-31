import type pg from "pg";

export type PowodOdmowy =
  | "brak_adresu"
  | "wykluczenie_globalne"
  | "wykluczenie_sklepu"
  | "brak_zgody";

export interface WynikBramki {
  wolno: boolean;
  powod?: PowodOdmowy;
}

/**
 * Wiążąca bramka wysyłki (AD-9, AD-25). Jedyne miejsce w systemie, które odpowiada
 * na pytanie "czy do tej osoby wolno teraz wysłać".
 *
 * Wywoływana W TEJ SAMEJ TRANSAKCJI co przejście wiadomości queued -> sending, bo lista
 * odbiorców policzona przy planowaniu kampanii jest kandydatem, nie decyzją: między nią
 * a wysyłką mijają dni (akceptacja klienta, harmonogram) i ktoś w tym czasie się wypisze.
 *
 * Kolejność sprawdzeń jest celowa: wykluczenia globalne najpierw, bo chronią reputację
 * całej platformy, a nie jednego sklepu.
 */
export async function canSendTo(
  klient: pg.PoolClient | pg.Pool,
  tenantId: string,
  profileId: string,
): Promise<WynikBramki> {
  const { rows } = await klient.query(
    `with profil as (
       select id, lower(btrim(email)) as klucz, email
         from profiles where tenant_id = $1 and id = $2
     )
     select
       p.email is null as brak_adresu,
       exists (select 1 from suppressions s where lower(btrim(s.email)) = p.klucz) as globalne,
       coalesce((
         select ts.action = 'suppressed' from tenant_suppressions ts
          where ts.tenant_id = $1 and lower(btrim(ts.email)) = p.klucz
          order by ts.occurred_at desc limit 1
       ), false) as sklepowe,
       coalesce((
         select c.state from consents c
          where c.tenant_id = $1 and c.profile_id = p.id and c.channel = 'email'
          order by c.occurred_at desc limit 1
       ), 'brak') <> 'granted' as bez_zgody
     from profil p`,
    [tenantId, profileId],
  );

  const w = rows[0];
  if (!w) return { wolno: false, powod: "brak_adresu" };
  if (w.brak_adresu) return { wolno: false, powod: "brak_adresu" };
  if (w.globalne) return { wolno: false, powod: "wykluczenie_globalne" };
  if (w.sklepowe) return { wolno: false, powod: "wykluczenie_sklepu" };
  if (w.bez_zgody) return { wolno: false, powod: "brak_zgody" };
  return { wolno: true };
}
