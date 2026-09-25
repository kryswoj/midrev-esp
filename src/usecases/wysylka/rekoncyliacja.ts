import { getPool } from "../../adapters/db/pool";
import { wyslijAlert } from "../../jobs/alerty";
import { zapiszZdarzenie } from "./wyslij-kampanie";

/**
 * Rekoncyliacja wiadomości zawieszonych w 'sending' (AD-23). Wiadomość w tym stanie
 * dłużej niż kwadrans oznacza crash między commitem 'sending' a odpowiedzią dostawcy:
 * mail MÓGŁ wyjść, więc ponowna wysyłka w ciemno jest zakazana (NFR15). Zamiast tego
 * wiadomość przechodzi w 'held' (stan nieznany u dostawcy) i idzie alert do człowieka,
 * który wyjaśnia sprawę po idempotencyKey / Message-ID u dostawcy.
 *
 * Zegarem jest claimed_at (moment zajęcia ostatniej partii), nie occurred_at zdarzenia
 * 'sending': zdarzenie jest unikalne per (message_id, event_type) i przy ponowieniu po
 * błędzie przejściowym nie odświeża się, więc kłamałoby o wieku bieżącej próby.
 */
export async function rekoncyliacjaWysylki(tenantId: string) {
  const pool = getPool();
  const klient = await pool.connect();
  let zawieszone: string[] = [];
  try {
    await klient.query("begin");
    const { rows } = await klient.query(
      `select id from messages
        where tenant_id = $1 and current_state = 'sending'
          and coalesce(claimed_at, created_at) < now() - interval '15 minutes'
        for update skip locked`,
      [tenantId],
    );
    for (const wiersz of rows) {
      await zapiszZdarzenie(klient, tenantId, wiersz.id, "held", {
        kiedy: "teraz",
        payload: { powod: "sending_bez_potwierdzenia" },
      });
    }
    await klient.query("commit");
    zawieszone = rows.map((w) => w.id);
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }

  if (zawieszone.length) {
    await wyslijAlert(
      `rekoncyliacja: tenant ${tenantId} ma ${zawieszone.length} wiadomości w 'sending' ` +
        `starszych niż 15 min — przeniesione do 'held', wymagają wyjaśnienia u dostawcy ` +
        `po idempotencyKey (id: ${zawieszone.slice(0, 10).join(", ")}${zawieszone.length > 10 ? ", …" : ""})`,
    );
  }
  return { zawieszone: zawieszone.length };
}
