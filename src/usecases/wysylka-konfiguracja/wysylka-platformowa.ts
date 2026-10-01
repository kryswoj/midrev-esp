import { getPool } from "../../adapters/db/pool";
import { smtpPlatformy, portSes } from "../../adapters/aws/fabryka";
import { AdapterNodemailer } from "../../adapters/email/nodemailer";
import { AdapterSmtp } from "../../adapters/email/smtp";
import { config, trybSandbox } from "../../config";
import type { DostawcaWysylki } from "../../domain/email/port";
import type { OpcjeDns } from "./domeny";
import { sprawdzDomenePlatformowa } from "./domena-platformowa";

/**
 * Wysyłka platformowa (0040): tenant bez własnego serwera wysyła przez SES platformy,
 * z adresu w SWOJEJ zweryfikowanej domenie platformowej.
 *
 * Bezpieczeństwo (cross-tenant): poświadczenia SMTP są wspólne dla wszystkich tenantów,
 * a SES pozwala wysłać z każdej zweryfikowanej tożsamości konta. Dlatego adres nadawcy
 * NIE pochodzi z żądania ani z treści kampanii: bierzemy go z `tenant_platform_senders`
 * tego tenanta i sprawdzamy, że leży DOKŁADNIE w jego domenie platformowej (FK złożony +
 * warunek niżej). Nagłówek X-SES-CONFIGURATION-SET też pochodzi z bazy tego tenanta.
 */

export type WyborPlatformowy =
  | { rodzaj: "platforma"; dostawca: DostawcaWysylki; nadawca: { od: string; odNazwa: string; odpowiedzDo?: string } }
  | { rodzaj: "blokada"; powod: string };

/** Po tylu godzinach stan domeny jest odświeżany przed partią (jak FR45 przy własnym serwerze). */
const WAZNOSC_STANU_H = 26;

interface Wiersz {
  domain_id: string;
  domain: string;
  status: string;
  ses_verified_for_sending: boolean;
  ses_mail_from_domain: string | null;
  last_checked_at: Date | null;
  from_name: string;
  from_email: string;
  reply_to: string | null;
  ses_configuration_set: string | null;
  ses_tenant_name: string | null;
  ses_events_destination_at: Date | null;
}

async function wczytaj(tenantId: string): Promise<Wiersz | null> {
  const { rows } = await getPool().query<Wiersz>(
    `select d.id as domain_id, d.domain, d.status, d.ses_verified_for_sending, d.ses_mail_from_domain, d.last_checked_at,
            s.from_name, s.from_email, s.reply_to, t.ses_configuration_set, t.ses_tenant_name, t.ses_events_destination_at
       from tenant_platform_senders s
       join sending_domains d on d.tenant_id = s.tenant_id and d.id = s.sending_domain_id and d.managed_by = 'platforma'
       join tenants t on t.id = s.tenant_id
      where s.tenant_id = $1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

/** Adres nadawcy platformowego tenanta (do przypisania domeny wiadomości) albo null. */
export async function adresNadawcyPlatformy(tenantId: string): Promise<string | null> {
  return (await wczytaj(tenantId))?.from_email ?? null;
}

/**
 * null = tenant nie ma domeny platformowej (wołający decyduje: sandbox → Mailpit,
 * produkcja → blokada „podłącz domenę").
 */
export async function wybierzWysylkePlatformowa(
  tenantId: string,
  opcje: { dostawca?: DostawcaWysylki; dns?: OpcjeDns; teraz?: Date } = {},
): Promise<WyborPlatformowy | null> {
  let w = await wczytaj(tenantId);
  if (!w) return null;
  const teraz = opcje.teraz ?? new Date();

  // adres nadawcy MUSI leżeć dokładnie w domenie platformowej tego tenanta
  if (w.from_email.split("@")[1] !== w.domain) {
    return { rodzaj: "blokada", powod: `Adres nadawcy ${w.from_email} nie należy do domeny ${w.domain}. Zapisz nadawcę ponownie w Ustawieniach wysyłki.` };
  }

  const przeterminowana = !w.last_checked_at || teraz.getTime() - new Date(w.last_checked_at).getTime() > WAZNOSC_STANU_H * 3600_000;
  if (w.status === "verified" && przeterminowana && portSes()) {
    const spr = await sprawdzDomenePlatformowa(tenantId, w.domain_id, { resolver: opcje.dns?.resolver });
    // odświeżenie bez odpowiedzi SES nie potwierdza niczego: stary „verified" to tylko pamięć
    if (!spr.ok || !spr.swiezySes) return { rodzaj: "blokada", powod: `Nie udało się potwierdzić domeny ${w.domain} przed wysyłką. Spróbujemy ponownie za kilka minut.` };
    w = (await wczytaj(tenantId)) ?? w;
  }
  if (w.status !== "verified" || !w.ses_verified_for_sending) {
    return {
      rodzaj: "blokada",
      powod: `Domena ${w.domain} nie jest jeszcze gotowa. Ustawienia → Wysyłka: wpisz brakujące rekordy, sprawdzamy je automatycznie co kilka minut.`,
    };
  }

  const nadawca = { od: w.from_email, odNazwa: w.from_name, ...(w.reply_to ? { odpowiedzDo: w.reply_to } : {}) };
  const k = config();
  const smtp = smtpPlatformy();
  if (!trybSandbox()) {
    // Odbicia i skargi platformowe wracają WYŁĄCZNIE przez SNS. Bez niego wysyłka byłaby
    // ślepa: martwe adresy nie trafiałyby na wykluczenia, a konto SES poszłoby pod review.
    // per tenant: cel zdarzeń potwierdzony w JEGO zestawie (review r1, P1), nie tylko flaga globalna
    if (!k.SES_ZDARZENIA_SNS || k.SES_SNS_TOPIC_ARN.length === 0 || !w.ses_configuration_set || !w.ses_events_destination_at) {
      return { rodzaj: "blokada", powod: "Wysyłka ruszy, gdy zakończymy konfigurację po naszej stronie. Nic nie musisz robić — damy znać." };
    }
    if (!smtp && !opcje.dostawca) return { rodzaj: "blokada", powod: "Wysyłka ruszy, gdy zakończymy konfigurację po naszej stronie. Nic nie musisz robić — damy znać." };
  }
  // atrapa w testach: transport podmieniony, zasady (nadawca, gotowość domeny, bramka
  // zdarzeń w produkcji) te same
  if (opcje.dostawca) return { rodzaj: "platforma", dostawca: opcje.dostawca, nadawca };
  if (!smtp) return null; // sandbox bez poświadczeń: wołający użyje Mailpita z nadawcą platformowym

  const naglowki: Record<string, string> = {};
  if (w.ses_configuration_set) naglowki["X-SES-CONFIGURATION-SET"] = w.ses_configuration_set;
  if (w.ses_tenant_name && k.SES_TENANTS) naglowki["X-SES-TENANT"] = w.ses_tenant_name;
  const adapter = new AdapterNodemailer(
    {
      host: smtp.host,
      port: smtp.port,
      bezpieczenstwo: smtp.port === 465 || smtp.port === 2465 ? "tls" : "starttls",
      uzytkownik: smtp.uzytkownik,
      haslo: smtp.haslo,
      rodzaj: "przekaznik",
      domenaKoperty: w.ses_mail_from_domain,
      naglowkiDodatkowe: naglowki,
    },
    { hostyDeweloperskie: k.SMTP_HOSTY_DEWELOPERSKIE, lookup: opcje.dns?.lookup },
  );
  return { rodzaj: "platforma", dostawca: adapter, nadawca };
}

/** Nadawca platformowy w sandboksie bez poświadczeń SES (Mailpit), do wołającego w nadawca.ts. */
export async function nadawcaPlatformyBezSmtp(tenantId: string): Promise<{ od: string; odNazwa: string; odpowiedzDo?: string } | null> {
  const w = await wczytaj(tenantId);
  if (!w || w.status !== "verified" || w.from_email.split("@")[1] !== w.domain) return null;
  return { od: w.from_email, odNazwa: w.from_name, ...(w.reply_to ? { odpowiedzDo: w.reply_to } : {}) };
}

/** Krok onboardingu „Pierwszy mail testowy": data PIERWSZEGO udanego testu (później bez zmian). */
export async function oznaczPierwszyTest(tenantId: string, kiedy = new Date()): Promise<void> {
  await getPool().query("update tenants set first_test_email_at = coalesce(first_test_email_at, $2) where id = $1", [tenantId, kiedy]);
}

function htmlBezpieczny(t: string): string {
  return t.replace(/[&<>"']/g, (z) => `&#${z.charCodeAt(0)};`);
}

/**
 * Mail testowy z ekranu ustawień w trybie platformowym: ta sama decyzja co przed partią
 * (wybierzWysylkePlatformowa: domena gotowa, nadawca z bazy, nagłówki tenanta), poza kolejką.
 */
export async function wyslijTestPlatformy(
  tenantId: string,
  adresSurowy: string,
  opcje: { dostawca?: DostawcaWysylki; dns?: OpcjeDns } = {},
): Promise<{ ok: true; od: string } | { ok: false; blad: string }> {
  const adres = adresSurowy.trim().toLowerCase();
  if (!/^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/.test(adres) || adres.length > 320) {
    return { ok: false, blad: "Podaj jeden adres e-mail, na który ma przyjść test." };
  }
  let wybor = await wybierzWysylkePlatformowa(tenantId, opcje);
  if (!wybor && trybSandbox()) {
    // sandbox bez poświadczeń SES: Mailpit, ale z prawdziwym nadawcą platformowym
    const n = await nadawcaPlatformyBezSmtp(tenantId);
    if (n) wybor = { rodzaj: "platforma", dostawca: new AdapterSmtp(config().SMTP_HOST, config().SMTP_PORT), nadawca: n };
  }
  if (!wybor) return { ok: false, blad: "Najpierw podłącz domenę i poczekaj, aż będzie gotowa." };
  if (wybor.rodzaj === "blokada") return { ok: false, blad: wybor.powod };
  const d = wybor.dostawca as DostawcaWysylki & { wyslijTestowa?: AdapterNodemailer["wyslijTestowa"] };
  const tresc = {
    do: adres,
    od: wybor.nadawca.od,
    odNazwa: wybor.nadawca.odNazwa,
    odpowiedzDo: wybor.nadawca.odpowiedzDo,
    temat: "Test: Twoja domena wysyła maile",
    html: `<p>To jest wiadomość testowa z MidRev.</p><p>Nadawca: ${htmlBezpieczny(wybor.nadawca.odNazwa)} &lt;${htmlBezpieczny(wybor.nadawca.od)}&gt;</p><p>Jeśli ją widzisz w skrzynce odbiorczej, wysyłka działa.</p>`,
    idempotencyKey: `test-${crypto.randomUUID()}`,
  };
  try {
    if (typeof d.wyslijTestowa === "function") await d.wyslijTestowa(tresc);
    else await d.wyslij({ ...tresc, adresWypisania: "" });
  } catch (b) {
    console.error(`[wysylka-platformowa] test tenanta ${tenantId} nie wyszedł: ${String((b as Error)?.message ?? b).slice(0, 200)}`);
    return { ok: false, blad: "Nie udało się wysłać testu. Spróbuj za chwilę — jeśli się powtórzy, napisz do nas." };
  } finally {
    await d.zamknij?.();
  }
  await oznaczPierwszyTest(tenantId);
  return { ok: true, od: wybor.nadawca.od };
}
