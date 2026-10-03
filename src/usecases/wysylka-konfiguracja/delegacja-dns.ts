import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { getPool } from "../../adapters/db/pool";
import { portRoute53 } from "../../adapters/aws/fabryka";
import { czyBrakRekordu, type ResolverDns } from "../../adapters/email/dns";
import { resolverAutorytatywnySystemowy, type OdpowiedzAutorytatywna, type ResolverAutorytatywny, type TypZapytania } from "../../adapters/email/dns-autorytatywny";
import type { RekordPlatformowy } from "../../domain/email/domena-platformowa";
import type { DostawcaDns } from "../../domain/email/dostawcy-dns";
import {
  nazwaBezKropki,
  ocenDelegacje,
  rekordyStrefyDelegowanej,
  roznicaStrefy,
  TAG_TENANTA,
  type OcenaDelegacji,
  type PortRoute53,
  type StrefaRoute53,
} from "../../domain/email/route53";
import { BladAws } from "../../domain/email/ses";

/**
 * „Jeden wpis u dostawcy": subdomena wysyłkowa delegowana rekordem NS do strefy Route 53
 * platformy. Ten plik zakłada strefę (idempotentnie), utrzymuje w niej rekordy i ocenia,
 * co klient wpisał u siebie.
 *
 * Izolacja tenantów (AD-2): strefa jest czytana WYŁĄCZNIE przez wiersz dns_hosted_zones
 * z predykatem tenant_id. Strefa w AWS jest „nasza" tylko wtedy, gdy ma CallerReference
 * z tego wiersza; tag midrev_tenant innego tenanta = odmowa i alert. Nie ma tu żadnej
 * ścieżki, która przyjmuje identyfikator strefy z formularza.
 *
 * Komunikaty dla klienta po ludzku; kody AWS idą wyłącznie do alertu operatora.
 */

type Alert = (tresc: string) => Promise<void>;

export interface OpcjeDelegacji {
  route53?: PortRoute53 | null;
  autorytatywny?: ResolverAutorytatywny;
  alert: Alert;
  teraz?: Date;
}

// Po AccessDenied opcja znika na 15 minut w tym procesie: bez zalewu alertów i bez
// pokazywania klientom ścieżki, która i tak się nie uda.
let zablokowanyDo = 0;
let alertBrakuKluczy = false;

/** Tylko testy. */
export function wyczyscBlokadeRoute53() {
  zablokowanyDo = 0;
  alertBrakuKluczy = false;
}

export function route53Z(o: { route53?: PortRoute53 | null; teraz?: Date }): PortRoute53 | null {
  if (o.route53 !== undefined) return o.route53;
  if ((o.teraz ?? new Date()).getTime() < zablokowanyDo) return null;
  return portRoute53();
}

/** Alert operatora raz na proces, gdy delegacja jest włączona flagą, a nie ma kluczy. */
export async function zglosBrakRoute53(wlaczona: boolean, port: PortRoute53 | null, alert: Alert) {
  if (!wlaczona || port || alertBrakuKluczy) return;
  alertBrakuKluczy = true;
  await alert("delegacja NS: ROUTE53_DELEGACJA=1, ale brak kluczy AWS (AWS_SES_ACCESS_KEY_ID/SECRET). Kreator pokazuje tylko rekordy ręczne.");
}

async function obsluzBladRoute53(b: unknown, co: string, o: OpcjeDelegacji) {
  if (b instanceof BladAws && b.brakUprawnien) {
    zablokowanyDo = (o.teraz ?? new Date()).getTime() + 15 * 60_000;
    await o.alert(
      `delegacja NS: brak uprawnień Route 53 przy „${co}" (${b.kod}). Opcja „jeden wpis" ukryta na 15 minut; klienci widzą rekordy ręczne. Dodaj politykę IAM z raportu 08-delegacja-ns.md.`,
    );
    return;
  }
  await o.alert(`delegacja NS: ${co} nie powiodło się: ${b instanceof BladAws ? `${b.kod}: ${b.message}` : String((b as Error)?.message ?? b).slice(0, 300)}`);
}

// ── Czy proponować „jeden wpis" ─────────────────────────────────────────────────

export type PowodBrakuDelegacji = "apex" | "zajeta_nazwa" | "dostawca" | "route53" | "niesprawdzona";

/**
 * Delegacja przejmuje WSZYSTKO pod nazwą subdomeny. Nie proponujemy jej, gdy:
 *   - wysyłka idzie z domeny głównej (NS na „@" = cała domena u nas, wykluczone),
 *   - pod tą nazwą już coś działa (strona, poczta): NS by to wyłączył,
 *   - panel dostawcy nie pozwala na NS dla subdomeny.
 */
export async function powodBrakuDelegacji(
  o: { domena: string; strefa: string; dostawca: DostawcaDns; tenantId?: string },
  resolver: ResolverDns,
): Promise<PowodBrakuDelegacji | null> {
  // NS wskazujący na strefę TEGO tenanta (ponowne podłączenie po odłączeniu) to nie „zajęta nazwa"
  const swoje = new Set<string>();
  if (o.tenantId) {
    const { rows } = await getPool().query<{ name_servers: string[] }>(
      "select name_servers from dns_hosted_zones where tenant_id = $1 and domain = $2",
      [o.tenantId, nazwaBezKropki(o.domena)],
    );
    for (const n of rows[0]?.name_servers ?? []) swoje.add(nazwaBezKropki(n));
  }
  if (o.domena === o.strefa) return "apex";
  if (!o.dostawca.nsDlaSubdomeny) return "dostawca";
  const zapytania: (() => Promise<unknown[]>)[] = [
    // subdomena już przekazana komuś innemu (własny NS): przejęcie jej wyłączyłoby tamtą usługę (review r2, P1)
    async () => (resolver.ns ? (await resolver.ns(o.domena)).filter((n) => !swoje.has(nazwaBezKropki(n))) : []),
    () => resolver.a(o.domena),
    () => resolver.aaaa(o.domena),
    () => resolver.cname(o.domena),
    () => resolver.mx(o.domena),
    () => resolver.txt(o.domena),
  ];
  for (const z of zapytania) {
    // awaria DNS to NIE dowód, że nazwa jest wolna (review r1, P1): jedna powtórka, potem
    // „niesprawdzona" — kreator zostaje przy rekordach, a worker spróbuje ponownie później
    let ok = false;
    for (let proba = 0; proba < 2 && !ok; proba++) {
      try {
        if ((await z()).length) return "zajeta_nazwa";
        ok = true;
      } catch (b) {
        if (czyBrakRekordu(b)) ok = true;
      }
    }
    if (!ok) return "niesprawdzona";
  }
  return null;
}

// ── Strefa ─────────────────────────────────────────────────────────────────────

export interface StrefaTenanta {
  id: string;
  zoneId: string;
  serweryNs: string[];
}

/** CallerReference z wiersza rezerwacji: unikalny na (tenant, domena, próba). */
export function callerReferenceZWiersza(tenantId: string, domena: string, wierszId: string): string {
  return `midrev-${createHash("sha256").update(`${tenantId}:${nazwaBezKropki(domena)}:${wierszId}`).digest("hex").slice(0, 48)}`;
}

/**
 * Strefa dla (tenant, domena): istniejąca z bazy albo nowa. Idempotentne:
 *   1. rezerwacja wiersza z CallerReference PRZED wywołaniem AWS,
 *   2. CreateHostedZone; „już istnieje" albo zgubiona odpowiedź → szukamy strefy o tej
 *      nazwie z NASZYM CallerReference (inne strefy o tej nazwie ignorujemy),
 *   3. tag midrev_tenant (obcy tag = odmowa), potwierdzony odczytem,
 *   4. zapis identyfikatora i serwerów NS z odczytem zwrotnym.
 */
export async function zapewnijStrefe(tenantId: string, domena: string, r53: PortRoute53, o: OpcjeDelegacji): Promise<StrefaTenanta | null> {
  const pool = getPool();
  const d = nazwaBezKropki(domena);
  const klient = await pool.connect();
  try {
    // blokada sesyjna na (tenant, domena): dwa równoległe podłączenia nie założą dwóch stref
    await klient.query("select pg_advisory_lock(hashtext('strefa-r53:' || $1 || ':' || $2))", [tenantId, d]);
    try {
      const noweId = uuidv7();
      await klient.query(
        `insert into dns_hosted_zones (id, tenant_id, domain, caller_reference) values ($1, $2, $3, $4)
         on conflict (tenant_id, domain) do nothing`,
        [noweId, tenantId, d, callerReferenceZWiersza(tenantId, d, noweId)],
      );
      const { rows: w } = await klient.query<{ id: string; caller_reference: string; zone_id: string | null }>(
        "select id, caller_reference, zone_id from dns_hosted_zones where tenant_id = $1 and domain = $2",
        [tenantId, d],
      );
      const wiersz = w[0];
      if (!wiersz) return null;

      let strefa: StrefaRoute53 | null = null;
      if (wiersz.zone_id) {
        strefa = await r53.odczytajStrefe(wiersz.zone_id);
        if (!strefa || strefa.nazwa !== d || strefa.callerReference !== wiersz.caller_reference) {
          await o.alert(`delegacja NS: strefa ${wiersz.zone_id} tenanta ${tenantId} (${d}) zniknęła albo nie pasuje. Usuń wiersz dns_hosted_zones ${wiersz.id} ręcznie, żeby założyć nową.`);
          return null;
        }
      } else {
        try {
          strefa = await r53.utworzStrefe(d, { callerReference: wiersz.caller_reference, komentarz: `midrev tenant ${tenantId}` });
        } catch (b) {
          if (b instanceof BladAws && !b.juzIstnieje) throw b;
          // „już istnieje" albo przerwane połączenie: strefa mogła powstać
          const nasze = (await r53.strefyONazwie(d)).filter((s) => s.callerReference === wiersz.caller_reference);
          if (!nasze[0]) throw b;
          strefa = nasze[0];
        }
      }

      const tagi = await r53.tagiStrefy(strefa.id);
      if (tagi[TAG_TENANTA] && tagi[TAG_TENANTA] !== tenantId) {
        await o.alert(`delegacja NS: strefa ${strefa.id} (${d}) ma tag innego tenanta (${tagi[TAG_TENANTA]}), a CallerReference tenanta ${tenantId}. Odmówiono, sprawdź ręcznie.`);
        return null;
      }
      if (tagi[TAG_TENANTA] !== tenantId) {
        await r53.ustawTagiStrefy(strefa.id, { [TAG_TENANTA]: tenantId, midrev_domena: d });
        if ((await r53.tagiStrefy(strefa.id))[TAG_TENANTA] !== tenantId) {
          await o.alert(`delegacja NS: tag strefy ${strefa.id} nie zapisał się (tenant ${tenantId}).`);
          return null;
        }
      }
      const ns = strefa.serweryNs.length ? strefa.serweryNs : ((await r53.odczytajStrefe(strefa.id))?.serweryNs ?? []);
      if (ns.length < 2) {
        await o.alert(`delegacja NS: strefa ${strefa.id} (${d}) nie ma serwerów NS w odpowiedzi.`);
        return null;
      }
      await klient.query(
        `update dns_hosted_zones set zone_id = $3, name_servers = $4, tagged_at = coalesce(tagged_at, now()), updated_at = now()
          where tenant_id = $1 and id = $2 and (zone_id is null or zone_id = $3)`,
        [tenantId, wiersz.id, strefa.id, ns],
      );
      const { rows: z } = await klient.query<{ zone_id: string; name_servers: string[] }>(
        "select zone_id, name_servers from dns_hosted_zones where tenant_id = $1 and id = $2",
        [tenantId, wiersz.id],
      );
      if (z[0]?.zone_id !== strefa.id || z[0].name_servers.join(",") !== ns.join(",")) {
        await o.alert(`delegacja NS: zapis strefy ${strefa.id} tenanta ${tenantId} nie zgadza się z odczytem.`);
        return null;
      }
      return { id: wiersz.id, zoneId: strefa.id, serweryNs: ns };
    } finally {
      await klient.query("select pg_advisory_unlock(hashtext('strefa-r53:' || $1 || ':' || $2))", [tenantId, d]);
    }
  } catch (b) {
    await obsluzBladRoute53(b, `zakładanie strefy ${d} (tenant ${tenantId})`, o);
    return null;
  } finally {
    klient.release();
  }
}

/** Strefa przypięta do domeny TEGO tenanta (jedyna droga do zone_id). */
async function strefaDomeny(tenantId: string, domainId: string) {
  const { rows } = await getPool().query<{ id: string; zone_id: string | null; name_servers: string[]; domain: string; caller_reference: string; r53_change_id: string | null; r53_change_status: string | null }>(
    `select z.id, z.zone_id, z.name_servers, z.domain, z.caller_reference, d.r53_change_id, d.r53_change_status
       from sending_domains d
       join dns_hosted_zones z on z.tenant_id = d.tenant_id and z.id = d.hosted_zone_id
      where d.tenant_id = $1 and d.id = $2 and d.managed_by = 'platforma'`,
    [tenantId, domainId],
  );
  return rows[0] ?? null;
}

/** Przypięcie strefy do domeny i wybór trybu (tylko ten sam tenant: złożony klucz obcy). */
export async function przypnijStrefe(
  tenantId: string,
  domainId: string,
  strefa: StrefaTenanta | null,
  powod: PowodBrakuDelegacji | null,
  /** true = strefa dochodzi później (ponowienie): klient już pracuje na rekordach, nie zmieniamy mu widoku */
  zostawTryb = false,
) {
  await getPool().query(
    `update sending_domains
        set hosted_zone_id = $3,
            dns_mode = case when $3::uuid is null then 'reczny' when $5 then dns_mode else 'delegacja' end,
            delegation_unavailable = $4
      where tenant_id = $1 and id = $2 and managed_by = 'platforma'`,
    [tenantId, domainId, strefa?.id ?? null, strefa ? null : powod, zostawTryb],
  );
}

// ── Rekordy w strefie ───────────────────────────────────────────────────────────

/**
 * Doprowadza strefę do stanu oczekiwanego (UPSERT brakujących, DELETE zbędnych) i zapisuje
 * datę synchronizacji dopiero po odczycie zwrotnym zgodnym z oczekiwanym.
 * Zwraca false przy błędzie (alert poszedł) albo braku strefy.
 */
export async function synchronizujStrefe(
  tenantId: string,
  domainId: string,
  rekordy: readonly RekordPlatformowy[],
  r53: PortRoute53,
  o: OpcjeDelegacji,
): Promise<boolean> {
  const z = await strefaDomeny(tenantId, domainId);
  if (!z?.zone_id || !rekordy.length) return false;
  const pool = getPool();
  try {
    const chciane = rekordyStrefyDelegowanej(rekordy);
    const zmiany = roznicaStrefy(z.domain, await r53.rekordy(z.zone_id), chciane);
    if (zmiany.length) {
      // Przed KAŻDĄ zmianą: strefa w AWS nadal jest tą, którą założyliśmy dla tego tenanta
      // (nazwa, CallerReference z wiersza, tag). Pomyłka operatora albo przestawiony tag =
      // stop i alert, bez zapisu (review r1, P2).
      const wAws = await r53.odczytajStrefe(z.zone_id);
      const tagi = wAws ? await r53.tagiStrefy(z.zone_id) : {};
      if (!wAws || wAws.nazwa !== z.domain || wAws.callerReference !== z.caller_reference || tagi[TAG_TENANTA] !== tenantId) {
        await o.alert(`delegacja NS: strefa ${z.zone_id} nie zgadza się z zapisem tenanta ${tenantId} (nazwa, CallerReference albo tag). Rekordy NIE zostały zmienione; sprawdź ręcznie.`);
        return false;
      }
      const wynik = await r53.zmienRekordy(z.zone_id, zmiany, `midrev: rekordy wysylki ${z.domain}`);
      const poZmianie = roznicaStrefy(z.domain, await r53.rekordy(z.zone_id), chciane);
      if (poZmianie.length) {
        await o.alert(`delegacja NS: po zmianie w strefie ${z.zone_id} (tenant ${tenantId}) nadal ${poZmianie.length} rozbieżności.`);
        return false;
      }
      await pool.query(
        `update sending_domains set r53_change_id = $3, r53_change_status = $4, r53_synced_at = $5
          where tenant_id = $1 and id = $2 and managed_by = 'platforma'`,
        [tenantId, domainId, wynik.changeId, wynik.stan, o.teraz ?? new Date()],
      );
      return true;
    }
    let stan = z.r53_change_status;
    if (z.r53_change_id && stan === "PENDING") stan = await r53.stanZmiany(z.r53_change_id);
    await pool.query(
      `update sending_domains set r53_change_status = $3, r53_synced_at = coalesce(r53_synced_at, $4)
        where tenant_id = $1 and id = $2 and managed_by = 'platforma'`,
      [tenantId, domainId, z.r53_change_id ? stan : null, o.teraz ?? new Date()],
    );
    return true;
  } catch (b) {
    await obsluzBladRoute53(b, `synchronizacja rekordów strefy ${z.domain} (tenant ${tenantId})`, o);
    return false;
  }
}

// ── Co klient wpisał u siebie ───────────────────────────────────────────────────

async function zapytajLubNull(a: ResolverAutorytatywny, nazwa: string, typ: TypZapytania, serwery: string[]): Promise<OdpowiedzAutorytatywna | null> {
  try {
    return await a.zapytaj(nazwa, typ, serwery);
  } catch {
    return null;
  }
}

function serweryNs(o: OdpowiedzAutorytatywna | null, wlasciciel: string): string[] {
  if (!o) return [];
  return [...o.odpowiedzi, ...o.autorytet].filter((r) => r.typ === "NS" && r.nazwa === wlasciciel).map((r) => nazwaBezKropki(r.dane));
}

/**
 * Ocena delegacji: pyta serwery dostawcy klienta (widok rodzica: co jest wpisane) i zwykły
 * resolver (co widzi internet). Zapisuje stan w bazie i przestawia tryb na „delegacja",
 * gdy wpis NS działa (klient mógł go dodać mimo wybranej ścieżki ręcznej).
 */
export async function sprawdzDelegacje(
  tenantId: string,
  domainId: string,
  d: { domena: string; strefa: string; nazwaWzgledna: string },
  resolver: ResolverDns,
  o: OpcjeDelegacji,
): Promise<OcenaDelegacji | null> {
  const z = await strefaDomeny(tenantId, domainId);
  if (!z?.zone_id || z.name_servers.length < 2) return null;
  const auth = o.autorytatywny ?? resolverAutorytatywnySystemowy(resolver);
  const domena = nazwaBezKropki(d.domena);
  const strefa = nazwaBezKropki(d.strefa);

  // Serwery dostawcy = NS domeny głównej BEZ naszych. Gdy klient dopisał nasze serwery do
  // domeny głównej, resolver zwraca je razem z serwerami dostawcy; pytanie naszych udawałoby
  // „działa" i ukryło awarię strony (review r1, P1). Nasze w tym zestawie = PILNE od razu.
  const naszeSet = new Set(z.name_servers.map(nazwaBezKropki));
  let nsApexPubliczne: string[] = [];
  try {
    nsApexPubliczne = (await resolver.ns!(strefa)).map(nazwaBezKropki);
  } catch {
    nsApexPubliczne = [];
  }
  // (filtr tylko po NASZYCH serwerach: klient może sam trzymać domenę w Route 53 na swoim koncie)
  const serweryRodzica = nsApexPubliczne.filter((n) => !naszeSet.has(n));
  const nsDomeny = serweryRodzica.length ? await zapytajLubNull(auth, domena, "NS", serweryRodzica) : null;
  const rodzic = nsDomeny ? serweryNs(nsDomeny, domena) : null;
  const podwojona = rodzic && !rodzic.length ? serweryNs(await zapytajLubNull(auth, `${domena}.${strefa}`, "NS", serweryRodzica), `${domena}.${strefa}`) : [];
  const apex = [
    ...nsApexPubliczne,
    ...(serweryRodzica.length ? serweryNs(await zapytajLubNull(auth, strefa, "NS", serweryRodzica), strefa) : []),
  ];

  // Stary wpis pod samą nazwą subdomeny, który serwer dostawcy podaje Z AUTORYTETEM obok
  // (albo zamiast) NS: przy poprawnej delegacji serwer odsyła dalej i nie ma tu odpowiedzi.
  const konflikty: string[] = [];
  if (serweryRodzica.length) {
    for (const typ of ["CNAME", "A", "MX", "TXT"] as const) {
      const q = await zapytajLubNull(auth, domena, typ, serweryRodzica);
      if (q?.autorytatywna && q.odpowiedzi.some((r) => r.nazwa === domena && r.typ === typ)) konflikty.push(typ);
      if (typ === "CNAME" && q?.odpowiedzi.some((r) => r.nazwa === domena && r.typ === "CNAME")) break; // CNAME wyklucza resztę
    }
  }
  // bez żadnego NS wpis A/TXT pod news to po prostu inna usługa, a nie pomyłka przy NS
  const istotneKonflikty = rodzic?.length || podwojona.length || konflikty.includes("CNAME") ? konflikty : [];

  let publicznie: string[] | null = null;
  try {
    publicznie = (await resolver.ns!(domena)).map(nazwaBezKropki);
  } catch (b) {
    publicznie = czyBrakRekordu(b) ? [] : null;
  }

  const ocena = ocenDelegacje({
    domena,
    strefa,
    nasze: z.name_servers,
    nazwaWzgledna: d.nazwaWzgledna,
    rodzic,
    podwojona,
    apex,
    konflikty: istotneKonflikty,
    publicznie,
  });
  await getPool().query(
    `update sending_domains
        set delegation_state = $3, delegation_details = $4, delegation_checked_at = $5,
            dns_mode = case when $3 = 'dziala' then 'delegacja' else dns_mode end
      where tenant_id = $1 and id = $2 and managed_by = 'platforma'`,
    [tenantId, domainId, ocena.stan, JSON.stringify(ocena), o.teraz ?? new Date()],
  );
  return ocena;
}

/** Klient wpisał rekordy ręcznie, a NS nie ma: tryb „reczny" (inna tabela jako główna). */
export async function przelaczNaRecznyGdyRekordy(tenantId: string, domainId: string) {
  await getPool().query(
    `update sending_domains set dns_mode = 'reczny'
      where tenant_id = $1 and id = $2 and managed_by = 'platforma' and dns_mode = 'delegacja' and delegation_state = 'brak'`,
    [tenantId, domainId],
  );
}
