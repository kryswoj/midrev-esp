import { getPool } from "../adapters/db/pool";

/**
 * Lista profili z wyszukiwarka i paginacja kursorem (fala 1 UX, pkt 5; E6.1).
 *
 * Dotad lista brala 200 profili posortowanych po ostatnim zakupie, co wymagalo zagregowania
 * WSZYSTKICH zamowien tenanta przed LIMIT (audyt 01-stan-kodu, metryki-i-profil-2026-09-30).
 * Teraz:
 *  - kolejnosc: najnowsze profile (created_at, id) po indeksie profiles_lista_idx (0041);
 *  - strona 50 wierszy, kursor keyset (created_at, id) w obie strony, bez OFFSET;
 *  - zamowienia liczone LATERAL tylko dla 50 wierszy strony (orders_profile_idx);
 *  - wyszukiwanie po PREFIKSIE: e-mail, imie, nazwisko (lower(...) text_pattern_ops) albo
 *    telefon w E.164; wzorzec LIKE z ucieczka % _ \, wartosci wylacznie jako parametry;
 *  - szybki filtr stanu zgody e-mail: OSTATNI wpis rejestru (AD-16), ta sama kolejnosc co
 *    listy (occurred_at desc, id desc);
 *  - kazde zapytanie z predykatem tenant_id (AD-2); kursor nie niesie tenanta.
 */

export const ROZMIAR_STRONY = 50;
/** Powyzej tej liczby licznik mowi "ponad 100 000" zamiast liczyc dalej. */
export const LIMIT_LICZNIKA = 100_000;
export const STANY_ZGODY = ["granted", "withdrawn", "brak"] as const;
export type StanZgodyFiltr = (typeof STANY_ZGODY)[number];

export interface WierszListyProfili {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  created_at: Date;
  zgoda: StanZgodyFiltr;
  zamowien: number;
  wydal_minor: string;
  ostatnie: Date | null;
}

export interface StronaProfili {
  wiersze: WierszListyProfili[];
  /** liczba WSZYSTKICH profili pasujacych do wyszukiwania i filtra (nie tylko strony), z sufitem */
  razem: number;
  /** true: pasujacych jest wiecej niz LIMIT_LICZNIKA, `razem` to sufit */
  ponadLimit: boolean;
  /** kursor nastepnej (starszej) strony albo null */
  dalej: string | null;
  /** kursor poprzedniej (nowszej) strony albo null; null tez na pierwszej stronie */
  wstecz: string | null;
}

export interface ZapytanieListy {
  q?: string;
  zgoda?: string;
  /** kursor z poprzedniej odpowiedzi */
  po?: string;
  przed?: string;
}

/** Ucieczka znakow specjalnych LIKE (z `escape '\'`). */
export function uciekajLike(s: string): string {
  return s.replace(/[\\%_]/g, (z) => `\\${z}`);
}

interface Kursor {
  czas: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// znacznik czasu w zapisie Postgresa (created_at::text), np. 2026-10-02 19:33:01.123456+00
const CZAS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export function zakodujKursor(k: Kursor): string {
  return Buffer.from(`${k.czas}|${k.id}`, "utf8").toString("base64url");
}

/** Kursor z adresu: zly albo spreparowany = brak kursora (pierwsza strona), nigdy blad SQL. */
export function odkodujKursor(s: string | undefined): Kursor | null {
  if (!s || s.length > 200) return null;
  let tekst: string;
  try {
    tekst = Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [czas, id, ...reszta] = tekst.split("|");
  if (reszta.length || !czas || !id || !CZAS.test(czas) || !UUID.test(id)) return null;
  return { czas, id };
}

/**
 * Warunek wyszukiwania (SQL + parametry od numeru `n`). Zwraca null dla pustego zapytania.
 * Zasady (wszystko prefiksem, bez wielkosci liter):
 *  - z "@": prefiks adresu e-mail;
 *  - same cyfry/telefonowe znaki (min. 6 cyfr): prefiks numeru w E.164 (+48 dla 9 cyfr);
 *  - jedno slowo: prefiks e-maila, imienia albo nazwiska;
 *  - dwa slowa: imie i nazwisko w dowolnej kolejnosci.
 */
export function warunekWyszukiwania(qSurowe: string, n: number): { sql: string; parametry: string[] } | null {
  const q = qSurowe.replace(/\s+/g, " ").trim().slice(0, 100).toLowerCase();
  if (!q) return null;
  const p = (i: number) => `$${n + i}`;
  if (q.includes("@")) {
    return { sql: `p.email is not null and lower(p.email) like ${p(0)} escape '\\'`, parametry: [`${uciekajLike(q)}%`] };
  }
  if (/^[+\d\s().\-/]+$/.test(q)) {
    const cyfry = q.replace(/\D/g, "");
    if (cyfry.length >= 6) {
      const wzorce = q.startsWith("+") ? [`+${cyfry}%`]
        : cyfry.startsWith("00") ? [`+${cyfry.slice(2)}%`]
        : [`+${cyfry}%`, `+48${cyfry}%`];
      return {
        sql: `p.phone is not null and (${wzorce.map((_, i) => `midrev_telefon_e164(p.phone) like ${p(i)}`).join(" or ")})`,
        parametry: wzorce,
      };
    }
  }
  const slowa = q.split(" ").filter(Boolean).slice(0, 2).map((s) => `${uciekajLike(s)}%`);
  if (slowa.length === 1) {
    return {
      // "is not null" przy kazdej galezi: indeksy prefiksowe sa czesciowe (where ... is not null)
      sql: `((p.email is not null and lower(p.email) like ${p(0)} escape '\\') or (p.first_name is not null and lower(p.first_name) like ${p(0)} escape '\\') or (p.last_name is not null and lower(p.last_name) like ${p(0)} escape '\\'))`,
      parametry: slowa,
    };
  }
  return {
    sql: `p.first_name is not null and p.last_name is not null
        and ((lower(p.first_name) like ${p(0)} escape '\\' and lower(p.last_name) like ${p(1)} escape '\\')
          or (lower(p.first_name) like ${p(1)} escape '\\' and lower(p.last_name) like ${p(0)} escape '\\'))`,
    parametry: slowa,
  };
}

// ostatni wpis zgody e-mail (AD-16); indeks consents_profile_idx (tenant, profil, kanal, czas)
const ZGODA_LATERAL = `left join lateral (
    select c.state from consents c
     where c.tenant_id = p.tenant_id and c.profile_id = p.id and c.channel = 'email'
     order by c.occurred_at desc, c.id desc limit 1
  ) z on true`;

export async function stronaProfili(tenantId: string, zapytanie: ZapytanieListy = {}): Promise<StronaProfili> {
  const parametry: unknown[] = [tenantId];
  const warunki: string[] = ["p.tenant_id = $1"];
  const szukaj = warunekWyszukiwania(zapytanie.q ?? "", parametry.length + 1);
  if (szukaj) {
    warunki.push(szukaj.sql);
    parametry.push(...szukaj.parametry);
  }
  const zgoda = (STANY_ZGODY as readonly string[]).includes(zapytanie.zgoda ?? "") ? (zapytanie.zgoda as StanZgodyFiltr) : null;
  if (zgoda) {
    parametry.push(zgoda);
    warunki.push(`coalesce(z.state, 'brak') = $${parametry.length}`);
  }
  const wspolneWhere = warunki.join(" and ");
  const parametryLiczenia = [...parametry];

  const po = odkodujKursor(zapytanie.po);
  const przed = po ? null : odkodujKursor(zapytanie.przed);
  const k = po ?? przed;
  let whereStrony = wspolneWhere;
  if (k) {
    parametry.push(k.czas, k.id);
    const a = parametry.length - 1, b = parametry.length;
    whereStrony += po ? ` and (p.created_at, p.id) < ($${a}::timestamptz, $${b}::uuid)` : ` and (p.created_at, p.id) > ($${a}::timestamptz, $${b}::uuid)`;
  }
  // o jeden wiecej, zeby wiedziec, czy jest kolejna strona w tym kierunku
  parametry.push(ROZMIAR_STRONY + 1);
  const kolejnosc = przed ? "asc" : "desc";

  const pool = getPool();
  const [strona, licznik] = await Promise.all([
    pool.query(
      `with strona as (
         select p.id, p.tenant_id, p.email, p.first_name, p.last_name, p.phone, p.created_at,
                p.created_at::text as kursor_czas, coalesce(z.state, 'brak') as zgoda
           from profiles p
           ${ZGODA_LATERAL}
          where ${whereStrony}
          order by p.created_at ${kolejnosc}, p.id ${kolejnosc}
          limit $${parametry.length}
       )
       select s.id, s.email, s.first_name, s.last_name, s.phone, s.created_at, s.kursor_czas, s.zgoda,
              o.zamowien, o.wydal_minor, o.ostatnie
         from strona s
         left join lateral (
           select count(*)::int as zamowien,
                  coalesce(sum(o.total_minor) filter (where o.status in ('completed', 'processing')), 0)::text as wydal_minor,
                  max(o.occurred_at) as ostatnie
             from orders o
            where o.tenant_id = s.tenant_id and o.profile_id = s.id
         ) o on true
        order by s.created_at desc, s.id desc`,
      parametry,
    ),
    pool.query<{ ile: string }>(
      // licznik z sufitem: przy filtrze zgody liczenie to sonda indeksu na profil, wiec liczymy
      // najwyzej LIMIT_LICZNIKA + 1 wierszy (review Codeksa R1); UI pokazuje wtedy "ponad N"
      `select count(*)::text as ile from (select 1 from profiles p ${zgoda ? ZGODA_LATERAL : ""} where ${wspolneWhere} limit ${LIMIT_LICZNIKA + 1}) x`,
      parametryLiczenia,
    ),
  ]);

  const wiersze = strona.rows as (WierszListyProfili & { kursor_czas: string })[];
  const nadmiar = wiersze.length > ROZMIAR_STRONY;
  // przy "przed" nadmiarowy wiersz jest NAJNOWSZY (na poczatku po odwroceniu kolejnosci)
  const widoczne = nadmiar ? (przed ? wiersze.slice(1) : wiersze.slice(0, ROZMIAR_STRONY)) : wiersze;
  const pierwszy = widoczne[0];
  const ostatni = widoczne[widoczne.length - 1];
  const kursor = (w: { kursor_czas: string; id: string }) => zakodujKursor({ czas: w.kursor_czas, id: w.id });
  return {
    wiersze: widoczne.map(({ kursor_czas: _k, ...w }) => w),
    razem: Math.min(Number(licznik.rows[0].ile), LIMIT_LICZNIKA),
    ponadLimit: Number(licznik.rows[0].ile) > LIMIT_LICZNIKA,
    // dalej (starsze): gdy szlismy w dol i byl nadmiar, albo gdy cofalismy sie (wtedy zawsze sa starsze)
    dalej: ostatni && (przed ? true : nadmiar) ? kursor(ostatni) : null,
    // wstecz (nowsze): gdy przyszlismy kursorem "po", albo cofajac sie byl nadmiar
    wstecz: pierwszy && (po ? true : przed ? nadmiar : false) ? kursor(pierwszy) : null,
  };
}

/** Ktore z podanych profili sa po anonimizacji RODO (tylko dla wierszy strony). */
export async function zanonimizowaneSposrod(tenantId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { rows } = await getPool().query<{ profile_id: string }>(
    `select distinct profile_id from events
      where tenant_id = $1 and event_type = 'rodo.anonimizacja' and profile_id = any($2::uuid[])`,
    [tenantId, ids],
  );
  return new Set(rows.map((r) => r.profile_id));
}
