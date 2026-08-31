import { getPool } from "../adapters/db/pool";
import { skompiluj } from "../adapters/db/segmenty";
import type { Regula } from "../domain/segmenty";

export interface RozbicieOdbiorcow {
  kandydaci: number;
  wykluczeniGlobalnie: number;
  wykluczeniLokalnie: number;
  bezZgody: number;
  bezAdresu: number;
  docelowo: number;
  probka: { email: string | null; imie: string | null; nazwisko: string | null }[];
  zrodla: { mode: string; typ: string; nazwa: string; ile: number }[];
  /** pełna lista docelowych profili; z niej silnik wysyłki buduje wiadomości */
  doceloweIds: string[];
}

async function idZeZrodla(
  tenantId: string,
  typ: string,
  sourceId: string,
): Promise<{ nazwa: string; ids: string[] }> {
  const pool = getPool();
  if (typ === "list") {
    const { rows } = await pool.query(
      `select l.name, coalesce(array_agg(m.profile_id) filter (where m.profile_id is not null), '{}') as ids
         from lists l
         left join list_members m on m.tenant_id = l.tenant_id and m.list_id = l.id
        where l.tenant_id = $1 and l.id = $2 group by l.name`,
      [tenantId, sourceId],
    );
    return { nazwa: rows[0]?.name ?? "?", ids: rows[0]?.ids ?? [] };
  }
  const { rows: seg } = await pool.query(
    "select name, rules from segments where tenant_id = $1 and id = $2",
    [tenantId, sourceId],
  );
  if (!seg[0]) return { nazwa: "?", ids: [] };
  const { gdzie, parametry } = skompiluj(seg[0].rules as Regula[], tenantId);
  const { rows } = await pool.query<{ id: string }>(
    `select pr.id from profiles pr where pr.tenant_id = $1 ${gdzie}`,
    parametry,
  );
  return { nazwa: seg[0].name, ids: rows.map((r) => r.id) };
}

/**
 * Rozbicie odbiorców kampanii (FR34 plus bramka z AD-25).
 *
 * Kluczowa rzecz, którą ten ekran pokazuje: lista zbudowana z segmentów to KANDYDACI,
 * nie odbiorcy. Wiążące sprawdzenie i tak nastąpi tuż przed wysyłką, bo między
 * przygotowaniem kampanii a jej wyjściem mijają dni: akceptacja klienta, harmonogram,
 * limit warmupu. Ktoś w tym czasie zdąży się wypisać.
 */
export async function policzOdbiorcow(
  tenantId: string,
  campaignId: string,
): Promise<RozbicieOdbiorcow> {
  const pool = getPool();
  const { rows: zrodlaWiersze } = await pool.query(
    `select mode, source_type, source_id from campaign_audience
      where tenant_id = $1 and campaign_id = $2`,
    [tenantId, campaignId],
  );

  const wlaczone = new Set<string>();
  const wylaczone = new Set<string>();
  const zrodla: RozbicieOdbiorcow["zrodla"] = [];

  for (const z of zrodlaWiersze) {
    const { nazwa, ids } = await idZeZrodla(tenantId, z.source_type, z.source_id);
    zrodla.push({ mode: z.mode, typ: z.source_type, nazwa, ile: ids.length });
    for (const id of ids) (z.mode === "include" ? wlaczone : wylaczone).add(id);
  }

  const kandydaciIds = [...wlaczone].filter((id) => !wylaczone.has(id));
  if (kandydaciIds.length === 0) {
    return {
      kandydaci: 0,
      wykluczeniGlobalnie: 0,
      wykluczeniLokalnie: 0,
      bezZgody: 0,
      bezAdresu: 0,
      docelowo: 0,
      probka: [],
      zrodla,
      doceloweIds: [],
    };
  }

  // Jedno zapytanie klasyfikujące. Stan zgody i stan wykluczenia to OSTATNI wpis
  // w rejestrze, nie kolumna, więc oba liczone są z okna po dacie zdarzenia.
  const { rows } = await pool.query(
    `with kandydaci as (
       select p.id, p.email, p.first_name, p.last_name, lower(btrim(p.email)) as klucz
         from profiles p
        where p.tenant_id = $1 and p.id = any($2::uuid[])
     ),
     zgoda as (
       select distinct on (profile_id) profile_id, state
         from consents
        where tenant_id = $1 and channel = 'email'
        order by profile_id, occurred_at desc
     ),
     lokalne as (
       select distinct on (lower(btrim(email))) lower(btrim(email)) as klucz, action
         from tenant_suppressions
        where tenant_id = $1
        order by lower(btrim(email)), occurred_at desc
     )
     select k.id, k.email, k.first_name, k.last_name,
            (k.email is null) as bez_adresu,
            exists (select 1 from suppressions s where lower(btrim(s.email)) = k.klucz) as globalnie,
            coalesce((select l.action = 'suppressed' from lokalne l where l.klucz = k.klucz), false) as lokalnie,
            coalesce((select z.state from zgoda z where z.profile_id = k.id), 'brak') <> 'granted' as bez_zgody
       from kandydaci k`,
    [tenantId, kandydaciIds],
  );

  const docelowi = rows.filter(
    (r: any) => !r.bez_adresu && !r.globalnie && !r.lokalnie && !r.bez_zgody,
  );

  return {
    kandydaci: rows.length,
    bezAdresu: rows.filter((r: any) => r.bez_adresu).length,
    wykluczeniGlobalnie: rows.filter((r: any) => r.globalnie).length,
    wykluczeniLokalnie: rows.filter((r: any) => !r.globalnie && r.lokalnie).length,
    bezZgody: rows.filter((r: any) => !r.globalnie && !r.lokalnie && r.bez_zgody).length,
    docelowo: docelowi.length,
    probka: docelowi.slice(0, 8).map((r: any) => ({
      email: r.email,
      imie: r.first_name,
      nazwisko: r.last_name,
    })),
    zrodla,
    doceloweIds: docelowi.map((r: any) => r.id),
  };
}
