import type { PoolClient } from "pg";
import { nagrobek } from "../przetworz-zdarzenie";
import { hashIdentyfikatora } from "../../adapters/hash-adresu";
import type { AtrybutyProfilu, IdentyfikatoryProfilu } from "../api/zdarzenie-api";
import { sprawdzWlasciwosci } from "../../domain/zdarzenia/limity";

/**
 * Identyfikacja profilu dla zdarzeń z API (E2 / 2.4, plan 2.5).
 *
 * Kolejność dopasowania: id → email → phone_number → external_id → anonymous_id (jak
 * rozumiemy dokumentację Klaviyo; do potwierdzenia na koncie testowym). Pierwszy trafiony
 * identyfikator wygrywa. Pozostałe podane identyfikatory:
 *   - wskazują ten sam profil albo nikogo → uzupełniamy nimi puste pola profilu,
 *   - wskazują INNY profil → KONFLIKT: zdarzenie idzie do wygranego profilu, identyfikator
 *     drugiego NIE jest nadpisywany ani przenoszony, konflikt wraca do wołającego (alert).
 * Telefon dopasowuje wyłącznie wtedy, gdy znormalizowany numer wskazuje DOKŁADNIE jeden
 * profil (0033: bez unikalnego indeksu, bo Woo dopuszcza wspólny numer w rodzinie).
 *
 * Brak profilu = tworzymy (także z samym anonymous_id). Nagrobek RODO (0024) albo profil
 * zanonimizowany = odmowa: API nie odtwarza osoby po art. 17.
 *
 * Atrybuty: imię, nazwisko, organizacja, tytuł, język NADPISUJĄ (jak Klaviyo), lokalizacja
 * i właściwości są SCALANE (`||`), pusty napis zapisuje pusty napis (tak n8n czyści pola).
 */

export type RodzajIdentyfikatora = "id" | "email" | "phone_number" | "external_id" | "anonymous_id";

export interface KonfliktIdentyfikatora {
  rodzaj: RodzajIdentyfikatora;
  /** profil, na który wskazuje ten identyfikator (inny niż wybrany) */
  innyProfil: string;
}

/**
 * `tryb: "klient"` = żądanie z przeglądarki (`/client/*`, klucz publiczny strony). Kto zna
 * klucz strony i czyjś e-mail, może wysłać żądanie w jego imieniu (tak samo w Klaviyo),
 * więc przeglądarka NIE nadpisuje danych istniejącego profilu (plan 2.5):
 *   - imię, nazwisko, organizacja, tytuł, język: tylko uzupełnienie pustych pól,
 *   - identyfikatory (e-mail, telefon, external_id): bez zmian; wolno wyłącznie powiązać
 *     pusty `anonymous_id` (identyfikacja przeglądarki po identify),
 *   - właściwości i lokalizacja: scalane (jak w Klaviyo).
 * Nowy profil zakłada się normalnie (z e-mailem, telefonem albo external_id).
 */
export interface OpcjeIdentyfikacji {
  tryb?: "api" | "klient";
}

export type WynikIdentyfikacji =
  | { odrzucone: false; profileId: string; utworzony: boolean; dopasowanyPo: RodzajIdentyfikatora | null; konflikty: KonfliktIdentyfikatora[] }
  | { odrzucone: true; powod: "rodo" | "niepoprawne_wlasciwosci" | "nie_znaleziono"; opis: string };

async function jedenProfil(klient: PoolClient, sql: string, parametry: unknown[]): Promise<string | null | "wiele"> {
  const { rows } = await klient.query<{ id: string }>(sql + " limit 2", parametry);
  if (rows.length === 0) return null;
  if (rows.length > 1) return "wiele";
  return rows[0].id;
}

async function znajdzPo(
  klient: PoolClient,
  tenantId: string,
  rodzaj: RodzajIdentyfikatora,
  wartosc: string,
): Promise<string | null | "wiele"> {
  switch (rodzaj) {
    case "id":
      return jedenProfil(klient, "select id from profiles where tenant_id = $1 and id = $2::uuid", [tenantId, wartosc]);
    case "email":
      return jedenProfil(klient, "select id from profiles where tenant_id = $1 and email is not null and lower(btrim(email)) = lower(btrim($2))", [tenantId, wartosc]);
    case "phone_number":
      return jedenProfil(klient, "select id from profiles where tenant_id = $1 and phone is not null and midrev_telefon_e164(phone) = $2", [tenantId, wartosc]);
    case "external_id":
      return jedenProfil(klient, "select id from profiles where tenant_id = $1 and external_id = $2", [tenantId, wartosc]);
    case "anonymous_id":
      return jedenProfil(klient, "select id from profiles where tenant_id = $1 and anonymous_id = $2", [tenantId, wartosc]);
  }
}

async function zanonimizowany(klient: PoolClient, tenantId: string, profileId: string): Promise<boolean> {
  const { rows } = await klient.query<{ jest: boolean }>(
    `select exists (
       select 1 from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
        where e.tenant_id = $1 and e.profile_id = $2 and m.integration_key = 'midrev' and m.name = 'rodo.anonimizacja'
     ) or exists (
       select 1 from events where tenant_id = $1 and profile_id = $2 and event_type = 'rodo.anonimizacja'
     ) as jest`,
    [tenantId, profileId],
  );
  return rows[0].jest;
}

function obetnij(v: string | null | undefined, maks: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return v.slice(0, maks);
}

/**
 * Nagrobki RODO (0024 e-mail, 0033 telefon/external_id/anonymous_id) dla podanych
 * identyfikatorów. Wołane na starcie i PONOWNIE tuż przed założeniem nowego profilu:
 * anonimizacja zatwierdzona między startem a wyszukaniem czyści identyfikatory profilu,
 * więc wyszukanie nic nie znajdzie, a nagrobek już jest (review Codeksa R3).
 */
async function maNagrobek(klient: PoolClient, tenantId: string, ident: IdentyfikatoryProfilu): Promise<boolean> {
  if (ident.email && (await nagrobek(klient, tenantId, { email: ident.email }))) {
    return true;
  }
  const hasze: [string, string][] = (
    [
      ["phone_number", ident.telefon],
      ["external_id", ident.externalId],
      ["anonymous_id", ident.anonymousId],
    ] as [string, string | null][]
  )
    .filter((x): x is [string, string] => Boolean(x[1]))
    .map(([r, w]) => [r, hashIdentyfikatora(r, w)]);
  if (hasze.length) {
    const { rows } = await klient.query<{ jest: boolean }>(
      `select exists (select 1 from rodo_nagrobki_identyfikatorow n
                       join unnest($2::text[], $3::text[]) as x(rodzaj, hash) on n.rodzaj = x.rodzaj and n.hash = x.hash
                      where n.tenant_id = $1) as jest`,
      [tenantId, hasze.map((h) => h[0]), hasze.map((h) => h[1])],
    );
    if (rows[0].jest) return true;
  }

  return false;
}

export async function identyfikujProfil(
  klient: PoolClient,
  tenantId: string,
  ident: IdentyfikatoryProfilu,
  atrybuty: AtrybutyProfilu,
  proba = 0,
  opcje: OpcjeIdentyfikacji = {},
): Promise<WynikIdentyfikacji> {
  const klientPrzegladarki = opcje.tryb === "klient";
  for (const [nazwa, obiekt] of [["properties", atrybuty.wlasciwosci], ["location", atrybuty.lokalizacja]] as const) {
    const n = obiekt ? sprawdzWlasciwosci(obiekt) : null;
    if (n) return { odrzucone: true, powod: "niepoprawne_wlasciwosci", opis: `${nazwa}${n.wskaznik}: ${n.opis}` };
  }
  if (await maNagrobek(klient, tenantId, ident)) {
    return { odrzucone: true, powod: "rodo", opis: "identyfikator ma nagrobek RODO" };
  }

  const kolejnosc: [RodzajIdentyfikatora, string | null][] = [
    ["id", ident.id],
    ["email", ident.email],
    ["phone_number", ident.telefon],
    ["external_id", ident.externalId],
    ["anonymous_id", ident.anonymousId],
  ];
  // Blokady doradcze na KAŻDY podany identyfikator (posortowane: brak zakleszczeń między
  // żądaniami z tymi samymi identyfikatorami w innej kolejności). Dwa równoległe żądania
  // o tę samą nową osobę (także z samym telefonem, który nie ma unikalnego indeksu)
  // czekają na siebie, a drugie widzi profil założony przez pierwsze (review Codeksa R2a).
  if (proba === 0) {
    const klucze = kolejnosc
      .filter(([, w]) => w)
      .map(([r, w]) => `${tenantId}:${r}:${r === "email" ? String(w).trim().toLowerCase() : w}`)
      .sort();
    for (const k of klucze) {
      await klient.query("select pg_advisory_xact_lock(hashtextextended('profil-api:' || $1::text, 0))", [k]);
    }
  }
  const trafienia = new Map<RodzajIdentyfikatora, string | "wiele" | null>();
  for (const [rodzaj, wartosc] of kolejnosc) {
    if (wartosc) trafienia.set(rodzaj, await znajdzPo(klient, tenantId, rodzaj, wartosc));
  }

  let wybrany: string | null = null;
  let dopasowanyPo: RodzajIdentyfikatora | null = null;
  for (const [rodzaj] of kolejnosc) {
    const t = trafienia.get(rodzaj);
    if (t && t !== "wiele") {
      wybrany = t;
      dopasowanyPo = rodzaj;
      break;
    }
  }

  const konflikty: KonfliktIdentyfikatora[] = [];
  for (const [rodzaj, t] of trafienia) {
    if (t && t !== "wiele" && wybrany && t !== wybrany) konflikty.push({ rodzaj, innyProfil: t });
  }
  const wolno = (r: RodzajIdentyfikatora) => {
    const t = trafienia.get(r);
    // identyfikator wolno dopisać tylko, gdy nie wskazuje nikogo innego
    return t === null || t === undefined || t === wybrany;
  };

  const imie = obetnij(atrybuty.imie, 255);
  const nazwisko = obetnij(atrybuty.nazwisko, 255);
  const organizacja = obetnij(atrybuty.organizacja, 255);
  const tytul = obetnij(atrybuty.tytul, 255);
  const jezyk = obetnij(atrybuty.jezyk, 64);
  const lokalizacja = JSON.stringify(atrybuty.lokalizacja ?? {});
  const wlasciwosci = JSON.stringify(atrybuty.wlasciwosci ?? {});

  if (!wybrany && ident.id && !ident.email && !ident.telefon && !ident.externalId && !ident.anonymousId) {
    // Sam identyfikator profilu, którego nie ma w TYM tenancie (AD-40: cudzy = nie istnieje).
    // Nie zakładamy pustego profilu bez żadnego kontaktu.
    return { odrzucone: true, powod: "nie_znaleziono", opis: "profil o podanym id nie istnieje w tym koncie" };
  }

  if (!wybrany) {
    if (await maNagrobek(klient, tenantId, ident)) {
      return { odrzucone: true, powod: "rodo", opis: "identyfikator ma nagrobek RODO" };
    }
    // Nowy profil. Wyścig dwóch żądań o tę samą osobę: unikalny indeks e-maila/external_id
    // odrzuca drugie wstawienie - wtedy savepoint i ponowna identyfikacja (profil już jest).
    await klient.query("savepoint nowy_profil_api");
    try {
      const { rows } = await klient.query<{ id: string }>(
        `insert into profiles (tenant_id, email, phone, external_id, anonymous_id, first_name, last_name,
                               organization, title, locale, location, properties, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, now())
         returning id`,
        [
          tenantId,
          ident.email && wolno("email") ? ident.email : null,
          ident.telefon && trafienia.get("phone_number") !== "wiele" ? ident.telefon : null,
          ident.externalId,
          ident.anonymousId,
          imie ?? null,
          nazwisko ?? null,
          organizacja ?? null,
          tytul ?? null,
          jezyk ?? null,
          lokalizacja,
          wlasciwosci,
        ],
      );
      await klient.query("release savepoint nowy_profil_api");
      return { odrzucone: false, profileId: rows[0].id, utworzony: true, dopasowanyPo: null, konflikty };
    } catch (blad) {
      await klient.query("rollback to savepoint nowy_profil_api");
      if ((blad as { code?: string }).code !== "23505" || proba > 0) throw blad;
      return identyfikujProfil(klient, tenantId, ident, atrybuty, proba + 1, opcje);
    }
  }

  // Blokada wiersza PRZED sprawdzeniem anonimizacji: równoległa anonimizacja (też
  // `for update`) albo skończyła się przed nami (widzimy jej ślad), albo czeka na nas.
  // Bez tego worker po odczekaniu dopisywałby e-mail/telefon do właśnie wyczyszczonego
  // profilu (review Codeksa R2a).
  await klient.query("select 1 from profiles where tenant_id = $1 and id = $2 for update", [tenantId, wybrany]);
  if (await zanonimizowany(klient, tenantId, wybrany)) {
    return { odrzucone: true, powod: "rodo", opis: "profil zanonimizowany (art. 17)" };
  }

  // Istniejący profil: atrybuty podane w żądaniu nadpisują (undefined = bez zmiany),
  // lokalizacja i właściwości scalane, identyfikatory tylko do pustych pól i tylko
  // niekonfliktowe. Blokada wiersza na czas zapisu.
  await klient.query(
    `update profiles set
       first_name   = case when $3::boolean then (case when $19::boolean then coalesce(nullif(first_name, ''), $4) else $4 end) else first_name end,
       last_name    = case when $5::boolean then (case when $19::boolean then coalesce(nullif(last_name, ''), $6) else $6 end) else last_name end,
       organization = case when $7::boolean then (case when $19::boolean then coalesce(nullif(organization, ''), $8) else $8 end) else organization end,
       title        = case when $9::boolean then (case when $19::boolean then coalesce(nullif(title, ''), $10) else $10 end) else title end,
       locale       = case when $11::boolean then (case when $19::boolean then coalesce(nullif(locale, ''), $12) else $12 end) else locale end,
       location     = location || $13::jsonb,
       properties   = properties || $14::jsonb,
       email        = coalesce(email, $15),
       phone        = coalesce(phone, $16),
       external_id  = coalesce(external_id, $17),
       anonymous_id = coalesce(anonymous_id, $18),
       updated_at   = now()
     where tenant_id = $1 and id = $2`,
    [
      tenantId,
      wybrany,
      imie !== undefined,
      imie ?? null,
      nazwisko !== undefined,
      nazwisko ?? null,
      organizacja !== undefined,
      organizacja ?? null,
      tytul !== undefined,
      tytul ?? null,
      jezyk !== undefined,
      jezyk ?? null,
      lokalizacja,
      wlasciwosci,
      !klientPrzegladarki && ident.email && wolno("email") ? ident.email : null,
      !klientPrzegladarki && ident.telefon && trafienia.get("phone_number") !== "wiele" && wolno("phone_number") ? ident.telefon : null,
      !klientPrzegladarki && ident.externalId && wolno("external_id") ? ident.externalId : null,
      ident.anonymousId && wolno("anonymous_id") ? ident.anonymousId : null,
      klientPrzegladarki,
    ],
  );
  return { odrzucone: false, profileId: wybrany, utworzony: false, dopasowanyPo, konflikty };
}
