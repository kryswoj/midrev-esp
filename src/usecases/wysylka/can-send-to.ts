import type pg from "pg";
import { hashAdresu } from "../../adapters/hash-adresu";

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
 *
 * Wykluczenie globalne trafia ALBO po adresie, ALBO po kluczowanym haszu adresu
 * (migracja 0022): po anonimizacji RODO wpis traci adres, a blokada ma przeżyć powrót
 * tej samej osoby z nową zgodą - odbity adres odbije znowu, a skarżący zgłosi znowu.
 */
export interface OpcjeBramki {
  /**
   * Wiadomosc TRANSAKCYJNA (krok automatyzacji oznaczony przez operatora, np. potwierdzenie
   * zamowienia): pomija wylacznie brak zgody MARKETINGOWEJ. Supresje (wykluczenie globalne:
   * odbicie, skarga; wykluczenie sklepu: wypis z linku) obowiazuja zawsze (plan 3.5).
   */
  transakcyjny?: boolean;
}

export async function canSendTo(
  klient: pg.PoolClient | pg.Pool,
  tenantId: string,
  profileId: string,
  opcje: OpcjeBramki = {},
): Promise<WynikBramki> {
  // hasz liczy aplikacja (klucz pochodny od SECRETS_KEY nie ma czego szukać w SQL),
  // więc adres czytamy pierwszym zapytaniem; profil bez adresu kończy się od razu
  const { rows: profile } = await klient.query<{ email: string | null }>(
    "select email from profiles where tenant_id = $1 and id = $2",
    [tenantId, profileId],
  );
  if (!profile[0] || !profile[0].email) return { wolno: false, powod: "brak_adresu" };
  const hash = hashAdresu(profile[0].email);

  const { rows } = await klient.query(
    `with profil as (
       select id, lower(btrim(email)) as klucz, email
         from profiles where tenant_id = $1 and id = $2
     )
     select
       p.email is null as brak_adresu,
       exists (select 1 from suppressions s
                where lower(btrim(s.email)) = p.klucz or s.email_hash = $3) as globalne,
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
    [tenantId, profileId, hash],
  );

  const w = rows[0];
  if (!w) return { wolno: false, powod: "brak_adresu" };
  if (w.brak_adresu) return { wolno: false, powod: "brak_adresu" };
  if (w.globalne) return { wolno: false, powod: "wykluczenie_globalne" };
  if (w.sklepowe) return { wolno: false, powod: "wykluczenie_sklepu" };
  if (w.bez_zgody && !opcje.transakcyjny) return { wolno: false, powod: "brak_zgody" };
  return { wolno: true };
}
