import { getPool } from "../../adapters/db/pool";
import {
  sanityzujTekst,
  schematDokumentu,
  wczytajDokument,
  type Blok,
  type DokumentMaila,
} from "../../domain/email/bloki";
import { renderujDokument } from "./render-blokow";

/**
 * Zapis treści kampanii z edytora bloków i z kroku „Temat i nadawca".
 *
 * Co się zapisuje: `campaigns.content = content || { html, wersjaSchematu, style, bloki }`.
 * `html` to wyrenderowane bloki i DOKŁADNIE to pole czyta silnik wysyłki, akceptacja
 * klienta i wysyłka testowa. Pozostałe klucze w `content` (jeśli kiedyś dojdą) zostają.
 *
 * Reguły przeniesione 1:1 z poprzedniego `zapiszTrescAkcja`:
 *  - po starcie wysyłki (sending, paused, sent, cancelled) treść jest zamrożona —
 *    warunek powtórzony w UPDATE, bo między odczytem a zapisem worker mógł ruszyć,
 *  - zmiana tematu, preheadera albo HTML-a kampanii zaakceptowanej lub czekającej na
 *    akceptację cofa ją do szkicu i wygasza niezdecydowane linki akceptacji (FR41),
 *  - zapis bez faktycznej zmiany NIE unieważnia rundy akceptacji.
 *
 * DŁUG: SQL w use-case zamiast w repozytoria.ts (AD-18) — jak w wysylka-konfiguracja.
 * Każde zapytanie ma predykat tenant_id (AD-2).
 */

export const STATUSY_ZAMROZONE = ["sending", "paused", "sent", "cancelled"] as const;

/** JSON z posortowanymi kluczami: jsonb w Postgresie zmienia kolejność kluczy obiektu. */
export function kanonicznyJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(kanonicznyJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${kanonicznyJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

type Wynik<T = object> = ({ ok: true } & T) | { ok: false; blad: string };

function oczysc(blok: Blok): Blok {
  switch (blok.typ) {
    case "tekst":
    case "stopka":
      return { ...blok, html: sanityzujTekst(blok.html) };
    case "kolumny":
      return {
        ...blok,
        lewa: { ...blok.lewa, html: sanityzujTekst(blok.lewa.html) },
        prawa: { ...blok.prawa, html: sanityzujTekst(blok.prawa.html) },
      };
    default:
      return blok;
  }
}

/**
 * Walidacja dokumentu z przeglądarki: schemat zod + sanityzacja tekstów sformatowanych.
 * Dokument przychodzi jako JSON z formularza albo z wywołania akcji, więc jest wejściem
 * nieufnym tak samo jak każde pole formularza.
 */
export function przygotujDokument(surowy: unknown): Wynik<{ dokument: DokumentMaila }> {
  let dane = surowy;
  if (typeof surowy === "string") {
    if (surowy.length > 1_500_000) return { ok: false, blad: "Treść jest za duża do zapisania (limit 1,5 MB)." };
    try {
      dane = JSON.parse(surowy);
    } catch {
      return { ok: false, blad: "Treść edytora przyszła uszkodzona — odśwież stronę i spróbuj ponownie." };
    }
  }
  const wynik = schematDokumentu.safeParse(dane);
  if (!wynik.success) {
    const pierwszy = wynik.error.issues[0];
    return {
      ok: false,
      blad: `Treść nie przeszła walidacji (${pierwszy?.path.join(".") || "dokument"}: ${pierwszy?.message ?? "błąd"}).`,
    };
  }
  const ids = new Set<string>();
  for (const b of wynik.data.bloki) {
    if (ids.has(b.id)) return { ok: false, blad: "Dwa bloki mają ten sam identyfikator — odśwież edytor." };
    ids.add(b.id);
  }
  const oczyszczony = { ...wynik.data, bloki: wynik.data.bloki.map(oczysc) };
  // Sanityzacja potrafi WYDŁUŻYĆ tekst (& → &amp;), więc wynik też musi spełniać schemat —
  // inaczej zapis przejdzie, a ponowne otwarcie uzna dokument za uszkodzony (review Codeksa, P2).
  if (!schematDokumentu.safeParse(oczyszczony).success) {
    return { ok: false, blad: "Tekst po zabezpieczeniu znaków specjalnych jest za długi — skróć najdłuższy blok tekstu." };
  }
  return { ok: true, dokument: oczyszczony };
}

export interface ZmianyTresci {
  dokument?: DokumentMaila;
  temat?: string | null;
  preheader?: string | null;
  nazwa?: string;
  /**
   * Autozapis: zapis wyłącznie, gdy kampania JEST szkicem — warunek w samym UPDATE, więc
   * autozapis nie cofnie po cichu akceptacji kampanii, która w międzyczasie poszła do klienta.
   */
  tylkoSzkic?: boolean;
}

export async function zapiszTrescKampanii(
  tenantId: string,
  campaignId: string,
  zmiany: ZmianyTresci,
): Promise<Wynik<{ cofnieta: boolean; planZdjety: boolean; uwagi: string[]; html: string }>> {
  // Odczyt, render i zapis w JEDNEJ transakcji z blokadą wiersza (review Codeksa, P1):
  // bez niej autozapis tematu w jednej zakładce i zapis bloków w drugiej czytały ten sam
  // stan A, a późniejszy UPDATE przywracał bloki A na miejsce świeżo zapisanych B.
  const klient = await getPool().connect();
  try {
    await klient.query("begin");
    const wynik = await zapiszWTransakcji(klient, tenantId, campaignId, zmiany);
    if (!wynik.ok) {
      await klient.query("rollback");
      return wynik;
    }
    await klient.query("commit");
    return wynik;
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

type Klient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

async function zapiszWTransakcji(
  pool: Klient,
  tenantId: string,
  campaignId: string,
  zmiany: ZmianyTresci,
): Promise<Wynik<{ cofnieta: boolean; planZdjety: boolean; uwagi: string[]; html: string }>> {
  const { rows } = await pool.query(
    `select status, name, subject, preheader, content, scheduled_at from campaigns
      where tenant_id = $1 and id = $2 for update`,
    [tenantId, campaignId],
  );
  const kampania = rows[0];
  if (!kampania) return { ok: false, blad: "Nie znaleziono kampanii." };
  const statusPrzed = String(kampania.status);
  if ((STATUSY_ZAMROZONE as readonly string[]).includes(statusPrzed)) {
    return {
      ok: false,
      blad: "Kampania po starcie wysyłki jest zamknięta - odbiorcy dostali to, co zaakceptował klient, i treść karty musi się z tym zgadzać.",
    };
  }
  if (zmiany.tylkoSzkic && statusPrzed !== "draft") {
    return { ok: false, blad: "Kampania nie jest już szkicem (poszła do akceptacji) — autozapis wstrzymany. Zapisz ręcznie." };
  }

  const nazwa = zmiany.nazwa !== undefined ? zmiany.nazwa.trim() : String(kampania.name);
  if (!nazwa) return { ok: false, blad: "Nazwa robocza nie może być pusta." };
  if (nazwa.length > 200) return { ok: false, blad: "Nazwa robocza jest za długa (maks. 200 znaków)." };
  const temat = zmiany.temat !== undefined ? zmiany.temat?.trim() || null : kampania.subject;
  const preheader = zmiany.preheader !== undefined ? zmiany.preheader?.trim() || null : kampania.preheader;
  if (temat && temat.length > 250) return { ok: false, blad: "Temat jest za długi (maks. 250 znaków)." };
  if (preheader && preheader.length > 250) return { ok: false, blad: "Preheader jest za długi (maks. 250 znaków)." };

  // Źródło bloków: nowy dokument z edytora albo ten, który już leży w bazie. Zmiana
  // samego preheadera też przerenderowuje HTML, bo preheader jest częścią HTML-a.
  const obecna = wczytajDokument(kampania.content);
  const dokument = zmiany.dokument ?? (obecna.zrodlo === "bloki" ? obecna.dokument : null);
  let nowaTresc: Record<string, unknown> | null = null;
  let uwagi: string[] = [];
  const htmlPrzed = String((kampania.content as any)?.html ?? "");
  let html = htmlPrzed;
  if (dokument) {
    const render = renderujDokument(dokument, { preheader });
    uwagi = render.uwagi;
    html = render.html;
    nowaTresc = {
      html,
      wersjaSchematu: dokument.wersjaSchematu,
      style: dokument.style,
      bloki: dokument.bloki,
    };
  }
  const zmianaWysylanego = html !== htmlPrzed || temat !== kampania.subject || preheader !== kampania.preheader;
  // B4 przy planie: lista kontrolna sprawdzana jest przy USTAWIANIU terminu, a dispatcher
  // sprawdza potem tylko akceptację. Zmiana treści po zaplanowaniu zdejmuje plan — nowy
  // termin przejdzie bramkę listy kontrolnej od nowa (review Codeksa, P1).
  const planZdjety = zmianaWysylanego && kampania.scheduled_at !== null;

  const zapis = await pool.query(
    `update campaigns set name = $3, subject = $4, preheader = $5,
            content = case when $6::jsonb is null then content else coalesce(content, '{}'::jsonb) || $6::jsonb end,
            status = case when status in ('approved', 'awaiting_approval') and $7::boolean then 'draft' else status end,
            scheduled_at = case when $8::boolean then null else scheduled_at end,
            updated_at = now()
      where tenant_id = $1 and id = $2 and status not in ('sending', 'paused', 'sent', 'cancelled')
      returning status`,
    [tenantId, campaignId, nazwa, temat, preheader, nowaTresc ? JSON.stringify(nowaTresc) : null, zmianaWysylanego, planZdjety],
  );
  if (zapis.rowCount === 0) {
    return { ok: false, blad: "Kampania w międzyczasie weszła w wysyłkę - treść nie została zmieniona." };
  }
  const cofnieta = ["approved", "awaiting_approval"].includes(statusPrzed) && zapis.rows[0].status === "draft";
  if (cofnieta) {
    // stare, niezdecydowane linki akceptacji dotyczyły innej treści
    await pool.query(
      `update campaign_approvals set expires_at = now()
        where tenant_id = $1 and campaign_id = $2 and decided_at is null and expires_at > now()`,
      [tenantId, campaignId],
    );
  }

  // Odczyt zwrotny ZAPISANEGO rekordu (AGENTS.md, pkt 3): silnik wysyła `content.html`,
  // więc sprawdzamy, że w bazie leży dokładnie to, co wyrenderowaliśmy.
  const { rows: poZapisie } = await pool.query(
    `select name, subject, preheader, content->>'html' as html, content->'bloki' as bloki
       from campaigns where tenant_id = $1 and id = $2`,
    [tenantId, campaignId],
  );
  const zapisana = poZapisie[0];
  if (
    !zapisana ||
    zapisana.name !== nazwa ||
    (zapisana.html ?? "") !== html ||
    zapisana.subject !== temat ||
    zapisana.preheader !== preheader ||
    (nowaTresc && kanonicznyJson(zapisana.bloki) !== kanonicznyJson(nowaTresc.bloki))
  ) {
    return { ok: false, blad: "Zapis treści nie zgadza się z odczytem z bazy. Odśwież stronę i sprawdź treść przed wysyłką." };
  }
  return { ok: true, cofnieta, planZdjety, uwagi, html };
}
