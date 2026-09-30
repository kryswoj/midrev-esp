import { z } from "zod";
import { sprawdzCzas, sprawdzNazweMetryki, sprawdzWlasciwosci, MAKS_UNIQUE_ID } from "../../domain/zdarzenia/limity";
import { telefonE164 } from "../../domain/zdarzenia/telefon";

/**
 * Kształt `POST /api/events` (JSON:API Klaviyo, revision 2025-01-15 .. 2026-07-15) i jego
 * walidacja. Ta sama funkcja działa synchronicznie w trasie (400 od razu, jak Klaviyo)
 * i w workerze (drugi raz, na zapisanym surowym ciele), więc worker nie ufa temu, co
 * przeszło przez trasę w innej wersji kodu.
 *
 * Nieznane pola są przepuszczane (passthrough): Klaviyo dokłada atrybuty między rewizjami,
 * a n8n nie może dostać 400 za pole, którego nie używamy.
 */

const tekst = (maks: number) => z.string().max(maks);

const schematLokalizacji = z
  .object({
    address1: tekst(255).nullish(),
    address2: tekst(255).nullish(),
    city: tekst(255).nullish(),
    region: tekst(255).nullish(),
    country: tekst(255).nullish(),
    zip: tekst(64).nullish(),
    latitude: z.union([z.number(), z.string().max(32)]).nullish(),
    longitude: z.union([z.number(), z.string().max(32)]).nullish(),
    timezone: tekst(64).nullish(),
    ip: tekst(64).nullish(),
  })
  .passthrough();

const schematAtrybutowProfilu = z
  .object({
    email: tekst(320).nullish(),
    phone_number: tekst(40).nullish(),
    external_id: tekst(255).nullish(),
    anonymous_id: tekst(255).nullish(),
    first_name: tekst(255).nullish(),
    last_name: tekst(255).nullish(),
    organization: tekst(255).nullish(),
    title: tekst(255).nullish(),
    locale: tekst(64).nullish(),
    location: schematLokalizacji.nullish(),
    properties: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

const schematCiala = z.object({
  data: z
    .object({
      type: z.literal("event"),
      attributes: z
        .object({
          properties: z.record(z.string(), z.unknown()),
          time: z.string().max(64).nullish(),
          value: z.number().nullish(),
          value_currency: z.string().regex(/^[A-Za-z]{3}$/, "kod waluty ISO 4217").nullish(),
          unique_id: z.string().max(MAKS_UNIQUE_ID).nullish(),
          // rozszerzenie MidRev (plan 2.6): jawny import historii, nie wyzwala flow
          backfill: z.boolean().nullish(),
          metric: z.object({
            data: z
              .object({
                type: z.literal("metric"),
                attributes: z.object({ name: z.string(), service: z.string().max(64).nullish() }).passthrough(),
              })
              .passthrough(),
          }),
          profile: z.object({
            data: z
              .object({
                type: z.literal("profile"),
                id: z.string().max(64).nullish(),
                attributes: schematAtrybutowProfilu.nullish(),
              })
              .passthrough(),
          }),
        })
        .passthrough(),
    })
    .passthrough(),
});

export interface IdentyfikatoryProfilu {
  id: string | null;
  email: string | null;
  /** E.164 */
  telefon: string | null;
  externalId: string | null;
  anonymousId: string | null;
}

export interface AtrybutyProfilu {
  imie?: string | null;
  nazwisko?: string | null;
  organizacja?: string | null;
  tytul?: string | null;
  jezyk?: string | null;
  lokalizacja?: Record<string, unknown> | null;
  wlasciwosci?: Record<string, unknown> | null;
}

export interface ZdarzenieApi {
  nazwaMetryki: string;
  identyfikatory: IdentyfikatoryProfilu;
  atrybuty: AtrybutyProfilu;
  properties: Record<string, unknown>;
  /** null = czas przyjęcia żądania (jak Klaviyo) */
  czas: Date | null;
  wartosc: number | null;
  waluta: string | null;
  uniqueId: string | null;
  backfill: boolean;
}

export interface BladWalidacji {
  wskaznik: string;
  opis: string;
}

export type WynikWalidacji = { ok: true; dane: ZdarzenieApi } | { ok: false; bledy: BladWalidacji[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ISO 8601; bez strefy = UTC (jak Klaviyo). */
export function czasZTekstu(t: string): Date | null {
  const s = t.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/i.test(s)) return null;
  const zeStrefa = /(Z|[+-]\d{2}:?\d{2})$/i.test(s) || s.length === 10 ? s : s + "Z";
  const d = new Date(zeStrefa.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

const pusty = (v: string | null | undefined) => (v === undefined || v === null || v.trim() === "" ? null : v.trim());

export function zwalidujZdarzenieApi(cialo: unknown, teraz: Date): WynikWalidacji {
  const p = schematCiala.safeParse(cialo);
  if (!p.success) {
    return {
      ok: false,
      bledy: p.error.issues.slice(0, 10).map((i) => ({
        wskaznik: "/" + i.path.map((x) => String(x).replace(/~/g, "~0").replace(/\//g, "~1")).join("/"),
        opis: i.message,
      })),
    };
  }
  const a = p.data.data.attributes;
  const bledy: BladWalidacji[] = [];

  const nazwa = a.metric.data.attributes.name;
  const bladNazwy = sprawdzNazweMetryki(nazwa);
  if (bladNazwy) bledy.push({ wskaznik: "/data/attributes/metric/data/attributes/name", opis: bladNazwy });

  const naruszenie = sprawdzWlasciwosci(a.properties);
  if (naruszenie) bledy.push({ wskaznik: `/data/attributes/properties${naruszenie.wskaznik}`, opis: naruszenie.opis });

  let czas: Date | null = null;
  if (a.time !== undefined && a.time !== null) {
    czas = czasZTekstu(a.time);
    if (!czas) bledy.push({ wskaznik: "/data/attributes/time", opis: "czas musi być datą ISO 8601" });
    else {
      const b = sprawdzCzas(czas, teraz.getTime());
      if (b) bledy.push({ wskaznik: "/data/attributes/time", opis: b });
    }
  }

  const prof = a.profile.data;
  const at = prof.attributes ?? {};
  const email = pusty(at.email ?? null);
  if (email && (!EMAIL.test(email) || email.length > 254)) {
    bledy.push({ wskaznik: "/data/attributes/profile/data/attributes/email", opis: "niepoprawny adres e-mail" });
  }
  const telSurowy = pusty(at.phone_number ?? null);
  const telefon = telSurowy ? telefonE164(telSurowy) : null;
  if (telSurowy && !telefon) {
    bledy.push({ wskaznik: "/data/attributes/profile/data/attributes/phone_number", opis: "numer telefonu musi dać się zapisać w E.164" });
  }
  const id = pusty(prof.id ?? null);
  if (id && !UUID.test(id)) {
    bledy.push({ wskaznik: "/data/attributes/profile/data/id", opis: "nieznany format identyfikatora profilu" });
  }
  const externalId = pusty(at.external_id ?? null);
  const anonymousId = pusty(at.anonymous_id ?? null);
  if (!id && !email && !telSurowy && !externalId && !anonymousId) {
    bledy.push({
      wskaznik: "/data/attributes/profile/data/attributes",
      opis: "profil wymaga identyfikatora: id, email, phone_number, external_id albo anonymous_id",
    });
  }
  if (at.properties) {
    const n = sprawdzWlasciwosci(at.properties);
    if (n) bledy.push({ wskaznik: `/data/attributes/profile/data/attributes/properties${n.wskaznik}`, opis: n.opis });
  }
  if (at.location) {
    const n = sprawdzWlasciwosci(at.location);
    if (n) bledy.push({ wskaznik: `/data/attributes/profile/data/attributes/location${n.wskaznik}`, opis: n.opis });
  }
  if (a.value !== undefined && a.value !== null && !Number.isFinite(a.value)) {
    bledy.push({ wskaznik: "/data/attributes/value", opis: "wartość musi być liczbą" });
  }
  const uniqueId = pusty(a.unique_id ?? null);

  if (bledy.length) return { ok: false, bledy };
  return {
    ok: true,
    dane: {
      nazwaMetryki: nazwa.trim(),
      identyfikatory: { id, email, telefon, externalId, anonymousId },
      atrybuty: {
        imie: at.first_name,
        nazwisko: at.last_name,
        organizacja: at.organization,
        tytul: at.title,
        jezyk: at.locale,
        lokalizacja: at.location ?? undefined,
        wlasciwosci: at.properties ?? undefined,
      },
      properties: a.properties,
      czas,
      wartosc: a.value ?? null,
      waluta: a.value_currency ? a.value_currency.toUpperCase() : null,
      uniqueId,
      backfill: a.backfill === true,
    },
  };
}
