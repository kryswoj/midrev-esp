import type pg from "pg";
import { schematGrafu, type Graf } from "../../domain/automatyzacje/graf";
import { filtrPusty, opiszFiltr, zapytanieFiltrowane, type Filtr, type KontekstFlowSql, type ZrodloSql } from "../../domain/filtry";
import { zapiszZdarzenie } from "../zdarzenia/zapisz-zdarzenie";

/**
 * Filtry profilu automatyzacji liczone na bazie (E4b, plan 3.3):
 *  - filtr profilu flow: przy wejsciu i przed kazda akcja (e-mail, aktualizacja profilu);
 *  - dodatkowe filtry maila: przed tym jednym mailem;
 *  - powtorka obu TUZ PRZED wysylka (bramka w transakcji przejscia w sending), bo wiadomosc
 *    moze czekac w kolejce na limit dobowy, a w tym czasie osoba kupi.
 *
 * Jedna droga ewaluacji: kompilator SQL z `domain/filtry` (parytet z TS pilnuje test), przez
 * `zapytanieFiltrowane` (predykat tenanta skladany strukturalnie, AD-2, AD-42).
 *
 * Modul nie importuje silnika (`przetworz-zdarzenia`), bo woła go tez wysylka kampanii.
 */

type Klient = pg.PoolClient | pg.Pool;

/** Kolumny profilu dla kompilatora (tabela `profiles` pod aliasem `p`). */
export const ZRODLO_PROFILU: ZrodloSql = {
  profil: {
    properties: "p.properties",
    kolumny: { email: "p.email", first_name: "p.first_name", last_name: "p.last_name", phone_number: "p.phone" },
    id: "p.id",
    tenantId: "p.tenant_id",
  },
};

/** Czy profil spelnia filtr (pusty filtr = tak). Kontekst flow: "od startu", "ta automatyzacja". */
export async function profilSpelnia(klient: Klient, tenantId: string, profileId: string, filtr: Filtr | null | undefined, kontekst: KontekstFlowSql | null, teraz = new Date()): Promise<boolean> {
  if (filtrPusty(filtr)) return true;
  const q = zapytanieFiltrowane({ kolumny: "1", zrodloSql: "profiles p", alias: "p", tenantId, filtr, zrodlo: ZRODLO_PROFILU, teraz, kontekst, idWiersza: profileId });
  const { rowCount } = await klient.query(q.sql, q.parametry);
  return (rowCount ?? 0) > 0;
}

/** Kontekst flow z wiersza uczestnika (entered_at jako tekst z bazy, bez utraty mikrosekund). */
export function kontekstUczestnika(u: { id: string | null; flow_id: string; entered_at: string; trigger_event_id: string | null }): KontekstFlowSql {
  return { flowId: u.flow_id, start: u.entered_at, zdarzenieWyzwalajaceId: u.trigger_event_id, uczestnikId: u.id };
}

export type PowodPominiecia = "filtr_profilu" | "dodatkowy_filtr" | "smart_sending" | "blad_definicji";

export const OPISY_POMINIEC: Record<PowodPominiecia, string> = {
  filtr_profilu: "nie spełnia filtra profilu automatyzacji",
  dodatkowy_filtr: "nie spełnia dodatkowego filtra tego maila",
  smart_sending: "smart sending: dostał od nas maila w oknie bez wysyłki",
  blad_definicji: "definicji automatyzacji nie da się odczytać",
};

/**
 * „Skipped Send” w strumieniu metryk (AD-36): mail, ktory NIE wyszedl, z powodem. Emisja
 * w SAVEPOINCIE: limit metryk albo blad strumienia nie moze cofnac decyzji silnika.
 */
export async function emitujPominiecie(
  klient: pg.PoolClient,
  z: { tenantId: string; profileId: string; flowId: string; emailId: string; uczestnikId: string; powod: PowodPominiecia; messageId?: string | null },
): Promise<void> {
  await klient.query("savepoint pominiecie_wysylki");
  try {
    await zapiszZdarzenie(klient, {
      tenantId: z.tenantId,
      metryka: { integracja: "midrev", nazwa: "Skipped Send", mozeWyzwalac: false, wbudowana: true },
      profileId: z.profileId,
      occurredAt: new Date(),
      uniqueId: `skip:${z.uczestnikId}:${z.emailId}`,
      properties: { $flow: z.flowId, "Flow Message": z.emailId, "Skip Reason": z.powod.toUpperCase(), Opis: OPISY_POMINIEC[z.powod] },
      source: "system",
      messageId: z.messageId ?? null,
    });
    await klient.query("release savepoint pominiecie_wysylki");
  } catch (b) {
    await klient.query("rollback to savepoint pominiecie_wysylki");
    console.error(`[automatyzacje] tenant ${z.tenantId}: Skipped Send nie zapisał się: ${String((b as Error)?.message ?? b).slice(0, 200)}`);
  }
}

/**
 * Bramka filtrow tuz przed wysylka wiadomosci z automatyzacji. Wolana w transakcji przejscia
 * queued -> sending (AD-25), po canSendTo. Dotyczy wylacznie wersji z filtrami (v3): flow bez
 * nich przechodza bez zadnego zapytania, wiec ich zachowanie sie nie zmienia.
 *
 * Nie blokuje wiersza uczestnika (ten moze trzymac worker przejsc: kolejnosc blokad
 * wiadomosc -> uczestnik vs uczestnik -> wiadomosc grozilaby zakleszczeniem). Slad w sciezce
 * osoby to dopisany wiersz flow_transitions (append-only); wyjscie osoby z flow nastapi przy
 * jej nastepnej akcji (filtr profilu jest sprawdzany przed kazda).
 */
export async function bramkaFiltrowPrzedWysylka(
  klient: pg.PoolClient,
  tenantId: string,
  m: { journeyRunId: string; emailId: string; messageId: string },
): Promise<{ wolno: true } | { wolno: false; powod: PowodPominiecia; opis: string }> {
  const { rows } = await klient.query(
    `select p.id, p.flow_id, p.profile_id, p.version, p.node_id, p.entered_at::text as entered_at, p.trigger_event_id, v.definition
       from flow_participants p
       join flow_versions v on v.tenant_id = p.tenant_id and v.flow_id = p.flow_id and v.version = p.version
      where p.tenant_id = $1 and p.id = $2`,
    [tenantId, m.journeyRunId],
  );
  const u = rows[0];
  if (!u) return { wolno: true };
  // tani test bez parsowania: definicja bez filtrow (v1, v2, v3 bez filtrow) nie ma czego sprawdzac
  const tekst = JSON.stringify(u.definition);
  if (!tekst.includes('"filtrProfilu"') && !tekst.includes('"dodatkoweFiltry"')) return { wolno: true };
  const parsed = schematGrafu.safeParse(u.definition);
  const g: Graf | null = parsed.success ? parsed.data : null;
  let powod: PowodPominiecia | null = null;
  let filtrOpis = "";
  if (!g) powod = "blad_definicji";
  else {
    const kontekst = kontekstUczestnika(u);
    const wezelMaila = g.wezly.find((w) => w.typ === "email" && w.emailId === m.emailId);
    if (!(await profilSpelnia(klient, tenantId, u.profile_id, g.ustawienia.filtrProfilu, kontekst))) {
      powod = "filtr_profilu";
      filtrOpis = opiszFiltr(g.ustawienia.filtrProfilu);
    } else if (wezelMaila?.typ === "email" && !(await profilSpelnia(klient, tenantId, u.profile_id, wezelMaila.dodatkoweFiltry, kontekst))) {
      powod = "dodatkowy_filtr";
      filtrOpis = opiszFiltr(wezelMaila.dodatkoweFiltry);
    }
  }
  if (!powod) return { wolno: true };
  const wezelId = g?.wezly.find((w) => w.typ === "email" && w.emailId === m.emailId)?.id ?? u.node_id;
  await klient.query(
    `insert into flow_transitions (tenant_id, participant_id, flow_id, profile_id, version, from_node, to_node, kind, detail, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $6, 'pominieto', $7, now())`,
    [tenantId, u.id, u.flow_id, u.profile_id, u.version, wezelId, JSON.stringify({ emailId: m.emailId, messageId: m.messageId, powod, przyWysylce: true, filtr: filtrOpis })],
  );
  await emitujPominiecie(klient, { tenantId, profileId: u.profile_id, flowId: u.flow_id, emailId: m.emailId, uczestnikId: u.id, powod, messageId: m.messageId });
  return { wolno: false, powod, opis: OPISY_POMINIEC[powod] };
}
