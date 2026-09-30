import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { getPool } from "../../adapters/db/pool";
import { adresSledzenia, config } from "../../config";
import { rozpoznajObraz, type FormatObrazu } from "./format";
import { czytajPlikObrazu, sciezkaObrazu, usunPlikObrazu, zapiszPlikObrazu } from "./pliki";

/**
 * Biblioteka obrazów tenanta (audyt #14, FR33).
 *
 * Kontrakt adresu: `${TRACKING_URL ?? APP_URL}/o/{token}.{ext}` (adresSledzenia). Token to 32 losowe bajty (base64url),
 * jedyny klucz trasy publicznej. Maila otwiera odbiorca bez sesji, więc trasa nie może
 * pytać o tenanta — pyta o token, a tenant wynika z odnalezionego wiersza.
 *
 * Usunięcie obrazu nie może zepsuć maili, które już wyszły albo zaraz wyjdą: obraz użyty
 * w kampanii poza szkicem albo w automatyzacji jest zablokowany do usunięcia, a powód
 * wraca do panelu i stoi przy przycisku.
 */

export const MAKS_ROZMIAR_OBRAZU = 5 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WidokObrazu {
  id: string;
  /** absolutny adres do maila (domena śledzenia: TRACKING_URL, bez niej APP_URL) */
  url: string;
  /** ścieżka względna do miniatury w panelu — działa pod każdym adresem panelu */
  sciezka: string;
  nazwa: string;
  mime: string;
  rozmiar: number;
  szerokosc: number;
  wysokosc: number;
  wgranoO: string;
  /** null = wolno usunąć; tekst = powód blokady, pokazywany przy przycisku */
  blokadaUsuniecia: string | null;
  /** w ilu szkicach obraz jest wstawiony (usunięcie wolno, ale obraz z nich zniknie) */
  szkice: number;
}

export function sciezkaPubliczna(token: string, ext: string): string {
  return `/o/${token}.${ext}`;
}

export function adresObrazu(token: string, ext: string): string {
  return `${adresSledzenia()}${sciezkaPubliczna(token, ext)}`;
}

/** Nazwa do wyświetlenia: sama nazwa bazowa, bezpieczne znaki, ograniczona długość. */
export function odkazNazweObrazu(surowa: string | null | undefined): string {
  const baza = String(surowa ?? "").split(/[\\/]/).pop() ?? "";
  const czysta = baza.replace(/[^\p{L}\p{N}._ -]/gu, "").trim().slice(0, 120);
  return czysta || "obraz";
}

function powodBlokady(kampanie: string[], automatyzacje: string[], weFlow: boolean): string | null {
  if (kampanie.length) {
    const reszta = kampanie.length > 1 ? ` i ${kampanie.length - 1} ${kampanie.length - 1 === 1 ? "innej" : "innych"}` : "";
    return `Nie można usunąć: obraz jest w kampanii „${kampanie[0]}"${reszta}, która czeka na klienta, wyszła albo wychodzi. Usunięcie zepsułoby maila u odbiorców.`;
  }
  if (automatyzacje.length || weFlow) {
    const nazwa = automatyzacje[0] ? ` „${automatyzacje[0]}"` : "";
    return `Nie można usunąć: obraz jest w mailu automatyzacji${nazwa}, która może go jeszcze wysłać.`;
  }
  return null;
}

// Użycie liczone z TREŚCI (campaigns.content, journeys.content, wersje flow), a nie z osobnej
// tabeli powiązań: treść jest jedynym źródłem prawdy o tym, co wyjdzie w mailu, a tabela
// powiązań rozjechałaby się z nią przy pierwszym zapisie, który o niej zapomni.
const UZYCIE = `
  -- szkic ZAPLANOWANY też jest „w drodze" (review Codeksa r2): po akceptacji dispatcher
  -- wyśle go o zaplanowanej porze, więc obraz nie może z niego zniknąć
  coalesce((select array_agg(c.name order by c.updated_at desc) from campaigns c
     where c.tenant_id = i.tenant_id and (c.status <> 'draft' or c.scheduled_at is not null)
       and strpos(c.content::text, i.token) > 0), '{}') as kampanie,
  (select count(*)::int from campaigns c
     where c.tenant_id = i.tenant_id and c.status = 'draft' and c.scheduled_at is null
       and strpos(c.content::text, i.token) > 0) as szkice,
  coalesce((select array_agg(j.name order by j.name) from journeys j
     where j.tenant_id = i.tenant_id and strpos(coalesce(j.content::text, ''), i.token) > 0), '{}') as automatyzacje,
  (exists (select 1 from flows f where f.tenant_id = i.tenant_id
            and strpos(coalesce(f.draft::text, '') || coalesce(f.live::text, ''), i.token) > 0)
   or exists (select 1 from flow_versions v where v.tenant_id = i.tenant_id
            and strpos(coalesce(v.emails::text, '') || coalesce(v.definition::text, ''), i.token) > 0)) as we_flow`;

function naWidok(w: any): WidokObrazu {
  return {
    id: w.id,
    url: adresObrazu(w.token, w.ext),
    sciezka: sciezkaPubliczna(w.token, w.ext),
    nazwa: w.original_name,
    mime: w.mime,
    rozmiar: Number(w.size_bytes),
    szerokosc: Number(w.width),
    wysokosc: Number(w.height),
    wgranoO: new Date(w.uploaded_at).toISOString(),
    blokadaUsuniecia: powodBlokady(w.kampanie ?? [], w.automatyzacje ?? [], Boolean(w.we_flow)),
    szkice: Number(w.szkice ?? 0),
  };
}

export type WynikWgrania =
  | { ok: true; obraz: WidokObrazu }
  | { ok: false; status: number; blad: string };

/**
 * Wgranie obrazu. Kolejność: rozpoznanie po bajtach → zapis pliku (atomowy) → wiersz w
 * bazie → odczyt zwrotny zapisanego wiersza. Gdy baza odmówi, plik jest kasowany — nie ma
 * stanu „plik na dysku bez wiersza, do którego nikt nie trafi".
 */
export async function wgrajObraz(
  tenantId: string,
  wej: { bajty: Uint8Array; nazwa: string; autor: string | null; kiedy: Date },
): Promise<WynikWgrania> {
  if (!UUID.test(tenantId)) return { ok: false, status: 404, blad: "Nie znaleziono sklepu." };
  if (wej.bajty.byteLength === 0) return { ok: false, status: 400, blad: "Plik jest pusty." };
  if (wej.bajty.byteLength > MAKS_ROZMIAR_OBRAZU) return { ok: false, status: 413, blad: "Obraz jest większy niż 5 MB. Zmniejsz go (do maila wystarczy 1200 px szerokości)." };
  const rozpoznany = rozpoznajObraz(wej.bajty);
  if (!rozpoznany) {
    return {
      ok: false,
      status: 415,
      blad: "To nie jest obsługiwany obraz. Przyjmujemy PNG, JPEG, GIF i WebP. SVG nie przyjmujemy: Gmail i Outlook go nie pokażą, a plik może zawierać skrypt.",
    };
  }

  const id = uuidv7();
  const token = randomBytes(32).toString("base64url");
  const nazwa = odkazNazweObrazu(wej.nazwa);
  const sciezka = sciezkaObrazu(tenantId, id, rozpoznany.format);
  await zapiszPlikObrazu(sciezka, wej.bajty);
  try {
    await getPool().query(
      `insert into images (id, tenant_id, token, mime, ext, size_bytes, width, height, original_name, uploaded_by, uploaded_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, tenantId, token, rozpoznany.mime, rozpoznany.format, wej.bajty.byteLength, rozpoznany.szerokosc, rozpoznany.wysokosc, nazwa, wej.autor, wej.kiedy],
    );
  } catch (blad) {
    await usunPlikObrazu(sciezka);
    throw blad;
  }

  // odczyt zwrotny ZAPISANEGO wiersza, nie danych wejściowych
  const { rows } = await getPool().query(
    `select i.*, ${UZYCIE} from images i where i.tenant_id = $1 and i.id = $2`,
    [tenantId, id],
  );
  const zapisany = rows[0];
  if (!zapisany || zapisany.token !== token || Number(zapisany.size_bytes) !== wej.bajty.byteLength || zapisany.ext !== rozpoznany.format) {
    throw new Error("Obraz: zapisany wiersz nie zgadza się z wgranym plikiem");
  }
  return { ok: true, obraz: naWidok(zapisany) };
}

/** Obrazy tenanta, najnowsze pierwsze, z informacją o tym, czy wolno je usunąć. */
export async function obrazyTenanta(tenantId: string, limit = 200): Promise<WidokObrazu[]> {
  const { rows } = await getPool().query(
    `select i.*, ${UZYCIE} from images i where i.tenant_id = $1
      order by i.uploaded_at desc, i.id desc limit $2`,
    [tenantId, limit],
  );
  return rows.map(naWidok);
}

export type WynikUsuniecia = { ok: true; szkice: number } | { ok: false; status: number; blad: string };

/**
 * Usunięcie obrazu. Sprawdzenie użycia i DELETE w jednej transakcji, z blokadą wierszy
 * kampanii zawierających obraz (FOR SHARE): kampania, która właśnie przechodzi ze szkicu
 * do akceptacji, poczeka na nasz commit i nie zdąży „wyjść" z obrazem, który za chwilę
 * zniknie. Plik z dysku znika dopiero po commicie — odwrotna kolejność zostawiłaby wiersz
 * wskazujący na brak pliku przy wycofanej transakcji.
 */
export async function usunObraz(tenantId: string, imageId: string): Promise<WynikUsuniecia> {
  if (!UUID.test(tenantId) || !UUID.test(imageId)) return { ok: false, status: 404, blad: "Nie znaleziono obrazu." };
  const klient = await getPool().connect();
  let doUsuniecia: { ext: string } | null = null;
  let szkice = 0;
  try {
    await klient.query("begin");
    const { rows: obraz } = await klient.query(
      "select token, ext from images where tenant_id = $1 and id = $2 for update",
      [tenantId, imageId],
    );
    if (!obraz[0]) {
      await klient.query("rollback");
      return { ok: false, status: 404, blad: "Nie znaleziono obrazu — mógł zostać już usunięty." };
    }
    await klient.query(
      "select id from campaigns where tenant_id = $1 and strpos(content::text, $2) > 0 for share",
      [tenantId, obraz[0].token],
    );
    const { rows } = await klient.query(`select ${UZYCIE} from images i where i.tenant_id = $1 and i.id = $2`, [tenantId, imageId]);
    const powod = powodBlokady(rows[0].kampanie ?? [], rows[0].automatyzacje ?? [], Boolean(rows[0].we_flow));
    if (powod) {
      await klient.query("rollback");
      return { ok: false, status: 409, blad: powod };
    }
    szkice = Number(rows[0].szkice ?? 0);
    const usuniete = await klient.query("delete from images where tenant_id = $1 and id = $2", [tenantId, imageId]);
    if (usuniete.rowCount !== 1) throw new Error("Obraz: DELETE nie usunął dokładnie jednego wiersza");
    await klient.query("commit");
    doUsuniecia = { ext: obraz[0].ext };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
  await usunPlikObrazu(sciezkaObrazu(tenantId, imageId, doUsuniecia.ext));
  return { ok: true, szkice };
}

/** Obraz dla trasy publicznej. Rozszerzenie w adresie musi się zgadzać z zapisanym. */
export async function plikPoTokenie(
  token: string,
  ext: string,
): Promise<{ bajty: Buffer; mime: string } | null> {
  if (!TOKEN.test(token)) return null;
  const { rows } = await getPool().query(
    "select tenant_id, id, ext, mime from images where token = $1",
    [token],
  );
  const w = rows[0];
  if (!w || w.ext !== ext) return null;
  const bajty = await czytajPlikObrazu(sciezkaObrazu(w.tenant_id, w.id, w.ext));
  if (!bajty) return null;
  return { bajty, mime: w.mime };
}

/**
 * Tokeny obrazów z NASZEJ biblioteki wstawione w HTML maila (adresy `…/o/…` na domenie
 * śledzenia ALBO na APP_URL). Oba hosty, bo szkic sprzed ustawienia TRACKING_URL ma
 * obrazy pod adresem panelu, a lista kontrolna i blokada usunięcia muszą je dalej widzieć.
 * Obce adresy (CDN sklepu) nie są naszą sprawą i tu nie trafiają.
 */
export function tokenyObrazowWHtml(html: string): string[] {
  const hosty = [...new Set([adresSledzenia(), config().APP_URL])].map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const wzorzec = new RegExp(`(?:${hosty.join("|")})/o/([A-Za-z0-9_-]{43})\\.(?:png|jpg|gif|webp)`, "g");
  return [...new Set([...html.matchAll(wzorzec)].map((m) => m[1]))];
}

/** Ile obrazów z biblioteki wstawionych w HTML nie istnieje (usunięte albo z cudzego sklepu). */
export async function brakujaceObrazy(tenantId: string, html: string): Promise<number> {
  const tokeny = tokenyObrazowWHtml(html);
  if (!tokeny.length) return 0;
  const { rows } = await getPool().query(
    "select token from images where tenant_id = $1 and token = any($2::text[])",
    [tenantId, tokeny],
  );
  return tokeny.length - rows.length;
}

export type { FormatObrazu };
