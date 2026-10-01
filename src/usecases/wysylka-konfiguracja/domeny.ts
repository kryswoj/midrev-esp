import { isIP } from "node:net";
import { getPool } from "../../adapters/db/pool";
import { resolverSystemowy, type ResolverDns } from "../../adapters/email/dns";
import { czyHostDeweloperski, rozwiazHostSmtp, type FunkcjaLookup } from "../../adapters/email/bezpieczny-host";
import { config } from "../../config";
import {
  normalizujDomene,
  rekordyDoUstawienia,
  zweryfikujDomene,
  type KontekstSerwera,
  type PolitykaDmarc,
  type RekordDoUstawienia,
  type StatusRekordu,
  type WynikWeryfikacji,
} from "./weryfikacja-dns";

/**
 * Domeny wysyłkowe tenanta pod WŁASNY serwer (managed_by = 'klient'): dodanie, ustawienia
 * (selektor DKIM, mechanizm SPF), sprawdzenie DNS z zapisem wyniku. Domeny platformowe
 * (0040) obsługuje domena-platformowa.ts — każde zapytanie tutaj je wyklucza.
 *
 * DŁUG: SQL powinien mieszkać w `adapters/db/repozytoria.ts` (AD-18). Leży tu z tego
 * samego powodu co w onboarding.ts — tamten plik należy w tej rundzie do innego agenta.
 * Każde zapytanie ma predykat `tenant_id` (AD-2).
 */

export type StatusDomenyWBazie = "pending" | "partial" | "verified" | "failed";

export interface DomenaWysylkowa {
  id: string;
  domena: string;
  status: StatusDomenyWBazie;
  selektorDkim: string | null;
  mechanizmSpf: string | null;
  spf: StatusRekordu | null;
  dkim: StatusRekordu | null;
  dmarc: StatusRekordu | null;
  politykaDmarc: PolitykaDmarc | null;
  /** pełny raport z ostatniego UDANEGO sprawdzenia */
  raport: WynikWeryfikacji | null;
  rekordy: RekordDoUstawienia[];
  sprawdzonoAt: Date | null;
  zweryfikowanoAt: Date | null;
  /** ostatnie sprawdzenie, które NIE dało odpowiedzi (awaria DNS) */
  bladSprawdzenia: string | null;
  utworzonoAt: Date;
}

export interface OpcjeDns {
  resolver?: ResolverDns;
  lookup?: FunkcjaLookup;
}

type Wynik<T = object> = ({ ok: true } & T) | { ok: false; blad: string };

const KOLUMNY = `id, domain, status, dkim_selector, spf_mechanism, spf_status, dkim_status, dmarc_status,
  dmarc_policy, check_details, dns_records, last_checked_at, verified_at, last_error, created_at`;

function zWiersza(w: Record<string, any>): DomenaWysylkowa {
  const raport = w.check_details && Object.keys(w.check_details).length ? (w.check_details as WynikWeryfikacji) : null;
  return {
    id: w.id,
    domena: w.domain,
    status: w.status,
    selektorDkim: w.dkim_selector,
    mechanizmSpf: w.spf_mechanism,
    spf: w.spf_status,
    dkim: w.dkim_status,
    dmarc: w.dmarc_status,
    politykaDmarc: w.dmarc_policy,
    raport,
    rekordy: Array.isArray(w.dns_records) ? w.dns_records : [],
    sprawdzonoAt: w.last_checked_at,
    zweryfikowanoAt: w.verified_at,
    bladSprawdzenia: w.last_error,
    utworzonoAt: w.created_at,
  };
}

export async function listaDomen(tenantId: string): Promise<DomenaWysylkowa[]> {
  const { rows } = await getPool().query(
    `select ${KOLUMNY} from sending_domains where tenant_id = $1 and managed_by = 'klient' order by created_at`,
    [tenantId],
  );
  return rows.map(zWiersza);
}

export async function domena(tenantId: string, domainId: string): Promise<DomenaWysylkowa | null> {
  const { rows } = await getPool().query(
    `select ${KOLUMNY} from sending_domains where tenant_id = $1 and id = $2 and managed_by = 'klient'`,
    [tenantId, domainId],
  );
  return rows[0] ? zWiersza(rows[0]) : null;
}

/** Selektor DKIM: pojedyncza etykieta DNS (albo kilka po kropce), małe litery. */
export function normalizujSelektor(surowy: string): string | null | undefined {
  const s = surowy.trim().toLowerCase().replace(/\._domainkey.*$/, "");
  if (!s) return null;
  return /^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/.test(s) ? s : undefined;
}

/**
 * Mechanizm SPF dostawcy. Człowiek wklei „_spf.google.com", „include:_spf.google.com"
 * albo „ip4:1.2.3.4" — przyjmujemy wszystkie trzy formy i zapisujemy jedną.
 * `undefined` = niepoprawny, `null` = pusty.
 */
export function normalizujMechanizmSpf(surowy: string): string | null | undefined {
  const s = surowy.trim().toLowerCase().replace(/^\+/, "");
  if (!s) return null;
  const ip = s.match(/^(ip4|ip6):(.+)$/);
  if (ip) {
    const [adres, prefiks] = ip[2].split("/");
    const rodzina = isIP(adres);
    if ((ip[1] === "ip4" && rodzina !== 4) || (ip[1] === "ip6" && rodzina !== 6)) return undefined;
    if (prefiks !== undefined && !(Number(prefiks) >= 0 && Number(prefiks) <= (rodzina === 4 ? 32 : 128))) return undefined;
    return s;
  }
  const cel = s.replace(/^include:/, "").replace(/\.$/, "");
  // nazwy SPF dostawców zaczynają się często od podkreślnika (_spf.google.com), więc
  // walidacja jest luźniejsza niż dla domeny nadawcy
  return cel.length <= 253 && /^([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(cel)
    ? `include:${cel}`
    : undefined;
}

export async function dodajDomene(
  tenantId: string,
  dane: { domena: string; selektorDkim: string; mechanizmSpf: string },
): Promise<Wynik<{ id: string }>> {
  const nazwa = normalizujDomene(dane.domena);
  if (!nazwa) return { ok: false, blad: "Podaj samą domenę, np. sklep.pl albo mail.sklep.pl — bez https:// i bez adresu e-mail." };
  const selektor = normalizujSelektor(dane.selektorDkim);
  if (selektor === undefined) return { ok: false, blad: "Selektor DKIM to krótka nazwa z panelu serwera, np. google, default albo s1." };
  const mechanizm = normalizujMechanizmSpf(dane.mechanizmSpf);
  if (mechanizm === undefined) return { ok: false, blad: "Mechanizm SPF podaj jako include:_spf.dostawca.pl albo ip4:1.2.3.4." };

  const kontekst: KontekstSerwera = { selektorDkim: selektor, mechanizmSpf: mechanizm, ipSerwera: null, hostSerwera: null };
  const { rows } = await getPool().query(
    `insert into sending_domains (tenant_id, domain, dkim_selector, spf_mechanism, dns_records)
     values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, domain) do nothing
     returning id, domain, dkim_selector, spf_mechanism`,
    [tenantId, nazwa, selektor, mechanizm, JSON.stringify(rekordyDoUstawienia(nazwa, kontekst))],
  );
  if (!rows[0]) return { ok: false, blad: `Domena ${nazwa} jest już dodana.` };
  // odczyt zwrotny: zapis ma być tym, co wysłaliśmy, a nie tym, co zwrócił INSERT
  const zapisana = await domena(tenantId, rows[0].id);
  if (!zapisana || zapisana.domena !== nazwa || zapisana.selektorDkim !== selektor || zapisana.mechanizmSpf !== mechanizm) {
    return { ok: false, blad: "Zapis domeny nie zgadza się z odczytem z bazy. Nic nie zostało zweryfikowane — spróbuj ponownie." };
  }
  return { ok: true, id: zapisana.id };
}

export async function zmienUstawieniaDomeny(
  tenantId: string,
  domainId: string,
  dane: { selektorDkim: string; mechanizmSpf: string },
): Promise<Wynik> {
  const selektor = normalizujSelektor(dane.selektorDkim);
  if (selektor === undefined) return { ok: false, blad: "Selektor DKIM to krótka nazwa z panelu serwera, np. google, default albo s1." };
  const mechanizm = normalizujMechanizmSpf(dane.mechanizmSpf);
  if (mechanizm === undefined) return { ok: false, blad: "Mechanizm SPF podaj jako include:_spf.dostawca.pl albo ip4:1.2.3.4." };
  // Zmiana selektora albo mechanizmu unieważnia poprzedni wynik: domena wraca do
  // „pending" i blokada FR45 działa, dopóki ktoś nie sprawdzi jej na nowo.
  await getPool().query(
    `update sending_domains
        set dkim_selector = $3, spf_mechanism = $4, status = 'pending', verified_at = null,
            spf_status = null, dkim_status = null, dmarc_status = null, dmarc_policy = null,
            check_details = '{}'::jsonb, last_error = null
      where tenant_id = $1 and id = $2 and managed_by = 'klient'
        and (dkim_selector is distinct from $3 or spf_mechanism is distinct from $4)`,
    [tenantId, domainId, selektor, mechanizm],
  );
  const zapisana = await domena(tenantId, domainId);
  if (!zapisana) return { ok: false, blad: "Nie ma takiej domeny na tym koncie." };
  if (zapisana.selektorDkim !== selektor || zapisana.mechanizmSpf !== mechanizm) {
    return { ok: false, blad: "Zapis ustawień domeny nie zgadza się z odczytem z bazy." };
  }
  return { ok: true };
}

export async function usunDomene(tenantId: string, domainId: string): Promise<Wynik> {
  try {
    await getPool().query("delete from sending_domains where tenant_id = $1 and id = $2 and managed_by = 'klient'", [tenantId, domainId]);
  } catch (blad) {
    if ((blad as { code?: string }).code === "23503") {
      return { ok: false, blad: "Z tej domeny wysyła skonfigurowany serwer SMTP. Najpierw zmień adres nadawcy." };
    }
    throw blad;
  }
  if (await domena(tenantId, domainId)) return { ok: false, blad: "Domena nadal jest w bazie." };
  return { ok: true };
}

/**
 * Kontekst serwera do oceny SPF: rodzaj serwera, domena koperty i adresy IP
 * skonfigurowanego serwera SMTP tenanta. Serwer deweloperski (Mailpit) nie ma sensu
 * w SPF — nie podajemy go wcale. Przekaźnik (SES) też nie: pocztę do odbiorców oddają
 * serwery dostawcy, nie host, z którym rozmawia panel, więc jego IP nic nie mówi.
 * Domena koperty liczy się tylko wtedy, gdy serwer wysyła z TEJ domeny (adres nadawcy
 * w sprawdzanej domenie) — inna domena tego samego konta ma własną kopertę = From.
 */
async function kontekstSerwera(tenantId: string, d: DomenaWysylkowa, lookup?: FunkcjaLookup): Promise<KontekstSerwera> {
  const kontekst: KontekstSerwera = { selektorDkim: d.selektorDkim, mechanizmSpf: d.mechanizmSpf, ipSerwera: null, hostSerwera: null };
  const { rows } = await getPool().query(
    "select host, port, relay_mode, envelope_domain, sending_domain_id from tenant_smtp_configs where tenant_id = $1",
    [tenantId],
  );
  const serwer = rows[0];
  if (!serwer) return kontekst;
  kontekst.hostSerwera = serwer.host;
  if (serwer.sending_domain_id === d.id) {
    kontekst.rodzaj = serwer.relay_mode === "przekaznik" ? "przekaznik" : "wlasny_serwer";
    kontekst.domenaKoperty = serwer.envelope_domain ?? null;
    if (kontekst.rodzaj === "przekaznik") return kontekst;
  }
  const hostyDeweloperskie = config().SMTP_HOSTY_DEWELOPERSKIE;
  if (czyHostDeweloperski(serwer.host, serwer.port, hostyDeweloperskie)) return kontekst;
  try {
    const cel = await rozwiazHostSmtp(serwer.host, serwer.port, { hostyDeweloperskie, lookup });
    kontekst.ipSerwera = cel.adresy;
  } catch {
    // serwer, którego nie da się rozwiązać, nie ma adresów do oceny SPF; test połączenia
    // powie o tym osobno i dokładniej
  }
  return kontekst;
}

/**
 * Sprawdzenie DNS domeny z zapisem wyniku.
 *
 * Awaria DNS (timeout, SERVFAIL) NIE nadpisuje poprzedniego wyniku: zapisujemy ją jako
 * `last_error` i zostawiamy stan z ostatniego udanego sprawdzenia. Inaczej jeden
 * chwilowy timeout przy codziennym sprawdzeniu zablokowałby wysyłkę zweryfikowanej
 * domeny, a panel pokazałby „brak rekordu" o rekordzie, który jest.
 */
export async function sprawdzDomene(
  tenantId: string,
  domainId: string,
  opcje: OpcjeDns = {},
): Promise<Wynik<{ domena: DomenaWysylkowa; wynik: WynikWeryfikacji }>> {
  const d = await domena(tenantId, domainId);
  if (!d) return { ok: false, blad: "Nie ma takiej domeny na tym koncie." };
  const kontekst = await kontekstSerwera(tenantId, d, opcje.lookup);
  const wynik = await zweryfikujDomene(d.domena, kontekst, opcje.resolver ?? resolverSystemowy());
  const rekordy = rekordyDoUstawienia(d.domena, kontekst);
  const pool = getPool();

  if (wynik.awariaDns) {
    const opis = [wynik.spf, wynik.dkim, wynik.dmarc]
      .filter((r) => r.przejsciowy)
      .map((r) => r.problem)
      .join(" ");
    await pool.query(
      `update sending_domains set last_error = $3, dns_records = $4 where tenant_id = $1 and id = $2 and managed_by = 'klient'`,
      [tenantId, domainId, opis || "DNS nie odpowiedział", JSON.stringify(rekordy)],
    );
  } else {
    const teraz = new Date();
    await pool.query(
      `update sending_domains
          set status = $3, spf_status = $4, dkim_status = $5, dmarc_status = $6, dmarc_policy = $7,
              check_details = $8, dns_records = $9, last_checked_at = $10, last_error = null,
              -- data weryfikacji zostaje z PIERWSZEGO przejścia w verified; spadek ją zeruje
              verified_at = case when $3 = 'verified' then coalesce(verified_at, $10) else null end
        where tenant_id = $1 and id = $2 and managed_by = 'klient'`,
      [
        tenantId,
        domainId,
        wynik.status,
        wynik.spf.status,
        wynik.dkim.status,
        wynik.dmarc.status,
        wynik.dmarc.polityka,
        JSON.stringify(wynik),
        JSON.stringify(rekordy),
        teraz,
      ],
    );
  }

  // Odczyt zwrotny: status w bazie ma być tym, co policzyliśmy. Rozjazd to błąd zapisu,
  // a nie „prawie zweryfikowana" — FR45 czyta dokładnie tę kolumnę.
  const zapisana = await domena(tenantId, domainId);
  if (!zapisana) return { ok: false, blad: "Domena zniknęła w trakcie sprawdzania." };
  if (!wynik.awariaDns && (zapisana.status !== wynik.status || zapisana.spf !== wynik.spf.status || zapisana.dkim !== wynik.dkim.status || zapisana.dmarc !== wynik.dmarc.status)) {
    return { ok: false, blad: "Wynik sprawdzenia nie zapisał się poprawnie. Spróbuj ponownie." };
  }
  return { ok: true, domena: zapisana, wynik };
}
