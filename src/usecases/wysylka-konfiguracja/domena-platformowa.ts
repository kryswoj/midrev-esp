import type { PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";
import { czyBrakRekordu, resolverSystemowy, type ResolverDns } from "../../adapters/email/dns";
import { portSes } from "../../adapters/aws/fabryka";
import { config } from "../../config";
import {
  decyzjaDmarc,
  porownajCel,
  rekordyPlatformowe,
  nazwaWzgledna,
  rozbierzWpis,
  zaproponujUklad,
  type DecyzjaDmarc,
  type KluczRekordu,
  type RekordPlatformowy,
  type UkladDomeny,
} from "../../domain/email/domena-platformowa";
import { dostawcaPoKluczu, rozpoznajDostawce, type DostawcaDns } from "../../domain/email/dostawcy-dns";
import type { ResolverAutorytatywny } from "../../adapters/email/dns-autorytatywny";
import type { OcenaDelegacji, PortRoute53 } from "../../domain/email/route53";
import {
  powodBrakuDelegacji,
  przelaczNaRecznyGdyRekordy,
  przypnijStrefe,
  route53Z,
  sprawdzDelegacje,
  synchronizujStrefe,
  zapewnijStrefe,
  type PowodBrakuDelegacji,
} from "./delegacja-dns";
import { BladAws, celKompletny, nazwaConfigurationSetu, nazwaTenantaSes, type PortSes, type StatusSes, type TozsamoscSes } from "../../domain/email/ses";

/**
 * Wysyłka platformowa: kreator „Podłącz domenę" (krok a: propozycja, b: założenie
 * tożsamości i rekordy, c: sprawdzanie). Klient nie widzi słów SES/SMTP/MAIL FROM —
 * komunikaty z tego pliku idą prosto do panelu, więc są pisane po ludzku. Szczegóły
 * techniczne (kody AWS) idą do alertu operatora, nie do klienta.
 *
 * Izolacja tenantów (AD-2): każde zapytanie ma predykat tenant_id; domena platformowa
 * jest dodatkowo unikalna globalnie (indeks 0040) i nie może nachodzić na domenę innego
 * tenanta (sprawdzenie niżej): tożsamość SES weryfikuje też subdomeny, a poświadczenia
 * SMTP platformy są wspólne — bez tego sklep B mógłby wysyłać jako sklep A.
 *
 * DŁUG (AD-18): SQL w use-case, jak w domeny.ts i serwer.ts.
 */

type Wynik<T = object> = ({ ok: true } & T) | { ok: false; blad: string };

export interface OpcjeDomeny {
  resolver?: ResolverDns;
  ses?: PortSes | null;
  teraz?: Date;
  /** alert operatora (kody AWS); domyślnie jobs/alerty */
  alert?: (tresc: string) => Promise<void>;
  /** Route 53 (delegacja „jeden wpis"); undefined = z fabryki, null = wyłączone */
  route53?: PortRoute53 | null;
  /** zapytania wprost do serwerów dostawcy klienta (testy: atrapa) */
  autorytatywny?: ResolverAutorytatywny;
}

function opcjeDelegacji(o: OpcjeDomeny) {
  return { route53: o.route53, autorytatywny: o.autorytatywny, teraz: o.teraz, alert: (t: string) => alertOperatora(o, t) };
}

async function alertOperatora(o: OpcjeDomeny, tresc: string) {
  if (o.alert) return o.alert(tresc);
  const { wyslijAlert } = await import("../../jobs/alerty");
  await wyslijAlert(tresc, { poziom: "uwaga" });
}

function sesZOpcji(o: OpcjeDomeny): PortSes | null {
  return o.ses === undefined ? portSes() : o.ses;
}

// ── Strefa DNS i dostawca ───────────────────────────────────────────────────────

export interface Strefa {
  strefa: string;
  serweryNs: string[];
  dostawca: DostawcaDns;
}

/**
 * Strefa = najbliższa w górę nazwa z rekordami NS (dla news.sklep.pl zwykle sklep.pl).
 * Zatrzymujemy się przed domeną najwyższego poziomu. `null` = domena nie istnieje w DNS.
 */
export async function znajdzStrefe(domena: string, resolver: ResolverDns): Promise<Strefa | null | "awaria"> {
  if (!resolver.ns) return null;
  const etykiety = domena.split(".");
  for (let i = 0; i < etykiety.length - 1; i++) {
    const nazwa = etykiety.slice(i).join(".");
    try {
      const ns = await resolver.ns(nazwa);
      if (ns.length) return { strefa: nazwa, serweryNs: ns, dostawca: rozpoznajDostawce(ns) };
    } catch (b) {
      if (!czyBrakRekordu(b)) return "awaria";
    }
  }
  return null;
}

async function rekordDmarc(nazwa: string, resolver: ResolverDns): Promise<string | null> {
  try {
    const r = (await resolver.txt(`_dmarc.${nazwa}`)).filter((t) => /^v=DMARC1\s*(;|$)/i.test(t.trim()));
    return r.length === 1 ? r[0] : null;
  } catch (b) {
    if (czyBrakRekordu(b)) return null;
    throw b;
  }
}

// ── Krok a: propozycja ─────────────────────────────────────────────────────────

export interface Propozycja {
  wpis: string;
  strefa: string;
  dostawca: DostawcaDns;
  uklad: UkladDomeny;
  dmarc: DecyzjaDmarc;
  prefiks: string;
  lokalna: string;
  /** własny rekord DMARC subdomeny w strefie klienta (po delegacji przenosimy go do naszej strefy) */
  dmarcWlasny: string | null;
}

/** Propozycja układu z wpisu klienta. Zawsze liczona po stronie serwera, nigdy z formularza. */
export async function przygotujPropozycje(
  wpisSurowy: string,
  o: { prefiks?: string; lokalna?: string; resolver?: ResolverDns } = {},
): Promise<Wynik<{ propozycja: Propozycja }>> {
  const wpis = rozbierzWpis(wpisSurowy);
  if (!wpis) return { ok: false, blad: "Wpisz adres strony albo e-mail, np. sklep.pl albo kontakt@sklep.pl." };
  const resolver = o.resolver ?? resolverSystemowy();
  const strefa = await znajdzStrefe(wpis.domena, resolver);
  if (strefa === "awaria") return { ok: false, blad: "Nie udało się sprawdzić domeny (serwer nazw nie odpowiedział). Spróbuj za minutę." };
  if (!strefa) return { ok: false, blad: `Nie znaleźliśmy domeny ${wpis.domena} w internecie. Sprawdź, czy nie ma literówki.` };
  const uklad = zaproponujUklad({ wpis, strefa: strefa.strefa, prefiks: o.prefiks, lokalna: o.lokalna });
  if (!uklad) return { ok: false, blad: "Ta nazwa nie nadaje się na adres. Użyj małych liter, cyfr i myślnika, np. news albo newsletter." };
  let dmarc: DecyzjaDmarc;
  let dmarcWlasny: string | null = null;
  try {
    dmarcWlasny = uklad.domenaWysylkowa === strefa.strefa ? null : await rekordDmarc(uklad.domenaWysylkowa, resolver);
    dmarc = decyzjaDmarc({
      domenaWysylkowa: uklad.domenaWysylkowa,
      strefa: strefa.strefa,
      rekordStrefy: await rekordDmarc(strefa.strefa, resolver),
      rekordWlasny: dmarcWlasny,
    });
  } catch {
    return { ok: false, blad: "Nie udało się sprawdzić domeny (serwer nazw nie odpowiedział). Spróbuj za minutę." };
  }
  return {
    ok: true,
    propozycja: {
      wpis: wpisSurowy.trim(),
      strefa: strefa.strefa,
      dostawca: strefa.dostawca,
      uklad,
      dmarc,
      prefiks: uklad.domenaGlowna ? "" : uklad.domenaWysylkowa === wpis.domena ? "" : uklad.domenaWysylkowa.slice(0, -(strefa.strefa.length + 1)),
      lokalna: uklad.adresNadawcy.split("@")[0],
      dmarcWlasny,
    },
  };
}

// ── Krok b: podłączenie ────────────────────────────────────────────────────────

const ADRES = /^[^@\s<>,;"()\[\]\\]+@[^@\s<>,;"()\[\]\\]+\.[^@\s<>,;"()\[\]\\]+$/;

function normalizujAdres(s: string): string | null | undefined {
  const a = s.trim().toLowerCase();
  if (!a) return null;
  return a.length <= 320 && ADRES.test(a) ? a : undefined;
}

export interface DanePodlaczenia {
  wpis: string;
  prefiks?: string;
  lokalna?: string;
  nazwaNadawcy: string;
  odpowiedzDo: string;
}

/** Domena platformowa innego tenanta, która jest tą samą domeną, jej nadrzędną albo subdomeną. */
async function kolizjaZInnymTenantem(klient: PoolClient, tenantId: string, domena: string): Promise<boolean> {
  const { rows } = await klient.query(
    `select 1 from sending_domains
      where managed_by = 'platforma' and tenant_id <> $1
        and (domain = $2 or $2 like '%.' || domain or domain like '%.' || $2)
      limit 1`,
    [tenantId, domena],
  );
  return rows.length > 0;
}

export async function podlaczDomene(tenantId: string, dane: DanePodlaczenia, o: OpcjeDomeny = {}): Promise<Wynik<{ domainId: string }>> {
  const ses = sesZOpcji(o);
  if (!ses) return { ok: false, blad: "Podłączanie domen jeszcze nie działa na tym serwerze. Daliśmy znać zespołowi MidRev." };

  const nazwaNadawcy = dane.nazwaNadawcy.replace(/[\r\n\x00]+/g, " ").replace(/\s+/g, " ").trim();
  if (!nazwaNadawcy || nazwaNadawcy.length > 200) return { ok: false, blad: "Podaj nazwę nadawcy, np. nazwę sklepu (do 200 znaków)." };
  const odpowiedzDo = normalizujAdres(dane.odpowiedzDo);
  if (odpowiedzDo === undefined) return { ok: false, blad: "Adres do odpowiedzi musi być jednym adresem e-mail." };

  const p = await przygotujPropozycje(dane.wpis, { prefiks: dane.prefiks, lokalna: dane.lokalna, resolver: o.resolver });
  if (!p.ok) return p;
  const { uklad, strefa, dostawca, dmarc } = p.propozycja;
  const domena = uklad.domenaWysylkowa;

  const pool = getPool();
  // 1. Rezerwacja w bazie PRZED wywołaniem AWS: globalny indeks unikalny rozstrzyga wyścig
  //    dwóch tenantów o tę samą domenę, zanim którykolwiek dotknie SES.
  const klient = await pool.connect();
  let domainId: string;
  try {
    await klient.query("begin");
    // Blokada GLOBALNA (nie per tenant): kolizję „ta sama / nadrzędna / subdomena innego
    // tenanta" sprawdzamy odczytem, a indeks unikalny łapie tylko identyczną nazwę. Bez
    // wspólnej blokady dwa tenanty mogłyby równolegle zarezerwować example.com i
    // news.example.com (review Codeksa r1, P1). Podłączenie domeny to rzadka operacja.
    await klient.query("select pg_advisory_xact_lock(hashtext('domena-platformowa:globalna'))");
    const { rows: wlasny } = await klient.query("select 1 from tenant_smtp_configs where tenant_id = $1", [tenantId]);
    if (wlasny.length) {
      await klient.query("rollback");
      return { ok: false, blad: "To konto wysyła przez własny serwer (Zaawansowane). Wyłącz go, żeby podłączyć domenę przez MidRev." };
    }
    const { rows: obecna } = await klient.query(
      "select domain from sending_domains where tenant_id = $1 and managed_by = 'platforma'",
      [tenantId],
    );
    if (obecna.length) {
      await klient.query("rollback");
      return { ok: false, blad: `Masz już podłączoną domenę ${obecna[0].domain}. Usuń ją, jeśli chcesz podłączyć inną.` };
    }
    if (await kolizjaZInnymTenantem(klient, tenantId, domena)) {
      await klient.query("rollback");
      return { ok: false, blad: "Ta domena jest już podłączona na innym koncie. Napisz do nas, wyjaśnimy to." };
    }
    const { rows: ins } = await klient.query(
      `insert into sending_domains (tenant_id, domain, managed_by, zone_apex, dns_provider, ses_mail_from_domain, dmarc_proposal, status)
       values ($1, $2, 'platforma', $3, $4, $5, $6, 'pending')
       on conflict do nothing
       returning id`,
      [tenantId, domena, strefa, dostawca.klucz, uklad.mailFrom, dmarc.propozycja],
    );
    if (!ins[0]) {
      await klient.query("rollback");
      return { ok: false, blad: `Domena ${domena} jest już dodana na tym albo innym koncie.` };
    }
    domainId = ins[0].id;
    await klient.query(
      `insert into tenant_platform_senders (tenant_id, sending_domain_id, from_name, from_email, reply_to)
       values ($1, $2, $3, $4, $5)`,
      [tenantId, domainId, nazwaNadawcy, uklad.adresNadawcy, odpowiedzDo],
    );
    await klient.query("commit");
  } catch (b) {
    await klient.query("rollback").catch(() => {});
    if ((b as { code?: string }).code === "23505") return { ok: false, blad: "Ta domena jest już podłączona na innym koncie. Napisz do nas, wyjaśnimy to." };
    throw b;
  } finally {
    klient.release();
  }

  // 2. AWS. Każdy błąd cofa rezerwację: klient nie zostaje z domeną, której nie ma w SES.
  const cofnij = async () => {
    await pool.query("delete from sending_domains where tenant_id = $1 and id = $2 and managed_by = 'platforma'", [tenantId, domainId]);
  };
  const cs = nazwaConfigurationSetu(tenantId);
  let tozsamosc: TozsamoscSes;
  try {
    await ses.utworzConfigurationSet(cs, { midrev_tenant: tenantId });
    try {
      tozsamosc = await ses.utworzTozsamosc(domena, { configurationSet: cs, tagi: { midrev_tenant: tenantId, midrev_domena: domainId } });
    } catch (b) {
      if (!(b instanceof BladAws && b.juzIstnieje)) throw b;
      // Tożsamość już jest na koncie AWS. Przejmujemy ją WYŁĄCZNIE, gdy należy do tego
      // samego tenanta (tag z naszego wcześniejszego podejścia); obca = odmowa.
      const istniejaca = await ses.odczytajTozsamosc(domena);
      if (!istniejaca || istniejaca.tagi.midrev_tenant !== tenantId) {
        await cofnij();
        await alertOperatora(o, `podłączanie domeny: ${domena} istnieje już w SES i nie należy do tenanta ${tenantId} (tag ${istniejaca?.tagi.midrev_tenant ?? "brak"}). Odmówiono.`);
        return { ok: false, blad: "Ta domena jest już podłączona w innym miejscu. Napisz do nas, wyjaśnimy to." };
      }
      if (istniejaca.configurationSet !== cs) await ses.ustawConfigurationSetTozsamosci(domena, cs);
      tozsamosc = { ...istniejaca, configurationSet: cs };
    }
    await ses.ustawMailFrom(domena, uklad.mailFrom);
    // zestaw przypisany tenantowi dopiero po udanym założeniu tożsamości (review r1, P2)
    await pool.query("update tenants set ses_configuration_set = $2 where id = $1 and ses_configuration_set is distinct from $2", [tenantId, cs]);
  } catch (b) {
    await cofnij();
    const opis = b instanceof BladAws ? `${b.kod}: ${b.message}` : String((b as Error)?.message ?? b).slice(0, 300);
    await alertOperatora(
      o,
      b instanceof BladAws && b.brakUprawnien
        ? `podłączanie domeny ${domena} (tenant ${tenantId}): brak uprawnień IAM w SES (${opis}). Sprawdź politykę użytkownika aplikacji.`
        : `podłączanie domeny ${domena} (tenant ${tenantId}) nie powiodło się: ${opis}`,
    );
    return { ok: false, blad: "Nie udało się podłączyć domeny po naszej stronie. Zespół MidRev dostał powiadomienie, spróbuj za kilka minut." };
  }

  // 3. Opcjonalnie: cel zdarzeń (SNS) i SES Tenants. Błąd = alert operatora, NIE błąd klienta.
  await podepnijZasobyOpcjonalne(tenantId, domena, cs, ses, o);

  // 4. Zapis odpowiedzi SES z odczytem zwrotnym.
  if (!tozsamosc.strefaPodpisu || tozsamosc.dkimTokeny.length < 3) {
    await alertOperatora(o, `podłączanie domeny ${domena}: SES nie zwrócił kompletu tokenów DKIM (${tozsamosc.dkimTokeny.length}).`);
  }
  await zapiszStanSes(tenantId, domainId, tozsamosc, o.teraz ?? new Date());

  // 5. „Jeden wpis u dostawcy": strefa Route 53 dla subdomeny. Każdy błąd = alert
  //    operatora i zwykła ścieżka z rekordami; klient nie widzi z tego nic technicznego.
  await przygotujDelegacje(tenantId, domainId, { domena, strefa, dostawca, dmarcWlasny: p.propozycja.dmarcWlasny }, o);

  await pool.query("update sending_domains set next_check_at = $3 where tenant_id = $1 and id = $2", [
    tenantId,
    domainId,
    new Date((o.teraz ?? new Date()).getTime() + 60_000),
  ]);
  const { rows } = await pool.query(
    "select domain, ses_dkim_tokens, ses_mail_from_domain from sending_domains where tenant_id = $1 and id = $2",
    [tenantId, domainId],
  );
  if (!rows[0] || rows[0].domain !== domena || rows[0].ses_mail_from_domain !== uklad.mailFrom) {
    return { ok: false, blad: "Zapis domeny nie zgadza się z odczytem z bazy. Spróbuj ponownie." };
  }
  return { ok: true, domainId };
}

/**
 * Strefa Route 53 i rekordy w niej, gdy delegacja ma sens (subdomena, wolna nazwa, panel
 * pozwala na NS). Bez Route 53 albo przy błędzie domena zostaje w trybie ręcznym.
 */
async function przygotujDelegacje(
  tenantId: string,
  domainId: string,
  p: { domena: string; strefa: string; dostawca: DostawcaDns; dmarcWlasny: string | null },
  o: OpcjeDomeny,
  zostawTryb = false,
) {
  const od = opcjeDelegacji(o);
  const r53 = route53Z(od);
  let powod: PowodBrakuDelegacji | null = r53 ? await powodBrakuDelegacji({ ...p, tenantId }, o.resolver ?? resolverSystemowy()) : "route53";
  if (powod || !r53) {
    await przypnijStrefe(tenantId, domainId, null, powod);
    return;
  }
  const strefa = await zapewnijStrefe(tenantId, p.domena, r53, od);
  if (!strefa) powod = "route53";
  await przypnijStrefe(tenantId, domainId, strefa, powod, zostawTryb);
  if (!strefa) return;
  // Własny DMARC subdomeny ze strefy klienta po delegacji przestanie być widoczny:
  // przenosimy go do naszej strefy bez zmian.
  if (p.dmarcWlasny) {
    await getPool().query("update sending_domains set dmarc_proposal = $3 where tenant_id = $1 and id = $2 and dmarc_proposal is null", [
      tenantId,
      domainId,
      /^v=DMARC1;/.test(p.dmarcWlasny) && p.dmarcWlasny.length <= 500 ? p.dmarcWlasny : null,
    ]);
  }
  const d = await domenaPlatformowaPoId(tenantId, domainId);
  if (d?.rekordy.length) await synchronizujStrefe(tenantId, domainId, d.rekordy, r53, od);
}

/**
 * Event destination (SNS) i SES Tenants: włączane flagami. AccessDenied (uprawnień SNS
 * jeszcze nie ma) = czytelny alert dla OPERATORA; klient tego nie widzi i kreator idzie dalej.
 */
export async function podepnijZasobyOpcjonalne(tenantId: string, domena: string, cs: string, ses: PortSes, o: OpcjeDomeny = {}) {
  const k = config();
  if (k.SES_ZDARZENIA_SNS && k.SES_SNS_TOPIC_ARN[0]) {
    try {
      await ses.dodajCelZdarzen(cs, "midrev-sns", k.SES_SNS_TOPIC_ARN[0]);
      // potwierdzenie odczytem: cel jest w zestawie i wskazuje NASZ temat
      const cele = await ses.celeZdarzen(cs);
      if (cele.some((c) => celKompletny(c, k.SES_SNS_TOPIC_ARN[0]))) {
        await getPool().query("update tenants set ses_events_destination_at = coalesce(ses_events_destination_at, now()) where id = $1 and ses_configuration_set = $2", [tenantId, cs]);
      }
    } catch (b) {
      await alertOperatora(
        o,
        b instanceof BladAws && b.brakUprawnien
          ? `zdarzenia SES: brak uprawnień do dodania celu SNS w zestawie ${cs} (tenant ${tenantId}). Odbicia i skargi tego klienta NIE dotrą, dopóki polityka IAM nie dostanie ses:CreateConfigurationSetEventDestination, ses:UpdateConfigurationSetEventDestination i ses:GetConfigurationSetEventDestinations.`
          : `zdarzenia SES: nie udało się dodać celu SNS w zestawie ${cs} (tenant ${tenantId}): ${String((b as Error)?.message ?? b).slice(0, 300)}`,
      );
    }
  }
  if (k.SES_TENANTS) {
    const nazwa = nazwaTenantaSes(tenantId);
    const konto = k.AWS_ACCOUNT_ID;
    if (!konto) {
      await alertOperatora(o, "SES_TENANTS włączone, ale brak AWS_ACCOUNT_ID — nie da się zbudować ARN zasobów do powiązania.");
      return;
    }
    try {
      await ses.utworzTenanta(nazwa, { midrev_tenant: tenantId });
      await ses.powiazZasobZTenantem(nazwa, `arn:aws:ses:${ses.region}:${konto}:identity/${domena}`);
      await ses.powiazZasobZTenantem(nazwa, `arn:aws:ses:${ses.region}:${konto}:configuration-set/${cs}`);
      // nagłówek X-SES-TENANT idzie dopiero, gdy powiązania się udały (inaczej SES odrzuci wysyłkę)
      await getPool().query("update tenants set ses_tenant_name = $2 where id = $1", [tenantId, nazwa]);
    } catch (b) {
      await alertOperatora(o, `SES Tenants: nie udało się założyć/powiązać tenanta ${nazwa}: ${String((b as Error)?.message ?? b).slice(0, 300)}. Wysyłka idzie bez X-SES-TENANT.`);
    }
  }
}

async function zapiszStanSes(tenantId: string, domainId: string, t: TozsamoscSes, teraz: Date) {
  await getPool().query(
    `update sending_domains
        set ses_status = $3, ses_dkim_status = $4, ses_mail_from_status = $5, ses_verified_for_sending = $6,
            ses_dkim_tokens = case when cardinality($7::text[]) > 0 then $7::text[] else ses_dkim_tokens end,
            ses_signing_zone = coalesce($8, ses_signing_zone),
            ses_error_type = $9, ses_polled_at = $10
      where tenant_id = $1 and id = $2 and managed_by = 'platforma'`,
    [tenantId, domainId, t.status, t.dkimStatus, t.mailFromStatus, t.gotowaDoWysylki, t.dkimTokeny, t.strefaPodpisu, t.typBledu, teraz],
  );
}

// ── Odczyt ─────────────────────────────────────────────────────────────────────

export type StanRekordu = "ok" | "czeka" | "brak" | "zle";

export interface OcenaRekordu {
  stan: StanRekordu;
  /** co jest nie tak, jednym zdaniem po ludzku (null przy ok) */
  komunikat: string | null;
}

export interface RaportSprawdzenia {
  rekordy: Partial<Record<KluczRekordu, OcenaRekordu>>;
  /** sprawy poza tabelą (np. rekord pocztowy wpisany pod domenę główną) */
  ostrzezenia: string[];
  /** ostatnie sprawdzenie nie dostało odpowiedzi od DNS */
  awaria: boolean;
  sprawdzonoAt: string;
}

export interface DomenaPlatformowa {
  id: string;
  domena: string;
  strefa: string;
  dostawca: DostawcaDns;
  status: "pending" | "partial" | "verified" | "failed";
  gotowa: boolean;
  rekordy: RekordPlatformowy[];
  raport: RaportSprawdzenia | null;
  sesStatus: StatusSes | null;
  zweryfikowanoAt: Date | null;
  sprawdzonoAt: Date | null;
  utworzonoAt: Date;
  nadawca: { nazwa: string; adres: string; odpowiedzDo: string | null } | null;
  mailFrom: string;
  dmarcPropozycja: string | null;
  /** która ścieżka jest główna w kreatorze */
  tryb: "reczny" | "delegacja";
  /** „jeden wpis": serwery naszej strefy i ostatnia ocena; null = opcji nie ma */
  delegacja: {
    nazwa: string;
    serwery: string[];
    ocena: OcenaDelegacji | null;
    sprawdzonoAt: Date | null;
    rekordyZsynchronizowane: boolean;
  } | null;
  /** dlaczego nie proponujemy „jednego wpisu" (apex, zajęta nazwa, panel, brak Route 53) */
  delegacjaNiedostepna: PowodBrakuDelegacji | null;
}

const KOLUMNY = `d.id, d.domain, d.zone_apex, d.dns_provider, d.status, d.check_details, d.ses_status, d.ses_dkim_status,
  d.ses_mail_from_status, d.ses_verified_for_sending, d.ses_dkim_tokens, d.ses_signing_zone, d.ses_mail_from_domain,
  d.dmarc_proposal, d.verified_at, d.last_checked_at, d.created_at,
  d.dns_mode, d.delegation_state, d.delegation_details, d.delegation_checked_at, d.delegation_unavailable, d.r53_synced_at,
  z.zone_id, z.name_servers,
  s.from_name, s.from_email, s.reply_to`;

function zWiersza(w: Record<string, any>, region: string): DomenaPlatformowa {
  const dostawca = dostawcaPoKluczu(w.dns_provider);
  const raport = w.check_details && Array.isArray(w.check_details.ostrzezenia) ? (w.check_details as RaportSprawdzenia) : null;
  return {
    id: w.id,
    domena: w.domain,
    strefa: w.zone_apex,
    dostawca,
    status: w.status,
    gotowa: w.status === "verified" && w.ses_verified_for_sending === true,
    rekordy: w.ses_signing_zone
      ? rekordyPlatformowe({
          domenaWysylkowa: w.domain,
          strefa: w.zone_apex,
          tokeny: w.ses_dkim_tokens ?? [],
          strefaPodpisu: w.ses_signing_zone,
          mailFrom: w.ses_mail_from_domain ?? `bounce.${w.domain}`,
          region,
          dmarcPropozycja: w.dmarc_proposal,
          kropkaNaKoncu: dostawca.kropkaNaKoncu,
        })
      : [],
    raport,
    sesStatus: w.ses_status,
    zweryfikowanoAt: w.verified_at,
    sprawdzonoAt: w.last_checked_at,
    utworzonoAt: w.created_at,
    nadawca: w.from_email ? { nazwa: w.from_name, adres: w.from_email, odpowiedzDo: w.reply_to } : null,
    mailFrom: w.ses_mail_from_domain ?? `bounce.${w.domain}`,
    dmarcPropozycja: w.dmarc_proposal,
    tryb: w.dns_mode === "delegacja" ? "delegacja" : "reczny",
    delegacja:
      w.zone_id && Array.isArray(w.name_servers) && w.name_servers.length >= 2
        ? {
            nazwa: nazwaWzgledna(w.domain, w.zone_apex),
            serwery: w.name_servers,
            ocena: w.delegation_details && typeof w.delegation_details.stan === "string" ? (w.delegation_details as OcenaDelegacji) : null,
            sprawdzonoAt: w.delegation_checked_at,
            rekordyZsynchronizowane: w.r53_synced_at !== null,
          }
        : null,
    delegacjaNiedostepna: w.delegation_unavailable,
  };
}

export async function domenaPlatformowa(tenantId: string): Promise<DomenaPlatformowa | null> {
  const { rows } = await getPool().query(
    `select ${KOLUMNY}
       from sending_domains d
       left join tenant_platform_senders s on s.tenant_id = d.tenant_id and s.sending_domain_id = d.id
       left join dns_hosted_zones z on z.tenant_id = d.tenant_id and z.id = d.hosted_zone_id
      where d.tenant_id = $1 and d.managed_by = 'platforma'
      order by d.created_at limit 1`,
    [tenantId],
  );
  return rows[0] ? zWiersza(rows[0], config().AWS_REGION) : null;
}

/** Odczyt po identyfikatorze domeny w obrębie tenanta (link dla informatyka). */
export async function domenaPlatformowaPoId(tenantId: string, domainId: string): Promise<DomenaPlatformowa | null> {
  const { rows } = await getPool().query(
    `select ${KOLUMNY}
       from sending_domains d
       left join tenant_platform_senders s on s.tenant_id = d.tenant_id and s.sending_domain_id = d.id
       left join dns_hosted_zones z on z.tenant_id = d.tenant_id and z.id = d.hosted_zone_id
      where d.tenant_id = $1 and d.id = $2 and d.managed_by = 'platforma'`,
    [tenantId, domainId],
  );
  return rows[0] ? zWiersza(rows[0], config().AWS_REGION) : null;
}

// ── Krok c: sprawdzenie ────────────────────────────────────────────────────────

type OdpowiedzDns<T> = { ok: true; wartosc: T } | { ok: false; brak: boolean };

async function zapytaj<T>(f: () => Promise<T>): Promise<OdpowiedzDns<T>> {
  try {
    return { ok: true, wartosc: await f() };
  } catch (b) {
    return { ok: false, brak: czyBrakRekordu(b) };
  }
}

const AWARIA: OcenaRekordu = { stan: "czeka", komunikat: "Nie udało się teraz zapytać serwera nazw. Sprawdzimy ponownie za kilka minut." };

/**
 * Ocena rekordów w DNS z wykrywaniem typowych pomyłek:
 *   - wartość z doklejoną nazwą domeny (panel bez kropki na końcu),
 *   - nazwa z domeną wpisaną dwa razy (panel sam dopisuje domenę do pola Nazwa),
 *   - więcej niż jeden rekord pocztowy na adresie zwrotnym,
 *   - rekord zwrotów wpisany pod domenę główną albo pod adres nadawcy (psuje pocztę firmy).
 */
export async function ocenRekordyWDns(d: Pick<DomenaPlatformowa, "domena" | "strefa" | "rekordy" | "mailFrom">, resolver: ResolverDns): Promise<RaportSprawdzenia> {
  const rekordy: Partial<Record<KluczRekordu, OcenaRekordu>> = {};
  const ostrzezenia: string[] = [];
  let awaria = false;
  const strefa = d.strefa;
  const podwojona = (pelna: string) => `${pelna}.${strefa}`;

  for (const r of d.rekordy) {
    if (r.typ === "CNAME") {
      const odp = await zapytaj(() => resolver.cname(r.nazwaPelna));
      if (odp.ok && odp.wartosc.length) {
        const wynik = porownajCel(odp.wartosc[0], r.oczekiwana, strefa);
        rekordy[r.klucz] =
          wynik === "ok"
            ? { stan: "ok", komunikat: null }
            : wynik === "doklejona_strefa"
              ? { stan: "zle", komunikat: `Teraz w DNS jest ta wartość z dopisanym .${strefa} na końcu. Edytuj ten rekord (nie dodawaj drugiego) i wklej wartość z tabeli razem z kropką na końcu.` }
              : { stan: "zle", komunikat: `Wartość jest inna niż podana. Skopiuj ją jeszcze raz przyciskiem „Kopiuj”.` };
        continue;
      }
      if (!odp.ok && !odp.brak) {
        awaria = true;
        rekordy[r.klucz] = AWARIA;
        continue;
      }
      const dwa = await zapytaj(() => resolver.cname(podwojona(r.nazwaPelna)));
      rekordy[r.klucz] =
        dwa.ok && dwa.wartosc.length
          ? { stan: "zle", komunikat: `Nazwa ma domenę dwa razy (…${strefa}.${strefa}). W polu Nazwa wpisz tylko: ${r.nazwa}.` }
          : { stan: "brak", komunikat: null };
      continue;
    }
    if (r.typ === "MX") {
      const odp = await zapytaj(() => resolver.mx(r.nazwaPelna));
      if (odp.ok && odp.wartosc.length) {
        if (odp.wartosc.length > 1) {
          rekordy[r.klucz] = { stan: "zle", komunikat: "Pod tą nazwą jest więcej niż jeden rekord MX. Zostaw tylko ten jeden." };
          continue;
        }
        const wynik = porownajCel(odp.wartosc[0].exchange, r.oczekiwana, strefa);
        rekordy[r.klucz] =
          wynik === "ok"
            ? { stan: "ok", komunikat: null }
            : wynik === "doklejona_strefa"
              ? { stan: "zle", komunikat: `Teraz w DNS jest ta wartość z dopisanym .${strefa} na końcu. Edytuj ten rekord (nie dodawaj drugiego) i wklej wartość z tabeli razem z kropką na końcu.` }
              : { stan: "zle", komunikat: "Wartość jest inna niż podana. Skopiuj ją jeszcze raz przyciskiem „Kopiuj”." };
        continue;
      }
      if (!odp.ok && !odp.brak) {
        awaria = true;
        rekordy[r.klucz] = AWARIA;
        continue;
      }
      const dwa = await zapytaj(() => resolver.mx(podwojona(r.nazwaPelna)));
      rekordy[r.klucz] =
        dwa.ok && dwa.wartosc.length
          ? { stan: "zle", komunikat: `Nazwa ma domenę dwa razy (…${strefa}.${strefa}). W polu Nazwa wpisz tylko: ${r.nazwa}.` }
          : { stan: "brak", komunikat: null };
      continue;
    }
    // TXT: zwroty_spf albo ochrona
    const odp = await zapytaj(() => resolver.txt(r.nazwaPelna));
    if (!odp.ok && !odp.brak) {
      awaria = true;
      rekordy[r.klucz] = AWARIA;
      continue;
    }
    const txt = odp.ok ? odp.wartosc.map((t) => t.trim().replace(/^"|"$/g, "")) : [];
    if (r.klucz === "zwroty_spf") {
      const spf = txt.filter((t) => /^v=spf1(\s|$)/i.test(t));
      rekordy[r.klucz] =
        spf.length === 0
          ? { stan: "brak", komunikat: null }
          : spf.length > 1
            ? { stan: "zle", komunikat: "Pod tą nazwą są dwa rekordy zaczynające się od v=spf1. Zostaw jeden." }
            : /\binclude:amazonses\.com\b/i.test(spf[0])
              ? { stan: "ok", komunikat: null }
              : { stan: "zle", komunikat: "Rekord nie zawiera include:amazonses.com. Skopiuj wartość jeszcze raz." };
    } else {
      const dm = txt.filter((t) => /^v=DMARC1\s*(;|$)/i.test(t));
      rekordy[r.klucz] =
        dm.length === 1
          ? { stan: "ok", komunikat: null }
          : dm.length > 1
            ? { stan: "zle", komunikat: "Pod tą nazwą są dwa rekordy v=DMARC1. Zostaw jeden." }
            : { stan: "brak", komunikat: null };
    }
    if (rekordy[r.klucz]?.stan === "brak") {
      const dwa = await zapytaj(() => resolver.txt(podwojona(r.nazwaPelna)));
      if (dwa.ok && dwa.wartosc.length) {
        rekordy[r.klucz] = { stan: "zle", komunikat: `Nazwa ma domenę dwa razy (…${strefa}.${strefa}). W polu Nazwa wpisz tylko: ${r.nazwa}.` };
      }
    }
  }

  // Rekord zwrotów wpisany w złe miejsce: pod domenę główną = poczta firmy przestaje
  // dochodzić (najgroźniejsza pomyłka), pod adres nadawcy = odpowiedzi klientów giną.
  const mxStrefy = await zapytaj(() => resolver.mx(strefa));
  if (mxStrefy.ok && mxStrefy.wartosc.some((m) => /amazonses\.com\.?$/i.test(m.exchange) || /amazonses\.com\./i.test(m.exchange))) {
    ostrzezenia.push(
      `PILNE: rekord MX z adresem amazonses.com jest wpisany pod samą domenę ${strefa}. To wyłącza zwykłą pocztę firmy. Usuń go stamtąd i wpisz pod nazwą ${d.rekordy.find((r) => r.typ === "MX")?.nazwa ?? `bounce`}.`,
    );
  }
  if (d.domena !== strefa) {
    const mxNadawcy = await zapytaj(() => resolver.mx(d.domena));
    if (mxNadawcy.ok && mxNadawcy.wartosc.some((m) => /amazonses\.com/i.test(m.exchange))) {
      ostrzezenia.push(
        `Rekord MX z adresem amazonses.com jest wpisany pod ${d.domena}, a powinien być pod ${d.mailFrom}. Przenieś go — inaczej odpowiedzi na newsletter nie dojdą.`,
      );
    }
  }
  return { rekordy, ostrzezenia, awaria, sprawdzonoAt: new Date().toISOString() };
}

/**
 * Stan rekordu po złożeniu dwóch źródeł: SES (autorytet dla podpisu i adresu zwrotnego)
 * i naszego DNS (podaje POWÓD, gdy SES jeszcze czeka). Rekord widoczny u nas, którego SES
 * jeszcze nie potwierdził, to „czeka", nie „ok": SES sprawdza go co kilka minut.
 */
function zlozStan(
  klucz: KluczRekordu,
  dns: OcenaRekordu | undefined,
  t: { dkimStatus: StatusSes | null; mailFromStatus: StatusSes | null },
): OcenaRekordu {
  const zDns = dns ?? { stan: "brak" as const, komunikat: null };
  if (klucz.startsWith("podpis")) {
    if (t.dkimStatus === "SUCCESS") return { stan: "ok", komunikat: null };
    if (zDns.stan === "ok") return { stan: "czeka", komunikat: "Rekord jest w DNS. Czekamy, aż potwierdzi go serwer wysyłki (zwykle kilka minut)." };
    return zDns;
  }
  if (klucz === "zwroty_mx") {
    if (t.mailFromStatus === "SUCCESS") return { stan: "ok", komunikat: null };
    if (zDns.stan === "ok") return { stan: "czeka", komunikat: "Rekord jest w DNS. Czekamy na potwierdzenie (zwykle kilka minut)." };
    return zDns;
  }
  return zDns;
}

/** Rytm sprawdzania: świeża domena często, potem rzadziej; gotowa raz na dobę. */
export function nastepneSprawdzenie(utworzono: Date, gotowa: boolean, teraz: Date): Date {
  if (gotowa) return new Date(teraz.getTime() + 24 * 3600_000);
  const wiek = teraz.getTime() - utworzono.getTime();
  const krok = wiek < 15 * 60_000 ? 60_000 : wiek < 24 * 3600_000 ? 5 * 60_000 : wiek < 72 * 3600_000 ? 15 * 60_000 : 3600_000;
  return new Date(teraz.getTime() + krok);
}

export interface WynikSprawdzenia {
  domena: DomenaPlatformowa;
  /** SES odpowiedział w TYM sprawdzeniu (bez tego stan „verified" jest tylko pamięcią) */
  swiezySes: boolean;
  /** to sprawdzenie przestawiło domenę w „gotowa" (do powiadomienia) */
  wlasnieGotowa: boolean;
}

export async function sprawdzDomenePlatformowa(tenantId: string, domainId: string, o: OpcjeDomeny = {}): Promise<Wynik<WynikSprawdzenia>> {
  const teraz = o.teraz ?? new Date();
  const d = await domenaPlatformowaPoId(tenantId, domainId);
  if (!d) return { ok: false, blad: "Nie ma takiej domeny na tym koncie." };
  const ses = sesZOpcji(o);
  const resolver = o.resolver ?? resolverSystemowy();
  const pool = getPool();

  // 1. SES (źródło prawdy dla wysyłki). Błąd SES nie zeruje stanu: zostaje poprzedni.
  let t: TozsamoscSes | null = null;
  let bladSes: string | null = null;
  if (ses) {
    try {
      t = await ses.odczytajTozsamosc(d.domena);
      if (!t) {
        bladSes = "Domena zniknęła po naszej stronie. Napisz do nas — podłączymy ją ponownie.";
        await alertOperatora(o, `domena platformowa ${d.domena} (tenant ${tenantId}) nie istnieje w SES, a jest w bazie.`);
      } else {
        // adres zwrotny w stanie FAILED jest w SES końcowy: zakładamy go ponownie, sam
        if (t.mailFromStatus === "FAILED" || !t.mailFromDomena) {
          await ses.ustawMailFrom(d.domena, d.mailFrom).catch(() => {});
        }
        await zapiszStanSes(tenantId, domainId, t, teraz);
      }
    } catch (b) {
      bladSes = "Nie udało się teraz sprawdzić domeny po naszej stronie. Spróbujemy za kilka minut.";
      if (b instanceof BladAws && b.brakUprawnien) await alertOperatora(o, `odczyt domeny ${d.domena}: brak uprawnień IAM (${b.kod}).`);
    }
  }

  // 2. DNS z wykrywaniem pomyłek. Brak DMARC, który znikł po podłączeniu: dokładamy propozycję.
  const dmarcTeraz = await (async () => {
    if (d.dmarcPropozycja) return d.dmarcPropozycja;
    try {
      const wlasny = d.domena === d.strefa ? null : await rekordDmarc(d.domena, resolver);
      const dec = decyzjaDmarc({ domenaWysylkowa: d.domena, strefa: d.strefa, rekordStrefy: await rekordDmarc(d.strefa, resolver), rekordWlasny: wlasny });
      return dec.propozycja;
    } catch {
      return null;
    }
  })();
  if (dmarcTeraz !== d.dmarcPropozycja) {
    await pool.query("update sending_domains set dmarc_proposal = $3 where tenant_id = $1 and id = $2", [tenantId, domainId, dmarcTeraz]);
  }
  // 3. „Jeden wpis": rekordy w naszej strefie (doprowadzenie do stanu) i ocena wpisu NS
  //    u dostawcy. Bez Route 53 (wyłączony, brak uprawnień) pomijamy: zostaje stan z bazy.
  let ocenaDelegacji: OcenaDelegacji | null = null;
  let poDmarc = (await domenaPlatformowaPoId(tenantId, domainId)) ?? d;
  // Opcji nie było, bo DNS nie odpowiedział albo Route 53 był niedostępny: proponujemy ją
  // teraz, ale tylko domenie, która jeszcze nie jest gotowa (także wg ŚWIEŻEGO odczytu SES,
  // review r2). Klient widział już tabelę ręczną, więc widok główny się nie zmienia: jeden
  // rekord pojawia się jako alternatywa, a tryb przestawi się sam, gdy wykryjemy wpis NS.
  if (
    !poDmarc.delegacja &&
    (poDmarc.delegacjaNiedostepna === "niesprawdzona" || poDmarc.delegacjaNiedostepna === "route53") &&
    poDmarc.status !== "verified" &&
    !t?.gotowaDoWysylki &&
    route53Z(opcjeDelegacji(o))
  ) {
    const zaczal = true;
    let wlasny: string | null = null;
    try {
      wlasny = await rekordDmarc(poDmarc.domena, resolver);
    } catch {
      wlasny = null;
    }
    await przygotujDelegacje(tenantId, domainId, { domena: poDmarc.domena, strefa: poDmarc.strefa, dostawca: poDmarc.dostawca, dmarcWlasny: wlasny }, o, zaczal);
    poDmarc = (await domenaPlatformowaPoId(tenantId, domainId)) ?? poDmarc;
  }
  if (poDmarc.delegacja) {
    const od = opcjeDelegacji(o);
    const r53 = route53Z(od);
    if (r53 && poDmarc.rekordy.length) await synchronizujStrefe(tenantId, domainId, poDmarc.rekordy, r53, od);
    ocenaDelegacji = await sprawdzDelegacje(tenantId, domainId, { domena: d.domena, strefa: d.strefa, nazwaWzgledna: poDmarc.delegacja.nazwa }, resolver, od);
  }

  const odswiezona = (await domenaPlatformowaPoId(tenantId, domainId)) ?? d;
  const dns = await ocenRekordyWDns(odswiezona, resolver);
  if (ocenaDelegacji?.pilne) dns.ostrzezenia.unshift(`PILNE: ${ocenaDelegacji.pilne}`);
  // NS nie ma, a rekordy z tabeli są wpisane: klient wybrał drogę ręczną
  if (odswiezona.tryb === "delegacja" && ocenaDelegacji?.stan === "brak" && Object.values(dns.rekordy).some((r) => r?.stan === "ok" || r?.stan === "zle")) {
    await przelaczNaRecznyGdyRekordy(tenantId, domainId);
  }
  // Stan SES z bazy: świeży, gdy odczyt się udał, poprzedni, gdy nie (błąd SES nie zeruje).
  const { rows: zapisSes } = await pool.query(
    "select ses_dkim_status, ses_mail_from_status, ses_verified_for_sending from sending_domains where tenant_id = $1 and id = $2",
    [tenantId, domainId],
  );
  const stanSes = {
    dkimStatus: (zapisSes[0]?.ses_dkim_status ?? null) as StatusSes | null,
    mailFromStatus: (zapisSes[0]?.ses_mail_from_status ?? null) as StatusSes | null,
    gotowaDoWysylki: zapisSes[0]?.ses_verified_for_sending === true,
  };

  // Awaria DNS nie obniża stanu rekordu, który był ok (wzorzec z domeny.ts)
  const poprzedni = odswiezona.raport?.rekordy ?? {};
  const zlozone: Partial<Record<KluczRekordu, OcenaRekordu>> = {};
  for (const r of odswiezona.rekordy) {
    const z = zlozStan(r.klucz, dns.rekordy[r.klucz], stanSes);
    zlozone[r.klucz] = z === AWARIA && poprzedni[r.klucz]?.stan === "ok" ? poprzedni[r.klucz]! : z;
  }
  const raport: RaportSprawdzenia = { rekordy: zlozone, ostrzezenia: dns.ostrzezenia, awaria: dns.awaria, sprawdzonoAt: teraz.toISOString() };
  if (bladSes) raport.ostrzezenia.unshift(bladSes);

  const stany = odswiezona.rekordy.map((r) => zlozone[r.klucz]?.stan ?? "brak");
  const sesGotowa = stanSes.gotowaDoWysylki && stanSes.dkimStatus === "SUCCESS" && stanSes.mailFromStatus === "SUCCESS";
  const wszystkieOk = stany.length > 0 && stany.every((s) => s === "ok");
  const status: DomenaPlatformowa["status"] =
    sesGotowa && wszystkieOk ? "verified" : stany.some((s) => s === "ok" || s === "czeka") ? "partial" : "pending";
  // Bez ŚWIEŻEJ odpowiedzi SES nie awansujemy do verified (nie wiemy, czy SES podpisuje),
  // a verified nie spada przez chwilowy błąd SES albo DNS: wtedy status zostaje.
  const nowyStatus =
    t && !dns.awaria ? status : odswiezona.status === "verified" ? "verified" : status === "verified" ? "partial" : status;
  const gotowa = nowyStatus === "verified";

  const { rows: przed } = await pool.query("select status from sending_domains where tenant_id = $1 and id = $2", [tenantId, domainId]);
  await pool.query(
    `update sending_domains
        set status = $3, check_details = $4, last_checked_at = $5, last_error = $6,
            verified_at = case when $3 = 'verified' then coalesce(verified_at, $5) else null end,
            ready_notified_at = case when $3 = 'verified' then ready_notified_at else null end,
            next_check_at = $7
      where tenant_id = $1 and id = $2 and managed_by = 'platforma'`,
    [tenantId, domainId, nowyStatus, JSON.stringify(raport), teraz, dns.awaria ? "DNS nie odpowiedział" : null, nastepneSprawdzenie(odswiezona.utworzonoAt, gotowa, teraz)],
  );
  const zapisana = await domenaPlatformowaPoId(tenantId, domainId);
  if (!zapisana || zapisana.status !== nowyStatus) return { ok: false, blad: "Wynik sprawdzenia nie zapisał się poprawnie." };
  return { ok: true, domena: zapisana, wlasnieGotowa: gotowa && przed[0]?.status !== "verified", swiezySes: t !== null };
}

// ── Nadawca i usunięcie ────────────────────────────────────────────────────────

export async function zapiszNadawcePlatformy(
  tenantId: string,
  dane: { nazwaNadawcy: string; lokalna: string; odpowiedzDo: string },
): Promise<Wynik> {
  const d = await domenaPlatformowa(tenantId);
  if (!d) return { ok: false, blad: "Najpierw podłącz domenę." };
  const nazwa = dane.nazwaNadawcy.replace(/[\r\n\x00]+/g, " ").replace(/\s+/g, " ").trim();
  if (!nazwa || nazwa.length > 200) return { ok: false, blad: "Podaj nazwę nadawcy (do 200 znaków)." };
  const lokalna = dane.lokalna.trim().toLowerCase();
  const { poprawnaLokalna } = await import("../../domain/email/domena-platformowa");
  if (!poprawnaLokalna(lokalna)) return { ok: false, blad: "Część adresu przed @ może mieć litery, cyfry, kropkę i myślnik, np. newsletter." };
  const odp = normalizujAdres(dane.odpowiedzDo);
  if (odp === undefined) return { ok: false, blad: "Adres do odpowiedzi musi być jednym adresem e-mail." };
  // adres nadawcy ZAWSZE w domenie platformowej tego tenanta: domeny z formularza nie bierzemy
  const adres = `${lokalna}@${d.domena}`;
  const { rowCount } = await getPool().query(
    `update tenant_platform_senders set from_name = $3, from_email = $4, reply_to = $5, updated_at = clock_timestamp()
      where tenant_id = $1 and sending_domain_id = $2`,
    [tenantId, d.id, nazwa, adres, odp],
  );
  if (!rowCount) return { ok: false, blad: "Nie udało się zapisać nadawcy." };
  const z = await domenaPlatformowa(tenantId);
  if (z?.nadawca?.adres !== adres || z.nadawca.nazwa !== nazwa || z.nadawca.odpowiedzDo !== odp) {
    return { ok: false, blad: "Zapis nadawcy nie zgadza się z odczytem z bazy." };
  }
  return { ok: true };
}

/**
 * Odłączenie domeny: wiersz znika z bazy (z nadawcą i linkami). Tożsamość w SES zostaje
 * (polityka IAM nie daje DeleteEmailIdentity — świadomie): ponowne podłączenie tej samej
 * domeny przez TEGO tenanta przejmie ją po tagu, a inny tenant dostanie odmowę.
 */
export async function odlaczDomenePlatformowa(tenantId: string): Promise<Wynik> {
  await getPool().query("delete from sending_domains where tenant_id = $1 and managed_by = 'platforma'", [tenantId]);
  return (await domenaPlatformowa(tenantId)) ? { ok: false, blad: "Domena nadal jest w bazie." } : { ok: true };
}
