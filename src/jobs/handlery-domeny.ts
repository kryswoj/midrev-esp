import { getPool } from "../adapters/db/pool";
import { smtpPlatformy } from "../adapters/aws/fabryka";
import { AdapterNodemailer } from "../adapters/email/nodemailer";
import { config } from "../config";
import { portSes } from "../adapters/aws/fabryka";
import { podepnijZasobyOpcjonalne, sprawdzDomenePlatformowa, type OpcjeDomeny } from "../usecases/wysylka-konfiguracja/domena-platformowa";

/**
 * Automatyczne sprawdzanie domen platformowych (krok c kreatora). Tik co 2 minuty bierze
 * domeny, którym minął `next_check_at` (rytm w nastepneSprawdzenie: świeża co minutę,
 * potem co 5 i 15 minut, gotowa raz na dobę), i sprawdza je PO KOLEI: limit API SES poza
 * wysyłką to 1 zapytanie/s na konto, więc między domenami jest przerwa.
 *
 * Dwa workery naraz: `pg_try_advisory_lock` — drugi tik po prostu nic nie robi.
 * Przejście w „gotowa" = powiadomienie RAZ (ready_notified_at ustawiane atomowo).
 */

export const ODSTEP_DOMEN_MS = 120_000;
const BLOKADA = 7_150_415_040;
const NA_TIK = 25;
const PRZERWA_MS = 1_100;

export type WyslijPowiadomienie = (p: { do: string[]; temat: string; html: string }) => Promise<void>;

/** Domyślnie: e-mail przez SES platformy z SES_POWIADOMIENIA_OD; bez konfiguracji nic (panel i tak pokazuje). */
async function wyslijPrzezPlatforme(p: { do: string[]; temat: string; html: string }): Promise<void> {
  const k = config();
  const smtp = smtpPlatformy();
  if (!smtp || !k.SES_POWIADOMIENIA_OD) return;
  const adapter = new AdapterNodemailer(
    { host: smtp.host, port: smtp.port, bezpieczenstwo: smtp.port === 465 || smtp.port === 2465 ? "tls" : "starttls", uzytkownik: smtp.uzytkownik, haslo: smtp.haslo, rodzaj: "przekaznik", domenaKoperty: null },
    { hostyDeweloperskie: k.SMTP_HOSTY_DEWELOPERSKIE },
  );
  try {
    for (const adres of p.do) {
      await adapter.wyslijTestowa({ do: adres, od: k.SES_POWIADOMIENIA_OD, odNazwa: "MidRev", temat: p.temat, html: p.html, idempotencyKey: `domena-${Date.now()}-${Math.random().toString(36).slice(2)}` });
    }
  } finally {
    await adapter.zamknij();
  }
}

function html(t: string) {
  return t.replace(/[&<>"']/g, (z) => `&#${z.charCodeAt(0)};`);
}

/** Powiadomienie „domena gotowa": raz na przejście (atomowo), e-mail do osób z dostępem do konta. */
export async function powiadomOGotowosci(tenantId: string, domainId: string, wyslij: WyslijPowiadomienie = wyslijPrzezPlatforme): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query<{ domain: string }>(
    `update sending_domains set ready_notified_at = clock_timestamp()
      where tenant_id = $1 and id = $2 and managed_by = 'platforma' and status = 'verified' and ready_notified_at is null
      returning domain`,
    [tenantId, domainId],
  );
  if (!rows[0]) return false;
  const { rows: osoby } = await pool.query<{ email: string }>(
    `select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 order by m.created_at limit 5`,
    [tenantId],
  );
  if (osoby.length) {
    const panel = `${config().APP_URL}/t/${tenantId}/ustawienia/wysylka`;
    try {
      await wyslij({
        do: osoby.map((o) => o.email),
        temat: `Domena ${rows[0].domain} jest gotowa do wysyłki`,
        html: `<p>Dzień dobry,</p><p>sprawdziliśmy rekordy domeny <b>${html(rows[0].domain)}</b> — wszystko jest na miejscu. Możesz wysyłać kampanie.</p><p><a href="${html(panel)}">Przejdź do panelu</a></p><p>Zespół MidRev</p>`,
      });
    } catch (b) {
      // panel i tak pokazuje „gotowa"; brak maila to nie powód do ponownego przejścia
      console.error(`[domeny] powiadomienie e-mail dla tenanta ${tenantId} nie wyszło: ${String((b as Error)?.message ?? b).slice(0, 200)}`);
    }
  }
  return true;
}

export async function tikDomen(o: OpcjeDomeny & { wyslij?: WyslijPowiadomienie; przerwaMs?: number } = {}): Promise<{ sprawdzone: number; gotowe: number }> {
  const pool = getPool();
  const klient = await pool.connect();
  let sprawdzone = 0;
  let gotowe = 0;
  try {
    const { rows: blokada } = await klient.query("select pg_try_advisory_lock($1) as mam", [BLOKADA]);
    if (!blokada[0]?.mam) return { sprawdzone, gotowe };
    try {
      const { rows } = await klient.query<{ tenant_id: string; id: string }>(
        `select tenant_id, id from sending_domains
          where managed_by = 'platforma' and (next_check_at is null or next_check_at <= $1)
          order by next_check_at nulls first limit $2`,
        [o.teraz ?? new Date(), NA_TIK],
      );
      for (const [i, d] of rows.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, o.przerwaMs ?? PRZERWA_MS));
        try {
          const w = await sprawdzDomenePlatformowa(d.tenant_id, d.id, o);
          sprawdzone++;
          if (w.ok && w.domena.status === "verified") {
            if (await powiadomOGotowosci(d.tenant_id, d.id, o.wyslij)) gotowe++;
          }
        } catch (b) {
          console.error(`[domeny] sprawdzenie domeny ${d.id} (tenant ${d.tenant_id}) nie powiodło się: ${String((b as Error)?.message ?? b).slice(0, 200)}`);
          await pool.query("update sending_domains set next_check_at = $3 where tenant_id = $1 and id = $2", [d.tenant_id, d.id, new Date(Date.now() + 15 * 60_000)]);
        }
      }
      // Cel zdarzeń (SNS) nie powstał przy podłączeniu (np. uprawnienia SNS doszły później):
      // ponawiamy tu, bez udziału klienta. Bez niego bramka nie wypuści wysyłki tenanta.
      const ses = o.ses === undefined ? portSes() : o.ses;
      if (config().SES_ZDARZENIA_SNS && config().SES_SNS_TOPIC_ARN[0] && ses) {
        const { rows: bezCelu } = await klient.query<{ id: string; ses_configuration_set: string; domain: string }>(
          `select t.id, t.ses_configuration_set, d.domain from tenants t
             join sending_domains d on d.tenant_id = t.id and d.managed_by = 'platforma'
            where t.ses_configuration_set is not null and t.ses_events_destination_at is null
              and (t.ses_events_attempted_at is null or t.ses_events_attempted_at < now() - interval '1 hour')
            order by t.ses_events_attempted_at nulls first, t.id
            limit 5`,
        );
        // próba odnotowana PRZED wywołaniem: trwale psujący się tenant wraca najwcześniej za godzinę
        // i nie zasłania kolejnych (rotacja po dacie próby)
        for (const t of bezCelu) {
          await pool.query("update tenants set ses_events_attempted_at = now() where id = $1", [t.id]);
          await podepnijZasobyOpcjonalne(t.id, t.domain, t.ses_configuration_set, ses, o);
        }
      }
    } finally {
      await klient.query("select pg_advisory_unlock($1)", [BLOKADA]);
    }
  } finally {
    klient.release();
  }
  return { sprawdzone, gotowe };
}
