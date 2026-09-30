import { config } from "../../config";
import type { Wykonawca } from "../../domain/automatyzacje/wyzwalanie";

/**
 * Czy tryby ponownego wejscia inne niz "raz" wolno uzywac (AD-41, AD-46).
 *
 * Dwa warunki naraz:
 *  1. flaga MIDREV_PONOWNE_WEJSCIE=1 (decyzja operatora, po wydaniu z 0036);
 *  2. w bazie NIE MA juz starych unikalnosci (0019, 0005). Dopoki sa, drugi przebieg tej
 *     samej osoby i jego wiadomosc wywrocilyby sie na nich (albo, gorzej, zostaly cicho
 *     pominiete), wiec sama flaga nie wystarcza.
 */
export const STARE_UNIKALNOSCI = [
  "flow_participants_tenant_id_flow_id_profile_id_key",
  "messages_tenant_id_source_type_source_id_profile_id_key",
] as const;

export async function ponowneWejscieDostepne(klient: Wykonawca): Promise<boolean> {
  if (!config().MIDREV_PONOWNE_WEJSCIE) return false;
  const { rows } = await klient.query(
    `select count(*)::int as n from pg_constraint
      where conname = any($1::text[]) and conrelid in ('flow_participants'::regclass, 'messages'::regclass)`,
    [[...STARE_UNIKALNOSCI]],
  );
  return rows[0].n === 0;
}

/** Stan do komunikatu (flaga wlaczona, a schemat jeszcze stary = alert dla operatora). */
export async function stanPonownegoWejscia(klient: Wykonawca): Promise<{ flaga: boolean; dostepne: boolean }> {
  const flaga = config().MIDREV_PONOWNE_WEJSCIE;
  return { flaga, dostepne: flaga ? await ponowneWejscieDostepne(klient) : false };
}
