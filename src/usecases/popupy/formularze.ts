import type { PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";
import { wczytajDokument } from "../../domain/email/bloki";
import {
  blokZgody,
  definicjaPubliczna,
  domyslnaZgoda,
  indeksKrokuEmail,
  kolumnyZgodnosci,
  problemyPublikacji,
  rozneDefinicje,
  schematDefinicji,
  STYL_DOMYSLNY,
  wczytajDefinicje,
  zPopupuStarego,
  type DefinicjaFormularza,
  type Problem,
  type StylFormularza,
  type TypFormularza,
} from "../../domain/formularze/model";
import { szablon, type IdSzablonu } from "../../domain/formularze/szablony";
import { nazwaFirmyTenanta } from "./zarzadzaj";

/**
 * Builder formularzy (0043): szkic z autozapisu, publikacja, duplikat, archiwum, dane
 * dla skryptu na stronie. Każde zapytanie ma predykat tenant_id (AD-2); id formularza
 * z cudzego tenanta zachowuje się jak nieistniejące.
 *
 * Dowód zgody (0041) zostaje nietknięty: publikacja porównuje tekst bloku zgody i adres
 * polityki z BIEŻĄCĄ wersją klauzuli i przy różnicy zakłada NOWĄ, niezmienną wersję
 * w tej samej transakcji, w której zapisuje definicję. Skrypt pokazuje tekst wersji z bazy.
 */

export class BladFormularza extends Error {}

const KOLUMNY = `p.id, p.tenant_id, p.name, p.headline, p.body_text, p.button_text, p.discount_code, p.rules,
  p.active, p.created_at, p.list_id, p.consent_version, p.form_type, p.draft, p.definition, p.revision,
  p.updated_at, p.published_at, p.archived_at,
  v.wording as consent_wording, v.privacy_url as consent_privacy_url`;
const WERSJA = `left join popup_consent_versions v
  on v.tenant_id = p.tenant_id and v.popup_id = p.id and v.version = p.consent_version`;

interface Wiersz {
  id: string;
  tenant_id: string;
  name: string;
  headline: string;
  body_text: string;
  button_text: string;
  discount_code: string | null;
  rules: { delay_seconds?: number } | null;
  active: boolean;
  created_at: Date;
  list_id: string | null;
  consent_version: number | null;
  form_type: TypFormularza;
  draft: unknown;
  definition: unknown;
  revision: number;
  updated_at: Date | null;
  published_at: Date | null;
  archived_at: Date | null;
  consent_wording: string | null;
  consent_privacy_url: string | null;
}

/** Opublikowana definicja: nowa z kolumny albo stary popup przełożony w locie. */
export function definicjaOpublikowana(w: Wiersz): DefinicjaFormularza | null {
  if (w.definition) return wczytajDefinicje(w.definition);
  // stary format: brak szkicu i brak definicji = popup sprzed 0043
  if (w.draft) return null;
  return zPopupuStarego(w);
}

/**
 * Styl domyślny „z danych konta”: kolor marki i krój z ostatniej kampanii zbudowanej
 * w edytorze bloków (tam operator już ustawił markę). Bez kampanii: neutralny domyślny.
 */
export async function stylDomyslnyKonta(tenantId: string): Promise<StylFormularza> {
  const { rows } = await getPool().query<{ content: string | null }>(
    `select content from campaigns where tenant_id = $1 and content is not null order by created_at desc limit 5`,
    [tenantId],
  );
  for (const r of rows) {
    const { dokument, zrodlo } = wczytajDokument(r.content);
    if (zrodlo !== "bloki") continue;
    const s = dokument.style;
    const jasny = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 160;
    };
    return {
      ...STYL_DOMYSLNY,
      kolorPrzycisku: s.kolorMarki,
      kolorTekstuPrzycisku: jasny(s.kolorMarki) ? "#111111" : "#ffffff",
      kolorTekstu: s.kolorTekstu,
      kroj: s.kroj === "systemowy" ? "strona" : s.kroj,
    };
  }
  return { ...STYL_DOMYSLNY };
}

async function wolnaNazwa(klient: PoolClient | ReturnType<typeof getPool>, tenantId: string, nazwa: string): Promise<string> {
  const baza = nazwa.trim().slice(0, 110) || "Formularz";
  const { rows } = await klient.query<{ name: string }>("select name from popups where tenant_id = $1 and (name = $2 or name like $3)", [
    tenantId,
    baza,
    `${baza.replace(/[\\%_]/g, (z) => `\\${z}`)} (%)`,
  ]);
  const zajete = new Set(rows.map((r) => r.name));
  if (!zajete.has(baza)) return baza;
  for (let i = 2; i < 500; i++) if (!zajete.has(`${baza} (${i})`)) return `${baza} (${i})`;
  return `${baza} ${Date.now()}`;
}

/**
 * Wersja 1 klauzuli nowego szkicu. Szkic nie jest na stronie, więc ta wersja niczego jeszcze
 * nie dowodzi; przy publikacji powstaje nowa, jeśli tekst się zmienił. Tekst spoza limitów
 * bazy (20-2000) zastępujemy domyślnym, żeby szkic dało się w ogóle założyć.
 */
function tekstWersji1(tekst: string | undefined, firma: string): string {
  const t = (tekst ?? "").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim();
  return t.length >= 20 && t.length <= 2000 ? t : domyslnaZgoda(firma);
}
function adresWersji1(adres: string | undefined): string | null {
  const a = (adres ?? "").trim();
  return /^https?:\/\/[^\s<>"]+$/.test(a) && a.length <= 500 ? a : null;
}

/** Nowy formularz z szablonu: szkic, wyłączony, z wersją 1 klauzuli z bloku zgody. */
export async function utworzFormularz(tenantId: string, wejscie: { nazwa: string; szablon: IdSzablonu; typ?: TypFormularza }): Promise<string> {
  const s = szablon(wejscie.szablon);
  if (!s) throw new BladFormularza("Nie ma takiego szablonu.");
  const [firma, styl] = await Promise.all([nazwaFirmyTenanta(tenantId), stylDomyslnyKonta(tenantId)]);
  let def = s.zbuduj(firma, styl);
  if (wejscie.typ && wejscie.typ !== def.typ) def = { ...def, typ: wejscie.typ, teaser: { ...def.teaser, wlaczony: wejscie.typ === "embed" ? false : def.teaser.wlaczony } };
  def = schematDefinicji.parse(def);
  const zgoda = blokZgody(def);
  const zgodnosc = kolumnyZgodnosci(def);
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const nazwa = await wolnaNazwa(klient, tenantId, wejscie.nazwa || s.nazwa);
    const { rows } = await klient.query(
      `insert into popups (tenant_id, name, headline, body_text, button_text, discount_code, rules, consent_version, form_type, draft, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, now()) returning id`,
      [tenantId, nazwa, zgodnosc.headline, zgodnosc.body_text, zgodnosc.button_text, zgodnosc.discount_code, JSON.stringify({ delay_seconds: zgodnosc.delay_seconds }), def.typ, JSON.stringify(def)],
    );
    const id = rows[0].id as string;
    await klient.query("insert into popup_consent_versions (tenant_id, popup_id, version, wording, privacy_url) values ($1, $2, 1, $3, $4)", [
      tenantId,
      id,
      tekstWersji1(zgoda?.tekst, firma),
      adresWersji1(zgoda?.adresPolityki),
    ]);
    await klient.query("commit");
    return id;
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}

export interface FormularzDoEdycji {
  id: string;
  nazwa: string;
  aktywny: boolean;
  zarchiwizowany: boolean;
  szkic: DefinicjaFormularza;
  opublikowana: DefinicjaFormularza | null;
  /** szkic różni się od wersji na stronie */
  niepublikowaneZmiany: boolean;
  revision: number;
  opublikowano: Date | null;
  zmieniono: Date | null;
  wersjaKlauzuli: number | null;
  /** formularz sprzed buildera (zapisze się w nowym formacie przy pierwszym zapisie) */
  staryFormat: boolean;
}

export async function formularzDoEdycji(tenantId: string, id: string): Promise<FormularzDoEdycji | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await getPool().query<Wiersz>(`select ${KOLUMNY} from popups p ${WERSJA} where p.tenant_id = $1 and p.id = $2`, [tenantId, id]);
  const w = rows[0];
  if (!w) return null;
  const opublikowana = definicjaOpublikowana(w);
  const staryFormat = !w.draft && !w.definition;
  let szkic = w.draft ? wczytajDefinicje(w.draft) : null;
  if (!szkic) szkic = opublikowana ?? zPopupuStarego(w);
  // dla starego formatu lista z kolumny (nie było jej w definicji)
  if (staryFormat) szkic = { ...szkic, listaId: w.list_id };
  return {
    id: w.id,
    nazwa: w.name,
    aktywny: w.active,
    zarchiwizowany: w.archived_at !== null,
    szkic,
    opublikowana,
    niepublikowaneZmiany: !w.active || rozneDefinicje(szkic, opublikowana),
    revision: w.revision,
    opublikowano: w.published_at,
    zmieniono: w.updated_at,
    wersjaKlauzuli: w.consent_version,
    staryFormat,
  };
}

export type WynikZapisuSzkicu = { ok: true; revision: number } | { ok: false; konflikt: true } | { ok: false; blad: string };

/**
 * Autozapis szkicu z optymistyczną współbieżnością: zapis przechodzi tylko na wersji,
 * którą builder wczytał. Druga karta z nowszą zmianą = konflikt (builder pokazuje baner).
 */
export async function zapiszSzkic(tenantId: string, id: string, revision: number, surowa: unknown, nazwa?: string): Promise<WynikZapisuSzkicu> {
  const def = schematDefinicji.safeParse(surowa);
  if (!def.success) return { ok: false, blad: "Nie udało się zapisać: formularz ma niepoprawny układ. Odśwież stronę." };
  const n = nazwa?.trim();
  if (n !== undefined && (n.length < 1 || n.length > 120)) return { ok: false, blad: "Nazwa formularza musi mieć od 1 do 120 znaków." };
  try {
    const { rows } = await getPool().query<{ revision: number }>(
      `update popups set draft = $4, revision = revision + 1, updated_at = now(), name = coalesce($5, name)
        where tenant_id = $1 and id = $2 and revision = $3 and archived_at is null
        returning revision`,
      [tenantId, id, revision, JSON.stringify(def.data), n ?? null],
    );
    if (rows[0]) return { ok: true, revision: rows[0].revision };
  } catch (b) {
    if ((b as { code?: string }).code === "23505") return { ok: false, blad: "Formularz o tej nazwie już istnieje." };
    throw b;
  }
  const { rows: jest } = await getPool().query("select 1 from popups where tenant_id = $1 and id = $2 and archived_at is null", [tenantId, id]);
  return jest[0] ? { ok: false, konflikt: true } : { ok: false, blad: "Nie znaleziono takiego formularza." };
}

export type WynikPublikacji =
  | { ok: true; wersjaKlauzuli: number; nowaWersja: boolean }
  | { ok: false; problemy: Problem[] }
  | { ok: false; konflikt: true }
  | { ok: false; blad: string };

/**
 * Publikacja: szkic → wersja na stronie sklepu, w jednej transakcji z wersją klauzuli.
 * Wymaga zapisanego szkicu w wersji `revision` (builder najpierw zapisuje, potem publikuje).
 */
export async function opublikujFormularz(tenantId: string, id: string, revision: number): Promise<WynikPublikacji> {
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query<Wiersz>(`select ${KOLUMNY} from popups p ${WERSJA} where p.tenant_id = $1 and p.id = $2 for update of p`, [tenantId, id]);
    const w = rows[0];
    if (!w || w.archived_at) {
      await klient.query("rollback");
      return { ok: false, blad: "Nie znaleziono takiego formularza." };
    }
    if (w.revision !== revision) {
      await klient.query("rollback");
      return { ok: false, konflikt: true };
    }
    const szkic = w.draft ? wczytajDefinicje(w.draft) : definicjaOpublikowana(w);
    if (!szkic) {
      await klient.query("rollback");
      return { ok: false, blad: "Szkic formularza jest uszkodzony. Odśwież builder." };
    }
    const def = w.draft ? szkic : { ...szkic, listaId: w.list_id };
    const problemy = problemyPublikacji(def).filter((p) => p.wymagane);
    if (problemy.length) {
      await klient.query("rollback");
      return { ok: false, problemy };
    }
    if (def.listaId) {
      const { rows: l } = await klient.query("select 1 from lists where tenant_id = $1 and id = $2", [tenantId, def.listaId]);
      if (!l[0]) {
        await klient.query("rollback");
        return { ok: false, problemy: [{ tekst: "Wybrana lista już nie istnieje. Wybierz inną.", wymagane: true }] };
      }
    }
    // Klauzula: nowa wersja tylko przy zmianie tekstu albo adresu polityki (0041).
    const zgoda = blokZgody(def)!;
    const tekst = zgoda.tekst.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim();
    const adres = zgoda.adresPolityki.trim() || null;
    let wersja = w.consent_version ?? 0;
    const nowa = w.consent_version === null || w.consent_wording !== tekst || (w.consent_privacy_url ?? null) !== adres;
    if (nowa) {
      const { rows: m } = await klient.query("select coalesce(max(version), 0)::int as v from popup_consent_versions where tenant_id = $1 and popup_id = $2", [tenantId, id]);
      wersja = m[0].v + 1;
      await klient.query("update popup_consent_versions set superseded_at = now() where tenant_id = $1 and popup_id = $2 and superseded_at is null", [tenantId, id]);
      await klient.query("insert into popup_consent_versions (tenant_id, popup_id, version, wording, privacy_url) values ($1, $2, $3, $4, $5)", [tenantId, id, wersja, tekst, adres]);
    }
    // definicja na stronę: tekst zgody znormalizowany tak samo jak wersja
    const doZapisu: DefinicjaFormularza = {
      ...def,
      kroki: def.kroki.map((k) => ({ ...k, bloki: k.bloki.map((b) => (b.typ === "zgoda" ? { ...b, tekst, adresPolityki: adres ?? "" } : b)) })),
    };
    const z = kolumnyZgodnosci(doZapisu);
    const upd = await klient.query(
      `update popups set definition = $3, draft = $3, revision = revision + 1, updated_at = now(), published_at = now(), active = true,
              form_type = $4, list_id = $5, consent_version = $6, headline = $7, body_text = $8, button_text = $9,
              discount_code = $10, rules = $11
        where tenant_id = $1 and id = $2`,
      [tenantId, id, JSON.stringify(doZapisu), doZapisu.typ, doZapisu.listaId, wersja, z.headline, z.body_text, z.button_text, z.discount_code, JSON.stringify({ delay_seconds: z.delay_seconds })],
    );
    if (upd.rowCount !== 1) throw new Error("opublikujFormularz: update nie trafił w wiersz");
    // odczyt zwrotny: na stronie będzie DOKŁADNIE ta wersja klauzuli i ta definicja
    const { rows: po } = await klient.query<Wiersz>(`select ${KOLUMNY} from popups p ${WERSJA} where p.tenant_id = $1 and p.id = $2`, [tenantId, id]);
    const opub = po[0] ? wczytajDefinicje(po[0].definition) : null;
    if (!opub || po[0].consent_wording !== tekst || (po[0].consent_privacy_url ?? null) !== adres || rozneDefinicje(opub, schematDefinicji.parse(doZapisu))) {
      throw new Error("opublikujFormularz: zapis nie zgadza się z odczytem z bazy");
    }
    await klient.query("commit");
    return { ok: true, wersjaKlauzuli: wersja, nowaWersja: nowa };
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}

/** Duplikat: nowy szkic (wyłączony) z kopią bieżącego szkicu i wersją 1 klauzuli. */
export async function duplikujFormularz(tenantId: string, id: string): Promise<string | null> {
  const f = await formularzDoEdycji(tenantId, id);
  if (!f) return null;
  const def = schematDefinicji.parse(f.szkic);
  const zgoda = blokZgody(def);
  const z = kolumnyZgodnosci(def);
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const nazwa = await wolnaNazwa(klient, tenantId, `${f.nazwa} (kopia)`);
    const { rows } = await klient.query(
      `insert into popups (tenant_id, name, headline, body_text, button_text, discount_code, rules, consent_version, form_type, draft, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, now()) returning id`,
      [tenantId, nazwa, z.headline, z.body_text, z.button_text, z.discount_code, JSON.stringify({ delay_seconds: z.delay_seconds }), def.typ, JSON.stringify(def)],
    );
    const nowy = rows[0].id as string;
    await klient.query("insert into popup_consent_versions (tenant_id, popup_id, version, wording, privacy_url) values ($1, $2, 1, $3, $4)", [
      tenantId,
      nowy,
      tekstWersji1(zgoda?.tekst, await nazwaFirmyTenanta(tenantId)),
      adresWersji1(zgoda?.adresPolityki),
    ]);
    await klient.query("commit");
    return nowy;
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}

/** Archiwum: znika z listy i ze strony sklepu. Wersje klauzuli (dowód zgody) zostają. */
export async function archiwizujFormularz(tenantId: string, id: string): Promise<boolean> {
  const w = await getPool().query("update popups set archived_at = now(), active = false where tenant_id = $1 and id = $2 and archived_at is null", [tenantId, id]);
  return (w.rowCount ?? 0) === 1;
}

// ── Skrypt na stronie sklepu ─────────────────────────────────────────────────

export interface FormularzNaStrone {
  id: string;
  nazwa: string;
  definicja: ReturnType<typeof definicjaPubliczna>;
  zgoda: { tekst: string; url: string | null; wersja: number };
  krokEmail: number;
}

/**
 * Włączone formularze tenanta w wersji OPUBLIKOWANEJ, z tekstem bieżącej wersji klauzuli
 * z bazy. Formularz bez klauzuli albo z uszkodzoną definicją nie trafia na stronę.
 */
export async function formularzeNaStrone(tenantId: string): Promise<FormularzNaStrone[]> {
  const { rows } = await getPool().query<Wiersz>(
    `select ${KOLUMNY}
       from popups p
       join popup_consent_versions v
         on v.tenant_id = p.tenant_id and v.popup_id = p.id and v.version = p.consent_version
      where p.tenant_id = $1 and p.active and p.archived_at is null
      order by p.created_at desc
      limit 20`,
    [tenantId],
  );
  const wynik: FormularzNaStrone[] = [];
  for (const w of rows) {
    const def = definicjaOpublikowana(w);
    if (!def || !w.consent_wording || w.consent_version === null) continue;
    const krokEmail = indeksKrokuEmail(def);
    if (krokEmail < 0) continue;
    wynik.push({
      id: w.id,
      nazwa: w.name,
      definicja: definicjaPubliczna(def, { tekst: w.consent_wording, adres: w.consent_privacy_url }),
      zgoda: { tekst: w.consent_wording, url: w.consent_privacy_url, wersja: w.consent_version },
      krokEmail,
    });
  }
  return wynik;
}

/** Opublikowana definicja + nazwa i tenant dla publicznych tras (zgłoszenie, krok, wyświetlenie). */
export async function formularzPubliczny(popupId: string): Promise<{ id: string; tenantId: string; nazwa: string; definicja: DefinicjaFormularza; wiersz: Wiersz } | null> {
  const { rows } = await getPool().query<Wiersz>(`select ${KOLUMNY} from popups p ${WERSJA} where p.id = $1 and p.active and p.archived_at is null`, [popupId]);
  const w = rows[0];
  if (!w) return null;
  const def = definicjaOpublikowana(w);
  if (!def) return null;
  return { id: w.id, tenantId: w.tenant_id, nazwa: w.name, definicja: def, wiersz: w };
}

export type StatusFormularza = "na_zywo" | "wstrzymany" | "szkic";

export interface PozycjaListy {
  id: string;
  nazwa: string;
  typ: TypFormularza;
  status: StatusFormularza;
  niepublikowaneZmiany: boolean;
  /** definicja do miniatury: szkic (to operator ostatnio widział w builderze) */
  podglad: DefinicjaFormularza | null;
  lista: string | null;
  zmieniono: Date | null;
  utworzono: Date;
}

/** Biblioteka formularzy (bez archiwum), najnowsze na górze. */
export async function listaFormularzy(tenantId: string): Promise<PozycjaListy[]> {
  const { rows } = await getPool().query<Wiersz & { lista: string | null }>(
    `select ${KOLUMNY}, l.name as lista
       from popups p ${WERSJA}
       left join lists l on l.tenant_id = p.tenant_id and l.id = p.list_id
      where p.tenant_id = $1 and p.archived_at is null
      order by coalesce(p.updated_at, p.created_at) desc`,
    [tenantId],
  );
  return rows.map((w) => {
    const opublikowana = definicjaOpublikowana(w);
    const szkic = (w.draft ? wczytajDefinicje(w.draft) : null) ?? opublikowana;
    const status: StatusFormularza = w.active ? "na_zywo" : opublikowana ? "wstrzymany" : "szkic";
    return {
      id: w.id,
      nazwa: w.name,
      typ: szkic?.typ ?? w.form_type,
      status,
      niepublikowaneZmiany: status !== "szkic" && Boolean(w.draft) && rozneDefinicje(szkic, opublikowana),
      podglad: szkic,
      lista: w.lista,
      zmieniono: w.updated_at,
      utworzono: w.created_at,
    };
  });
}
