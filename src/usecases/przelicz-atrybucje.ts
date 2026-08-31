import { getPool } from "../adapters/db/pool";

/**
 * Atrybucja przychodu (AD-14, AD-28, FR57).
 *
 * Model: last-touch click-based. Zamówienie dostaje przychód przypisany do OSTATNIEGO
 * kliknięcia tego profilu w oknie reguły przed datą zamówienia. Otwarcia nie istnieją
 * w tym modelu w ogóle: połowa otwarć to Apple MPP i nie znaczą nic.
 *
 * Przeliczenie tworzy NOWY przebieg (attribution_run) zamiast kasować poprzednie liczby.
 * Liczba pokazana wczoraj klientowi musi być do odtworzenia co do grosza, nawet jeśli
 * dziś zmieniło się okno.
 */
export async function przeliczAtrybucje(tenantId: string) {
  const pool = getPool();

  // reguła: ostatnia obowiązująca; gdy żadnej nie ma, tworzymy domyślną 120h (5 dni)
  let { rows: reguly } = await pool.query(
    `select id, window_hours from attribution_rules
      where tenant_id = $1 and effective_from <= now()
      order by effective_from desc limit 1`,
    [tenantId],
  );
  if (!reguly.length) {
    ({ rows: reguly } = await pool.query(
      `insert into attribution_rules (tenant_id) values ($1) returning id, window_hours`,
      [tenantId],
    ));
  }
  const regula = reguly[0];

  const { rows: przebiegi } = await pool.query(
    `insert into attribution_runs (tenant_id, rule_id, note)
     values ($1, $2, 'przeliczenie pełne') returning id`,
    [tenantId, regula.id],
  );
  const runId = przebiegi[0].id;

  // Jedno zapytanie: dla każdego opłaconego zamówienia ostatni klik profilu w oknie.
  // Wiadomość musi pochodzić z kampanii, a klik z zakresu [zamówienie - okno, zamówienie].
  const { rows } = await pool.query(
    `insert into attributions (tenant_id, run_id, order_id, message_id, campaign_id, click_id, amount_minor)
     select o.tenant_id, $2, o.id, k.message_id, m.source_id, k.id, o.total_minor
       from orders o
       join lateral (
         select c.id, c.message_id
           from clicks c
           join messages m2 on m2.tenant_id = c.tenant_id and m2.id = c.message_id
          where c.tenant_id = o.tenant_id
            and c.profile_id = o.profile_id
            and m2.source_type = 'campaign'
            and c.occurred_at <= o.occurred_at
            and c.occurred_at >= o.occurred_at - make_interval(hours => $3::int)
          order by c.occurred_at desc, c.id desc
          limit 1
       ) k on true
       join messages m on m.tenant_id = o.tenant_id and m.id = k.message_id
      where o.tenant_id = $1
        and o.profile_id is not null
        and o.status in ('completed', 'processing')
     returning id`,
    [tenantId, runId, regula.window_hours],
  );

  await pool.query("update attribution_runs set finished_at = now() where id = $1", [runId]);
  return { runId, przypisanych: rows.length, oknoGodzin: regula.window_hours };
}

/** Raport przychodu per kampania z NAJNOWSZEGO zakończonego przebiegu (FR59). */
export async function raportKampanii(tenantId: string, campaignId: string) {
  const pool = getPool();
  const { rows } = await pool.query(
    `with ostatni_przebieg as (
       select id from attribution_runs
        where tenant_id = $1 and finished_at is not null
        order by finished_at desc limit 1
     )
     select
       -- wyslane liczone ze ZDARZENIA sent, nie ze stanu koncowego: mail, ktory potem
       -- odbil albo dostal skarge, NADAL zostal wyslany i raport ma to pokazywac
       (select count(*)::int from message_events e
         join messages m on m.tenant_id = e.tenant_id and m.id = e.message_id
        where e.tenant_id = $1 and e.event_type = 'sent'
          and m.source_type = 'campaign' and m.source_id = $2) as wyslane,
       (select count(*)::int from messages m
         where m.tenant_id = $1 and m.source_type = 'campaign' and m.source_id = $2
           and m.current_state in ('suppressed', 'held')) as zatrzymane,
       (select count(distinct c.message_id)::int from clicks c
         join messages m on m.tenant_id = c.tenant_id and m.id = c.message_id
        where c.tenant_id = $1 and m.source_type = 'campaign' and m.source_id = $2) as klikniecia,
       (select coalesce(sum(a.amount_minor), 0)::text from attributions a
        where a.tenant_id = $1 and a.campaign_id = $2 and a.run_id = (select id from ostatni_przebieg)) as przychod_minor,
       (select count(*)::int from attributions a
        where a.tenant_id = $1 and a.campaign_id = $2 and a.run_id = (select id from ostatni_przebieg)) as zamowien`,
    [tenantId, campaignId],
  );
  return rows[0];
}
