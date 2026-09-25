import { getPool } from "../adapters/db/pool";
import { skompiluj } from "../adapters/db/segmenty";
import type { Regula } from "../domain/segmenty";
import { canSendTo, type PowodOdmowy } from "./wysylka/can-send-to";

// Ekran pojedynczego odbiorcy (FR21, FR22 i luka nr 2 z PANELE-ESP-NAWIGACJA).
//
// Pierwszy telefon od klienta brzmi "co wysłaliście pani Kowalskiej i skąd macie
// jej zgodę", więc ten moduł składa odpowiedź na oba pytania W JEDNYM przebiegu:
// stan zgody liczony z rejestru (nie z pola na profilu, AD-16), bramkę wysyłki
// tą samą funkcją, której używa silnik (canSendTo), i jedną oś czasu zamiast
// pięciu osobnych tabelek.
//
// SQL lokalnie zamiast w repozytoria.ts - z tego samego powodu co w popupach:
// praca równoległa, wspólne pliki nietykalne; po scaleniu do przeniesienia (AD-18).
// Każde zapytanie ma predykat tenant_id (AD-2): profil odbiorcy to dane osobowe,
// a w tym repo był już realny wyciek cross-tenant.

export interface DaneProfilu {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: Date;
  zamowien: number;
  wydal_minor: string;
  ostatnie_zamowienie: Date | null;
  wiadomosci: number;
  klikniec: number;
  /** profil przeszedł już przez żądanie usunięcia danych (wpis w logu RODO) */
  zanonimizowany: boolean;
}

export interface WpisZgody {
  channel: "email" | "sms";
  state: "granted" | "withdrawn";
  source: string;
  wording: string | null;
  occurred_at: Date;
  recorded_at: Date;
}

export interface StanKanalu {
  kanal: "email" | "sms";
  /** null = w rejestrze nie ma ani jednego wpisu dla tego kanału */
  stan: "granted" | "withdrawn" | null;
  odKiedy: Date | null;
  zrodlo: string | null;
  klauzula: string | null;
  wpisow: number;
}

export interface WpisWykluczenia {
  zakres: "globalne" | "sklep";
  action: string;
  reason: string;
  occurred_at: Date;
}

export type RodzajZdarzenia =
  | "zamowienie"
  | "wiadomosc"
  | "klikniecie"
  | "zgoda"
  | "wykluczenie"
  | "zdarzenie";

export interface ZdarzenieOsi {
  rodzaj: RodzajZdarzenia;
  occurred_at: Date;
  tytul: string;
  detal: string | null;
  kwota_minor: string | null;
}

export interface WierszWysylki {
  id: string;
  subject: string;
  email: string;
  current_state: string;
  created_at: Date;
  wyslano: Date | null;
  source_type: string;
  zrodlo_nazwa: string | null;
  klikniec: number;
}

export interface Przynaleznosc {
  id: string;
  nazwa: string;
  opis: string | null;
}

export interface WidokProfilu {
  profil: DaneProfilu;
  zgody: WpisZgody[];
  kanaly: StanKanalu[];
  wykluczenia: WpisWykluczenia[];
  bramka: { wolno: boolean; powod?: PowodOdmowy };
  os: ZdarzenieOsi[];
  wysylki: WierszWysylki[];
  listy: Przynaleznosc[];
  segmenty: Przynaleznosc[];
}

/** Stany wiadomości w języku panelu. Surowy enum silnika nie ma czego szukać w UI. */
const STANY_WIADOMOSCI: Record<string, { etykieta: string; waga: "ok" | "uwaga" | "blad" }> = {
  queued: { etykieta: "w kolejce", waga: "uwaga" },
  sending: { etykieta: "w wysyłce", waga: "uwaga" },
  sent: { etykieta: "wysłana", waga: "ok" },
  delivered: { etykieta: "dostarczona", waga: "ok" },
  bounced: { etykieta: "odbita", waga: "blad" },
  complained: { etykieta: "skarga odbiorcy", waga: "blad" },
  failed: { etykieta: "nieudana", waga: "blad" },
  suppressed: { etykieta: "zatrzymana bramką", waga: "uwaga" },
  held: { etykieta: "wstrzymana", waga: "uwaga" },
};

export function stanWiadomosci(stan: string): { etykieta: string; waga: "ok" | "uwaga" | "blad" } {
  return STANY_WIADOMOSCI[stan] ?? { etykieta: stan, waga: "uwaga" };
}

/** Powody odmowy wysyłki w języku panelu, w brzmieniu, które mówi co zrobić. */
export const POWODY_BRAMKI: Record<PowodOdmowy, string> = {
  brak_adresu: "Profil nie ma adresu e-mail, więc nie ma dokąd wysłać.",
  wykluczenie_globalne:
    "Adres jest na wykluczeniach globalnych całej platformy (twarde odbicie albo skarga). Zdejmuje je administrator.",
  wykluczenie_sklepu: "Osoba wypisała się z wysyłek tego sklepu. Wpis jest w rejestrze wykluczeń.",
  brak_zgody: "W rejestrze zgód nie ma aktualnej zgody na e-mail dla tego profilu.",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function danePodstawowe(tenantId: string, profileId: string): Promise<DaneProfilu | null> {
  // Identyfikator przychodzi z segmentu URL: śmieć ma dać „nie ma takiego profilu" (404),
  // a nie błąd rzutowania Postgresa (500) — audyt 24.09, #17, potwierdzone na żywo.
  if (!UUID.test(profileId)) return null;
  const { rows } = await getPool().query<DaneProfilu>(
    `select p.id, p.email, p.phone, p.first_name, p.last_name, p.created_at,
            (select count(*)::int from orders o
              where o.tenant_id = p.tenant_id and o.profile_id = p.id) as zamowien,
            coalesce((select sum(o.total_minor) from orders o
                       where o.tenant_id = p.tenant_id and o.profile_id = p.id
                         and o.status in ('completed','processing')), 0)::text as wydal_minor,
            (select max(o.occurred_at) from orders o
              where o.tenant_id = p.tenant_id and o.profile_id = p.id) as ostatnie_zamowienie,
            (select count(*)::int from messages m
              where m.tenant_id = p.tenant_id and m.profile_id = p.id) as wiadomosci,
            (select count(*)::int from clicks c
              where c.tenant_id = p.tenant_id and c.profile_id = p.id) as klikniec,
            exists (select 1 from events e
                     where e.tenant_id = p.tenant_id and e.profile_id = p.id
                       and e.event_type = 'rodo.anonimizacja') as zanonimizowany
       from profiles p
      where p.tenant_id = $1 and p.id = $2`,
    [tenantId, profileId],
  );
  return rows[0] ?? null;
}

/**
 * Cały rejestr zgód tego profilu, najnowsze pierwsze. Przy sporze o zgodę to jest
 * jedyny dowód, więc ekran pokazuje wszystkie wpisy, nie tylko ostatni stan.
 */
export async function zgodyProfilu(tenantId: string, profileId: string): Promise<WpisZgody[]> {
  const { rows } = await getPool().query<WpisZgody>(
    `select channel, state, source, wording, occurred_at, recorded_at
       from consents
      where tenant_id = $1 and profile_id = $2
      order by occurred_at desc, recorded_at desc`,
    [tenantId, profileId],
  );
  return rows;
}

/** Stan per kanał = OSTATNI wpis w rejestrze (AD-16), policzony z pobranej historii. */
export function stanyKanalow(zgody: WpisZgody[]): StanKanalu[] {
  return (["email", "sms"] as const).map((kanal) => {
    const wpisy = zgody.filter((z) => z.channel === kanal);
    const ostatni = wpisy[0];
    return {
      kanal,
      stan: ostatni?.state ?? null,
      odKiedy: ostatni?.occurred_at ?? null,
      zrodlo: ostatni?.source ?? null,
      klauzula: ostatni?.wording ?? null,
      wpisow: wpisy.length,
    };
  });
}

/**
 * Wykluczenia dotyczące adresu tego profilu: globalne (cała platforma) i lokalne
 * (ten sklep, stan z ostatniego wpisu). Bez adresu nie ma czego sprawdzać.
 */
export async function wykluczeniaProfilu(
  tenantId: string,
  email: string | null,
): Promise<WpisWykluczenia[]> {
  if (!email) return [];
  const { hashAdresu } = await import("../adapters/hash-adresu");
  const { rows } = await getPool().query<WpisWykluczenia>(
    `select 'globalne' as zakres, 'suppressed' as action, s.reason, s.created_at as occurred_at
       from suppressions s
      where lower(btrim(s.email)) = lower(btrim($2)) or s.email_hash = $3
     union all
     select 'sklep', ts.action, ts.reason, ts.occurred_at
       from (
         select distinct on (lower(btrim(email))) action, reason, occurred_at
           from tenant_suppressions
          where tenant_id = $1 and lower(btrim(email)) = lower(btrim($2))
          order by lower(btrim(email)), occurred_at desc
       ) ts
      order by 4 desc`,
    [tenantId, email, hashAdresu(email)],
  );
  return rows;
}

/**
 * Jedna chronologiczna oś czasu zamiast pięciu tabelek: zamówienia, wysyłki,
 * kliknięcia, wpisy zgód, wykluczenia i pozostałe zdarzenia (zapis z popupu,
 * ślad operacji RODO).
 *
 * 'order.created' z `events` jest tu świadomie pominięte: to samo zamówienie
 * przychodzi już z tabeli `orders`, z numerem i kwotą, a podwójny wpis na osi
 * wyglądałby jak dwa zakupy.
 */
export async function osCzasu(
  tenantId: string,
  profileId: string,
  email: string | null,
  limit = 80,
): Promise<ZdarzenieOsi[]> {
  const { rows } = await getPool().query<ZdarzenieOsi>(
    `select 'zamowienie'::text as rodzaj, o.occurred_at,
            coalesce(o.number, o.external_id) as tytul,
            o.status as detal, o.total_minor::text as kwota_minor
       from orders o
      where o.tenant_id = $1 and o.profile_id = $2
     union all
     select 'wiadomosc', coalesce(w.wyslano, m.created_at), m.subject,
            m.current_state, null::text
       from messages m
       left join lateral (
         select max(me.occurred_at) as wyslano from message_events me
          where me.tenant_id = m.tenant_id and me.message_id = m.id and me.event_type = 'sent'
       ) w on true
      where m.tenant_id = $1 and m.profile_id = $2
     union all
     select 'klikniecie', c.occurred_at, c.url, null::text, null::text
       from clicks c
      where c.tenant_id = $1 and c.profile_id = $2
     union all
     select 'zgoda', cs.occurred_at, cs.source, cs.channel || ':' || cs.state, null::text
       from consents cs
      where cs.tenant_id = $1 and cs.profile_id = $2
     union all
     select 'zdarzenie', e.occurred_at, e.event_type,
            coalesce(e.payload->>'popup_name', e.payload->>'aktor'), null::text
       from events e
      where e.tenant_id = $1 and e.profile_id = $2 and e.event_type <> 'order.created'
     union all
     select 'wykluczenie', ts.occurred_at, ts.reason, ts.action, null::text
       from tenant_suppressions ts
      where ts.tenant_id = $1
        and $3::text is not null
        and lower(btrim(ts.email)) = lower(btrim($3::text))
      order by 2 desc
      limit $4`,
    [tenantId, profileId, email, limit],
  );
  return rows;
}

/** Historia wysyłek ze stanem każdej wiadomości i nazwą kampanii/automatyzacji. */
export async function wysylkiProfilu(
  tenantId: string,
  profileId: string,
  limit = 50,
): Promise<WierszWysylki[]> {
  const { rows } = await getPool().query<WierszWysylki>(
    `select m.id, m.subject, m.email, m.current_state, m.created_at, m.source_type,
            coalesce(k.name, j.name) as zrodlo_nazwa,
            (select max(me.occurred_at) from message_events me
              where me.tenant_id = m.tenant_id and me.message_id = m.id
                and me.event_type = 'sent') as wyslano,
            (select count(*)::int from clicks c
              where c.tenant_id = m.tenant_id and c.message_id = m.id) as klikniec
       from messages m
       left join campaigns k on m.source_type = 'campaign'
            and k.tenant_id = m.tenant_id and k.id = m.source_id
       left join journeys j on m.source_type = 'journey'
            and j.tenant_id = m.tenant_id and j.id = m.source_id
      where m.tenant_id = $1 and m.profile_id = $2
      order by m.created_at desc
      limit $3`,
    [tenantId, profileId, limit],
  );
  return rows;
}

export async function listyProfilu(tenantId: string, profileId: string): Promise<Przynaleznosc[]> {
  const { rows } = await getPool().query<Przynaleznosc>(
    `select l.id, l.name as nazwa, m.source as opis
       from list_members m
       join lists l on l.tenant_id = m.tenant_id and l.id = m.list_id
      where m.tenant_id = $1 and m.profile_id = $2
      order by m.added_at desc`,
    [tenantId, profileId],
  );
  return rows;
}

/**
 * Segment to definicja reguł, nie zapisana lista ludzi, więc przynależność liczy
 * się TERAZ - tym samym kompilatorem reguł, którym liczy się odbiorców kampanii.
 * Inaczej ekran profilu i licznik kampanii mogłyby mówić dwie różne rzeczy.
 */
export async function segmentyProfilu(tenantId: string, profileId: string): Promise<Przynaleznosc[]> {
  const pool = getPool();
  const { rows: segmenty } = await pool.query<{ id: string; name: string; rules: Regula[] }>(
    "select id, name, rules from segments where tenant_id = $1 order by created_at desc",
    [tenantId],
  );
  const wynik: Przynaleznosc[] = [];
  for (const segment of segmenty) {
    let skompilowany: ReturnType<typeof skompiluj>;
    try {
      skompilowany = skompiluj(segment.rules ?? [], tenantId);
    } catch (blad) {
      // segment z nieprawidłowymi regułami (zapisany przed walidacją) nie ma prawa
      // wywrócić KAŻDEJ strony profilu tenanta - pokazujemy go jako uszkodzony
      wynik.push({ id: segment.id, nazwa: segment.name, opis: `segment uszkodzony: ${blad instanceof Error ? blad.message : String(blad)}` });
      continue;
    }
    const { gdzie, parametry } = skompilowany;
    const indeksProfilu = parametry.length + 1;
    const { rows } = await pool.query<{ jest: boolean }>(
      `select exists (
         select 1 from profiles pr
          where pr.tenant_id = $1 and pr.id = $${indeksProfilu} ${gdzie}
       ) as jest`,
      [...parametry, profileId],
    );
    if (rows[0].jest) wynik.push({ id: segment.id, nazwa: segment.name, opis: null });
  }
  return wynik;
}

/** Komplet widoku jednego odbiorcy. Zwraca null, gdy profil nie należy do tenanta. */
export async function widokProfilu(tenantId: string, profileId: string): Promise<WidokProfilu | null> {
  const profil = await danePodstawowe(tenantId, profileId);
  if (!profil) return null;

  const [zgody, wykluczenia, os, wysylki, listy, segmenty, bramka] = await Promise.all([
    zgodyProfilu(tenantId, profil.id),
    wykluczeniaProfilu(tenantId, profil.email),
    osCzasu(tenantId, profil.id, profil.email),
    wysylkiProfilu(tenantId, profil.id),
    listyProfilu(tenantId, profil.id),
    segmentyProfilu(tenantId, profil.id),
    // ta sama funkcja, której w transakcji używa silnik wysyłki (AD-9): ekran ma
    // mówić dokładnie to, co zrobi system, a nie własną interpretację reguł
    canSendTo(getPool(), tenantId, profil.id),
  ]);

  return {
    profil,
    zgody,
    kanaly: stanyKanalow(zgody),
    wykluczenia,
    bramka,
    os,
    wysylki,
    listy,
    segmenty,
  };
}

/** Które profile tenanta przeszły przez żądanie usunięcia - do oznaczenia na liście. */
export async function zanonimizowaneProfile(tenantId: string): Promise<Set<string>> {
  const { rows } = await getPool().query<{ profile_id: string }>(
    `select distinct profile_id from events
      where tenant_id = $1 and event_type = 'rodo.anonimizacja' and profile_id is not null`,
    [tenantId],
  );
  return new Set(rows.map((r) => r.profile_id));
}
