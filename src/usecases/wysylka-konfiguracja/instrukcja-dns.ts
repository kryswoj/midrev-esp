import { createHash, randomBytes } from "node:crypto";
import { getPool } from "../../adapters/db/pool";
import { config } from "../../config";
import { domenaPlatformowaPoId, type DomenaPlatformowa } from "./domena-platformowa";

/**
 * „Wyślij instrukcję informatykowi": publiczna strona z rekordami DNS na tokenie.
 *
 * Token: 32 losowe bajty (base64url), w bazie wyłącznie SHA-256 (wzorzec sesji z 0006).
 * Ważny 14 dni, tylko odczyt, unieważniany przy ponownym wygenerowaniu i przy odłączeniu
 * domeny (kaskada FK). Strona pokazuje WYŁĄCZNIE domenę, rekordy i stan sprawdzenia:
 * żadnej nazwy konta, adresów e-mail, danych firmy ani identyfikatorów.
 */

export const WAZNOSC_LINKU_DNI = 14;

function hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function utworzLinkInstrukcji(
  tenantId: string,
  domainId: string,
  teraz = new Date(),
): Promise<{ ok: true; url: string; wygasa: Date } | { ok: false; blad: string }> {
  const d = await domenaPlatformowaPoId(tenantId, domainId);
  if (!d) return { ok: false, blad: "Nie ma takiej domeny na tym koncie." };
  const token = randomBytes(32).toString("base64url");
  const wygasa = new Date(teraz.getTime() + WAZNOSC_LINKU_DNI * 86_400_000);
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    // jeden ważny link na domenę: nowy unieważnia poprzednie (wysłany w złe miejsce = do odwołania)
    await klient.query(
      "update dns_instruction_links set revoked_at = $3 where tenant_id = $1 and sending_domain_id = $2 and revoked_at is null",
      [tenantId, domainId, teraz],
    );
    await klient.query(
      `insert into dns_instruction_links (tenant_id, sending_domain_id, token_hash, expires_at, created_at)
       values ($1, $2, $3, $4, $5)`,
      [tenantId, domainId, hash(token), wygasa, teraz],
    );
    await klient.query("commit");
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
  return { ok: true, url: `${config().APP_URL}/dns/${token}`, wygasa };
}

export interface Instrukcja {
  domena: string;
  strefa: string;
  rekordy: DomenaPlatformowa["rekordy"];
  raport: DomenaPlatformowa["raport"];
  dostawca: DomenaPlatformowa["dostawca"];
  gotowa: boolean;
  wygasa: Date;
  /** „jeden wpis" (serwery naszej strefy: dane publiczne, bez identyfikatorów konta) */
  tryb: DomenaPlatformowa["tryb"];
  delegacja: DomenaPlatformowa["delegacja"];
}

/** null = token nieznany, wygasły, unieważniony albo domena odłączona (strona pokazuje 404). */
export async function odczytajInstrukcje(token: string, teraz = new Date()): Promise<Instrukcja | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { rows } = await getPool().query(
    `select tenant_id, sending_domain_id, expires_at from dns_instruction_links
      where token_hash = $1 and revoked_at is null and expires_at > $2`,
    [hash(token), teraz],
  );
  const l = rows[0];
  if (!l) return null;
  const d = await domenaPlatformowaPoId(l.tenant_id, l.sending_domain_id);
  if (!d) return null;
  return { domena: d.domena, strefa: d.strefa, rekordy: d.rekordy, raport: d.raport, dostawca: d.dostawca, gotowa: d.gotowa, wygasa: l.expires_at, tryb: d.tryb, delegacja: d.delegacja };
}
