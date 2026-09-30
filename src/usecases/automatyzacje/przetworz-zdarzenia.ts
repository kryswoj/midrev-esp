import { randomBytes } from "node:crypto";
import type pg from "pg";
import { getPool } from "../../adapters/db/pool";
import type { DostawcaWysylki } from "../../domain/email/port";
import {
  cel,
  minutNaStarcie,
  minutOpoznienia,
  schematGrafu,
  wezel,
  ZRODLA_POJEDYNCZE,
  type Graf,
  type Wezel,
} from "../../domain/automatyzacje/graf";
import { canSendTo } from "../wysylka/can-send-to";
import { zlozWiadomosc, type DaneStopki } from "../wysylka/renderuj";
import { wyslijPartie } from "../wysylka/wyslij-kampanie";
import { politykaSledzenia, zgodyNaSledzenie } from "../wysylka/zgody";
import { adresNadawcyTenanta } from "../wysylka-konfiguracja/nadawca";
import { najblizszyTermin, ocenWarunek } from "./warunki";

/**
 * Silnik wykonania automatyzacji (graf). Jeden tik per tenant, co minute z workera
 * (`automatyzacje_tik`), w trzech fazach:
 *
 *  1. WEJSCIA  - zdarzenia wyzwalacza od chwili wlaczenia flow -> nowi uczestnicy.
 *  2. PRZEJSCIA - kazdy uczestnik "w toku", ktorego czas nadszedl, idzie po grafie
 *     wezel po wezle az do opoznienia albo konca. Kazde przejscie to wiersz w
 *     flow_transitions (append-only), a wezel e-mail buduje wiadomosc `queued`
 *     w `messages` (source_type 'journey', source_id = id wiadomosci flow).
 *  3. WYSYLKA  - ten sam silnik co kampanie (`wyslijPartie`), z ta sama wiazaca
 *     bramka canSendTo w transakcji wysylki (AD-25, FR69). Wolana w `finally`:
 *     awaria fazy 1 albo 2 nie moze zatrzymac maili, ktore juz czekaja w kolejce.
 *
 * Dlaczego dwa workery nie przesuna nikogo dwa razy i nie wysla nic dwa razy:
 *  - wejscie: transakcja z `for share` na wierszu flow (wlaczanie/wylaczanie trzyma
 *    `for update`, wiec wejscie nie przemknie sie w trakcie wylaczenia) i insert
 *    `on conflict (tenant_id, flow_id, profile_id) do nothing` + przejscie "wejscie"
 *    w TYM SAMYM poleceniu (CTE): osoba nie istnieje w flow bez sladu wejscia;
 *  - przejscie: uczestnik jest zajmowany `for update skip locked` w transakcji, ktora
 *    zapisuje ZARAZEM nowy wezel, przejscie i (dla e-maila) wiadomosc;
 *  - wiadomosc: unikalnosc AD-26 (tenant, source_type, source_id, profile_id);
 *  - wysylka: SKIP LOCKED w `wyslijPartie`.
 *
 * Tresc maila pochodzi z MIGAWKI wersji (`flow_versions.emails`, 0025), po ktorej biegnie
 * uczestnik, a nie z `journeys` (szkic edytowany na zywo). Publikacja nowej definicji
 * i nowej tresci dotyczy nowych przejsc przez krok dopiero po "Opublikuj".
 *
 * Wstrzymany flow: nikt nie wchodzi i nikt sie nie przesuwa (uczestnicy stoja).
 */

const OKNO_SKANU_MIN = 7 * 1440;
/** bezpiecznik na przebieg jednego uczestnika w jednym tiku (graf i tak jest acykliczny) */
const MAX_KROKOW = 60;
/** opoznienie przeterminowane o wiecej (np. po dlugim wstrzymaniu) nie wypycha maila fala */
const PRZETERMINOWANE_OPOZNIENIE = "24 hours";
/** "czekaj do" przeterminowane o wiecej liczy sie od nowa od teraz (wtorek 10:00 nie wychodzi w czwartek w nocy) */
const PRZETERMINOWANE_CZEKAJ_DO = "1 hour";
/** po tylu bledach silnika na jednym uczestniku jego sciezka jest przerywana z alertem */
const MAX_BLEDOW_UCZESTNIKA = 3;

const UUID_SQL = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

function token(): string {
  return randomBytes(18).toString("base64url");
}

type Klient = pg.PoolClient;

interface Uczestnik {
  id: string;
  flow_id: string;
  profile_id: string;
  version: number;
  node_id: string;
  entered_at: string;
  node_since: string;
  resume_at: string | null;
  przeterminowany: boolean;
  przeterminowany_czekaj: boolean;
  context: Record<string, unknown>;
  flow_status: string;
  definition: unknown;
  emails: Record<string, { subject?: string; html?: string }>;
  wyjscie_po_zakupie: boolean;
}

async function przejscie(
  klient: Klient,
  tenantId: string,
  u: Uczestnik,
  kind: string,
  od: string | null,
  do_: string | null,
  detail: Record<string, unknown>,
) {
  await klient.query(
    `insert into flow_transitions (tenant_id, participant_id, flow_id, profile_id, version, from_node, to_node, kind, detail, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [tenantId, u.id, u.flow_id, u.profile_id, u.version, od, do_, kind, JSON.stringify(detail)],
  );
}

// ── Faza 1: wejscia ─────────────────────────────────────────────────────────

/**
 * CTE wejscia: insert uczestnika i jego przejscie "wejscie" jednym poleceniem. Zrodlo
 * kandydatow (`$ZRODLO`) zwraca kolumny profile_id, occurred_at, event_id, context.
 */
function sqlWejscia(zrodlo: string): string {
  return `with kandydaci as (${zrodlo}),
       wstawieni as (
         insert into flow_participants (tenant_id, flow_id, profile_id, version, node_id, status,
                                        entered_at, node_since, trigger_event_id, context)
         select $1, $2, k.profile_id, $3, $4, 'w_toku', k.occurred_at, k.occurred_at, k.event_id, k.context
           from kandydaci k
           join profiles p on p.tenant_id = $1 and p.id = k.profile_id
          where p.email is not null
         on conflict (tenant_id, flow_id, profile_id) do nothing
         returning id, profile_id, entered_at, node_id, version
       )
       insert into flow_transitions (tenant_id, participant_id, flow_id, profile_id, version, from_node, to_node, kind, detail, occurred_at)
       select $1, w.id, $2, w.profile_id, w.version, null, w.node_id, 'wejscie', $5::jsonb, w.entered_at
         from wstawieni w
       returning participant_id`;
}

export async function wprowadzUczestnikow(tenantId: string): Promise<{ wprowadzeni: number; alerty: string[] }> {
  const pool = getPool();
  const { rows: flowy } = await pool.query(
    "select id from flows where tenant_id = $1 and status = 'wlaczony' and live is not null",
    [tenantId],
  );
  let wprowadzeni = 0;
  const alerty: string[] = [];
  for (const { id: flowId } of flowy) {
    // blad jednej automatyzacji (np. zepsuta definicja) nie zatrzymuje wejsc do pozostalych
    try {
      wprowadzeni += await wprowadzDoFlow(tenantId, flowId);
    } catch (blad) {
      if (jestBledemSystemowym(blad)) throw blad; // awaria bazy: jeden dlawiony alert w tiku, nie po jednym na flow
      console.error(`[automatyzacje] flow ${flowId}: wejścia`, blad);
      alerty.push(`automatyzacja ${flowId}: wejścia nie przeszły: ${blad instanceof Error ? blad.message : String(blad)}`);
    }
  }
  return { wprowadzeni, alerty };
}

async function wprowadzDoFlow(tenantId: string, flowId: string): Promise<number> {
  const pool = getPool();
  {
    const klient = await pool.connect();
    try {
      await klient.query("begin");
      // `for share`: zmiana statusu trzyma `for update` na tym wierszu, wiec wejscie
      // i wylaczenie sa rozdzielone - nikt nie wejdzie do flow, ktory wlasnie gasnie
      // (review: wejscie w wyscigu z wylaczeniem zostawialo osobe `w_toku` w szkicu).
      const { rows } = await klient.query(
        `select live, live_version, active_since::text as active_since
           from flows where tenant_id = $1 and id = $2 and status = 'wlaczony' and live is not null
          for share`,
        [tenantId, flowId],
      );
      const f = rows[0];
      const parsed = f ? schematGrafu.safeParse(f.live) : null;
      if (!f || !parsed?.success) {
        await klient.query("rollback");
        if (f) throw new Error("opublikowana definicja nie przechodzi schematu");
        return 0;
      }
      const g = parsed.data;
      const start = wezel(g, g.start);
      if (!start || start.typ !== "wyzwalacz") {
        await klient.query("rollback");
        return 0;
      }
      const okno = `${OKNO_SKANU_MIN + minutNaStarcie(g)} minutes`;
      const detail = JSON.stringify({ zdarzenie: start.zdarzenie });
      let wynik;
      if (start.zdarzenie === "list.joined") {
        if (!start.listId) {
          await klient.query("rollback");
            return 0;
        }
        // Tylko dodania POJEDYNCZE (reczne, formularz), chyba ze operator jawnie wlaczyl
        // masowe. Import 20 tys. adresow na liste z powitaniem nie moze wyslac 20 tys.
        // powitan. Dodania przez inne automatyzacje nigdy: dwa flowy przerzucajace osobe
        // miedzy listami krecilyby sie w kolko.
        wynik = await klient.query(
          sqlWejscia(`
            select m.profile_id, m.added_at as occurred_at, null::uuid as event_id,
                   jsonb_build_object('listId', m.list_id, 'zrodlo', m.source) as context
              from list_members m
             where m.tenant_id = $1 and m.list_id = $6
               and m.added_at >= now() - $7::interval
               and m.added_at >= $8::timestamptz
               and split_part(m.source, ':', 1) <> 'automatyzacja'
               and ($9::boolean or split_part(m.source, ':', 1) = any($10::text[]))`),
          [tenantId, flowId, f.live_version, g.start, detail, start.listId, okno, f.active_since,
           start.takzeMasowe === true, [...ZRODLA_POJEDYNCZE]],
        );
      } else {
        // Pierwsze pasujace zdarzenie osoby decyduje o dacie wejscia (AD-10). Zdarzenia
        // z importu historii (payload.kanal = 'import') nie sa nowymi zakupami: import
        // sprzed roku nie moze uruchomic podziekowania za zakup.
        wynik = await klient.query(
          sqlWejscia(`
            select distinct on (e.profile_id) e.profile_id, e.occurred_at, e.id as event_id,
                   jsonb_strip_nulls(jsonb_build_object(
                     'orderId', case when e.payload->>'orderId' ~ '${UUID_SQL}' then e.payload->>'orderId' end,
                     'totalMinor', e.payload->'totalMinor')) as context
              from events e
             where e.tenant_id = $1 and e.event_type = $6 and e.profile_id is not null
               and coalesce(e.payload->>'kanal', 'webhook') <> 'import'
               and e.occurred_at >= now() - $7::interval
               and e.occurred_at >= $8::timestamptz
             order by e.profile_id, e.occurred_at, e.id`),
          [tenantId, flowId, f.live_version, g.start, detail, start.zdarzenie, okno, f.active_since],
        );
      }
      await klient.query("commit");
      return wynik.rowCount ?? 0;
    } catch (blad) {
      await klient.query("rollback").catch(() => {});
      throw blad;
    } finally {
      klient.release();
    }
  }
}

// ── Faza 2: przejscia ───────────────────────────────────────────────────────

interface Otoczenie {
  nazwaSklepu: string;
  /** dane nadawcy do stopki (0029): firma, adres pocztowy, NIP */
  nadawca: DaneStopki;
  sendingDomainId: string | null;
  polityka: Awaited<ReturnType<typeof politykaSledzenia>>;
}

async function otoczenieTenanta(tenantId: string): Promise<Otoczenie> {
  const pool = getPool();
  const { rows } = await pool.query(
    "select name, sender_company_name, sender_postal_address, sender_tax_id from tenants where id = $1",
    [tenantId],
  );
  const od = await adresNadawcyTenanta(tenantId);
  const domena = od.split("@")[1]?.trim().toLowerCase();
  const { rows: sd } = domena
    ? await pool.query("select id from sending_domains where tenant_id = $1 and lower(domain) = $2", [tenantId, domena])
    : { rows: [] as { id: string }[] };
  return {
    nazwaSklepu: String(rows[0]?.name ?? ""),
    nadawca: { firma: rows[0]?.sender_company_name ?? null, adres: rows[0]?.sender_postal_address ?? null, nip: rows[0]?.sender_tax_id ?? null },
    sendingDomainId: sd[0]?.id ?? null, polityka: await politykaSledzenia(pool, tenantId) };
}

type WynikWiadomosci =
  | { ok: true; messageId: string; nowa: true }
  | { ok: true; messageId: string; nowa: false }
  | { ok: false; powod: string; wyjscie: boolean };

/**
 * Wezel e-mail: buduje wiadomosc `queued` dla uczestnika Z MIGAWKI jego wersji.
 * `nowa: false` = ta osoba dostala juz kiedys wiadomosc z tego kroku (AD-26).
 */
async function zbudujWiadomoscWezla(
  klient: Klient,
  tenantId: string,
  u: Uczestnik,
  emailId: string,
  oto: Otoczenie,
): Promise<WynikWiadomosci> {
  const migawka = u.emails?.[emailId];
  if (!migawka) return { ok: false, powod: "brak migawki treści w tej wersji", wyjscie: false };
  const temat = String(migawka.subject ?? "");
  const tresc = String(migawka.html ?? "");
  if (!temat.trim() || !tresc.trim()) return { ok: false, powod: "wiadomość bez tematu albo treści", wyjscie: false };

  const { rows: prof } = await klient.query("select email from profiles where tenant_id = $1 and id = $2", [tenantId, u.profile_id]);
  if (!prof[0]?.email) return { ok: false, powod: "brak_adresu", wyjscie: true };

  // Bramka zgod PRZED zbudowaniem wiadomosci: osoba bez zgody WYCHODZI z automatyzacji
  // z jawnym powodem w sciezce, zamiast zostawiac po sobie wiadomosc `suppressed`.
  // Wiazaca bramka i tak stoi w transakcji wysylki (AD-25); ta jest dodatkowa.
  const bramka = await canSendTo(klient, tenantId, u.profile_id);
  if (!bramka.wolno) return { ok: false, powod: bramka.powod ?? "brak_zgody", wyjscie: true };

  const zgody = await zgodyNaSledzenie(klient, tenantId, u.profile_id, oto.polityka);
  const clickToken = token();
  const unsubToken = token();
  const { html, linki } = zlozWiadomosc({
    trescHtml: tresc,
    clickToken,
    unsubscribeToken: unsubToken,
    nazwaSklepu: oto.nazwaSklepu,
    nadawca: oto.nadawca,
    sledzKlikniecia: zgody.klikniecia,
    sledzOtwarcia: zgody.otwarcia,
  });
  const wstaw = await klient.query(
    `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject,
                           body_html, click_token, unsubscribe_token, links,
                           sending_domain_id, open_tracking_allowed, click_tracking_allowed)
     values ($1, $2, 'journey', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (tenant_id, source_type, source_id, profile_id) do nothing
     returning id`,
    [tenantId, u.profile_id, emailId, prof[0].email, temat, html, clickToken, unsubToken,
     JSON.stringify(linki), oto.sendingDomainId, zgody.otwarcia, zgody.klikniecia],
  );
  if (wstaw.rows[0]) return { ok: true, messageId: wstaw.rows[0].id, nowa: true };
  const { rows: istniejaca } = await klient.query(
    `select id from messages where tenant_id = $1 and source_type = 'journey' and source_id = $2 and profile_id = $3`,
    [tenantId, emailId, u.profile_id],
  );
  return { ok: true, messageId: istniejaca[0].id, nowa: false };
}

async function zajmijUczestnika(klient: Klient, tenantId: string, id: string): Promise<Uczestnik | null> {
  // blokada wiersza uczestnika + odczyt definicji i migawki tresci JEGO wersji;
  // `skip locked` = drugi worker nie czeka i nie dubluje, tylko bierze nastepnego
  const { rows } = await klient.query(
    `select p.id, p.flow_id, p.profile_id, p.version, p.node_id,
            p.entered_at::text as entered_at, p.node_since::text as node_since, p.resume_at::text as resume_at,
            (p.resume_at is not null and p.resume_at < now() - $3::interval) as przeterminowany,
            (p.resume_at is not null and p.resume_at < now() - $4::interval) as przeterminowany_czekaj,
            p.context, f.status as flow_status, v.definition, v.emails,
            coalesce((v.definition->'ustawienia'->>'wyjsciePoZakupie')::boolean, false) as wyjscie_po_zakupie
       from flow_participants p
       join flows f on f.tenant_id = p.tenant_id and f.id = p.flow_id
       join flow_versions v on v.tenant_id = p.tenant_id and v.flow_id = p.flow_id and v.version = p.version
      where p.tenant_id = $1 and p.id = $2 and p.status = 'w_toku'
        and (p.resume_at is null or p.resume_at <= now())
      for update of p skip locked`,
    [tenantId, id, PRZETERMINOWANE_OPOZNIENIE, PRZETERMINOWANE_CZEKAJ_DO],
  );
  return (rows[0] as Uczestnik) ?? null;
}

async function ustawWezel(klient: Klient, tenantId: string, u: Uczestnik, nodeId: string, nodeSince: string | "teraz", context?: Record<string, unknown>) {
  const { rows } = await klient.query(
    `update flow_participants
        set node_id = $3, node_since = coalesce($4::timestamptz, now()), resume_at = null,
            context = coalesce($5::jsonb, context)
      where tenant_id = $1 and id = $2
      returning node_since::text as node_since`,
    [tenantId, u.id, nodeId, nodeSince === "teraz" ? null : nodeSince, context ? JSON.stringify(context) : null],
  );
  u.node_id = nodeId;
  u.resume_at = null;
  u.przeterminowany = false;
  u.przeterminowany_czekaj = false;
  u.node_since = rows[0].node_since;
  if (context) u.context = context;
}

async function zakoncz(klient: Klient, tenantId: string, u: Uczestnik, status: "zakonczony" | "wyszedl" | "przerwany", powod: string | null, kind: string, detail: Record<string, unknown>) {
  await klient.query(
    `update flow_participants set status = $3, exit_reason = $4, finished_at = now(), resume_at = null
      where tenant_id = $1 and id = $2`,
    [tenantId, u.id, status, powod],
  );
  await przejscie(klient, tenantId, u, kind, u.node_id, null, { ...detail, powod });
}

/** Reguly wyjscia sprawdzane przy KAZDYM ruchu: zakup po wejsciu (gdy flow tak chce). */
async function regulaWyjscia(klient: Klient, tenantId: string, u: Uczestnik): Promise<string | null> {
  if (!u.wyjscie_po_zakupie) return null;
  const { rows } = await klient.query(
    `select exists (
       select 1 from orders o
        where o.tenant_id = $1 and o.profile_id = $2 and o.occurred_at > $3::timestamptz
          and o.status in ('completed', 'processing')
     ) as kupil`,
    [tenantId, u.profile_id, u.entered_at],
  );
  return rows[0].kupil ? "zakup" : null;
}

interface WynikJednego {
  ruszyl: boolean;
  zbudowane: number;
  alerty: string[];
}

/** Jeden uczestnik, jedna transakcja: idzie po wezlach az do oczekiwania albo konca. */
async function przesunJednego(tenantId: string, id: string, oto: Otoczenie): Promise<WynikJednego> {
  const klient = await getPool().connect();
  let zbudowane = 0;
  const alerty: string[] = [];
  try {
    await klient.query("begin");
    const u = await zajmijUczestnika(klient, tenantId, id);
    if (!u || u.flow_status !== "wlaczony") {
      // zajety przez inny worker albo flow wstrzymany: osoba stoi w miejscu
      await klient.query("rollback");
      return { ruszyl: false, zbudowane: 0, alerty };
    }
    const parsed = schematGrafu.safeParse(u.definition);
    if (!parsed.success) {
      await zakoncz(klient, tenantId, u, "przerwany", "definicja wersji nie przechodzi schematu", "przerwanie", {});
      await klient.query("commit");
      alerty.push(`automatyzacja ${u.flow_id}: wersja ${u.version} nie przechodzi schematu, ścieżka osoby przerwana`);
      return { ruszyl: true, zbudowane: 0, alerty };
    }
    const g: Graf = parsed.data;

    for (let krok = 0; krok < MAX_KROKOW; krok++) {
      const w: Wezel | undefined = wezel(g, u.node_id);
      if (!w) {
        await zakoncz(klient, tenantId, u, "przerwany", `krok „${u.node_id}” nie istnieje w tej wersji`, "przerwanie", {});
        break;
      }
      const wyjscie = await regulaWyjscia(klient, tenantId, u);
      if (wyjscie) {
        await zakoncz(klient, tenantId, u, "wyszedl", wyjscie, "wyjscie", { wezel: w.typ });
        break;
      }
      if (w.typ === "koniec") {
        await zakoncz(klient, tenantId, u, "zakonczony", null, "koniec", {});
        break;
      }

      let dalej: string | null = null;
      let odKiedy: string | "teraz" = "teraz";
      let nowyContext: Record<string, unknown> | undefined;
      let przerwano = false;

      switch (w.typ) {
        case "wyzwalacz":
          dalej = cel(w, "next");
          // pierwszy krok liczy sie od occurred_at zdarzenia, nie od tika
          odKiedy = u.node_since;
          break;
        case "opoznienie":
        case "czekaj_do": {
          // Termin liczony RAZ przy wejsciu w krok i zapisywany w resume_at; przy wznowieniu
          // (zajmijUczestnika wybralo nas, bo minal) uzywamy zapisanego. Wyjatek: "czekaj do"
          // przeterminowane o ponad godzine liczy sie od nowa od teraz.
          let termin: string;
          if (u.resume_at && !(w.typ === "czekaj_do" && u.przeterminowany_czekaj)) {
            termin = u.resume_at;
          } else if (w.typ === "opoznienie") {
            termin = (await klient.query("select ($1::timestamptz + make_interval(mins => $2::int))::text as t", [u.node_since, minutOpoznienia(w.ilosc, w.jednostka)])).rows[0].t;
          } else {
            // "czekaj do wtorku 10:00" liczone od max(wejscie w krok, teraz - 1 h): stare
            // node_since (spozniony webhook, lezacy worker) nie wypycha maila w czwartek w nocy
            const od = (await klient.query("select greatest($1::timestamptz, now() - interval '1 hour')::text as t", [u.node_since])).rows[0].t;
            termin = await najblizszyTermin(klient, od, w.dni, w.godzina);
          }
          const { rows: teraz } = await klient.query(
            "select ($1::timestamptz <= now()) as minal, ($1::timestamptz < now() - $2::interval) as przeterminowany",
            [termin, PRZETERMINOWANE_OPOZNIENIE],
          );
          // Opoznienie, ktorego termin minal ponad dobe temu - czy to termin zapisany (flow stal
          // wstrzymany), czy swiezo policzony od starego zdarzenia (worker lezal, webhook przyszedl
          // po dniach) - konczy sciezke z powodem. Ludzie nie dostaja maili fala (review runda 2, #3).
          if (w.typ === "opoznienie" && teraz[0].przeterminowany) {
            await zakoncz(klient, tenantId, u, "przerwany", "opóźnienie przeterminowane (automatyzacja stała)", "przerwanie", { termin });
            przerwano = true;
            break;
          }
          if (!teraz[0].minal) {
            await klient.query("update flow_participants set resume_at = $3 where tenant_id = $1 and id = $2", [tenantId, u.id, termin]);
            await przejscie(klient, tenantId, u, "oczekiwanie", w.id, w.id, { do: termin });
            u.resume_at = termin;
          } else {
            dalej = cel(w, "next");
            odKiedy = termin;
          }
          break;
        }
        case "warunek": {
          const ocena = await ocenWarunek(klient, tenantId, w.regula, { profileId: u.profile_id, enteredAt: u.entered_at, context: u.context });
          if ("przerwij" in ocena) {
            await zakoncz(klient, tenantId, u, "przerwany", ocena.przerwij, "przerwanie", { regula: w.regula.rodzaj });
            alerty.push(`${ocena.alert} (automatyzacja ${u.flow_id})`);
            przerwano = true;
            break;
          }
          dalej = cel(w, ocena.wynik ? "next_if_true" : "next_if_false");
          await przejscie(klient, tenantId, u, "warunek", w.id, dalej, { wynik: ocena.wynik, regula: w.regula.rodzaj, ...ocena.szczegol });
          break;
        }
        case "ab_split": {
          const { rows } = await klient.query("select (random() * 100 < $1::int) as a", [w.procentA]);
          const galaz = rows[0].a ? "a" : "b";
          dalej = cel(w, galaz);
          await przejscie(klient, tenantId, u, "podzial", w.id, dalej, { galaz: galaz.toUpperCase(), procentA: w.procentA });
          break;
        }
        case "email": {
          const wynik = await zbudujWiadomoscWezla(klient, tenantId, u, w.emailId, oto);
          if (!wynik.ok) {
            if (wynik.wyjscie) await zakoncz(klient, tenantId, u, "wyszedl", wynik.powod, "wyjscie", { emailId: w.emailId });
            else {
              await zakoncz(klient, tenantId, u, "przerwany", wynik.powod, "przerwanie", { emailId: w.emailId });
              alerty.push(`automatyzacja ${u.flow_id}: krok e-mail przerwał ścieżkę osoby (${wynik.powod})`);
            }
            przerwano = true;
            break;
          }
          if (wynik.nowa) {
            zbudowane++;
            await przejscie(klient, tenantId, u, "wyslano", w.id, w.id, { emailId: w.emailId, messageId: wynik.messageId });
          } else {
            // ta osoba dostala juz kiedys ten mail (AD-26): sciezka mowi prawde, ze tym razem nie
            await przejscie(klient, tenantId, u, "pominieto", w.id, w.id, { emailId: w.emailId, messageId: wynik.messageId, powod: "wiadomość z tego kroku już wcześniej wyszła do tej osoby" });
          }
          nowyContext = { ...u.context, ostatniaWiadomoscId: wynik.messageId };
          dalej = cel(w, "next");
          break;
        }
        case "profil": {
          if (w.akcja.rodzaj === "dodaj_do_listy") {
            await klient.query(
              `insert into list_members (tenant_id, list_id, profile_id, source, added_at)
               select $1, l.id, $3, 'automatyzacja:' || $4::text, now() from lists l where l.tenant_id = $1 and l.id = $2
               on conflict (list_id, profile_id) do nothing`,
              [tenantId, w.akcja.listId, u.profile_id, u.flow_id],
            );
          } else {
            await klient.query("delete from list_members where tenant_id = $1 and list_id = $2 and profile_id = $3", [tenantId, w.akcja.listId, u.profile_id]);
          }
          await przejscie(klient, tenantId, u, "profil", w.id, w.id, { akcja: w.akcja.rodzaj, listId: w.akcja.listId });
          dalej = cel(w, "next");
          break;
        }
      }

      if (przerwano || dalej === null) break;
      const poprzedni = u.node_id;
      await ustawWezel(klient, tenantId, u, dalej, odKiedy, nowyContext);
      await przejscie(klient, tenantId, u, "przejscie", poprzedni, dalej, {});
    }
    // udany ruch zeruje licznik bledow silnika (review #9): trzy przypadkowe bledy w ciagu
    // tygodni nie moga przerwac sciezki, ktora w miedzyczasie dziala
    await klient.query("update flow_participants set context = context - 'bledySilnika' where tenant_id = $1 and id = $2 and context ? 'bledySilnika'", [tenantId, u.id]);
    await klient.query("commit");
    return { ruszyl: true, zbudowane, alerty };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

/**
 * Blad silnika na jednym uczestniku (np. dane, ktorych zapytanie nie przyjmuje) NIE
 * zatrzymuje tiku calego tenanta. Uczestnik dostaje odroczenie z rosnacym odstepem,
 * a po MAX_BLEDOW_UCZESTNIKA probach jego sciezka jest przerywana z alertem.
 */
interface StanKandydata {
  id: string;
  node_id: string;
  node_since: string;
  resume_at: string | null;
}

/**
 * Blad jednego uczestnika: odroczenie z rosnacym odstepem, po MAX_BLEDOW_UCZESTNIKA probach
 * przerwanie z alertem. UPDATE jest warunkowany stanem z chwili wyboru kandydata (review #5):
 * jesli inny worker w miedzyczasie przesunal te osobe, nie nadpisujemy jej swiezego terminu.
 */
async function zapiszBladUczestnika(tenantId: string, k: StanKandydata, blad: unknown): Promise<string | null> {
  const opis = (blad instanceof Error ? blad.message : String(blad)).slice(0, 500);
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query(
      `update flow_participants
          set context = jsonb_set(context, '{bledySilnika}', to_jsonb(coalesce((context->>'bledySilnika')::int, 0) + 1)),
              resume_at = now() + make_interval(mins => 5 * (coalesce((context->>'bledySilnika')::int, 0) + 1))
        where tenant_id = $1 and id = $2 and status = 'w_toku'
          and node_id = $3 and node_since = $4::timestamptz and resume_at is not distinct from $5::timestamptz
        returning flow_id, profile_id, version, node_id, (context->>'bledySilnika')::int as bledy`,
      [tenantId, k.id, k.node_id, k.node_since, k.resume_at],
    );
    const p = rows[0];
    let alert: string | null = null;
    if (p && p.bledy >= MAX_BLEDOW_UCZESTNIKA) {
      await klient.query(
        `update flow_participants set status = 'przerwany', exit_reason = 'błąd silnika', finished_at = now(), resume_at = null
          where tenant_id = $1 and id = $2`,
        [tenantId, k.id],
      );
      await klient.query(
        `insert into flow_transitions (tenant_id, participant_id, flow_id, profile_id, version, from_node, to_node, kind, detail, occurred_at)
         values ($1, $2, $3, $4, $5, $6, null, 'przerwanie', $7, now())`,
        [tenantId, k.id, p.flow_id, p.profile_id, p.version, p.node_id, JSON.stringify({ powod: "błąd silnika", blad: opis })],
      );
      alert = `automatyzacja ${p.flow_id}: ścieżka osoby przerwana po ${p.bledy} błędach silnika w kroku ${p.node_id}: ${opis}`;
    }
    await klient.query("commit");
    return alert;
  } catch (e) {
    await klient.query("rollback").catch(() => {});
    return `automatyzacja: nie udało się nawet zapisać błędu uczestnika ${k.id}: ${e instanceof Error ? e.message : String(e)} (pierwotny: ${opis})`;
  } finally {
    klient.release();
  }
}

/**
 * Blad SYSTEMOWY (review runda 2, #4): brak kolumny/tabeli po zlym wdrozeniu, zerwane polaczenie,
 * zakleszczenie, restart bazy. Taki blad nie jest wina uczestnika: liczenie go jako proby
 * przerwaloby po pol godzinie sciezki WSZYSTKICH osob wszystkich sklepow.
 */
const KODY_SYSTEMOWE = new Set(["42703", "42P01", "42883", "40P01", "40001", "57P01", "57P02", "57P03", "53300", "53200", "53100"]);
const KODY_SIECI = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EHOSTUNREACH"]);

export function jestBledemSystemowym(blad: unknown): boolean {
  const kod = (blad as { code?: unknown })?.code;
  if (typeof kod !== "string") return /Connection terminated|connection timeout/i.test(String((blad as Error)?.message ?? ""));
  return KODY_SYSTEMOWE.has(kod) || kod.startsWith("08") || KODY_SIECI.has(kod);
}

export class BladSystemowy extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BladSystemowy";
  }
}

// Ten sam alert systemowy najwyzej raz na godzine na proces workera (dla wszystkich tenantow):
// awaria bazy nie moze zasypac kanalu alertem co minute z kazdego sklepu.
const ostatnieAlertySystemowe = new Map<string, number>();
const ODSTEP_ALERTU_MS = 3600_000;
export function alertSystemowy(tresc: string, teraz = Date.now()): string | null {
  const klucz = tresc.slice(0, 200);
  const poprzedni = ostatnieAlertySystemowe.get(klucz);
  if (poprzedni !== undefined && teraz - poprzedni < ODSTEP_ALERTU_MS) return null;
  ostatnieAlertySystemowe.set(klucz, teraz);
  if (ostatnieAlertySystemowe.size > 500) ostatnieAlertySystemowe.clear();
  return tresc;
}

export async function przesunUczestnikow(
  tenantId: string,
  opcje: { limit?: number } = {},
): Promise<{ przesunieci: number; zbudowane: number; bledy: number; alerty: string[] }> {
  const pool = getPool();
  const { rows: kandydaci } = await pool.query<StanKandydata>(
    `select p.id, p.node_id, p.node_since::text as node_since, p.resume_at::text as resume_at
       from flow_participants p
       join flows f on f.tenant_id = p.tenant_id and f.id = p.flow_id
      where p.tenant_id = $1 and p.status = 'w_toku' and f.status = 'wlaczony'
        and (p.resume_at is null or p.resume_at <= now())
      order by p.resume_at nulls first, p.node_since
      limit $2`,
    [tenantId, opcje.limit ?? 500],
  );
  const wynik = { przesunieci: 0, zbudowane: 0, bledy: 0, alerty: [] as string[] };
  if (!kandydaci.length) return wynik;
  const oto = await otoczenieTenanta(tenantId);
  const bledy: { k: StanKandydata; blad: unknown }[] = [];
  for (const k of kandydaci) {
    try {
      const w = await przesunJednego(tenantId, k.id, oto);
      if (w.ruszyl) wynik.przesunieci++;
      wynik.zbudowane += w.zbudowane;
      wynik.alerty.push(...w.alerty);
    } catch (blad) {
      if (jestBledemSystemowym(blad)) {
        // przerwij tik od razu, bez liczenia prob komukolwiek
        throw new BladSystemowy(`automatyzacje: błąd systemowy (${(blad as { code?: string }).code ?? "?"}): ${blad instanceof Error ? blad.message : String(blad)}`);
      }
      bledy.push({ k, blad });
    }
  }
  if (bledy.length) {
    // Ten sam blad u wiekszosci kandydatow tego tiku to tez awaria systemu, nie danych osoby.
    const grupy = new Map<string, number>();
    for (const b of bledy) {
      const tresc = b.blad instanceof Error ? b.blad.message : String(b.blad);
      grupy.set(tresc, (grupy.get(tresc) ?? 0) + 1);
    }
    const [najczestszy, ile] = [...grupy.entries()].sort((x, y) => y[1] - x[1])[0];
    if (ile >= 3 && ile * 2 >= wynik.przesunieci + bledy.length) {
      throw new BladSystemowy(`automatyzacje: ten sam błąd u ${ile} z ${wynik.przesunieci + bledy.length} osób w tiku (${najczestszy})`);
    }
    for (const b of bledy) {
      wynik.bledy++;
      console.error(`[automatyzacje] tenant ${tenantId}: uczestnik ${b.k.id}: błąd silnika`, b.blad);
      const alert = await zapiszBladUczestnika(tenantId, b.k, b.blad);
      if (alert) wynik.alerty.push(alert);
    }
  }
  return wynik;
}

// ── Tik ─────────────────────────────────────────────────────────────────────

export async function uruchomAutomatyzacje(
  tenantId: string,
  opcje: { dostawca?: DostawcaWysylki } = {},
) {
  const alerty: string[] = [];
  let wejscia = 0;
  let ruch = { przesunieci: 0, zbudowane: 0, bledy: 0, alerty: [] as string[] };
  let bladRuchu: unknown = null;
  try {
    const w = await wprowadzUczestnikow(tenantId);
    wejscia = w.wprowadzeni;
    alerty.push(...w.alerty);
  } catch (blad) {
    // awaria wejsc nie blokuje ruchu osob, ktore juz sa w srodku, ani wysylki
    console.error(`[automatyzacje] tenant ${tenantId}: wejścia`, blad);
    const tresc = alertSystemowy(`automatyzacje: wejścia nie przeszły: ${blad instanceof Error ? blad.message : String(blad)}`);
    if (tresc) alerty.push(tresc);
  }
  try {
    ruch = await przesunUczestnikow(tenantId);
    alerty.push(...ruch.alerty);
  } catch (blad) {
    // Blad systemowy albo blad wyboru kandydatow: jeden alert (dlawiony), bez liczenia prob
    // uczestnikom i bez ponawiania joba - kolejny tik za minute sprobuje sam.
    console.error(`[automatyzacje] tenant ${tenantId}: ruch uczestników`, blad);
    const tresc = alertSystemowy(blad instanceof Error ? blad.message : String(blad));
    if (tresc) alerty.push(tresc);
    bladRuchu = blad;
  }
  // Wysylka ZAWSZE: maile juz zbudowane nie moga czekac na naprawe cudzego bledu.
  const wysylka = await wyslijPartie(tenantId, { dostawca: opcje.dostawca });
  return {
    bladSystemowy: bladRuchu !== null, wejscia, przesunieci: ruch.przesunieci, zbudowane: ruch.zbudowane, bledyUczestnikow: ruch.bledy, alerty, wysylka };
}
