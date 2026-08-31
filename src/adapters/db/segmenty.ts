import { getPool } from "./pool";
import type { Regula } from "../../domain/segmenty";

/**
 * Kompilacja reguł segmentu do SQL (AD-18).
 *
 * Dwie zasady, których nie wolno tu złamać:
 * 1. Wartości idą wyłącznie parametrami. Żadne sklejanie napisów z danymi.
 * 2. Predykat tenanta jest w KAŻDYM złączeniu, nie tylko w zapytaniu zewnętrznym (AD-2).
 *    Podzapytanie bez tego przepuściłoby zamówienia innego klienta agencji.
 */
export function skompiluj(reguly: Regula[], tenantId: string) {
  const warunki: string[] = [];
  const parametry: unknown[] = [tenantId];
  const p = (wartosc: unknown) => `$${parametry.push(wartosc)}`;

  for (const regula of reguly) {
    switch (regula.typ) {
      case "kupil_w_ostatnich":
        warunki.push(`exists (
          select 1 from orders o
           where o.tenant_id = $1 and o.profile_id = pr.id
             and o.status in ('completed','processing')
             and o.occurred_at >= now() - make_interval(days => ${p(regula.dni)}::int))`);
        break;
      case "nie_kupil_od":
        warunki.push(`not exists (
          select 1 from orders o
           where o.tenant_id = $1 and o.profile_id = pr.id
             and o.status in ('completed','processing')
             and o.occurred_at >= now() - make_interval(days => ${p(regula.dni)}::int))`);
        break;
      case "wydal_powyzej":
        warunki.push(`(
          select coalesce(sum(o.total_minor), 0) from orders o
           where o.tenant_id = $1 and o.profile_id = pr.id
             and o.status in ('completed','processing')) > ${p(regula.kwotaMinor)}::bigint`);
        break;
      case "liczba_zamowien_min":
        warunki.push(`(
          select count(*) from orders o
           where o.tenant_id = $1 and o.profile_id = pr.id
             and o.status in ('completed','processing')) >= ${p(regula.ile)}::int`);
        break;
      case "ma_zgode":
        // stan zgody to OSTATNI wpis w rejestrze, nie kolumna w profilu (AD-16)
        warunki.push(`(
          select c.state from consents c
           where c.tenant_id = $1 and c.profile_id = pr.id and c.channel = ${p(regula.kanal)}
           order by c.occurred_at desc limit 1) = 'granted'`);
        break;
    }
  }

  const gdzie = warunki.length ? `and ${warunki.join("\n and ")}` : "";
  return { gdzie, parametry };
}

export async function policzSegment(tenantId: string, reguly: Regula[]): Promise<number> {
  const { gdzie, parametry } = skompiluj(reguly, tenantId);
  const { rows } = await getPool().query<{ ile: number }>(
    `select count(*)::int as ile from profiles pr where pr.tenant_id = $1 ${gdzie}`,
    parametry,
  );
  return rows[0].ile;
}

export async function profileSegmentu(tenantId: string, reguly: Regula[], limit = 25) {
  const { gdzie, parametry } = skompiluj(reguly, tenantId);
  const { rows } = await getPool().query(
    `select pr.id, pr.email, pr.first_name, pr.last_name,
            (select count(*)::int from orders o
              where o.tenant_id = pr.tenant_id and o.profile_id = pr.id) as zamowien
       from profiles pr
      where pr.tenant_id = $1 ${gdzie}
      order by pr.created_at desc
      limit ${limit}`,
    parametry,
  );
  return rows;
}
