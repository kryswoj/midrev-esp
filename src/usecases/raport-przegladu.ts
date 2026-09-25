import { getPool } from "../adapters/db/pool";

/**
 * Dane ekranu startowego: PIENIĄDZ NA GÓRZE.
 *
 * Wzorzec to „Home" Klaviyo (PANELE-ESP-NAWIGACJA-2026-09-22, sekcja 1.2): pierwsze dwie
 * liczby po zalogowaniu to przychód całkowity i przychód przypisany, potem rozbicie na
 * automatyzacje kontra kampanie, dopiero niżej listy. Wniosek z researchu brzmiał wprost:
 * pierwszą liczbą na ekranie startowym jest pieniądz, nie wysłane maile — bo to jest
 * argument, którym agencja tłumaczy klientowi, za co płaci.
 *
 * DŁUG DO SPŁACENIA: SQL ma docelowo mieszkać w `adapters/db/repozytoria.ts` (AD-18).
 * Leży tutaj, bo `repozytoria.ts` należy w tej rundzie do innego agenta — ten sam powód
 * i ten sam wzorzec co w `adapters/store/stan-webhookow.ts`. Każde zapytanie ma predykat
 * `tenant_id` (AD-2).
 */

export interface PrzychodPrzegladu {
  /** Suma zamówień opłaconych i w realizacji — ta sama definicja co `podsumowanieTenanta`. */
  sklepMinor: number;
  zamowienSklep: number;
  waluta: string;
  odKiedy: Date | null;
  doKiedy: Date | null;
  /**
   * Przychód przypisany e-mailowi z NAJNOWSZEGO ZAKOŃCZONEGO przebiegu atrybucji.
   * `null` znaczy, że atrybucji nigdy nie przeliczono — i to jest co innego niż zero.
   * Zero mówi „e-mail nic nie zarobił", null mówi „nie wiemy, bo nikt nie policzył".
   */
  przypisanyMinor: number | null;
  przypisanychZamowien: number;
  przebiegAt: Date | null;
  oknoGodzin: number | null;
  /**
   * Rozbicie przypisanego przychodu na źródła z TEGO SAMEGO przebiegu co `przypisanyMinor`.
   * Każde zamówienie ma w przebiegu dokładnie jedno źródło (ostatni klik), więc
   * `kampanieMinor + automatyzacjeMinor === przypisanyMinor` co do grosza.
   * Semantyka `null` jak wyżej: `null` = nie liczono, `0` = policzono i nic nie zarobiło.
   *
   * Do migracji 0018 `kampanieMinor` było równe całemu `przypisanyMinor` (atrybucja znała
   * tylko kampanie). Teraz to wyłącznie przychód kampanii.
   */
  kampanieMinor: number | null;
  kampanieZamowien: number;
  automatyzacjeMinor: number | null;
  automatyzacjeZamowien: number;
}

export interface WierszKampanii {
  id: string;
  name: string;
  status: string;
  /** Moment OSTATNIEJ wysyłki kampanii, liczony ze zdarzeń `sent`, nie z `updated_at`. */
  wyslanaAt: Date | null;
  wyslane: number;
  klikniecia: number;
  przychodMinor: number;
  zamowien: number;
}

/**
 * Przychód sklepu i przychód przypisany w jednym zapytaniu.
 *
 * Przychód sklepu: `orders` ze statusem `completed` albo `processing`, po dacie ZE ŹRÓDŁA
 * (AD-10). Ta sama definicja, którą liczy `podsumowanieTenanta` — celowo, bo dwie różne
 * definicje przychodu na dwóch ekranach to najszybszy sposób na utratę zaufania klienta.
 *
 * Przychód przypisany: suma `attributions` z najnowszego przebiegu z `finished_at`.
 * Przebieg niezakończony jest niepełny i jego suma spadałaby w trakcie liczenia.
 */
export async function przychodPrzegladu(tenantId: string): Promise<PrzychodPrzegladu> {
  const { rows } = await getPool().query(
    `with ostatni as (
       select r.id, r.finished_at, u.window_hours
         from attribution_runs r
         join attribution_rules u on u.id = r.rule_id
        where r.tenant_id = $1 and r.finished_at is not null
        order by r.finished_at desc, r.id desc
        limit 1
     )
     select
       (select coalesce(sum(total_minor), 0)::text from orders
         where tenant_id = $1 and status in ('completed','processing')) as sklep_minor,
       (select count(*)::int from orders
         where tenant_id = $1 and status in ('completed','processing')) as zamowien_sklep,
       -- waluta z najczęściej występującej w zamówieniach: panel nie sumuje walut,
       -- a sklep w sandboxie i u klienta ma jedną. Brak zamówień -> PLN.
       (select currency from orders where tenant_id = $1
         group by currency order by count(*) desc limit 1) as waluta,
       (select min(occurred_at) from orders where tenant_id = $1) as od_kiedy,
       (select max(occurred_at) from orders where tenant_id = $1) as do_kiedy,
       (select id from ostatni) as przebieg_id,
       (select finished_at from ostatni) as przebieg_at,
       (select window_hours from ostatni) as okno_godzin,
       (select coalesce(sum(a.amount_minor), 0)::text from attributions a
         where a.tenant_id = $1 and a.run_id = (select id from ostatni)) as przypisany_minor,
       (select count(*)::int from attributions a
         where a.tenant_id = $1 and a.run_id = (select id from ostatni)) as przypisanych_zamowien,
       (select coalesce(sum(a.amount_minor), 0)::text from attributions a
         where a.tenant_id = $1 and a.run_id = (select id from ostatni)
           and a.source_type = 'campaign') as kampanie_minor,
       (select count(*)::int from attributions a
         where a.tenant_id = $1 and a.run_id = (select id from ostatni)
           and a.source_type = 'campaign') as kampanie_zamowien,
       (select coalesce(sum(a.amount_minor), 0)::text from attributions a
         where a.tenant_id = $1 and a.run_id = (select id from ostatni)
           and a.source_type = 'journey') as automatyzacje_minor,
       (select count(*)::int from attributions a
         where a.tenant_id = $1 and a.run_id = (select id from ostatni)
           and a.source_type = 'journey') as automatyzacje_zamowien`,
    [tenantId],
  );
  const w = rows[0];
  const byloPrzeliczenie = w.przebieg_id !== null;
  return {
    sklepMinor: Number(w.sklep_minor),
    zamowienSklep: w.zamowien_sklep,
    waluta: w.waluta ?? "PLN",
    odKiedy: w.od_kiedy ?? null,
    doKiedy: w.do_kiedy ?? null,
    przypisanyMinor: byloPrzeliczenie ? Number(w.przypisany_minor) : null,
    przypisanychZamowien: w.przypisanych_zamowien,
    przebiegAt: w.przebieg_at ?? null,
    oknoGodzin: w.okno_godzin ?? null,
    kampanieMinor: byloPrzeliczenie ? Number(w.kampanie_minor) : null,
    kampanieZamowien: w.kampanie_zamowien,
    automatyzacjeMinor: byloPrzeliczenie ? Number(w.automatyzacje_minor) : null,
    automatyzacjeZamowien: w.automatyzacje_zamowien,
  };
}

/**
 * Ostatnie kampanie, które faktycznie wyszły, z liczbami z tego samego przebiegu
 * atrybucji co kafelki na karcie kampanii.
 *
 * `wyslane` liczone ze ZDARZENIA `sent`, nie ze stanu końcowego wiadomości: mail, który
 * potem się odbił, NADAL został wysłany. `klikniecia` to wiadomości z co najmniej jednym
 * kliknięciem w `clicks`, czyli kliknięcia uznane za ludzkie (bot nie trafia do tej
 * tabeli — patrz `wysylka/zaangazowanie.ts`).
 *
 * Data wysyłki to `max(occurred_at)` zdarzeń `sent`. NIE `updated_at` kampanii: ta
 * kolumna rusza się przy każdej zmianie rekordu i po tygodniu pokazywałaby dzień
 * ostatniej edycji zamiast dnia, w którym mail poszedł do ludzi.
 */
export async function ostatnieKampanie(tenantId: string, limit = 6): Promise<WierszKampanii[]> {
  const { rows } = await getPool().query(
    `with ostatni as (
       select id from attribution_runs
        where tenant_id = $1 and finished_at is not null
        order by finished_at desc, id desc limit 1
     )
     select c.id, c.name, c.status,
            w.wyslana_at,
            coalesce(w.wyslane, 0)::int as wyslane,
            coalesce(k.klikniecia, 0)::int as klikniecia,
            coalesce(a.przychod_minor, 0)::text as przychod_minor,
            coalesce(a.zamowien, 0)::int as zamowien
       from campaigns c
       left join lateral (
         select count(*) as wyslane, max(e.occurred_at) as wyslana_at
           from message_events e
           join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
          where e.tenant_id = c.tenant_id and e.event_type = 'sent'
            and m.source_type = 'campaign' and m.source_id = c.id
       ) w on true
       left join lateral (
         select count(distinct cl.message_id) as klikniecia
           from clicks cl
           join messages m on m.tenant_id = cl.tenant_id and m.id = cl.message_id
          where cl.tenant_id = c.tenant_id
            and m.source_type = 'campaign' and m.source_id = c.id
       ) k on true
       left join lateral (
         select sum(atr.amount_minor) as przychod_minor, count(*) as zamowien
           from attributions atr
          where atr.tenant_id = c.tenant_id and atr.campaign_id = c.id
            and atr.run_id = (select id from ostatni)
       ) a on true
      where c.tenant_id = $1
        and c.status in ('sending', 'paused', 'sent')
      order by w.wyslana_at desc nulls last, c.updated_at desc
      limit $2`,
    [tenantId, limit],
  );
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    wyslanaAt: r.wyslana_at ?? null,
    wyslane: r.wyslane,
    klikniecia: r.klikniecia,
    przychodMinor: Number(r.przychod_minor),
    zamowien: r.zamowien,
  }));
}
