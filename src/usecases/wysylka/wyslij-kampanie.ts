import { randomBytes } from "node:crypto";
import { getPool } from "../../adapters/db/pool";
import { AdapterSmtp } from "../../adapters/email/smtp";
import { config } from "../../config";
import type { DostawcaWysylki } from "../../domain/email/port";
import { canSendTo } from "./can-send-to";
import { zlozWiadomosc } from "./renderuj";
import { policzOdbiorcow } from "../policz-odbiorcow";

/**
 * Rangi stanów wiadomości (AD-22). Projekcja current_state na messages jest aktualizowana
 * WYŁĄCZNIE monotonicznie: UPDATE ... WHERE current_rank < nowa ranga. Dzięki temu webhook
 * dostawcy z "delivered" nie zostanie nadpisany przez spóźnione "sent" workera.
 */
const RANGI: Record<string, number> = {
  queued: 0,
  claimed: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  bounced: 3,
  failed: 3,
  suppressed: 3,
  held: 3,
  complained: 4,
};

async function zapiszZdarzenie(
  klient: import("pg").PoolClient,
  tenantId: string,
  messageId: string,
  typ: string,
  payload: Record<string, unknown> = {},
) {
  // Zdarzenie jest append-only z unikalnością (message_id, event_type): powtórka
  // (np. ponowiony job) nie tworzy drugiego wpisu i nie przesuwa stanu wstecz.
  await klient.query(
    `insert into message_events (tenant_id, message_id, event_type, payload)
     values ($1, $2, $3, $4) on conflict (message_id, event_type) do nothing`,
    [tenantId, messageId, typ, JSON.stringify(payload)],
  );
  await klient.query(
    `update messages set current_state = $3, current_rank = $4
      where tenant_id = $1 and id = $2 and current_rank < $4`,
    [tenantId, messageId, typ, RANGI[typ] ?? 0],
  );
}

function token(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Faza 1: budowa wiadomości dla kampanii. Idempotentna dzięki unikalności
 * (tenant_id, source_type, source_id, profile_id) z AD-26: drugie uruchomienie
 * nie tworzy duplikatów, tylko dokłada brakujących odbiorców.
 */
export async function zbudujWiadomosciKampanii(tenantId: string, campaignId: string) {
  const pool = getPool();
  const { rows: kampanie } = await pool.query(
    `select c.name, c.subject, c.content, t.name as nazwa_sklepu
       from campaigns c join tenants t on t.id = c.tenant_id
      where c.tenant_id = $1 and c.id = $2`,
    [tenantId, campaignId],
  );
  const kampania = kampanie[0];
  if (!kampania) throw new Error("Kampania nie istnieje w tym tenancie");
  const trescHtml: string = (kampania.content as any)?.html ?? "";
  if (!trescHtml.trim()) throw new Error("Kampania nie ma treści");
  if (!kampania.subject) throw new Error("Kampania nie ma tematu");

  const odbiorcy = await policzOdbiorcow(tenantId, campaignId);
  let utworzone = 0;

  for (const profileId of odbiorcy.doceloweIds) {
    const { rows: profil } = await pool.query(
      "select email from profiles where tenant_id = $1 and id = $2",
      [tenantId, profileId],
    );
    const email = profil[0]?.email;
    if (!email) continue;

    const clickToken = token();
    const unsubToken = token();
    // HTML utrwalany PER WIADOMOŚĆ z jej własnymi tokenami: zmiana szablonu po wysyłce
    // nie może wstecznie zmienić tego, co ludzie dostali (AD-32).
    const { html, linki } = zlozWiadomosc({
      trescHtml,
      clickToken,
      unsubscribeToken: unsubToken,
      nazwaSklepu: kampania.nazwa_sklepu,
    });

    const wynik = await pool.query(
      `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject,
                             body_html, click_token, unsubscribe_token, links)
       values ($1, $2, 'campaign', $3, $4, $5, $6, $7, $8, $9)
       on conflict (tenant_id, source_type, source_id, profile_id) do nothing
       returning id`,
      [tenantId, profileId, campaignId, email, kampania.subject, html, clickToken, unsubToken, JSON.stringify(linki)],
    );
    if (wynik.rowCount) utworzone++;
  }
  return { utworzone, kandydatow: odbiorcy.doceloweIds.length };
}

/** Ile wiadomości tenant wysłał dzisiaj; podstawa limitu dobowego (FR52). */
async function wyslaneDzisiaj(tenantId: string): Promise<number> {
  const { rows } = await getPool().query(
    `select count(*)::int as ile from message_events e
      join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
     where e.tenant_id = $1 and e.event_type = 'sent' and e.occurred_at >= date_trunc('day', now())`,
    [tenantId],
  );
  return rows[0].ile;
}

/**
 * Faza 2: wysyłka partii. Cykl JEDNEJ wiadomości wg AD-23:
 *   tx1: wiążące canSendTo + przejście queued -> sending, commit PRZED wywołaniem dostawcy
 *   wywołanie dostawcy z idempotencyKey = id wiadomości
 *   tx2: zapis sent + identyfikator u dostawcy
 * Partia NIGDY nie jest jedną transakcją: awaria w środku zostawia domknięte pojedyncze
 * wiadomości, a nie połowicznie wysłaną partię bez śladu.
 */
export async function wyslijPartie(
  tenantId: string,
  opcje: { limit?: number; dostawca?: DostawcaWysylki } = {},
) {
  const pool = getPool();
  const dostawca = opcje.dostawca ?? new AdapterSmtp(config().SMTP_HOST, config().SMTP_PORT);
  const limitPartii = opcje.limit ?? 50;

  const { rows: limity } = await pool.query(
    "select daily_limit from tenant_send_limits where tenant_id = $1",
    [tenantId],
  );
  const limitDobowy = limity[0]?.daily_limit ?? 500;
  const dzisiaj = await wyslaneDzisiaj(tenantId);
  const wolneMiejsce = Math.max(0, limitDobowy - dzisiaj);
  if (wolneMiejsce === 0) {
    return { wyslane: 0, odmowy: 0, bledy: 0, powodZatrzymania: "limit_dobowy" as const };
  }

  // Zajęcie partii tym samym wzorcem co kolejka: atomowy UPDATE przez SKIP LOCKED.
  // Bez tego dwa workery pracujące naraz wybrałyby te same wiadomości w stanie queued
  // i każda wyszłaby dwa razy, a podwójna wysyłka jest nieodwracalna (NFR15).
  const { rows: doWyslania } = await pool.query(
    `update messages set current_state = 'claimed', current_rank = current_rank
      where (tenant_id, id) in (
        select tenant_id, id from messages
         where tenant_id = $1 and current_state = 'queued'
         order by created_at
         for update skip locked
         limit $2
      )
     returning id, profile_id, email, subject, body_html, unsubscribe_token`,
    [tenantId, Math.min(limitPartii, wolneMiejsce)],
  );

  let wyslane = 0;
  let odmowy = 0;
  let bledy = 0;

  for (const wiadomosc of doWyslania) {
    const klient = await pool.connect();
    let wolnoWysylac = false;
    try {
      await klient.query("begin");
      // wiążące sprawdzenie w tej samej transakcji co przejście stanu (AD-25)
      const bramka = wiadomosc.profile_id
        ? await canSendTo(klient, tenantId, wiadomosc.profile_id)
        : { wolno: true as const };
      if (!bramka.wolno) {
        await zapiszZdarzenie(klient, tenantId, wiadomosc.id, "suppressed", {
          powod: (bramka as any).powod,
        });
        odmowy++;
      } else {
        await zapiszZdarzenie(klient, tenantId, wiadomosc.id, "sending");
        wolnoWysylac = true;
      }
      await klient.query("commit");
    } catch (blad) {
      await klient.query("rollback").catch(() => {});
      klient.release();
      throw blad;
    }
    klient.release();
    if (!wolnoWysylac) continue;

    try {
      const wynik = await dostawca.wyslij({
        do: wiadomosc.email,
        od: config().MAIL_FROM,
        odNazwa: "Sklep Testowy MidRev",
        temat: wiadomosc.subject,
        html: wiadomosc.body_html,
        adresWypisania: `${config().APP_URL}/u/${wiadomosc.unsubscribe_token}`,
        idempotencyKey: wiadomosc.id,
      });
      const k2 = await pool.connect();
      try {
        await k2.query("begin");
        await k2.query("update messages set provider_id = $3 where tenant_id = $1 and id = $2", [
          tenantId,
          wiadomosc.id,
          wynik.providerId,
        ]);
        await zapiszZdarzenie(k2, tenantId, wiadomosc.id, "sent", { provider: dostawca.nazwa });
        await k2.query("commit");
        wyslane++;
      } catch (blad) {
        await k2.query("rollback").catch(() => {});
        throw blad;
      } finally {
        k2.release();
      }
    } catch (blad) {
      // Wiadomość zostaje w stanie sending: przy wznowieniu jest najpierw wyjaśniana
      // u dostawcy po idempotencyKey, nie wysyłana w ciemno drugi raz (AD-23, NFR15).
      bledy++;
      const k3 = await pool.connect();
      try {
        await k3.query("begin");
        await zapiszZdarzenie(k3, tenantId, wiadomosc.id, "failed", {
          blad: blad instanceof Error ? blad.message : String(blad),
        });
        await k3.query("commit");
      } finally {
        k3.release();
      }
    }
  }

  return { wyslane, odmowy, bledy, powodZatrzymania: null };
}
