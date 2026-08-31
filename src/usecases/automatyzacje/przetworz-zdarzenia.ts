import { randomBytes } from "node:crypto";
import { getPool } from "../../adapters/db/pool";
import type { DostawcaWysylki } from "../../domain/email/port";
import { zlozWiadomosc } from "../wysylka/renderuj";
import { wyslijPartie } from "../wysylka/wyslij-kampanie";

function token(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Tik automatyzacji dla jednego tenanta: zdarzenia z ostatnich 48h kontra aktywne
 * journeye. Automatyzacja NIE ma wlasnego toru wysylki: buduje wiadomosci queued
 * w `messages` i oddaje je temu samemu silnikowi co kampanie, wiec kazdy mail
 * przechodzi przez wiazaca bramke canSendTo w transakcji wysylki (AD-25, FR69).
 *
 * Idempotencja jest trzywarstwowa i kazda warstwa lapie inny scenariusz:
 * 1. journey_runs (tani filtr w SQL): normalny przebieg, profil juz obsluzony
 *    nie jest nawet renderowany.
 * 2. unikalnosc (tenant_id, source_type, source_id, profile_id) z AD-26: dwa tiki
 *    rownolegle przechodza filtr 1 naraz, ale tylko jeden insert tworzy wiersz,
 *    drugi konczy sie "on conflict do nothing".
 * 3. SKIP LOCKED w wyslijPartie: nawet jedna wiadomosc queued nie wyjdzie dwa
 *    razy, gdy dwa procesy wysylaja rownoczesnie.
 *
 * Okno 48h to tylko granica skanu (koszt zapytania), nie zrodlo poprawnosci:
 * o "czy juz bylo" decyduja warstwy 1-2, a o "czy wolno siegac wstecz" granica
 * active_since. Journey wlaczony dzis widzi wylacznie zdarzenia po aktywacji,
 * wiec wlaczenie nie ostrzeliwuje ludzi powitaniami sprzed dwoch dni.
 */
export async function uruchomAutomatyzacje(
  tenantId: string,
  opcje: { dostawca?: DostawcaWysylki } = {},
) {
  const pool = getPool();
  const { rows: tenanci } = await pool.query("select name from tenants where id = $1", [tenantId]);
  const nazwaSklepu: string = tenanci[0]?.name ?? "";

  // granica aktywacji jako ::text, nie Date: pg parsowaloby timestamptz do JS Date
  // i gubilo mikrosekundy, a granica "od aktywacji" ma byc ostra (znalezisko z review)
  const { rows: journeye } = await pool.query(
    `select id, trigger_event, delay_minutes, subject, content,
            coalesce(active_since, created_at)::text as granica_aktywacji
       from journeys where tenant_id = $1 and active`,
    [tenantId],
  );

  let zbudowane = 0;

  for (const journey of journeye) {
    const trescHtml: string = (journey.content as any)?.html ?? "";
    // journey bez tresci nie moze wywrocic calego tika; po prostu nic nie buduje
    if (!trescHtml.trim() || !journey.subject) continue;

    // min(occurred_at): pierwszy pasujacy event decyduje o czasie, kolejne zdarzenia
    // tego profilu niczego nie dokladaja, bo mail z journeya jest jeden na profil.
    // Delay liczony od occurred_at zdarzenia (AD-10), nie od chwili tika.
    // occurred_at krazy jako TEKST prosto z bazy (ten sam powod co w kolejce):
    // Postgres trzyma mikrosekundy, JS Date tylko milisekundy, a triggered_at
    // w journey_runs ma byc rowny occurred_at zdarzenia co do mikrosekundy.
    // Okno skanu to 48h liczone od chwili DOJRZENIA (occurred_at + delay), nie od
    // occurred_at: samo "ostatnie 48h" ucieloby zdarzenia z delayem powyzej 48h,
    // ktore nigdy nie zdazylyby dojrzec w oknie (znalezisko z review).
    const { rows: kandydaci } = await pool.query(
      `select e.profile_id, p.email, min(e.occurred_at)::text as occurred_at
         from events e
         join profiles p on p.tenant_id = e.tenant_id and p.id = e.profile_id
        where e.tenant_id = $1
          and e.event_type = $2
          and e.occurred_at >= now() - interval '48 hours' - make_interval(mins => $5::int)
          and e.occurred_at >= $3::timestamptz
          and p.email is not null
          and not exists (
            select 1 from journey_runs jr
             where jr.journey_id = $4 and jr.profile_id = e.profile_id
          )
        group by e.profile_id, p.email
       having min(e.occurred_at) + make_interval(mins => $5::int) <= now()`,
      [
        tenantId,
        journey.trigger_event,
        journey.granica_aktywacji,
        journey.id,
        journey.delay_minutes,
      ],
    );

    for (const kandydat of kandydaci) {
      const clickToken = token();
      const unsubToken = token();
      // tokeny i HTML per wiadomosc, ten sam wzorzec co kampanie (AD-32, AD-33):
      // pozniejsza edycja tresci journeya nie zmienia wstecznie wyslanych maili
      const { html, linki } = zlozWiadomosc({
        trescHtml,
        clickToken,
        unsubscribeToken: unsubToken,
        nazwaSklepu,
      });

      // insert-select z warunkiem na journeys.active ORAZ aktualna granice
      // aktywacji: stan odczytany na poczatku tika jest tylko kandydatem, wiazaco
      // sprawdza go baza w chwili zapisu. Journey wylaczony w trakcie tika nie
      // tworzy juz wiadomosci, a wylaczony i wlaczony ponownie nie przyjmie
      // zdarzenia sprzed NOWEJ aktywacji (znaleziska z review rundy 1 i 2);
      // wiadomosci JUZ queued wychodza jak w kampaniach.
      const wynik = await pool.query(
        `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject,
                               body_html, click_token, unsubscribe_token, links)
         select $1, $2, 'journey', $3, $4, $5, $6, $7, $8, $9
          where exists (
            select 1 from journeys j
             where j.tenant_id = $1 and j.id = $3 and j.active
               and $10::timestamptz >= coalesce(j.active_since, j.created_at)
          )
         on conflict (tenant_id, source_type, source_id, profile_id) do nothing
         returning id`,
        [
          tenantId,
          kandydat.profile_id,
          journey.id,
          kandydat.email,
          journey.subject,
          html,
          clickToken,
          unsubToken,
          JSON.stringify(linki),
          kandydat.occurred_at,
        ],
      );
      if (wynik.rowCount) zbudowane++;

      // Rejestr POZA transakcja z insertem wiadomosci i PO nim, celowo:
      // awaria miedzy insertami zostawia wiadomosc bez wpisu, a kolejny tik
      // trafia konfliktem w messages (nie wysle drugiej) i uzupelnia rejestr.
      // Odwrotna kolejnosc gubilaby maila na zawsze. Warunek "wiadomosc istnieje"
      // jest konieczny: gdy insert wyzej nic nie dal, bo journey zostal wlasnie
      // wylaczony, wpis do rejestru zamknalby profilowi droge na zawsze, mimo ze
      // zadnego maila nie bylo.
      await pool.query(
        `insert into journey_runs (journey_id, profile_id, triggered_at)
         select $1, $2, $3
          where exists (
            select 1 from messages m
             where m.tenant_id = $4 and m.source_type = 'journey'
               and m.source_id = $1 and m.profile_id = $2
          )
         on conflict (journey_id, profile_id) do nothing`,
        [journey.id, kandydat.profile_id, kandydat.occurred_at, tenantId],
      );
    }
  }

  // od razu w swiat, tym samym silnikiem i przez te same bramki co kampanie;
  // wysyla wszystko queued tenanta, wiec przy okazji dociaga tez zaleglosci
  const wysylka = await wyslijPartie(tenantId, { dostawca: opcje.dostawca });
  return { zbudowane, wysylka };
}
