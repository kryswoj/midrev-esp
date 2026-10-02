import { z } from "zod";
import { getPool } from "../../adapters/db/pool";

// Zarzadzanie popupami z panelu i odczyt konfiguracji dla skryptu on-site (Epik F).
// SQL lokalnie zamiast w repozytoria.ts z tego samego powodu co w zglos-popup.ts:
// praca rownolegla, wspolne pliki nietykalne; po scaleniu do przeniesienia (AD-18).

export interface Popup {
  id: string;
  tenant_id: string;
  name: string;
  headline: string;
  body_text: string;
  button_text: string;
  discount_code: string | null;
  rules: { delay_seconds?: number };
  active: boolean;
  created_at: Date;
  /** lista docelowa (0041); null = bez listy */
  list_id: string | null;
  /** biezaca wersja klauzuli zgody (0041); null = popup bez klauzuli, nie wyswietla sie */
  consent_version: number | null;
  /** tekst biezacej wersji klauzuli: DOKLADNIE to widzi osoba przy polu wyboru */
  consent_wording: string | null;
  consent_privacy_url: string | null;
}

export interface WierszPopupu extends Popup {
  /** ile zgloszen przyszlo przez ten popup, liczone z events 'popup.submitted' */
  zgloszen: number;
  /** nazwa listy docelowej albo null */
  lista: string | null;
}

// kolumny popupu z biezaca wersja klauzuli (lewe zlaczenie: popup sprzed 0041 bez wersji)
const KOLUMNY = `p.id, p.tenant_id, p.name, p.headline, p.body_text, p.button_text,
       p.discount_code, p.rules, p.active, p.created_at, p.list_id, p.consent_version,
       v.wording as consent_wording, v.privacy_url as consent_privacy_url`;
const ZLACZENIE_WERSJI = `left join popup_consent_versions v
       on v.tenant_id = p.tenant_id and v.popup_id = p.id and v.version = p.consent_version`;

export async function popupyTenanta(tenantId: string): Promise<WierszPopupu[]> {
  const { rows } = await getPool().query<WierszPopupu>(
    `select ${KOLUMNY}, l.name as lista,
            (select count(*)::int from events e
              where e.tenant_id = p.tenant_id
                and e.event_type = 'popup.submitted'
                and e.payload->>'popup_id' = p.id::text) as zgloszen
       from popups p
       ${ZLACZENIE_WERSJI}
       left join lists l on l.tenant_id = p.tenant_id and l.id = p.list_id
      where p.tenant_id = $1
      order by p.created_at desc`,
    [tenantId],
  );
  return rows;
}

// ── Klauzula zgody (0041) ─────────────────────────────────────────────────────

export const MIN_KLAUZULA = 20;
export const MAX_KLAUZULA = 2000;

/** Domyslna klauzula po polsku z nazwa firmy z danych konta (nadawca albo nazwa konta). */
export function domyslnaKlauzula(firma: string): string {
  const nazwa = firma.trim() || "tego sklepu";
  return `Zapisuję się na newsletter ${nazwa} i zgadzam się na otrzymywanie wiadomości e-mail z ofertami i nowościami. Zgodę mogę wycofać w każdej chwili, klikając link w stopce wiadomości.`;
}

/** Nazwa firmy do klauzuli: firma nadawcy z ustawien wysylki, inaczej nazwa konta. */
export async function nazwaFirmyTenanta(tenantId: string): Promise<string> {
  const { rows } = await getPool().query(
    "select coalesce(nullif(btrim(sender_company_name), ''), name) as firma from tenants where id = $1",
    [tenantId],
  );
  return rows[0]?.firma ?? "";
}

/** Tekst klauzuli: bez znakow sterujacych (poza nowa linia), z przycietymi brzegami. */
const schematKlauzuli = z
  .string()
  .transform((s) => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim())
  .pipe(z.string().min(MIN_KLAUZULA).max(MAX_KLAUZULA));

/** Adres polityki prywatnosci: pusty = brak; inaczej http(s) bez spacji, do 500 znakow. */
const schematAdresuPolityki = z
  .string()
  .trim()
  .max(500)
  .transform((s) => (s === "" ? null : s))
  .pipe(z.string().regex(/^https?:\/\/[^\s<>"]+$/).nullable());

export interface WersjaKlauzuli {
  id: string;
  version: number;
  wording: string;
  privacy_url: string | null;
  created_at: Date;
  superseded_at: Date | null;
}

export async function wersjeKlauzuli(tenantId: string, popupId: string): Promise<WersjaKlauzuli[]> {
  const { rows } = await getPool().query<WersjaKlauzuli>(
    `select id, version, wording, privacy_url, created_at, superseded_at
       from popup_consent_versions where tenant_id = $1 and popup_id = $2
      order by version desc`,
    [tenantId, popupId],
  );
  return rows;
}

type Klient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

/** Lista docelowa musi nalezec do tenanta (FK zlozony i tak to wymusi; tu czytelny blad). */
async function sprawdzListe(klient: Klient, tenantId: string, listId: string | null): Promise<void> {
  if (!listId) return;
  const { rows } = await klient.query("select 1 from lists where tenant_id = $1 and id = $2", [tenantId, listId]);
  if (!rows[0]) throw new BladPopupu("Wybrana lista nie istnieje.");
}

export class BladPopupu extends Error {}

// Tresci popupu trafiaja do skryptu ladowanego na cudzych stronach, wiec dlugosc
// jest czescia kontraktu: bez limitow jedna sciana tekstu robi z popupu
// nieuzywalny, wielosetkilobajtowy skrypt (znalezisko review).
const schematPopupu = z.object({
  name: z.string().trim().min(1).max(120),
  headline: z.string().trim().min(1).max(200),
  bodyText: z.string().trim().min(1).max(1000),
  buttonText: z.string().trim().min(1).max(80),
  discountCode: z.string().trim().min(1).max(60).nullable(),
  delaySeconds: z.number(),
  /** brak = domyslna klauzula z nazwa firmy (testy, stare wywolania) */
  consentWording: schematKlauzuli.optional(),
  privacyUrl: schematAdresuPolityki.optional(),
  listId: z.string().uuid().nullable().optional(),
});

export async function utworzPopup(
  tenantId: string,
  daneWejsciowe: {
    name: string;
    headline: string;
    bodyText: string;
    buttonText: string;
    discountCode: string | null;
    delaySeconds: number;
    consentWording?: string;
    privacyUrl?: string;
    listId?: string | null;
  },
): Promise<string> {
  const dane = schematPopupu.parse(daneWejsciowe);
  // delay ograniczony do sensownego zakresu juz tutaj, bo trafia do setTimeout
  // w przegladarce odbiorcy: ujemny albo absurdalnie dlugi psuje popup po cichu
  const delay = Math.min(Math.max(Math.round(dane.delaySeconds), 0), 600);
  const wording = dane.consentWording ?? domyslnaKlauzula(await nazwaFirmyTenanta(tenantId));
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    await sprawdzListe(klient, tenantId, dane.listId ?? null);
    // popup i wersja 1 klauzuli w jednej transakcji (FK popups -> wersja jest odroczony)
    const { rows } = await klient.query(
      `insert into popups (tenant_id, name, headline, body_text, button_text, discount_code, rules, list_id, consent_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1)
       returning id`,
      [
        tenantId,
        dane.name,
        dane.headline,
        dane.bodyText,
        dane.buttonText,
        dane.discountCode,
        JSON.stringify({ delay_seconds: delay }),
        dane.listId ?? null,
      ],
    );
    const id = rows[0].id as string;
    await klient.query(
      "insert into popup_consent_versions (tenant_id, popup_id, version, wording, privacy_url) values ($1, $2, 1, $3, $4)",
      [tenantId, id, wording, dane.privacyUrl ?? null],
    );
    await klient.query("commit");
    return id;
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

export type WynikZmianyKlauzuli =
  | { ok: true; wersja: number; nowaWersja: boolean }
  | { ok: false; blad: string };

/**
 * Zmiana klauzuli zgody i listy docelowej istniejacego popupu. Zmiana tekstu albo adresu
 * polityki = NOWA wersja (stara zostaje z superseded_at, bo wskazuja na nia zapisane zgody).
 * Ten sam tekst = bez nowej wersji. Wiersz popupu blokowany (`for update`), zeby dwie karty
 * nie nadaly tego samego numeru wersji. Predykat tenant_id w kazdym zapytaniu (AD-2).
 */
export async function zmienKlauzule(
  tenantId: string,
  popupId: string,
  wejscie: { consentWording: string; privacyUrl: string; listId: string | null },
): Promise<WynikZmianyKlauzuli> {
  const t = schematKlauzuli.safeParse(wejscie.consentWording);
  if (!t.success) return { ok: false, blad: `Klauzula musi mieć od ${MIN_KLAUZULA} do ${MAX_KLAUZULA} znaków.` };
  const u = schematAdresuPolityki.safeParse(wejscie.privacyUrl);
  if (!u.success) return { ok: false, blad: "Adres polityki prywatności musi zaczynać się od https:// albo http:// (albo zostaw puste pole)." };
  const l = z.string().uuid().nullable().safeParse(wejscie.listId);
  if (!l.success) return { ok: false, blad: "Wybrana lista nie istnieje." };
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query(
      `select p.consent_version, v.wording, v.privacy_url
         from popups p ${ZLACZENIE_WERSJI}
        where p.tenant_id = $1 and p.id = $2 for update of p`,
      [tenantId, popupId],
    );
    if (!rows[0]) {
      await klient.query("rollback");
      return { ok: false, blad: "Nie znaleziono takiego formularza." };
    }
    try {
      await sprawdzListe(klient, tenantId, l.data);
    } catch (b) {
      await klient.query("rollback");
      if (b instanceof BladPopupu) return { ok: false, blad: b.message };
      throw b;
    }
    const biezaca: number | null = rows[0].consent_version;
    const bezZmian = biezaca !== null && rows[0].wording === t.data && (rows[0].privacy_url ?? null) === u.data;
    let wersja = biezaca ?? 0;
    if (!bezZmian) {
      const { rows: max } = await klient.query(
        "select coalesce(max(version), 0)::int as v from popup_consent_versions where tenant_id = $1 and popup_id = $2",
        [tenantId, popupId],
      );
      wersja = max[0].v + 1;
      await klient.query(
        "update popup_consent_versions set superseded_at = now() where tenant_id = $1 and popup_id = $2 and superseded_at is null",
        [tenantId, popupId],
      );
      await klient.query(
        "insert into popup_consent_versions (tenant_id, popup_id, version, wording, privacy_url) values ($1, $2, $3, $4, $5)",
        [tenantId, popupId, wersja, t.data, u.data],
      );
    }
    const w = await klient.query(
      "update popups set consent_version = $3, list_id = $4 where tenant_id = $1 and id = $2",
      [tenantId, popupId, wersja, l.data],
    );
    if ((w.rowCount ?? 0) !== 1) throw new Error("zmienKlauzule: update popupu nie trafil w wiersz");
    // odczyt zwrotny: biezaca wersja ma DOKLADNIE zapisany tekst
    const { rows: po } = await klient.query(
      `select v.wording, v.privacy_url, p.list_id from popups p ${ZLACZENIE_WERSJI} where p.tenant_id = $1 and p.id = $2`,
      [tenantId, popupId],
    );
    if (po[0]?.wording !== t.data || (po[0]?.privacy_url ?? null) !== u.data || (po[0]?.list_id ?? null) !== l.data) {
      throw new Error("zmienKlauzule: zapis nie zgadza się z odczytem z bazy");
    }
    await klient.query("commit");
    return { ok: true, wersja, nowaWersja: !bezZmian };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

/**
 * Wlacza albo wylacza popup. Predykat tenant_id, zeby id z cudzego tenanta nic
 * nie zrobilo. Zwraca, czy COKOLWIEK sie zmienilo: wywolujacy nie ma prawa
 * raportowac sukcesu po UPDATE, ktory nie trafil w zaden wiersz (znalezisko
 * review; ten sam blad co klamiace liczniki backfilli).
 */
export async function ustawAktywnosc(
  tenantId: string,
  popupId: string,
  aktywny: boolean,
): Promise<boolean> {
  const wynik = await getPool().query(
    "update popups set active = $3 where tenant_id = $1 and id = $2",
    [tenantId, popupId, aktywny],
  );
  return (wynik.rowCount ?? 0) > 0;
}

/**
 * Najnowszy aktywny popup tenanta - to jego konfiguracje skrypt on-site wstrzykuje
 * na strone sklepu. "Najnowszy" jest swiadomym rozstrzygnieciem: gdy operator
 * wlaczy dwa popupy naraz, wygrywa ostatnio utworzony, zamiast losowego.
 */
export async function aktywnyPopup(tenantId: string): Promise<Popup | null> {
  // Popup bez klauzuli (utworzony przez stary kod po rollbacku) NIE jest wyswietlany:
  // formularz zbierajacy zgode bez pokazanego tekstu to dokladnie blad, ktory 0041 naprawia.
  const { rows } = await getPool().query<Popup>(
    `select ${KOLUMNY}
       from popups p
       join popup_consent_versions v
         on v.tenant_id = p.tenant_id and v.popup_id = p.id and v.version = p.consent_version
      where p.tenant_id = $1 and p.active
      order by p.created_at desc
      limit 1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

/**
 * Konfiguracja popupu dla publicznego GET. Tylko aktywne popupy i BEZ kodu
 * rabatowego: kod dostaje sie dopiero po zostawieniu adresu, inaczej kazdy
 * moglby go wyciagnac z odpowiedzi bez zapisu.
 */
export async function popupPubliczny(popupId: string): Promise<Omit<Popup, "discount_code"> | null> {
  const { rows } = await getPool().query<Popup>(
    `select p.id, p.tenant_id, p.name, p.headline, p.body_text, p.button_text, p.rules, p.active, p.created_at,
            p.list_id, p.consent_version, v.wording as consent_wording, v.privacy_url as consent_privacy_url
       from popups p
       join popup_consent_versions v
         on v.tenant_id = p.tenant_id and v.popup_id = p.id and v.version = p.consent_version
      where p.id = $1 and p.active`,
    [popupId],
  );
  return rows[0] ?? null;
}
