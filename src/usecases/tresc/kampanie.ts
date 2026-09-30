import { getPool } from "../../adapters/db/pool";

/**
 * Operacje na kampanii jako całości: duplikat (audyt #20), usunięcie szkicu i liczby
 * do listy kampanii. Każde zapytanie zawężone do tenanta (AD-2) — identyfikator kampanii
 * obcego sklepu zachowuje się dokładnie jak nieistniejący.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Klucze treści, które należą do PROJEKTU maila. Wszystko inne w `content` zostaje w oryginale. */
const KLUCZE_TRESCI = ["html", "bloki", "style", "wersjaSchematu"] as const;

const PRZYROSTEK_KOPII = /\s\(kopia(?:\s(\d+))?\)$/;

/**
 * Nazwa kopii: „{nazwa} (kopia)", a przy kolizji „(kopia 2)", „(kopia 3)"… Kopia kopii nie
 * rośnie w „(kopia) (kopia)": przyrostek oryginału jest zdejmowany przed doborem numeru.
 */
export function nazwaKopii(nazwa: string, zajete: Iterable<string>): string {
  const baza = nazwa.replace(PRZYROSTEK_KOPII, "").trim() || nazwa.trim();
  const uzyte = new Set([...zajete].map((n) => n.trim().toLowerCase()));
  const pierwsza = `${baza} (kopia)`;
  if (!uzyte.has(pierwsza.toLowerCase())) return pierwsza;
  for (let n = 2; n < 10000; n += 1) {
    const kandydat = `${baza} (kopia ${n})`;
    if (!uzyte.has(kandydat.toLowerCase())) return kandydat;
  }
  return `${baza} (kopia ${Date.now()})`;
}

export type WynikDuplikatu =
  | { ok: true; id: string; nazwa: string; pominieteZrodla: number }
  | { ok: false; blad: string };

/**
 * Duplikat kampanii: NOWY szkic z projektem maila (bloki, style, html), tematem,
 * preheaderem i wyborem odbiorców. Nic z wysyłki: bez planu (`scheduled_at`), bez
 * akceptacji klienta (`campaign_approvals`), bez wiadomości i zdarzeń (`messages` są
 * przypięte do id źródła), bez atrybucji, bez znaczników wstrzymania i odwołania.
 *
 * Źródła odbiorców kopiowane są tylko wtedy, gdy nadal istnieją w TYM sklepie — lista
 * usunięta po wysyłce oryginału nie wraca do kopii jako martwy wpis.
 *
 * Transakcja z blokadą doradczą per tenant: dwa równoległe „Duplikuj" nie dostaną tej
 * samej nazwy „(kopia)". Po zapisie odczyt zwrotny nowego wiersza i porównanie z
 * oryginałem — licznik w komunikacie mówi o tym, co naprawdę jest w bazie.
 */
export async function duplikujKampanie(tenantId: string, campaignId: string): Promise<WynikDuplikatu> {
  if (!UUID.test(tenantId) || !UUID.test(campaignId)) return { ok: false, blad: "Nie znaleziono kampanii." };
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    await klient.query("select pg_advisory_xact_lock(hashtext('kampania-duplikat:' || $1::text))", [tenantId]);
    const { rows: zrodlo } = await klient.query(
      // FOR SHARE (review Codeksa r1): równoległy zapis treści/odbiorców źródła czeka do
      // końca kopiowania, więc kopia jest spójną migawką, a nie treścią z jednej chwili
      // i odbiorcami z drugiej
      "select name, subject, preheader, content from campaigns where tenant_id = $1 and id = $2 for share",
      [tenantId, campaignId],
    );
    if (!zrodlo[0]) {
      await klient.query("rollback");
      return { ok: false, blad: "Nie znaleziono kampanii — mogła zostać usunięta." };
    }
    const o = zrodlo[0];
    const tresc: Record<string, unknown> = {};
    for (const k of KLUCZE_TRESCI) if (o.content && k in o.content) tresc[k] = o.content[k];

    const { rows: nazwy } = await klient.query("select name from campaigns where tenant_id = $1", [tenantId]);
    const nazwa = nazwaKopii(String(o.name), nazwy.map((r) => String(r.name)));

    const teraz = new Date();
    const { rows: nowa } = await klient.query(
      `insert into campaigns (tenant_id, name, subject, preheader, content, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, 'draft', $6, $6) returning id`,
      [tenantId, nazwa, o.subject, o.preheader, JSON.stringify(tresc), teraz],
    );
    const id = nowa[0].id as string;

    const { rows: zrodla } = await klient.query(
      `select count(*)::int as wszystkie from campaign_audience where tenant_id = $1 and campaign_id = $2`,
      [tenantId, campaignId],
    );
    const skopiowane = await klient.query(
      `insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id)
       select a.tenant_id, $3, a.mode, a.source_type, a.source_id
         from campaign_audience a
        where a.tenant_id = $1 and a.campaign_id = $2
          and (
            (a.source_type = 'list' and exists (select 1 from lists l where l.tenant_id = a.tenant_id and l.id = a.source_id))
            or (a.source_type = 'segment' and exists (select 1 from segments s where s.tenant_id = a.tenant_id and s.id = a.source_id))
          )`,
      [tenantId, campaignId, id],
    );

    // odczyt zwrotny ZAPISANEGO rekordu, nie danych, które chcieliśmy zapisać
    const { rows: zapisana } = await klient.query(
      `select c.name, c.subject, c.preheader, c.content, c.status, c.scheduled_at, c.paused_at, c.cancelled_at,
              (select count(*)::int from campaign_audience a where a.tenant_id = c.tenant_id and a.campaign_id = c.id) as zrodel,
              (select count(*)::int from campaign_approvals p where p.tenant_id = c.tenant_id and p.campaign_id = c.id) as akceptacji
         from campaigns c where c.tenant_id = $1 and c.id = $2`,
      [tenantId, id],
    );
    const z = zapisana[0];
    const zgodna =
      z &&
      z.name === nazwa &&
      z.subject === o.subject &&
      z.preheader === o.preheader &&
      z.status === "draft" &&
      z.scheduled_at === null &&
      z.paused_at === null &&
      z.cancelled_at === null &&
      z.akceptacji === 0 &&
      z.zrodel === skopiowane.rowCount &&
      JSON.stringify(z.content?.html ?? null) === JSON.stringify(o.content?.html ?? null) &&
      JSON.stringify(z.content?.bloki ?? null) === JSON.stringify(o.content?.bloki ?? null);
    if (!zgodna) throw new Error("Duplikat kampanii: zapisany wiersz nie zgadza się z oryginałem");
    await klient.query("commit");
    return { ok: true, id, nazwa, pominieteZrodla: Number(zrodla[0].wszystkie) - (skopiowane.rowCount ?? 0) };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

export type WynikUsunieciaSzkicu = { ok: true; nazwa: string } | { ok: false; blad: string };

/**
 * Usunięcie SZKICU. Tylko szkic: kampania, która czeka na klienta, jest zaakceptowana albo
 * wyszła, ma historię, której nie wolno zgubić (akceptacja, wiadomości, przychód).
 * Status sprawdzany pod blokadą wiersza i powtórzony w warunku DELETE, więc kampania
 * wysłana do akceptacji w tej samej chwili nie zniknie.
 *
 * Szkic z wiadomościami albo atrybucją (stan niemożliwy w normalnym przepływie, ale
 * możliwy po ręcznej zmianie statusu) też jest odmawiany — wiadomości nie mają FK do
 * kampanii i zostałyby sierotami w raportach.
 */
export async function usunSzkicKampanii(tenantId: string, campaignId: string): Promise<WynikUsunieciaSzkicu> {
  if (!UUID.test(tenantId) || !UUID.test(campaignId)) return { ok: false, blad: "Nie znaleziono kampanii." };
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query(
      "select name, status from campaigns where tenant_id = $1 and id = $2 for update",
      [tenantId, campaignId],
    );
    const k = rows[0];
    if (!k) {
      await klient.query("rollback");
      return { ok: false, blad: "Nie znaleziono kampanii — mogła zostać już usunięta." };
    }
    if (k.status !== "draft") {
      await klient.query("rollback");
      return { ok: false, blad: `Usunąć można tylko szkic. „${k.name}" ma już historię akceptacji albo wysyłki.` };
    }
    const { rows: slady } = await klient.query(
      `select
         exists (select 1 from messages m where m.tenant_id = $1 and m.source_type = 'campaign' and m.source_id = $2) as wiadomosci,
         exists (select 1 from attributions a where a.tenant_id = $1 and a.campaign_id = $2) as atrybucja`,
      [tenantId, campaignId],
    );
    if (slady[0].wiadomosci || slady[0].atrybucja) {
      await klient.query("rollback");
      return { ok: false, blad: `„${k.name}" ma wysłane wiadomości albo przypisany przychód, więc zostaje w historii.` };
    }
    const usuniete = await klient.query(
      "delete from campaigns where tenant_id = $1 and id = $2 and status = 'draft'",
      [tenantId, campaignId],
    );
    if (usuniete.rowCount !== 1) throw new Error("Usunięcie szkicu: DELETE nie usunął dokładnie jednego wiersza");
    await klient.query("commit");
    return { ok: true, nazwa: String(k.name) };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

export interface LiczbyKampanii {
  wyslane: number;
  przychodMinor: number;
}

/**
 * Wysłane i przychód dla wszystkich kampanii tenanta dwoma zapytaniami (lista kampanii).
 * Te same definicje co `raportKampanii`: wysłane ze ZDARZENIA sent, przychód z
 * najnowszego zakończonego przebiegu atrybucji. `atrybucjaPoliczona = false` znaczy, że
 * przebiegu nie było: wtedy 0 zł to brak wyniku, a nie wynik, i lista ma to powiedzieć.
 */
export async function liczbyKampaniiTenanta(
  tenantId: string,
): Promise<{ liczby: Map<string, LiczbyKampanii>; atrybucjaPoliczona: boolean }> {
  const pool = getPool();
  const [wyslane, przychod] = await Promise.all([
    pool.query(
      `select m.source_id as id, count(*)::int as ile
         from message_events e
         join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
        where e.tenant_id = $1 and e.event_type = 'sent' and m.source_type = 'campaign'
        group by m.source_id`,
      [tenantId],
    ),
    pool.query(
      `with ostatni as (
         select id from attribution_runs
          where tenant_id = $1 and finished_at is not null
          order by finished_at desc, id desc limit 1
       )
       select (select id from ostatni) is not null as policzona,
              coalesce((
                select json_object_agg(s.campaign_id, s.minor) from (
                  select a.campaign_id, sum(a.amount_minor)::text as minor
                    from attributions a
                   where a.tenant_id = $1 and a.run_id = (select id from ostatni) and a.campaign_id is not null
                   group by a.campaign_id
                ) s
              ), '{}'::json) as sumy`,
      [tenantId],
    ),
  ]);
  const liczby = new Map<string, LiczbyKampanii>();
  const wpis = (id: string) => {
    let w = liczby.get(id);
    if (!w) {
      w = { wyslane: 0, przychodMinor: 0 };
      liczby.set(id, w);
    }
    return w;
  };
  for (const r of wyslane.rows) wpis(String(r.id)).wyslane = Number(r.ile);
  for (const [id, minor] of Object.entries((przychod.rows[0]?.sumy ?? {}) as Record<string, string>)) wpis(id).przychodMinor = Number(minor);
  return { liczby, atrybucjaPoliczona: Boolean(przychod.rows[0]?.policzona) };
}
