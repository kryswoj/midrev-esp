import { getPool } from "../adapters/db/pool";

/**
 * Widok właściwości profilu tylko do odczytu (E6 / MVP 6.4): właściwości niestandardowe
 * (`profiles.properties`, 99% profili po imporcie Klaviyo, dotąd niewidoczne) i identyfikatory
 * z 0033. Edycja to story 6.3 (poza MVP). Predykat tenant_id w każdym zapytaniu (AD-2).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WlasciwoscProfilu {
  klucz: string;
  /** wartość jako tekst do wyświetlenia (obiekty i listy jako JSON) */
  wartosc: string;
  typ: "string" | "number" | "boolean" | "list" | "object" | "null";
}

export interface WlasciwosciProfilu {
  wlasciwosci: WlasciwoscProfilu[];
  identyfikatory: {
    externalId: string | null;
    anonymousId: string | null;
    organizacja: string | null;
    stanowisko: string | null;
    jezyk: string | null;
    lokalizacja: Record<string, unknown>;
    zmieniono: Date | null;
  };
}

function typ(w: unknown): WlasciwoscProfilu["typ"] {
  if (w === null || w === undefined) return "null";
  if (Array.isArray(w)) return "list";
  if (typeof w === "object") return "object";
  if (typeof w === "number") return "number";
  if (typeof w === "boolean") return "boolean";
  return "string";
}

export async function wlasciwosciProfilu(tenantId: string, profileId: string): Promise<WlasciwosciProfilu | null> {
  if (!UUID.test(profileId)) return null;
  const { rows } = await getPool().query<{
    properties: Record<string, unknown>;
    external_id: string | null;
    anonymous_id: string | null;
    organization: string | null;
    title: string | null;
    locale: string | null;
    location: Record<string, unknown>;
    updated_at: Date | null;
  }>(
    `select properties, external_id, anonymous_id, organization, title, locale, location, updated_at
       from profiles where tenant_id = $1 and id = $2`,
    [tenantId, profileId],
  );
  const p = rows[0];
  if (!p) return null;
  const wlasciwosci = Object.entries(p.properties ?? {})
    .map(([klucz, w]) => ({
      klucz,
      typ: typ(w),
      wartosc: typeof w === "string" ? w : w === null || w === undefined ? "" : JSON.stringify(w),
    }))
    .sort((a, b) => a.klucz.localeCompare(b.klucz, "pl"));
  return {
    wlasciwosci,
    identyfikatory: {
      externalId: p.external_id,
      anonymousId: p.anonymous_id,
      organizacja: p.organization,
      stanowisko: p.title,
      jezyk: p.locale,
      lokalizacja: p.location ?? {},
      zmieniono: p.updated_at,
    },
  };
}

/** Metryki, które ta osoba ma na osi (do filtra osi): po indeksie profilu, bez skanu tenanta. */
export async function metrykiProfilu(tenantId: string, profileId: string): Promise<{ id: string; nazwa: string; ukryta: boolean }[]> {
  if (!UUID.test(profileId)) return [];
  const { rows } = await getPool().query<{ id: string; nazwa: string; ukryta: boolean }>(
    `select m.id, m.name as nazwa, m.hidden as ukryta
       from metrics m
      where m.tenant_id = $1
        and exists (select 1 from metric_events e where e.tenant_id = m.tenant_id and e.profile_id = $2 and e.metric_id = m.id)
      order by m.hidden, m.name`,
    [tenantId, profileId],
  );
  return rows;
}
