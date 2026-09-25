import { getPool } from "./pool";
import { parsujReguly, type Regula } from "../../domain/segmenty";

/**
 * Kompilacja reguł segmentu do SQL (AD-18).
 *
 * Trzy zasady, których nie wolno tu złamać:
 * 1. Wartości idą wyłącznie parametrami. Żadne sklejanie napisów z danymi (także `limit`).
 * 2. Predykat tenanta jest w KAŻDYM złączeniu, nie tylko w zapytaniu zewnętrznym (AD-2).
 *    Podzapytanie bez tego przepuściłoby zamówienia innego klienta agencji.
 * 3. Reguła, której kompilator nie zna, jest BŁĘDEM, nie pominięciem. Pominięta reguła
 *    to brak warunku, a brak warunku to cała baza tenanta (audyt #12).
 */
export function skompiluj(surowe: unknown, tenantId: string) {
  // walidacja PRZY KAŻDEJ kompilacji, nie tylko przy zapisie: segment zapisany
  // skryptem albo starszą wersją formularza też ma przejść przez schemat
  const reguly: Regula[] = parsujReguly(surowe);
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
      case "kliknal_w_ostatnich":
        // `clicks` = kliknięcia uznane za ludzkie (skanery zostają w message_engagement)
        warunki.push(`exists (
          select 1 from clicks k
           where k.tenant_id = $1 and k.profile_id = pr.id
             and k.occurred_at >= now() - make_interval(days => ${p(regula.dni)}::int))`);
        break;
      case "nie_kliknal_od": {
        // sunset: brak LUDZKIEGO kliknięcia od N dni, ale tylko u kogoś, kto co najmniej
        // N dni temu dostał od nas wiadomość. Profil, do którego nic jeszcze nie poszło
        // (świeży import), nie jest "nieaktywny" - nie miał w co kliknąć (review B).
        const dni = p(regula.dni);
        warunki.push(`not exists (
          select 1 from clicks k
           where k.tenant_id = $1 and k.profile_id = pr.id
             and k.occurred_at >= now() - make_interval(days => ${dni}::int))
         and exists (
          select 1 from messages m
           where m.tenant_id = $1 and m.profile_id = pr.id
             and m.source_type in ('campaign', 'journey')
             and m.created_at <= now() - make_interval(days => ${dni}::int))`);
        break;
      }
      default: {
        // schemat wyżej nie powinien tu nikogo wpuścić; gdyby ktoś dopisał typ do
        // schematu bez gałęzi w kompilatorze, to ma być błąd, nie cała baza
        const nieznana: never = regula;
        throw new Error(`Kompilator segmentów nie zna reguły: ${JSON.stringify(nieznana)}`);
      }
    }
  }

  if (!warunki.length) {
    throw new Error("Segment bez skompilowanych warunków objąłby całą bazę - odrzucone");
  }
  const gdzie = `and ${warunki.join("\n and ")}`;
  return { gdzie, parametry };
}

export async function policzSegment(tenantId: string, reguly: unknown): Promise<number> {
  const { gdzie, parametry } = skompiluj(reguly, tenantId);
  const { rows } = await getPool().query<{ ile: number }>(
    `select count(*)::int as ile from profiles pr where pr.tenant_id = $1 ${gdzie}`,
    parametry,
  );
  return rows[0].ile;
}

export async function profileSegmentu(tenantId: string, reguly: unknown, limit = 25) {
  const { gdzie, parametry } = skompiluj(reguly, tenantId);
  // limit parametrem, nie interpolacją (N12 z 31.08), z domknięciem do 1..500
  const indeksLimitu = parametry.push(Math.min(500, Math.max(1, Math.floor(Number(limit) || 25))));
  const { rows } = await getPool().query(
    `select pr.id, pr.email, pr.first_name, pr.last_name,
            (select count(*)::int from orders o
              where o.tenant_id = pr.tenant_id and o.profile_id = pr.id) as zamowien
       from profiles pr
      where pr.tenant_id = $1 ${gdzie}
      order by pr.created_at desc
      limit $${indeksLimitu}::int`,
    parametry,
  );
  return rows;
}
