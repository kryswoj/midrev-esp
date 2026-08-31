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

export async function zapiszZdarzenie(
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

/**
 * Ile miejsc z limitu dobowego tenant już ZAREZERWOWAŁ dzisiaj (FR52).
 * Licznikiem prawdy jest tenant_send_usage, nie zliczanie zdarzeń 'sent': rezerwacja
 * obejmuje też wiadomości w locie i spalone próby, więc równoległe procesy nie mogą
 * razem przekroczyć limitu. Rezerwacji nie zwalniamy przy niejasnym wyniku dostawcy.
 */
async function zuzycieDzisiaj(tenantId: string): Promise<number> {
  const { rows } = await getPool().query(
    "select used from tenant_send_usage where tenant_id = $1 and day = current_date",
    [tenantId],
  );
  return rows[0]?.used ?? 0;
}

/** Po tylu nieudanych próbach przejściowych wiadomość dostaje trwałe failed. */
const MAX_PROB_WIADOMOSCI = 5;

/**
 * Klasyfikacja błędu dostawcy wg tego, co WIADOMO o losie wiadomości:
 *   przejsciowy — dostawca NA PEWNO nie przyjął: odmowa nawiązania połączenia
 *     (nic nie wyszło) albo jawna odpowiedź SMTP 4xx (RFC 5321: odmowa tymczasowa,
 *     także po DATA oznacza nieprzyjęcie) -> bezpieczny powrót do queued.
 *   trwaly — jawna odpowiedź SMTP 5xx: dostawca odmówił na stałe -> failed.
 *   nieznany — zerwane połączenie, timeout (ECONNRESET/EPIPE/ETIMEDOUT): mogły zajść
 *     już PO kropce kończącej DATA, więc mail mógł wyjść. Wiadomość zostaje w sending
 *     i rozstrzyga ją rekoncyliacja (held + alert), nie ślepe ponowienie (NFR15).
 */
function klasaBledu(blad: unknown): "przejsciowy" | "trwaly" | "nieznany" {
  const kod = (blad as { code?: unknown })?.code;
  if (typeof kod === "string" && ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND"].includes(kod)) {
    return "przejsciowy";
  }
  const tresc = blad instanceof Error ? blad.message : String(blad);
  const odpowiedz = tresc.match(/dostano: (\d)\d\d/);
  if (odpowiedz) return odpowiedz[1] === "4" ? "przejsciowy" : "trwaly";
  return "nieznany";
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
  // Wstępny odczyt służy TYLKO doborowi rozmiaru partii; wiążąca jest rezerwacja
  // per wiadomość w transakcji przejścia w sending (poniżej).
  const zuzyte = await zuzycieDzisiaj(tenantId);
  const wolneMiejsce = Math.max(0, limitDobowy - zuzyte);
  if (wolneMiejsce === 0) {
    return { wyslane: 0, odmowy: 0, bledy: 0, powodZatrzymania: "limit_dobowy" as const };
  }

  // Zajęcie partii tym samym wzorcem co kolejka: atomowy UPDATE przez SKIP LOCKED.
  // Bez tego dwa workery pracujące naraz wybrałyby te same wiadomości w stanie queued
  // i każda wyszłaby dwa razy, a podwójna wysyłka jest nieodwracalna (NFR15).
  // claimed_at pełni dwie role: zegar recovery (zombie liczy timeout od zajęcia,
  // nie od utworzenia) i TOKEN WŁASNOŚCI partii — krąży jako tekst prosto z bazy
  // (mikrosekundy; przejście przez Date psuje wartość, jak przy tożsamości jobów).
  // Sam stan 'claimed' nie wystarcza za dowód własności: po odzyskaniu zombie inny
  // proces mógł zająć tę samą wiadomość na nowo i też widzieć 'claimed'.
  const { rows: doWyslania } = await pool.query(
    `update messages set current_state = 'claimed', claimed_at = now()
      where (tenant_id, id) in (
        select tenant_id, id from messages
         where tenant_id = $1 and current_state = 'queued'
         order by created_at
         for update skip locked
         limit $2
      )
     returning id, profile_id, email, subject, body_html, unsubscribe_token,
               claimed_at::text as claim_token`,
    [tenantId, Math.min(limitPartii, wolneMiejsce)],
  );

  let wyslane = 0;
  let odmowy = 0;
  let bledy = 0;
  let powodZatrzymania: "limit_dobowy" | null = null;

  for (let i = 0; i < doWyslania.length; i++) {
    const wiadomosc = doWyslania[i];
    const klient = await pool.connect();
    let wolnoWysylac = false;
    let limitOdmowil = false;
    let utracona = false;
    try {
      await klient.query("begin");
      // Potwierdzenie własności pod blokadą wiersza: stan musi być 'claimed' I token
      // (claimed_at) musi być NASZ. Jeśli recovery zombie cofnął wiadomość do queued
      // i inny proces zajął ją na nowo, stan znów jest 'claimed', ale token inny —
      // wtedy NIE wolno ani wołać dostawcy, ani zapisywać suppressed.
      // porównanie tokenu jako WARTOŚCI w bazie (wzorzec z kolejki), nie tekst-do-tekstu
      // w JS: rendering timestamptz zależy od ustawień sesji, wartość nie
      const { rows: wlasnosc } = await klient.query(
        `select current_state, (claimed_at = $3::timestamptz) as nasz_claim
           from messages where tenant_id = $1 and id = $2 for update`,
        [tenantId, wiadomosc.id, wiadomosc.claim_token],
      );
      if (wlasnosc[0]?.current_state !== "claimed" || !wlasnosc[0]?.nasz_claim) {
        utracona = true;
      } else {
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
          // Rezerwacja limitu dobowego W TEJ SAMEJ transakcji co przejście w sending:
          // warunek `used + 1 <= limit` w bazie zamyka wyścig dwóch równoległych procesów.
          // Odmowa = brak zaktualizowanego wiersza; wtedy nic z tej transakcji nie wchodzi.
          const rezerwacja = await klient.query(
            `insert into tenant_send_usage (tenant_id, day, used) values ($1, current_date, 1)
             on conflict (tenant_id, day) do update set used = tenant_send_usage.used + 1
             where tenant_send_usage.used + 1 <= $2
             returning used`,
            [tenantId, limitDobowy],
          );
          if (!rezerwacja.rowCount) {
            limitOdmowil = true;
          } else {
            await zapiszZdarzenie(klient, tenantId, wiadomosc.id, "sending");
            wolnoWysylac = true;
          }
        }
      }
      if (limitOdmowil || utracona) await klient.query("rollback");
      else await klient.query("commit");
    } catch (blad) {
      await klient.query("rollback").catch(() => {});
      klient.release();
      throw blad;
    }
    klient.release();
    if (utracona) continue;

    if (limitOdmowil) {
      // Limit wyczerpany: ta wiadomość i cała reszta zajętej partii wracają do queued,
      // partia kończy się powodem limit_dobowy. Nic nie poszło do dostawcy.
      // Warunek na token własności: bez niego zbiorczy requeue starej partii mógłby
      // cofnąć świeże claimy innego workera, który przejął te wiadomości po recovery.
      const pozostale = doWyslania.slice(i).map((w) => w.id);
      await pool.query(
        `update messages set current_state = 'queued', claimed_at = null
          where tenant_id = $1 and id = any($2) and current_state = 'claimed'
            and claimed_at = $3::timestamptz`,
        [tenantId, pozostale, wiadomosc.claim_token],
      );
      powodZatrzymania = "limit_dobowy";
      break;
    }
    if (!wolnoWysylac) continue;

    let wynik;
    try {
      wynik = await dostawca.wyslij({
        do: wiadomosc.email,
        od: config().MAIL_FROM,
        odNazwa: "Sklep Testowy MidRev",
        temat: wiadomosc.subject,
        html: wiadomosc.body_html,
        adresWypisania: `${config().APP_URL}/u/${wiadomosc.unsubscribe_token}`,
        idempotencyKey: wiadomosc.id,
      });
    } catch (blad) {
      // Błąd DOSTAWCY. Rezerwacji limitu nie zwalniamy w żadnym z przypadków —
      // lepiej wysłać mniej niż przekroczyć limit przy niejasnym wyniku.
      bledy++;
      const opisBledu = blad instanceof Error ? blad.message : String(blad);
      const klasa = klasaBledu(blad);
      if (klasa === "nieznany") {
        // Stan u dostawcy nieznany (np. zerwane połączenie po DATA): wiadomość
        // zostaje w sending, rozstrzygnie ją rekoncyliacja (held + alert), nie
        // ślepe ponowienie (AD-23, NFR15).
        console.error(`[wysylka] wiadomość ${wiadomosc.id}: wynik u dostawcy nieznany, zostaje w sending: ${opisBledu}`);
        continue;
      }
      const k3 = await pool.connect();
      try {
        await k3.query("begin");
        // Guard stanu pod blokadą: jeśli w międzyczasie rekoncyliacja albo webhook
        // rozstrzygnęły los wiadomości (held/delivered/...), nie wolno jej ruszać.
        const { rows: stan } = await k3.query(
          "select current_state from messages where tenant_id = $1 and id = $2 for update",
          [tenantId, wiadomosc.id],
        );
        if (stan[0]?.current_state !== "sending") {
          await k3.query("rollback");
        } else if (klasa === "przejsciowy") {
          const { rows: proby } = await k3.query(
            "update messages set attempts = attempts + 1 where tenant_id = $1 and id = $2 returning attempts",
            [tenantId, wiadomosc.id],
          );
          if ((proby[0]?.attempts ?? MAX_PROB_WIADOMOSCI) >= MAX_PROB_WIADOMOSCI) {
            await zapiszZdarzenie(k3, tenantId, wiadomosc.id, "failed", {
              blad: opisBledu,
              powod: "wyczerpane_proby",
            });
          } else {
            // Kontrolowane cofnięcie projekcji (rank w dół): zdarzenie 'sending' z tej
            // próby zostaje w historii, a wiadomość wraca do gry przy następnej partii.
            await k3.query(
              `update messages set current_state = 'queued', current_rank = 0, claimed_at = null
                where tenant_id = $1 and id = $2`,
              [tenantId, wiadomosc.id],
            );
          }
          await k3.query("commit");
        } else {
          await zapiszZdarzenie(k3, tenantId, wiadomosc.id, "failed", { blad: opisBledu });
          await k3.query("commit");
        }
      } catch (bladZapisu) {
        await k3.query("rollback").catch(() => {});
        throw bladZapisu;
      } finally {
        k3.release();
      }
      continue;
    }

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
      // Dostawca PRZYJĄŁ, a zapis 'sent' padł: wiadomość zostaje w sending i NIE wraca
      // do queued (ponowienie = podwójna wysyłka). Rekoncyliacja oznaczy ją jako held
      // i zaalarmuje człowieka (AD-23, NFR15).
      await k2.query("rollback").catch(() => {});
      bledy++;
      console.error(
        `[wysylka] wiadomość ${wiadomosc.id}: dostawca przyjął, zapis sent nie przeszedł:`,
        blad,
      );
    } finally {
      k2.release();
    }
  }

  return { wyslane, odmowy, bledy, powodZatrzymania };
}
