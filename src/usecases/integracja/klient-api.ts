import { createHash } from "node:crypto";
import { z } from "zod";
import { getPool } from "../../adapters/db/pool";
import { jestWykluczonyGlobalnie } from "../../adapters/db/wykluczenia";
import { odczytajTokenMx } from "../../adapters/token-mx";
import { dodajZadanie } from "../../jobs/kolejka";
import { wyslijAlert } from "../../jobs/alerty";
import { sprawdzNazweMetryki, sprawdzWlasciwosci, MAKS_UNIQUE_ID } from "../../domain/zdarzenia/limity";
import { telefonE164 } from "../../domain/zdarzenia/telefon";
import {
  czyNazwaZastrzezona,
  MAKS_WLASNYCH_METRYK_STRONY,
  METRYKI_STRONY,
  STANDARDOWE_METRYKI_STRONY,
} from "../../domain/integracja/metryki-strony";
import type { AtrybutyProfilu, IdentyfikatoryProfilu } from "../api/zdarzenie-api";
import { identyfikujProfil } from "../zdarzenia/identyfikacja";
import { metrykaPoKluczu, LimitMetryk } from "../zdarzenia/metryki";
import { zapewnijPartycjeMiesiaca } from "../zdarzenia/partycje";
import { BladZdarzenia, zapiszZdarzenie } from "../zdarzenia/zapisz-zdarzenie";
import { uzupelnijKatalogZPrzegladarki } from "../katalog/katalog";
import { zapiszKoszykZPrzegladarki } from "../katalog/koszyki";
import type { KluczStrony } from "./klucz-strony";

/**
 * Client API zgodne z Klaviyo (`/client/events`, `/client/profiles`, `/client/subscriptions`
 * z `?company_id=<klucz strony>`), plan 2.1 / 6.
 *
 * Granica bezpieczeństwa: klucz strony jest publiczny, więc te trasy:
 *   - NIGDY nie zwracają danych (202 bez treści albo błąd JSON:API bez szczegółów konta),
 *   - nie przyjmują wewnętrznego `id` profilu (osobę wskazuje e-mail/telefon/external_id,
 *     anonimowy identyfikator przeglądarki albo podpisany token `_mx` z kliknięcia w mail),
 *   - nie nadpisują danych istniejącego profilu (identyfikujProfil, tryb „klient”),
 *   - nie zapisują zgody marketingowej bez dowodu: subskrypcja wymaga tekstu zgody
 *     identycznego z klauzulą ustawioną w panelu (tekst do rejestru bierzemy z bazy),
 *   - nie wysyłają metryk zastrzeżonych (Submitted Form, Received Email...),
 *   - gość bez żadnego identyfikatora poza anonimowym id, którego profil nie istnieje,
 *     nie zostawia śladu w bazie (podgląd na żywo w pamięci procesu i tyle).
 *
 * Zdarzenia i identyfikacja idą jak `/api/events`: raw_events (channel 'client') + job,
 * 202 po zapisie surowego żądania (AD-4). Subskrypcja: synchronicznie, jak popup.
 */

export const RODZAJ_JOBA_KLIENTA = "przetworz_zdarzenie_klienta";

const tekst = (maks: number) => z.string().max(maks);

const schematAtrybutow = z
  .object({
    email: tekst(320).nullish(),
    phone_number: tekst(40).nullish(),
    external_id: tekst(255).nullish(),
    anonymous_id: tekst(255).nullish(),
    // token z kliknięcia w mail: `_kx` (nazwa Klaviyo, skrypty przepięte z klaviyo.js) albo `_mx`
    _kx: tekst(200).nullish(),
    _mx: tekst(200).nullish(),
    first_name: tekst(255).nullish(),
    last_name: tekst(255).nullish(),
    organization: tekst(255).nullish(),
    title: tekst(255).nullish(),
    locale: tekst(64).nullish(),
    location: z.record(z.string(), z.unknown()).nullish(),
    properties: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

const schematProfiluWZdarzeniu = z.object({
  data: z.object({ type: z.literal("profile"), attributes: schematAtrybutow }).passthrough(),
});

const schematZdarzenia = z.object({
  data: z
    .object({
      type: z.literal("event"),
      attributes: z
        .object({
          properties: z.record(z.string(), z.unknown()).nullish(),
          // czas zgłoszony przez przeglądarkę NIE jest czasem zdarzenia (AD-39): przyjmujemy
          // pole dla zgodności z klaviyo.js, ale liczy się czas serwera
          time: z.string().max(64).nullish(),
          value: z.number().nullish(),
          value_currency: z.string().regex(/^[A-Za-z]{3}$/, "kod waluty ISO 4217").nullish(),
          unique_id: z.string().max(MAKS_UNIQUE_ID).nullish(),
          metric: z.object({
            data: z.object({ type: z.literal("metric"), attributes: z.object({ name: z.string() }).passthrough() }).passthrough(),
          }),
          profile: schematProfiluWZdarzeniu,
        })
        .passthrough(),
    })
    .passthrough(),
});

const schematProfilu = z.object({
  data: z.object({ type: z.literal("profile"), attributes: schematAtrybutow }).passthrough(),
});

const schematSubskrypcji = z.object({
  data: z
    .object({
      type: z.literal("subscription"),
      attributes: z
        .object({
          custom_source: tekst(120).nullish(),
          // rozszerzenie MidRev: brzmienie zgody, które osoba widziała przy polu wyboru
          consent_text: z.string().max(4000).nullish(),
          profile: schematProfiluWZdarzeniu,
        })
        .passthrough(),
      relationships: z
        .object({
          list: z.object({ data: z.object({ type: z.literal("list"), id: z.string().max(64) }).passthrough() }).nullish(),
        })
        .passthrough()
        .nullish(),
    })
    .passthrough(),
});

export interface BladKlienta {
  wskaznik: string;
  opis: string;
  /** kod JSON:API (domyślnie `invalid`) */
  kod?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const pusty = (v: string | null | undefined) => (v === undefined || v === null || v.trim() === "" ? null : v.trim());

function bledyZod(e: z.ZodError): BladKlienta[] {
  return e.issues.slice(0, 10).map((i) => ({
    wskaznik: "/" + i.path.map((x) => String(x).replace(/~/g, "~0").replace(/\//g, "~1")).join("/"),
    opis: i.message,
  }));
}

export interface ProfilKlienta {
  identyfikatory: IdentyfikatoryProfilu;
  /** token z linku (nieodczytany: jawny tekst nie trafia do bazy) */
  token: string | null;
  atrybuty: AtrybutyProfilu;
}

function profilZAtrybutow(at: z.infer<typeof schematAtrybutow>, wskaznik: string, bledy: BladKlienta[]): ProfilKlienta {
  const email = pusty(at.email ?? null);
  if (email && (!EMAIL.test(email) || email.length > 254)) bledy.push({ wskaznik: `${wskaznik}/email`, opis: "niepoprawny adres e-mail" });
  const telSurowy = pusty(at.phone_number ?? null);
  const telefon = telSurowy ? telefonE164(telSurowy) : null;
  if (telSurowy && !telefon) bledy.push({ wskaznik: `${wskaznik}/phone_number`, opis: "numer telefonu musi dać się zapisać w E.164" });
  for (const [nazwa, obiekt] of [["properties", at.properties], ["location", at.location]] as const) {
    const n = obiekt ? sprawdzWlasciwosci(obiekt) : null;
    if (n) bledy.push({ wskaznik: `${wskaznik}/${nazwa}${n.wskaznik}`, opis: n.opis });
  }
  return {
    identyfikatory: {
      id: null,
      email,
      telefon,
      externalId: pusty(at.external_id ?? null),
      anonymousId: pusty(at.anonymous_id ?? null),
    },
    token: pusty(at._mx ?? null) ?? pusty(at._kx ?? null),
    atrybuty: {
      imie: at.first_name,
      nazwisko: at.last_name,
      organizacja: at.organization,
      tytul: at.title,
      jezyk: at.locale,
      lokalizacja: at.location ?? undefined,
      wlasciwosci: at.properties ?? undefined,
    },
  };
}

function bezIdentyfikatora(p: ProfilKlienta): boolean {
  const i = p.identyfikatory;
  return !i.email && !i.telefon && !i.externalId && !i.anonymousId && !p.token;
}

export interface ZdarzenieKlienta {
  nazwaMetryki: string;
  profil: ProfilKlienta;
  properties: Record<string, unknown>;
  wartosc: number | null;
  waluta: string | null;
  uniqueId: string | null;
}

export function zwalidujZdarzenieKlienta(cialo: unknown): { ok: true; dane: ZdarzenieKlienta } | { ok: false; bledy: BladKlienta[] } {
  const p = schematZdarzenia.safeParse(cialo);
  if (!p.success) return { ok: false, bledy: bledyZod(p.error) };
  const a = p.data.data.attributes;
  const bledy: BladKlienta[] = [];
  const nazwa = a.metric.data.attributes.name;
  const bladNazwy = sprawdzNazweMetryki(nazwa);
  if (bladNazwy) bledy.push({ wskaznik: "/data/attributes/metric/data/attributes/name", opis: bladNazwy });
  else if (czyNazwaZastrzezona(nazwa)) {
    bledy.push({ wskaznik: "/data/attributes/metric/data/attributes/name", opis: "ta nazwa metryki jest zastrzeżona dla systemu", kod: "invalid" });
  }
  const properties = a.properties ?? {};
  const n = sprawdzWlasciwosci(properties);
  if (n) bledy.push({ wskaznik: `/data/attributes/properties${n.wskaznik}`, opis: n.opis });
  if (a.value !== undefined && a.value !== null && !Number.isFinite(a.value)) {
    bledy.push({ wskaznik: "/data/attributes/value", opis: "wartość musi być liczbą" });
  }
  const profil = profilZAtrybutow(a.profile.data.attributes, "/data/attributes/profile/data/attributes", bledy);
  if (bezIdentyfikatora(profil)) {
    bledy.push({
      wskaznik: "/data/attributes/profile/data/attributes",
      opis: "profil wymaga identyfikatora: email, phone_number, external_id, anonymous_id albo _kx",
    });
  }
  if (bledy.length) return { ok: false, bledy };
  return {
    ok: true,
    dane: {
      nazwaMetryki: nazwa.trim(),
      profil,
      properties,
      wartosc: a.value ?? null,
      waluta: a.value_currency ? a.value_currency.toUpperCase() : null,
      uniqueId: pusty(a.unique_id ?? null),
    },
  };
}

export function zwalidujProfilKlienta(cialo: unknown): { ok: true; dane: ProfilKlienta } | { ok: false; bledy: BladKlienta[] } {
  const p = schematProfilu.safeParse(cialo);
  if (!p.success) return { ok: false, bledy: bledyZod(p.error) };
  const bledy: BladKlienta[] = [];
  const profil = profilZAtrybutow(p.data.data.attributes, "/data/attributes", bledy);
  if (bezIdentyfikatora(profil)) {
    bledy.push({ wskaznik: "/data/attributes", opis: "profil wymaga identyfikatora: email, phone_number, external_id, anonymous_id albo _kx" });
  }
  if (bledy.length) return { ok: false, bledy };
  return { ok: true, dane: profil };
}

export interface SubskrypcjaKlienta {
  email: string;
  tekstZgody: string;
  listId: string | null;
  zrodlo: string | null;
  atrybuty: AtrybutyProfilu;
}

/** Brzmienie zgody do porównania: bez różnic w białych znakach i cudzysłowach typograficznych. */
export function normalizujTekstZgody(t: string): string {
  return t
    .normalize("NFC")
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function zwalidujSubskrypcjeKlienta(cialo: unknown): { ok: true; dane: SubskrypcjaKlienta } | { ok: false; bledy: BladKlienta[] } {
  const p = schematSubskrypcji.safeParse(cialo);
  if (!p.success) return { ok: false, bledy: bledyZod(p.error) };
  const a = p.data.data.attributes;
  const bledy: BladKlienta[] = [];
  const profil = profilZAtrybutow(a.profile.data.attributes, "/data/attributes/profile/data/attributes", bledy);
  if (!profil.identyfikatory.email) {
    bledy.push({
      wskaznik: "/data/attributes/profile/data/attributes/email",
      opis: "subskrypcja wymaga adresu e-mail (SMS nie jest obsługiwany)",
    });
  }
  const tekstZgody = pusty(a.consent_text ?? null);
  if (!tekstZgody) {
    bledy.push({
      wskaznik: "/data/attributes/consent_text",
      opis: "brak treści zgody: zapis na newsletter wymaga brzmienia zgody, które osoba zaakceptowała",
      kod: "consent_required",
    });
  }
  const listId = pusty(p.data.data.relationships?.list?.data.id ?? null);
  if (listId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(listId)) {
    bledy.push({ wskaznik: "/data/relationships/list/data/id", opis: "nieznana lista" });
  }
  if (bledy.length) return { ok: false, bledy };
  return {
    ok: true,
    dane: { email: profil.identyfikatory.email!, tekstZgody: tekstZgody!, listId, zrodlo: pusty(a.custom_source ?? null), atrybuty: profil.atrybuty },
  };
}

// ── Faza 1: przyjęcie (trasa) ─────────────────────────────────────────────────────

function sha256(t: string): string {
  return createHash("sha256").update(t, "utf8").digest("hex");
}

/** Ciało bez tokenu `_kx`/`_mx`: token działa jak poświadczenie (90 dni), więc nie leży w bazie. */
function bezTokenu(cialo: unknown, sciezka: "event" | "profile"): unknown {
  const kopia = JSON.parse(JSON.stringify(cialo));
  const at = sciezka === "event" ? kopia?.data?.attributes?.profile?.data?.attributes : kopia?.data?.attributes;
  if (at && typeof at === "object") {
    delete at._kx;
    delete at._mx;
  }
  return kopia;
}

export type WynikPrzyjeciaKlienta =
  | { status: "przyjete"; nowe: boolean }
  | { status: "anonimowe" }
  | { status: "odrzucone"; bledy: BladKlienta[] };

/**
 * Faza 1 dla `/client/events` (rodzaj `event`) i `/client/profiles` (rodzaj `profile`).
 * Token `_mx` jest odczytywany TU (bez bazy): zły, wygasły albo z innego konta = traktowany
 * jak brak, a do bazy idzie wyłącznie wynik (id profilu), nigdy sam token.
 */
export async function przyjmijZadanieKlienta(
  klucz: KluczStrony,
  rodzaj: "event" | "profile",
  cialo: unknown,
  przyjeto = new Date(),
): Promise<WynikPrzyjeciaKlienta> {
  const w = rodzaj === "event" ? zwalidujZdarzenieKlienta(cialo) : zwalidujProfilKlienta(cialo);
  if (!w.ok) return { status: "odrzucone", bledy: w.bledy };
  const profil = rodzaj === "event" ? (w.dane as ZdarzenieKlienta).profil : (w.dane as ProfilKlienta);
  const token = profil.token ? odczytajTokenMx(profil.token, przyjeto.getTime()) : null;
  const profilZTokenu = token && token.tenantId === klucz.tenantId ? token.profileId : null;
  const i = profil.identyfikatory;

  const pool = getPool();
  if (!profilZTokenu && !i.email && !i.telefon && !i.externalId) {
    // Sam anonimowy identyfikator przeglądarki: zapis tylko, gdy przeglądarka jest już
    // powiązana z profilem (wcześniejsze identify). Nieznany gość = brak śladu w bazie.
    if (!i.anonymousId) return { status: "anonimowe" };
    const { rows } = await pool.query("select 1 from profiles where tenant_id = $1 and anonymous_id = $2 limit 1", [klucz.tenantId, i.anonymousId]);
    if (!rows[0]) return { status: "anonimowe" };
  }

  const surowe = JSON.stringify(cialo);
  const identyfikator = profilZTokenu ?? i.email?.toLowerCase() ?? i.telefon ?? i.externalId ?? i.anonymousId ?? "";
  const dane = rodzaj === "event" ? (w.dane as ZdarzenieKlienta) : null;
  const kluczIdem = dane?.uniqueId
    ? `client:${sha256(JSON.stringify(["client", dane.nazwaMetryki, identyfikator, dane.uniqueId]))}`
    : `client:req:${sha256(surowe + "|" + (profilZTokenu ?? ""))}:${Math.floor(przyjeto.getTime() / 1000)}`;

  const klient = await pool.connect();
  try {
    await klient.query("begin");
    const { rows } = await klient.query<{ id: string }>(
      `insert into raw_events (tenant_id, store_id, source, idempotency_key, payload, received_at, channel)
       values ($1, null, 'client', $2, $3::jsonb, $4, 'client')
       on conflict (tenant_id, store_id, source, idempotency_key) do nothing
       returning id`,
      [
        klucz.tenantId,
        kluczIdem,
        JSON.stringify({ body: bezTokenu(cialo, rodzaj), meta: { rodzaj, site_key: klucz.id, ...(profilZTokenu ? { profil_z_tokenu: profilZTokenu } : {}) } }),
        przyjeto,
      ],
    );
    const id = rows[0]?.id ?? null;
    if (id) await dodajZadanie(klucz.tenantId, RODZAJ_JOBA_KLIENTA, { rawEventId: id }, { przez: klient });
    await klient.query("commit");
    return { status: "przyjete", nowe: id !== null };
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}

// ── Faza 2: worker ────────────────────────────────────────────────────────────────

export interface WynikPrzetworzeniaKlienta {
  status: "zapisane" | "duplikat" | "zidentyfikowane" | "pominiete" | "odrzucone";
  eventId?: string;
  profileId?: string;
  powod?: string;
}

/** Definicja metryki przeglądarki: standardowe (4) jako wbudowane, reszta własne. */
function definicjaMetryki(nazwa: string) {
  const standard = STANDARDOWE_METRYKI_STRONY.has(nazwa);
  return { integracja: "midrev" as const, nazwa, mozeWyzwalac: true, ukryta: false, wbudowana: standard };
}

export async function przetworzZadanieKlienta(tenantId: string, rawEventId: string): Promise<WynikPrzetworzeniaKlienta> {
  const pool = getPool();
  const { rows: podglad } = await pool.query<{ received_at: Date }>(
    "select received_at from raw_events where tenant_id = $1 and id = $2 and channel = 'client' and processed_at is null",
    [tenantId, rawEventId],
  );
  if (!podglad[0]) return { status: "pominiete" };
  await zapewnijPartycjeMiesiaca(podglad[0].received_at).catch(() => {
    /* zapiszZdarzenie założy ją w transakcji */
  });

  const klient = await pool.connect();
  let alert: string | null = null;
  try {
    await klient.query("begin");
    const { rows } = await klient.query<{
      payload: { body?: unknown; anonimizowano?: boolean; meta?: { rodzaj?: string; profil_z_tokenu?: string; site_key?: string } };
      received_at: Date;
      processed_at: Date | null;
    }>(
      "select payload, received_at, processed_at from raw_events where tenant_id = $1 and id = $2 and channel = 'client' for update",
      [tenantId, rawEventId],
    );
    const r = rows[0];
    if (!r || r.processed_at) {
      await klient.query("rollback");
      return { status: "pominiete" };
    }
    const zakoncz = async (blad: string | null, meta: Record<string, unknown> = {}, zaslep = false) => {
      await klient.query(
        `update raw_events set processed_at = now(), process_error = $3,
                payload = case when $5::boolean then jsonb_build_object('anonimizowano', true)
                               else jsonb_set(payload, '{meta}', coalesce(payload -> 'meta', '{}'::jsonb) || $4::jsonb) end
          where tenant_id = $1 and id = $2`,
        [tenantId, rawEventId, blad, JSON.stringify(meta), zaslep],
      );
    };
    if (r.payload?.anonimizowano) {
      await zakoncz("anonimizowano");
      await klient.query("commit");
      return { status: "pominiete", powod: "anonimizowano" };
    }
    const rodzaj = r.payload?.meta?.rodzaj === "profile" ? "profile" : "event";
    const w = rodzaj === "event" ? zwalidujZdarzenieKlienta(r.payload?.body) : zwalidujProfilKlienta(r.payload?.body);
    // Ciało bez tokenu: identyfikator z tokenu jest w meta. Brak innych identyfikatorów
    // przy profilu z tokenu nie jest błędem (walidacja wymaga identyfikatora w ciele).
    const zTokenu = r.payload?.meta?.profil_z_tokenu ?? null;
    if (!w.ok && !(zTokenu && w.bledy.every((b) => b.opis.startsWith("profil wymaga identyfikatora")))) {
      const opis = w.bledy.map((b) => `${b.wskaznik}: ${b.opis}`).join("; ").slice(0, 500);
      await zakoncz(`niepoprawne:${opis}`);
      await klient.query("commit");
      return { status: "odrzucone", powod: opis };
    }
    const cialo = r.payload?.body as Record<string, unknown>;
    const dane: ZdarzenieKlienta | null =
      rodzaj === "event" ? (w.ok ? (w.dane as ZdarzenieKlienta) : zdarzenieBezIdentyfikatora(cialo)) : null;
    const profil: ProfilKlienta = dane ? dane.profil : w.ok ? (w.dane as ProfilKlienta) : profilBezIdentyfikatora(cialo);
    const ident: IdentyfikatoryProfilu = { ...profil.identyfikatory, id: zTokenu };

    const wynikIdent = await identyfikujProfil(klient, tenantId, ident, profil.atrybuty, 0, { tryb: "klient" });
    if (wynikIdent.odrzucone) {
      await zakoncz(
        wynikIdent.powod === "rodo" ? "rodo:nagrobek" : wynikIdent.powod === "nie_znaleziono" ? "profil:nie_znaleziono" : `niepoprawne:${wynikIdent.opis}`.slice(0, 500),
        {},
        wynikIdent.powod === "rodo",
      );
      await klient.query("commit");
      return { status: "odrzucone", powod: wynikIdent.powod };
    }
    // konflikt anonimowego id (wspólny komputer, kilka osób w jednej przeglądarce) to norma;
    // alert tylko przy konflikcie twardego identyfikatora
    const twarde = wynikIdent.konflikty.filter((k) => k.rodzaj !== "anonymous_id");
    if (twarde.length) {
      alert = `konflikt identyfikatorów profilu w zdarzeniu ze strony (raw_event ${rawEventId}): zdarzenie przypisane do ${wynikIdent.profileId}, ` +
        twarde.map((k) => `${k.rodzaj} wskazuje ${k.innyProfil}`).join(", ");
    }

    if (!dane) {
      await zakoncz(null, { profile_id: wynikIdent.profileId });
      await klient.query("commit");
      return { status: "zidentyfikowane", profileId: wynikIdent.profileId };
    }

    // Własne metryki przeglądarki mają sufit (MAKS_WLASNYCH_METRYK_STRONY): ktoś z kluczem
    // publicznym nie może zużyć limitu 200 metryk konta wymyślonymi nazwami.
    const def = definicjaMetryki(dane.nazwaMetryki);
    const istniejaca = await metrykaPoKluczu(klient, tenantId, def, { utworz: false });
    if (istniejaca && istniejaca.wbudowana && !STANDARDOWE_METRYKI_STRONY.has(istniejaca.nazwa)) {
      await zakoncz("niepoprawne:metryka zastrzeżona");
      await klient.query("commit");
      return { status: "odrzucone", powod: "metryka zastrzeżona" };
    }
    if (!istniejaca && !def.wbudowana) {
      const { rows: ile } = await klient.query<{ n: number }>(
        "select count(*)::int as n from metrics where tenant_id = $1 and integration_key = 'midrev' and not builtin",
        [tenantId],
      );
      if (ile[0].n >= MAKS_WLASNYCH_METRYK_STRONY) {
        await zakoncz(`niepoprawne:limit ${MAKS_WLASNYCH_METRYK_STRONY} własnych metryk ze strony`);
        await klient.query("commit");
        alert = `strona wysyła nowe nazwy metryk ponad limit ${MAKS_WLASNYCH_METRYK_STRONY} (raw_event ${rawEventId}); zdarzenie odrzucone`;
        return { status: "odrzucone", powod: "limit metryk" };
      }
    }

    const properties =
      dane.wartosc !== null && dane.properties.$value === undefined ? { ...dane.properties, $value: dane.wartosc } : dane.properties;
    let wynik;
    try {
      await klient.query("savepoint zdarzenie_klienta");
      wynik = await zapiszZdarzenie(klient, {
        tenantId,
        metryka: def,
        profileId: wynikIdent.profileId,
        // AD-39: czas przeglądarki nie jest wiarygodny; zdarzenie dzieje się „teraz”
        occurredAt: r.received_at,
        ingestedAt: r.received_at,
        uniqueId: dane.uniqueId,
        properties,
        valueCurrency: dane.waluta,
        source: "client",
      });
      await klient.query("release savepoint zdarzenie_klienta");
    } catch (b) {
      if (!(b instanceof BladZdarzenia) && !(b instanceof LimitMetryk)) throw b;
      await klient.query("rollback to savepoint zdarzenie_klienta");
      await zakoncz(`niepoprawne:${b.message}`.slice(0, 500), { profile_id: wynikIdent.profileId });
      await klient.query("commit");
      return { status: "odrzucone", powod: b.message };
    }

    // Katalog z przeglądarki (gdy sklep nie ma feedu): best effort, błąd nie zatrzymuje zdarzenia
    if (!wynik.duplikat && dane.nazwaMetryki === METRYKI_STRONY.ogladanyProdukt) {
      try {
        await klient.query("savepoint katalog_klienta");
        await uzupelnijKatalogZPrzegladarki(klient, tenantId, properties, dane.waluta);
        await klient.query("release savepoint katalog_klienta");
      } catch (b) {
        await klient.query("rollback to savepoint katalog_klienta");
        console.warn(`[client] katalog z Viewed Product pominięty: ${b instanceof Error ? b.message : "błąd"}`);
      }
    }

    // Stan koszyka (plan integracji E.5): Added to Cart / Started Checkout, best effort
    if (!wynik.duplikat && (dane.nazwaMetryki === METRYKI_STRONY.dodanoDoKoszyka || dane.nazwaMetryki === METRYKI_STRONY.rozpoczetoZamowienie)) {
      try {
        await klient.query("savepoint koszyk_klienta");
        const { rows: k } = await klient.query<{ link_domains: string[]; currency: string }>(
          `select coalesce(s.link_domains, '{}') as link_domains, t.currency
             from tenants t left join site_keys s on s.tenant_id = t.id and s.id = $2
            where t.id = $1`,
          [tenantId, r.payload?.meta?.site_key ?? ""],
        );
        await zapiszKoszykZPrzegladarki(klient, {
          tenantId,
          profileId: wynikIdent.profileId,
          anonymousId: profil.identyfikatory.anonymousId,
          metryka: dane.nazwaMetryki,
          properties,
          waluta: dane.waluta ?? k[0]?.currency ?? "PLN",
          domeny: k[0]?.link_domains ?? [],
          kiedy: r.received_at,
        });
        await klient.query("release savepoint koszyk_klienta");
      } catch (b) {
        await klient.query("rollback to savepoint koszyk_klienta");
        console.warn(`[client] stan koszyka pominięty: ${b instanceof Error ? b.message : "błąd"}`);
      }
    }

    await zakoncz(null, { profile_id: wynikIdent.profileId, event_id: wynik.id, duplikat: wynik.duplikat });
    await klient.query("commit");
    return { status: wynik.duplikat ? "duplikat" : "zapisane", eventId: wynik.id, profileId: wynikIdent.profileId };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
    if (alert) await wyslijAlert(alert, { poziom: "uwaga", tenantId });
  }
}

/** Ciało zdarzenia, które przeszło fazę 1 tylko dzięki tokenowi (bez innych identyfikatorów). */
function zdarzenieBezIdentyfikatora(cialo: Record<string, unknown>): ZdarzenieKlienta {
  const kopia = JSON.parse(JSON.stringify(cialo));
  const at = kopia?.data?.attributes?.profile?.data?.attributes;
  if (at && typeof at === "object") at.anonymous_id = at.anonymous_id || "__token__";
  const w = zwalidujZdarzenieKlienta(kopia);
  if (!w.ok) throw new BladZdarzenia("zdarzenie niepoprawne");
  w.dane.profil.identyfikatory.anonymousId = null;
  return w.dane;
}

function profilBezIdentyfikatora(cialo: Record<string, unknown>): ProfilKlienta {
  const kopia = JSON.parse(JSON.stringify(cialo));
  const at = kopia?.data?.attributes;
  if (at && typeof at === "object") at.anonymous_id = at.anonymous_id || "__token__";
  const w = zwalidujProfilKlienta(kopia);
  if (!w.ok) throw new BladZdarzenia("profil niepoprawny");
  w.dane.identyfikatory.anonymousId = null;
  return w.dane;
}

// ── Subskrypcja (synchronicznie) ──────────────────────────────────────────────────

export type WynikSubskrypcji =
  | { status: "przyjete" }
  | { status: "odrzucone"; bledy: BladKlienta[] };

/**
 * `POST /client/subscriptions`. Zgoda marketingowa z publicznego internetu, więc:
 *   - klucz strony musi mieć ustawioną klauzulę zgody (panel), inaczej 400,
 *   - tekst z żądania musi być TĄ klauzulą (po normalizacji białych znaków); do rejestru
 *     zgód idzie tekst z bazy, nie z żądania (nikt nie zatruje historii zgód),
 *   - adres wykluczony (globalnie albo w tym sklepie) nie dostaje nowej zgody ani listy;
 *     odpowiedź i tak 202, żeby nie zdradzać, kto jest na liście wykluczeń,
 *   - lista spoza tego konta = 400 (AD-40).
 * Dopisanie do listy ze źródłem `formularz:strona-…` uruchamia wyzwalacz „dołączył do listy”.
 */
export async function przyjmijSubskrypcjeKlienta(
  klucz: KluczStrony,
  cialo: unknown,
  kontekst: { origin: string | null },
): Promise<WynikSubskrypcji> {
  const w = zwalidujSubskrypcjeKlienta(cialo);
  if (!w.ok) return { status: "odrzucone", bledy: w.bledy };
  const d = w.dane;
  if (!klucz.tekstZgody) {
    return {
      status: "odrzucone",
      bledy: [{ wskaznik: "/data/attributes/consent_text", opis: "zapis z tej strony jest wyłączony: w panelu nie ustawiono treści zgody", kod: "consent_not_configured" }],
    };
  }
  if (normalizujTekstZgody(d.tekstZgody) !== normalizujTekstZgody(klucz.tekstZgody)) {
    return {
      status: "odrzucone",
      bledy: [{ wskaznik: "/data/attributes/consent_text", opis: "treść zgody różni się od klauzuli ustawionej w panelu", kod: "consent_mismatch" }],
    };
  }
  const pool = getPool();
  const klient = await pool.connect();
  try {
    await klient.query("begin");
    if (d.listId) {
      const { rows } = await klient.query("select 1 from lists where tenant_id = $1 and id = $2", [klucz.tenantId, d.listId]);
      if (!rows[0]) {
        await klient.query("rollback");
        return { status: "odrzucone", bledy: [{ wskaznik: "/data/relationships/list/data/id", opis: "nieznana lista", kod: "not_found" }] };
      }
    }
    const ident = await identyfikujProfil(
      klient,
      klucz.tenantId,
      { id: null, email: d.email, telefon: null, externalId: null, anonymousId: null },
      { imie: d.atrybuty.imie, nazwisko: d.atrybuty.nazwisko, wlasciwosci: d.atrybuty.wlasciwosci },
      0,
      { tryb: "klient" },
    );
    if (ident.odrzucone) {
      // nagrobek RODO / złe właściwości: bez zapisu, odpowiedź jak przy sukcesie dla nagrobka
      await klient.query("rollback");
      if (ident.powod === "niepoprawne_wlasciwosci") {
        return { status: "odrzucone", bledy: [{ wskaznik: "/data/attributes/profile/data/attributes/properties", opis: ident.opis }] };
      }
      return { status: "przyjete" };
    }
    const { rows: wykl } = await klient.query<{ sklepowe: boolean }>(
      `select coalesce((select ts.action = 'suppressed' from tenant_suppressions ts
                         where ts.tenant_id = $1 and lower(btrim(ts.email)) = lower(btrim($2))
                         order by ts.occurred_at desc limit 1), false) as sklepowe`,
      [klucz.tenantId, d.email],
    );
    const wykluczony = wykl[0].sklepowe || (await jestWykluczonyGlobalnie(d.email, klient));
    if (!wykluczony) {
      const zrodlo = d.zrodlo ? d.zrodlo.replace(/[\u0000-\u001f]/g, "").slice(0, 80) : null;
      const szczegol = [
        `skrypt na stronie (klucz ${klucz.id})`,
        zrodlo ? `formularz „${zrodlo}”` : null,
        kontekst.origin ? `strona ${kontekst.origin}` : null,
        klucz.politykaUrl ? `polityka prywatności: ${klucz.politykaUrl}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      await klient.query(
        `insert into consents (tenant_id, profile_id, channel, state, source, wording, method_detail, occurred_at)
         values ($1, $2, 'email', 'granted', $3, $4, $5, now())`,
        [klucz.tenantId, ident.profileId, `strona:${zrodlo ?? klucz.id}`, klucz.tekstZgody, szczegol],
      );
      if (d.listId) {
        await klient.query(
          `insert into list_members (tenant_id, list_id, profile_id, source, added_at)
           values ($1, $2, $3, $4, now())
           on conflict (list_id, profile_id) do nothing`,
          [klucz.tenantId, d.listId, ident.profileId, `formularz:strona-${klucz.id}`],
        );
      }
    }
    await klient.query("commit");
    return { status: "przyjete" };
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    throw b;
  } finally {
    klient.release();
  }
}
