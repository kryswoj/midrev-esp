import { randomBytes } from "node:crypto";
import type pg from "pg";
import { getPool } from "../../adapters/db/pool";
import type { DostawcaWysylki } from "../../domain/email/port";
import {
  cel,
  SMART_SENDING_GODZIN,
  TYPY_AKCJI,
  minutNaStarcie,
  minutOpoznienia,
  schematGrafu,
  triggerEventGrafu,
  wezel,
  wyzwalaczGrafu,
  ZRODLA_POJEDYNCZE,
  type Graf,
  type PonowneWejscie,
  type Wezel,
  type WezelTypu,
  type ZrodloWyzwalacza,
} from "../../domain/automatyzacje/graf";
import { filtrPusty, ocenFiltr, opiszFiltr } from "../../domain/filtry";
import { emitujPominiecie, kontekstUczestnika, niedawnyMail, OPISY_POMINIEC, profilSpelnia, type PowodPominiecia } from "./bramka-filtrow";
import {
  type ZdarzenieWyzwalajace,
  kluczWejscia,
  MAX_SPOZNIENIE_MS,
  MAX_ZALEGLOSC_SKANU_MIN,
  minutPonownegoWejscia,
  ocenKandydata,
  UUID_ZERO,
  ZAKLADKA_SKANU_MIN,
} from "../../domain/automatyzacje/wyzwalanie";
import { kontekstSklepuMaila } from "../katalog/kontekst-maila";
import { BladSzablonu, oczyscTemat, renderujHtml, renderujTemat, zbudujKontekst } from "../../domain/email/szablon";
import { ponowneWejscieDostepne } from "./ponowne-wejscie";
import { wlasciwosciWyzwalacza, zrodloZdarzen } from "./zrodlo-zdarzen";
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

/** okno skanu wejsc z list (dodanie do listy nie ma znacznika skanu ani reguly 4 h) */
const OKNO_SKANU_LIST_MIN = 7 * 1440;
/** bezpiecznik na przebieg jednego uczestnika w jednym tiku (graf i tak jest acykliczny) */
const MAX_KROKOW = 60;
/** opoznienie przeterminowane o wiecej (np. po dlugim wstrzymaniu) nie wypycha maila fala */
const PRZETERMINOWANE_OPOZNIENIE = "24 hours";
/** "czekaj do" przeterminowane o wiecej liczy sie od nowa od teraz (wtorek 10:00 nie wychodzi w czwartek w nocy) */
const PRZETERMINOWANE_CZEKAJ_DO = "1 hour";
/** po tylu bledach silnika na jednym uczestniku jego sciezka jest przerywana z alertem */
const MAX_BLEDOW_UCZESTNIKA = 3;

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
  trigger_event_id: string | null;
  trigger_event_occurred_at: string | null;
  entry_key: string;
  flow_status: string;
  definition: unknown;
  emails: Record<string, { subject?: string; html?: string; szablon?: string }>;
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

/** Ile zdarzen jeden skan jednego flow bierze naraz (reszta w trybie nadrabiania w kolejnym tiku). */
export const LIMIT_SKANU = 5000;
/** Bezpiecznik stronicowania zakladki (MAX_STRON_ZAKLADKI x limit zdarzen w 15 min jednej metryki). */
const MAX_STRON_ZAKLADKI = 20;

/** Dlawik alertu „metryka nieznana biezacemu zrodlu” (flow -> ostatni alert, ms). */
const alertNieznanejMetryki = new Map<string, number>();

/** Kandydat do wejscia, niezaleznie od rodzaju wyzwalacza. */
interface KandydatWejscia {
  profileId: string;
  /** occurred_at zdarzenia (tekst z bazy, AD-10): data wejscia */
  occurredAt: string;
  occurredAtMs: number;
  eventId: string | null;
  eventOccurredAt: string | null;
  context: Record<string, unknown>;
  entryKey: string;
  /** tozsamosc proby wejscia niezalezna od trybu (`e:<zdarzenie>` / `l:<lista>:<epoka>`) */
  ref: string;
}

/**
 * Filtr profilu PRZY WEJSCIU (E4b, plan 3.3): kandydat, ktory go nie spelnia, nie wchodzi,
 * a powod laduje w `flow_entry_skips` (sciezka osoby, podglad wyzwalacza). Odrzucenie NIE
 * zajmuje klucza wejscia: osoba, ktora pozniej zacznie spelniac filtr, wejdzie przy kolejnym
 * zdarzeniu. Decyzja zapada raz: proba juz odrzucona (zakladka skanu czyta to samo zdarzenie
 * przez 15 min) nie jest liczona drugi raz. "Od startu flow" = od czasu tego zdarzenia.
 */
async function odsiejFiltremProfilu(
  klient: Klient,
  tenantId: string,
  flowId: string,
  g: Graf,
  kandydaci: KandydatWejscia[],
  tryb: PonowneWejscie,
): Promise<KandydatWejscia[]> {
  const filtr = g.ustawienia.filtrProfilu;
  if (filtrPusty(filtr) || !kandydaci.length) return kandydaci;
  const { rows: juzOdrzucone } = await klient.query(
    "select entry_ref, profile_id from flow_entry_skips where tenant_id = $1 and flow_id = $2 and entry_ref = any($3::text[])",
    [tenantId, flowId, kandydaci.map((k) => k.ref)],
  );
  const odrzucone = new Set(juzOdrzucone.map((r) => `${r.entry_ref}|${r.profile_id}`));
  let wTrybieRaz = new Set<string>();
  if (tryb.tryb === "raz") {
    // osoby, ktore juz sa w tym flow, i tak nie wejda drugi raz: nie liczymy im filtra
    const { rows } = await klient.query(
      "select profile_id from flow_participants where tenant_id = $1 and flow_id = $2 and entry_key = 'raz' and profile_id = any($3::uuid[])",
      [tenantId, flowId, [...new Set(kandydaci.map((k) => k.profileId))]],
    );
    wTrybieRaz = new Set(rows.map((r) => r.profile_id));
  }
  const posortowani = [...kandydaci].sort((x, y) => x.occurredAtMs - y.occurredAtMs || x.occurredAt.localeCompare(y.occurredAt));
  const przepuszczeni: KandydatWejscia[] = [];
  const nowoOdrzuceni: KandydatWejscia[] = [];
  const wszedl = new Set<string>();
  for (const k of posortowani) {
    if (odrzucone.has(`${k.ref}|${k.profileId}`) || wTrybieRaz.has(k.profileId)) continue;
    if (tryb.tryb === "raz" && wszedl.has(k.profileId)) continue;
    const ok = await profilSpelnia(klient, tenantId, k.profileId, filtr, {
      flowId, start: k.occurredAt, zdarzenieWyzwalajaceId: k.eventId, uczestnikId: null,
    });
    if (ok) {
      przepuszczeni.push(k);
      wszedl.add(k.profileId);
    } else nowoOdrzuceni.push(k);
  }
  if (nowoOdrzuceni.length) {
    await klient.query(
      `insert into flow_entry_skips (tenant_id, flow_id, profile_id, entry_ref, reason, detail, occurred_at)
       select $1, $2, k.profile_id, k.ref, 'filtr_profilu', $5::jsonb, k.occurred_at
         from unnest($3::uuid[], $4::text[], $6::timestamptz[]) as k(profile_id, ref, occurred_at)
         join profiles p on p.tenant_id = $1 and p.id = k.profile_id
       on conflict do nothing`,
      [tenantId, flowId, nowoOdrzuceni.map((k) => k.profileId), nowoOdrzuceni.map((k) => k.ref), JSON.stringify({ filtr: opiszFiltr(filtr) }), nowoOdrzuceni.map((k) => k.occurredAt)],
    );
  }
  return przepuszczeni;
}

/**
 * Wstawienie wejsc: uczestnik i jego przejscie "wejscie" jednym poleceniem (CTE), wiec osoba
 * nie istnieje w flow bez sladu wejscia. Idempotencja w bazie: unikalnosc (flow, profil,
 * entry_key) (AD-41). Tryb "po X": kazdy kandydat osobno, pod blokada doradcza (flow, profil),
 * ze sprawdzeniem ostatniego wejscia - dwa tiki naraz nie wpuszcza osoby dwa razy.
 */
async function wstawWejscia(
  klient: Klient,
  tenantId: string,
  flowId: string,
  wersja: number,
  startId: string,
  detail: string,
  kandydaci: KandydatWejscia[],
  tryb: PonowneWejscie,
): Promise<number> {
  if (!kandydaci.length) return 0;
  const wstaw = async (k: KandydatWejscia[]) => {
    const { rowCount } = await klient.query(
      `with k as (
         select * from unnest($5::uuid[], $6::timestamptz[], $7::uuid[], $8::timestamptz[], $9::text[]::jsonb[], $10::text[])
           as k(profile_id, occurred_at, event_id, event_occurred_at, context, entry_key)
       ),
       wstawieni as (
         insert into flow_participants (tenant_id, flow_id, profile_id, version, node_id, status, entered_at, node_since,
                                        trigger_event_id, trigger_event_occurred_at, context, entry_key)
         select $1, $2, k.profile_id, $3, $4, 'w_toku', k.occurred_at, k.occurred_at,
                k.event_id, k.event_occurred_at, k.context, k.entry_key
           from k
           join profiles p on p.tenant_id = $1 and p.id = k.profile_id
          where p.email is not null
         on conflict (tenant_id, flow_id, profile_id, entry_key) do nothing
         returning id, profile_id, entered_at, node_id, version
       )
       insert into flow_transitions (tenant_id, participant_id, flow_id, profile_id, version, from_node, to_node, kind, detail, occurred_at)
       select $1, w.id, $2, w.profile_id, w.version, null, w.node_id, 'wejscie', $11::jsonb, w.entered_at
         from wstawieni w
       returning participant_id`,
      [tenantId, flowId, wersja, startId,
       k.map((x) => x.profileId), k.map((x) => x.occurredAt), k.map((x) => x.eventId), k.map((x) => x.eventOccurredAt),
       k.map((x) => JSON.stringify(x.context)), k.map((x) => x.entryKey), detail],
    );
    return rowCount ?? 0;
  };

  const posortowani = [...kandydaci].sort((x, y) => x.occurredAtMs - y.occurredAtMs || x.occurredAt.localeCompare(y.occurredAt) || String(x.eventId).localeCompare(String(y.eventId)));
  if (tryb.tryb === "raz") {
    // pierwsze pasujace zdarzenie osoby decyduje o dacie wejscia (AD-10), jak dotad
    const pierwsze = new Map<string, KandydatWejscia>();
    for (const k of posortowani) if (!pierwsze.has(k.profileId)) pierwsze.set(k.profileId, k);
    return wstaw([...pierwsze.values()]);
  }
  if (tryb.tryb === "zawsze") return wstaw(posortowani);

  const minut = minutPonownegoWejscia(tryb)!;
  let n = 0;
  for (const k of posortowani) {
    await klient.query("select pg_advisory_xact_lock(hashtextextended($1, 7150415))", [`flow-wejscie:${tenantId}:${flowId}:${k.profileId}`]);
    const { rows } = await klient.query(
      `select exists (
         select 1 from flow_participants
          where tenant_id = $1 and flow_id = $2 and profile_id = $3
            and entered_at > $4::timestamptz - make_interval(mins => $5::int)
       ) as za_wczesnie`,
      [tenantId, flowId, k.profileId, k.occurredAt, minut],
    );
    if (rows[0].za_wczesnie) continue;
    n += await wstaw([k]);
  }
  return n;
}

export async function wprowadzUczestnikow(tenantId: string, opcje: { limitSkanu?: number } = {}): Promise<{ wprowadzeni: number; alerty: string[] }> {
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
      const w = await wprowadzDoFlow(tenantId, flowId, opcje.limitSkanu ?? LIMIT_SKANU);
      wprowadzeni += w.wprowadzeni;
      alerty.push(...w.alerty);
    } catch (blad) {
      if (jestBledemSystemowym(blad)) throw blad; // awaria bazy: jeden dlawiony alert w tiku, nie po jednym na flow
      console.error(`[automatyzacje] flow ${flowId}: wejścia`, blad);
      alerty.push(`automatyzacja ${flowId}: wejścia nie przeszły: ${blad instanceof Error ? blad.message : String(blad)}`);
    }
  }
  return { wprowadzeni, alerty };
}

/**
 * Wyzwalacz metryczny: zdarzenia ze zrodla (port) od kursora skanu, regula czasu (backfill,
 * import, > 4 h spoznienia, sprzed wlaczenia: nie wchodza, AD-39), filtr wyzwalacza, klucz
 * wejscia wg trybu ponownego wejscia (AD-41).
 *
 * Skan (plan 2.6): `nowe` = (recorded_at, id) > kursor z limitem (zawsze posuwa sie naprzod,
 * nawet przy tysiacach zdarzen w kwadransie) + `zakladka` = 15 min przed kursorem (transakcje
 * zatwierdzone poza kolejnoscia; ponowne przetworzenie jest idempotentne). Zdarzenia
 * zarejestrowane ponad dobe przed tikiem nie wchodza (worker lezal) - alert.
 *
 * Kursor zapisywany w TEJ SAMEJ transakcji co wejscia, a wiersz znacznika zablokowany
 * `for update`: dwa tiki tego samego flow ida po kolei, nie obok siebie.
 */
async function kandydaciMetryczni(
  klient: Klient,
  tenantId: string,
  flowId: string,
  activeSince: string,
  zrodlo: Extract<ZrodloWyzwalacza, { rodzaj: "metryka" }>,
  tryb: PonowneWejscie,
  limitSkanu: number,
): Promise<{ kandydaci: KandydatWejscia[]; alerty: string[]; zapiszZnacznik: () => Promise<void> }> {
  const alerty: string[] = [];
  await klient.query(
    `insert into flow_trigger_state (tenant_id, flow_id, scanned_to) values ($1, $2, $3::timestamptz)
     on conflict (tenant_id, flow_id) do nothing`,
    [tenantId, flowId, activeSince],
  );
  const { rows: st } = await klient.query(
    `select s.scanned_to::text as scanned_to, coalesce(s.kursor_id, $7::uuid)::text as kursor_id,
            now()::text as teraz, extract(epoch from now()) * 1000 as teraz_ms,
            extract(epoch from $3::timestamptz) * 1000 as active_ms,
            (s.scanned_to < now() - make_interval(mins => $4::int)) as zalegly,
            (now() - make_interval(mins => $4::int))::text as nie_wczesniej,
            (s.scanned_to - make_interval(mins => $5::int))::text as zakladka_od,
            greatest(date_trunc('second', $3::timestamptz), greatest(s.scanned_to, now() - make_interval(mins => $4::int)) - make_interval(mins => $6::int))::text as zaszle_nowe,
            greatest(date_trunc('second', $3::timestamptz), s.scanned_to - make_interval(mins => $5::int) - make_interval(mins => $6::int))::text as zaszle_zakladka
       from flow_trigger_state s
      where s.tenant_id = $1 and s.flow_id = $2
      for update`,
    [tenantId, flowId, activeSince, MAX_ZALEGLOSC_SKANU_MIN, ZAKLADKA_SKANU_MIN, MAX_SPOZNIENIE_MS / 60_000 + 5, UUID_ZERO],
  );
  const s = st[0];
  const kursor = { recordedAt: s.scanned_to as string, id: s.kursor_id as string };
  if (s.zalegly) {
    alerty.push(`automatyzacja ${flowId}: skan wyzwalacza zaległy o ponad dobę (worker nie działał?). Zdarzenia zarejestrowane wcześniej niż 24 h temu nie uruchomią automatyzacji.`);
  }
  const port = zrodloZdarzen();
  if (port.obsluguje && !port.obsluguje(zrodlo.metryka)) {
    // Flow na metryce, ktorej biezace zrodlo nie zna (np. metryka z API przy wylaczonej
    // MIDREV_GRAF_V2): bez skanu i BEZ przesuwania kursora, zeby po wlaczeniu flagi
    // zdarzenia z tego okresu weszly (w granicy doby zaleglosci), a nie przepadly.
    // alert najwyzej raz na godzine na flow (tik jest co minute)
    const ostatni = alertNieznanejMetryki.get(flowId) ?? 0;
    if (Date.now() - ostatni > 3600_000) {
      alertNieznanejMetryki.set(flowId, Date.now());
      alerty.push(`automatyzacja ${flowId}: metryka wyzwalacza „${zrodlo.metryka.nazwa}” wymaga MIDREV_GRAF_V2 (źródło ${port.nazwa} jej nie zna); wejścia wstrzymane do włączenia flagi`);
    }
    return { kandydaci: [], alerty, zapiszZnacznik: async () => {} };
  }
  const nowe = await port.kandydaci(klient, {
    tenantId, metryka: zrodlo.metryka, limit: limitSkanu, zaszlePo: s.zaszle_nowe,
    zakres: { rodzaj: "nowe", kursor, nieWczesniejNiz: s.nie_wczesniej },
  });
  // Zakladka stronami (malejaco, keyset) az do wyczerpania 15-minutowego okna: przy duzym
  // wolumenie spozniony commit nie moze zostac wypchniety poza limit jednego odczytu.
  const zakladka: ZdarzenieWyzwalajace[] = [];
  let gorna = kursor;
  let wlacznie = true;
  for (let strona = 0; ; strona++) {
    if (strona >= MAX_STRON_ZAKLADKI) {
      alerty.push(`automatyzacja ${flowId}: zakładka skanu (15 min przed kursorem) ma ponad ${MAX_STRON_ZAKLADKI * limitSkanu} zdarzeń; starsze transakcje zatwierdzone z opóźnieniem mogły nie wejść`);
      break;
    }
    const s2 = await port.kandydaci(klient, {
      tenantId, metryka: zrodlo.metryka, limit: limitSkanu, zaszlePo: s.zaszle_zakladka,
      zakres: { rodzaj: "zakladka", od: s.zakladka_od, kursor: gorna, wlacznie },
    });
    zakladka.push(...s2);
    if (s2.length < limitSkanu) break;
    const ost = s2[s2.length - 1];
    gorna = { recordedAt: ost.recordedAt, id: ost.id };
    wlacznie = false;
  }
  const teraz = new Date(Number(s.teraz_ms));
  const activeMs = Number(s.active_ms);
  const kandydaci: KandydatWejscia[] = [];
  const widziane = new Set<string>();
  for (const e of [...zakladka, ...nowe]) {
    if (widziane.has(e.id)) continue;
    widziane.add(e.id);
    if (ocenKandydata(e, activeMs, zrodlo.filtr, teraz) !== null) continue;
    kandydaci.push({
      profileId: e.profileId,
      occurredAt: e.occurredAt,
      occurredAtMs: e.occurredAtMs,
      eventId: e.id,
      eventOccurredAt: e.occurredAt,
      context: e.context,
      entryKey: kluczWejscia(tryb.tryb, { id: e.id }),
      ref: kluczWejscia("zawsze", { id: e.id }),
    });
  }
  const obciety = nowe.length >= limitSkanu;
  if (obciety) alerty.push(`automatyzacja ${flowId}: w jednym skanie ponad ${limitSkanu} zdarzeń wyzwalacza; reszta wejdzie w kolejnych tikach (nadrabianie)`);
  const ostatnie = nowe[nowe.length - 1];
  return {
    kandydaci,
    alerty,
    zapiszZnacznik: async () => {
      // obciety: kursor na ostatnim przetworzonym; inaczej na poczatku tej transakcji (wszystko
      // zatwierdzone wczesniej juz przeczytalismy, spoznione zlapie zakladka kolejnego tiku)
      await klient.query(
        `update flow_trigger_state set scanned_to = $3::timestamptz, kursor_id = $4::uuid, updated_at = now()
          where tenant_id = $1 and flow_id = $2`,
        obciety ? [tenantId, flowId, ostatnie.recordedAt, ostatnie.id] : [tenantId, flowId, s.teraz, null],
      );
    },
  };
}

async function wprowadzDoFlow(tenantId: string, flowId: string, limitSkanu: number): Promise<{ wprowadzeni: number; alerty: string[] }> {
  const pool = getPool();
  const klient = await pool.connect();
  const alerty: string[] = [];
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
      return { wprowadzeni: 0, alerty };
    }
    const g = parsed.data;
    const start = wyzwalaczGrafu(g);
    if (!start) {
      await klient.query("rollback");
      return { wprowadzeni: 0, alerty };
    }
    let tryb: PonowneWejscie = g.ustawienia.ponowneWejscie;
    if (tryb.tryb !== "raz" && !(await ponowneWejscieDostepne(klient))) {
      // Definicja z ponownym wejsciem, a baza jeszcze go nie obsluguje (flaga zdjeta po
      // publikacji, rollback 0036): bezpieczny tryb "raz" i alert, nigdy blad unikalnosci.
      alerty.push(`automatyzacja ${flowId}: ponowne wejście „${tryb.tryb}” jest niedostępne (flaga MIDREV_PONOWNE_WEJSCIE albo migracja 0036); osoby wchodzą tylko raz`);
      tryb = { tryb: "raz" };
    }
    const z = start.zrodlo;
    const detail = JSON.stringify(z.rodzaj === "lista" ? { zdarzenie: "list.joined" } : { zdarzenie: triggerEventGrafu(g), metryka: z.metryka });
    let kandydaci: KandydatWejscia[];
    let zapiszZnacznik: (() => Promise<void>) | null = null;
    if (z.rodzaj === "lista") {
      if (!z.listId) {
        await klient.query("rollback");
        return { wprowadzeni: 0, alerty };
      }
      // Tylko dodania POJEDYNCZE (reczne, formularz), chyba ze operator jawnie wlaczyl
      // masowe. Import 20 tys. adresow na liste z powitaniem nie moze wyslac 20 tys.
      // powitan. Dodania przez inne automatyzacje nigdy: dwa flowy przerzucajace osobe
      // miedzy listami krecilyby sie w kolko.
      const okno = `${OKNO_SKANU_LIST_MIN + minutNaStarcie(g)} minutes`;
      const { rows: lm } = await klient.query(
        `select m.profile_id, m.added_at::text as occurred_at, extract(epoch from m.added_at) * 1000 as occurred_ms,
                floor(extract(epoch from m.added_at) * 1000000)::bigint::text as epoka,
                jsonb_build_object('listId', m.list_id, 'zrodlo', m.source) as context
           from list_members m
          where m.tenant_id = $1 and m.list_id = $2
            and m.added_at >= now() - $3::interval
            and m.added_at >= $4::timestamptz
            and split_part(m.source, ':', 1) <> 'automatyzacja'
            and ($5::boolean or split_part(m.source, ':', 1) = any($6::text[]))`,
        [tenantId, z.listId, okno, f.active_since, z.takzeMasowe === true, [...ZRODLA_POJEDYNCZE]],
      );
      kandydaci = lm.map((r) => ({
        profileId: r.profile_id, occurredAt: r.occurred_at, occurredAtMs: Number(r.occurred_ms),
        eventId: null, eventOccurredAt: null, context: r.context,
        entryKey: kluczWejscia(tryb.tryb, { listId: z.listId!, addedAtEpoch: r.epoka }),
        ref: kluczWejscia("zawsze", { listId: z.listId!, addedAtEpoch: r.epoka }),
      }));
    } else {
      const m = await kandydaciMetryczni(klient, tenantId, flowId, f.active_since, z, tryb, limitSkanu);
      kandydaci = m.kandydaci;
      alerty.push(...m.alerty);
      zapiszZnacznik = m.zapiszZnacznik;
    }
    kandydaci = await odsiejFiltremProfilu(klient, tenantId, flowId, g, kandydaci, tryb);
    const n = await wstawWejscia(klient, tenantId, flowId, f.live_version, g.start, detail, kandydaci, tryb);
    if (zapiszZnacznik) await zapiszZnacznik();
    await klient.query("commit");
    return { wprowadzeni: n, alerty };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

// ── Faza 2: przejscia ───────────────────────────────────────────────────────

interface Otoczenie {
  nazwaSklepu: string;
  /** organization.name w szablonach: nazwa firmy nadawcy, a bez niej nazwa sklepu */
  organizacja: string;
  /** properties zdarzen wyzwalajacych wczytane w tym tiku (zdarzenie jest niezmienne) */
  zdarzenia: Map<string, Record<string, unknown> | null>;
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
    organizacja: String(rows[0]?.sender_company_name || rows[0]?.name || ""),
    zdarzenia: new Map(),
    nadawca: { firma: rows[0]?.sender_company_name ?? null, adres: rows[0]?.sender_postal_address ?? null, nip: rows[0]?.sender_tax_id ?? null },
    sendingDomainId: sd[0]?.id ?? null, polityka: await politykaSledzenia(pool, tenantId) };
}

type WynikWiadomosci =
  | { ok: true; messageId: string; nowa: true }
  | { ok: true; messageId: string; nowa: false }
  | { ok: false; powod: string; wyjscie: boolean }
  /** mail pominiety (dodatkowy filtr, smart sending): osoba idzie dalej, bez przesuwania */
  | { ok: false; pominiecie: PowodPominiecia };



/**
 * Wezel e-mail: buduje wiadomosc `queued` dla uczestnika Z MIGAWKI jego wersji.
 * Idempotencja per PRZEBIEG (AD-41): (tenant, zrodlo, profil, journey_run_id). `nowa: false`
 * = ta wiadomosc juz powstala w TYM przebiegu (ponowienie), nie "kiedys tej osobie".
 *
 * Zmienne `{{ event.X }}` / `{{ person.X }}` (AD-43) renderuja sie wylacznie dla migawek
 * opublikowanych po wprowadzeniu szablonow (`szablon: "liquid"`, zwalidowane przy publikacji).
 * Starsze wersje wychodza bajt w bajt jak dotad, nawet jesli tekst zawiera `{{`.
 */
async function zbudujWiadomoscWezla(
  klient: Klient,
  tenantId: string,
  u: Uczestnik,
  w: WezelTypu<"email">,
  oto: Otoczenie,
): Promise<WynikWiadomosci> {
  const emailId = w.emailId;
  const migawka = u.emails?.[emailId];
  if (!migawka) return { ok: false, powod: "brak migawki treści w tej wersji", wyjscie: false };
  const tematZrodlo = String(migawka.subject ?? "");
  const trescZrodlo = String(migawka.html ?? "");
  if (!tematZrodlo.trim() || !trescZrodlo.trim()) return { ok: false, powod: "wiadomość bez tematu albo treści", wyjscie: false };

  const { rows: prof } = await klient.query(
    "select email, first_name, last_name, phone, properties from profiles where tenant_id = $1 and id = $2",
    [tenantId, u.profile_id],
  );
  if (!prof[0]?.email) return { ok: false, powod: "brak_adresu", wyjscie: true };

  // Bramka zgod PRZED zbudowaniem wiadomosci: osoba bez zgody WYCHODZI z automatyzacji
  // z jawnym powodem w sciezce, zamiast zostawiac po sobie wiadomosc `suppressed`.
  // Wiazaca bramka i tak stoi w transakcji wysylki (AD-25); ta jest dodatkowa.
  // Dodatkowe filtry tego maila (E4b 4.6): kto nie spelnia, pomija TEN mail i idzie dalej.
  if (!(await profilSpelnia(klient, tenantId, u.profile_id, w.dodatkoweFiltry, kontekstUczestnika(u)))) {
    return { ok: false, pominiecie: "dodatkowy_filtr" };
  }
  // Transakcyjny pomija wylacznie brak zgody marketingowej; supresje obowiazuja (plan 3.5).
  const transakcyjny = w.transakcyjny === true;
  const bramka = await canSendTo(klient, tenantId, u.profile_id, { transakcyjny });
  if (!bramka.wolno) return { ok: false, powod: bramka.powod ?? "brak_zgody", wyjscie: true };

  // Jedna budowa wiadomosci na osobe naraz (blokada do konca transakcji przebiegu): dwa flow
  // budujace mail tej samej osobie w tej samej chwili ida po kolei, wiec smart sending drugiego
  // WIDZI wiadomosc pierwszego (read committed: kolejne polecenie po blokadzie ma nowy obraz).
  await klient.query("select pg_advisory_xact_lock(hashtextextended($1, 7150416))", [`wiadomosc-osoby:${tenantId}:${u.profile_id}`]);
  if (w.smartSending && !transakcyjny
    && (await niedawnyMail(klient, tenantId, u.profile_id, w.smartSendingGodzin ?? SMART_SENDING_GODZIN, { zKolejka: true, pominPrzebieg: { emailId, uczestnikId: u.id } }))) {
    return { ok: false, pominiecie: "smart_sending" };
  }

  let temat: string;
  let tresc: string;
  if (migawka.szablon === "liquid") {
    const wlasciwosci = u.trigger_event_id ? await zdarzenieUczestnika(klient, tenantId, u, oto) : null;
    const ctx = zbudujKontekst({ zdarzenie: wlasciwosci, profil: prof[0], organizacja: oto.organizacja });
    // blok „Produkty z koszyka”: koszyk osoby i produkty ze zdarzenia, aktualne w chwili budowy maila
    const potrzebne = { cart: /\bcart\./.test(trescZrodlo), products: /\bproducts\./.test(trescZrodlo) };
    if (potrzebne.cart || potrzebne.products) {
      Object.assign(ctx, await kontekstSklepuMaila(klient, tenantId, u.profile_id, wlasciwosci, potrzebne));
    }
    try {
      temat = renderujTemat(tematZrodlo, ctx);
      tresc = renderujHtml(trescZrodlo, ctx);
    } catch (e) {
      if (e instanceof BladSzablonu) return { ok: false, powod: `błąd w zmiennych (${e.message})`, wyjscie: false };
      throw e;
    }
    if (!temat) return { ok: false, powod: "temat po podstawieniu zmiennych jest pusty", wyjscie: false };
  } else {
    temat = oczyscTemat(tematZrodlo);
    tresc = trescZrodlo;
  }

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
  // Wydanie N (do 0036): wiadomosc z tego kroku mogl zbudowac STARY kod w oknie deployu, bez
  // journey_run_id. Przebieg "raz" to jedyny przebieg tej osoby w tym flow (stara unikalnosc),
  // wiec przypinamy ja do niego (dopisanie tozsamosci, zawezone do tej jednej wiadomosci)
  // zamiast wywracac sie na starej unikalnosci albo budowac druga.
  if (u.entry_key === "raz") {
    const { rows: stara } = await klient.query(
      `update messages set journey_run_id = $4
        where tenant_id = $1 and source_type = 'journey' and source_id = $2 and profile_id = $3
          and journey_run_id is null
        returning id`,
      [tenantId, emailId, u.profile_id, u.id],
    );
    if (stara[0]) return { ok: true, messageId: stara[0].id, nowa: false };
  }
  // Cel `on conflict` = nowa unikalnosc per przebieg (0035). Do czasu 0036 stoi tez stara
  // (bez przebiegu): wtedy drugi przebieg nie istnieje (ponowne wejscie wylaczone), a gdyby
  // jednak zaistnial, insert wywroci sie glosno zamiast cicho "pominac" mail.
  const wstaw = await klient.query(
    `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject,
                           body_html, click_token, unsubscribe_token, links,
                           sending_domain_id, open_tracking_allowed, click_tracking_allowed, journey_run_id, transactional)
     values ($1, $2, 'journey', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (tenant_id, source_id, profile_id, journey_run_id)
       where source_type = 'journey' and journey_run_id is not null do nothing
     returning id`,
    [tenantId, u.profile_id, emailId, prof[0].email, temat, html, clickToken, unsubToken,
     JSON.stringify(linki), oto.sendingDomainId, zgody.otwarcia, zgody.klikniecia, u.id, transakcyjny],
  );
  if (wstaw.rows[0]) return { ok: true, messageId: wstaw.rows[0].id, nowa: true };
  const { rows: istniejaca } = await klient.query(
    `select id from messages
      where tenant_id = $1 and source_type = 'journey' and source_id = $2 and profile_id = $3 and journey_run_id = $4`,
    [tenantId, emailId, u.profile_id, u.id],
  );
  return { ok: true, messageId: istniejaca[0].id, nowa: false };
}

/** Wlasciwosci zdarzenia, ktore wprowadzilo uczestnika (cache w tiku: zdarzenie jest niezmienne). */
async function zdarzenieUczestnika(klient: Klient, tenantId: string, u: Uczestnik, oto: Otoczenie): Promise<Record<string, unknown> | null> {
  if (!u.trigger_event_id) return null;
  // (id, occurred_at) = pelna tozsamosc wiersza metric_events (klucz partycji)
  const klucz = `${u.trigger_event_id}|${u.trigger_event_occurred_at ?? ""}`;
  if (!oto.zdarzenia.has(klucz)) {
    oto.zdarzenia.set(klucz, await wlasciwosciWyzwalacza(klient, tenantId, u.trigger_event_id, u.trigger_event_occurred_at));
  }
  return oto.zdarzenia.get(klucz) ?? null;
}

async function zajmijUczestnika(klient: Klient, tenantId: string, id: string): Promise<Uczestnik | null> {
  // blokada wiersza uczestnika + odczyt definicji i migawki tresci JEGO wersji;
  // `skip locked` = drugi worker nie czeka i nie dubluje, tylko bierze nastepnego
  const { rows } = await klient.query(
    `select p.id, p.flow_id, p.profile_id, p.version, p.node_id,
            p.entered_at::text as entered_at, p.node_since::text as node_since, p.resume_at::text as resume_at,
            (p.resume_at is not null and p.resume_at < now() - $3::interval) as przeterminowany,
            (p.resume_at is not null and p.resume_at < now() - $4::interval) as przeterminowany_czekaj,
            p.context, p.trigger_event_id, p.trigger_event_occurred_at::text as trigger_event_occurred_at, p.entry_key,
            f.status as flow_status, v.definition, v.emails,
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

const UUID_ZAMOWIENIA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reguly wyjscia sprawdzane przy KAZDYM ruchu: zakup po wejsciu (gdy flow tak chce). */
async function regulaWyjscia(klient: Klient, tenantId: string, u: Uczestnik): Promise<string | null> {
  if (!u.wyjscie_po_zakupie) return null;
  // Zamowienie, ktore WYZWOLILO flow, nie jest „zakupem po wejsciu”: strumien zdarzen (i jego
  // lustro w `events`) trzyma czas z dokladnoscia do sekundy (entered_at = occurred_at
  // zdarzenia), a `orders.occurred_at` moze miec ulamki sekundy - bez wykluczenia po id osoba
  // wychodzilaby na wlasnym zamowieniu. orderId = orders.id z kontekstu przebiegu.
  const orderId = typeof u.context?.orderId === "string" && UUID_ZAMOWIENIA.test(u.context.orderId) ? u.context.orderId : null;
  const { rows } = await klient.query(
    `select exists (
       select 1 from orders o
        where o.tenant_id = $1 and o.profile_id = $2 and o.occurred_at > $3::timestamptz
          and o.status in ('completed', 'processing')
          and o.id is distinct from $4::uuid
     ) as kupil`,
    [tenantId, u.profile_id, u.entered_at, orderId],
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
      // Filtr profilu flow (E4b 4.6) przed KAZDA akcja: kto przestal spelniac, wychodzi
      // z powodem w sciezce (Klaviyo: "Skipped: Fails profile filters"). Nie przed opoznieniem
      // i splitem: tam nic sie nie dzieje osobie, a decyzja zapada przy akcji.
      if (TYPY_AKCJI.has(w.typ) && !filtrPusty(g.ustawienia.filtrProfilu)
        && !(await profilSpelnia(klient, tenantId, u.profile_id, g.ustawienia.filtrProfilu, kontekstUczestnika(u)))) {
        await zakoncz(klient, tenantId, u, "wyszedl", "filtr_profilu", "wyjscie", { wezel: w.typ, wezelId: w.id, filtr: opiszFiltr(g.ustawienia.filtrProfilu) });
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
          const ocena = await ocenWarunek(klient, tenantId, w.regula, {
            profileId: u.profile_id, enteredAt: u.entered_at, context: u.context,
            flowId: u.flow_id, uczestnikId: u.id, triggerEventId: u.trigger_event_id,
          });
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
        case "podzial_zdarzenia": {
          // Split po zdarzeniu wyzwalajacym (Klaviyo: trigger split): wlasciwosci zdarzenia sa
          // niezmienne, wiec wynik nie zalezy od chwili. Brak zdarzenia = przerwanie z alertem,
          // nigdy cicha galaz "Nie".
          const wlasciwosci = u.trigger_event_id ? await zdarzenieUczestnika(klient, tenantId, u, oto) : null;
          if (!wlasciwosci) {
            await zakoncz(klient, tenantId, u, "przerwany", "brak zdarzenia wyzwalającego do podziału", "przerwanie", { wezelId: w.id });
            alerty.push(`automatyzacja ${u.flow_id}: podział po zdarzeniu bez zdarzenia wyzwalającego (uczestnik ${u.id})`);
            przerwano = true;
            break;
          }
          const wynik = ocenFiltr(w.filtr, { zdarzenie: wlasciwosci, teraz: new Date() });
          dalej = cel(w, wynik ? "next_if_true" : "next_if_false");
          await przejscie(klient, tenantId, u, "warunek", w.id, dalej, { wynik, podzialZdarzenia: true, filtr: opiszFiltr(w.filtr) });
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
          const wynik = await zbudujWiadomoscWezla(klient, tenantId, u, w, oto);
          if (!wynik.ok && "pominiecie" in wynik) {
            // mail pominiety, osoba idzie dalej bez przesuwania (Klaviyo: Skipped)
            await przejscie(klient, tenantId, u, "pominieto", w.id, w.id, { emailId: w.emailId, powod: wynik.pominiecie, opis: OPISY_POMINIEC[wynik.pominiecie] });
            await emitujPominiecie(klient, { tenantId, profileId: u.profile_id, flowId: u.flow_id, emailId: w.emailId, uczestnikId: u.id, powod: wynik.pominiecie });
            dalej = cel(w, "next");
            break;
          }
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
            // wiadomosc z tego kroku juz powstala W TYM PRZEBIEGU (AD-41): sciezka mowi prawde
            await przejscie(klient, tenantId, u, "pominieto", w.id, w.id, { emailId: w.emailId, messageId: wynik.messageId, powod: "wiadomość z tego kroku już powstała w tym przebiegu" });
          }
          nowyContext = { ...u.context, ostatniaWiadomoscId: wynik.messageId };
          dalej = cel(w, "next");
          break;
        }
        case "profil": {
          if (w.akcja.rodzaj === "ustaw_wlasciwosc" || w.akcja.rodzaj === "usun_wlasciwosc") {
            // Profil po anonimizacji RODO (email = null) nie dostaje nowych danych.
            const { rowCount } = w.akcja.rodzaj === "ustaw_wlasciwosc"
              ? await klient.query(
                `update profiles set properties = coalesce(properties, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb), updated_at = now()
                  where tenant_id = $1 and id = $2 and email is not null`,
                [tenantId, u.profile_id, w.akcja.klucz, JSON.stringify(w.akcja.wartosc)],
              )
              : await klient.query(
                `update profiles set properties = coalesce(properties, '{}'::jsonb) - $3::text, updated_at = now()
                  where tenant_id = $1 and id = $2 and email is not null`,
                [tenantId, u.profile_id, w.akcja.klucz],
              );
            await przejscie(klient, tenantId, u, "profil", w.id, w.id, {
              akcja: w.akcja.rodzaj, klucz: w.akcja.klucz,
              ...(w.akcja.rodzaj === "ustaw_wlasciwosc" ? { wartosc: w.akcja.wartosc } : {}),
              ...(rowCount ? {} : { pominieto: "profil zanonimizowany" }),
            });
            dalej = cel(w, "next");
            break;
          }
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
