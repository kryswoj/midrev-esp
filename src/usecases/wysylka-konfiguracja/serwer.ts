import { randomUUID } from "node:crypto";
import { getPool } from "../../adapters/db/pool";
import { odszyfruj, Sekret, zaszyfruj } from "../../adapters/crypto";
import {
  BladHostaSmtp,
  czyHostDeweloperski,
  normalizujHost,
  rozwiazHostSmtp,
  type FunkcjaLookup,
} from "../../adapters/email/bezpieczny-host";
import { AdapterNodemailer, type Bezpieczenstwo, type RodzajSerwera, type WynikTestu } from "../../adapters/email/nodemailer";
import { config } from "../../config";
import { normalizujDomene } from "./weryfikacja-dns";

/**
 * Konfiguracja własnego serwera SMTP tenanta: zapis, odczyt do formularza, test
 * połączenia, wiadomość testowa.
 *
 * Hasło: szyfrowane `zaszyfruj()` przed zapisem, odszyfrowywane WYŁĄCZNIE przy budowie
 * adaptera i od razu zawijane w `Sekret` (toString/toJSON dają gwiazdki). Widok dla
 * formularza (`WidokSerwera`) nie ma pola z hasłem ani szyfrogramem — tylko `hasloUstawione`.
 * Komunikaty błędów nigdy nie zawierają hasła.
 *
 * DŁUG: SQL w use-case zamiast w repozytoria.ts (AD-18) — jak w domeny.ts.
 */

export interface WidokSerwera {
  host: string;
  port: number;
  bezpieczenstwo: Bezpieczenstwo;
  uzytkownik: string | null;
  hasloUstawione: boolean;
  nazwaNadawcy: string;
  adresNadawcy: string;
  odpowiedzDo: string | null;
  /** 0029: własny serwer albo przekaźnik (SES) — decyduje o sposobie oceny SPF i kopercie */
  rodzaj: RodzajSerwera;
  /** domena koperty (Return-Path / custom MAIL FROM), np. bounce.news.midrev.pl */
  domenaKoperty: string | null;
  domenaId: string;
  domenaNadawcy: string;
  statusDomeny: string;
  polaczenieSprawdzoneAt: Date | null;
  ostatniTestAt: Date | null;
  ostatniBladTestu: string | null;
  /** serwer z jawnej listy SMTP_HOSTY_DEWELOPERSKIE (Mailpit) */
  deweloperski: boolean;
}

export interface DaneSerwera {
  host: string;
  port: string | number;
  bezpieczenstwo: string;
  uzytkownik: string;
  /** puste = zostaw obecne hasło */
  noweHaslo: string;
  usunHaslo: boolean;
  nazwaNadawcy: string;
  adresNadawcy: string;
  odpowiedzDo: string;
  /** "wlasny_serwer" (domyślnie) | "przekaznik" */
  rodzaj?: string;
  /** domena koperty; puste = koperta w domenie nadawcy */
  domenaKoperty?: string;
}

export interface OpcjeSerwera {
  lookup?: FunkcjaLookup;
}

type Wynik<T = object> = ({ ok: true } & T) | { ok: false; blad: string };

const ADRES = /^[^@\s<>,;"()\[\]\\]+@[^@\s<>,;"()\[\]\\]+\.[^@\s<>,;"()\[\]\\]+$/;

function normalizujAdres(surowy: string): string | null {
  const a = surowy.trim().toLowerCase();
  return a && a.length <= 320 && ADRES.test(a) ? a : null;
}

function html(tekst: string | number): string {
  return String(tekst).replace(/[&<>"']/g, (z) => `&#${z.charCodeAt(0)};`);
}

function hostyDeweloperskie(): string[] {
  return config().SMTP_HOSTY_DEWELOPERSKIE;
}

export async function odczytajSerwer(tenantId: string): Promise<WidokSerwera | null> {
  const { rows } = await getPool().query(
    `select c.host, c.port, c.security, c.username, (c.password_encrypted is not null) as haslo_ustawione,
            c.from_name, c.from_email, c.reply_to, c.sending_domain_id, d.domain, d.status as status_domeny,
            c.connection_verified_at, c.last_tested_at, c.last_test_error, c.relay_mode, c.envelope_domain
       from tenant_smtp_configs c
       join sending_domains d on d.tenant_id = c.tenant_id and d.id = c.sending_domain_id
      where c.tenant_id = $1`,
    [tenantId],
  );
  const w = rows[0];
  if (!w) return null;
  return {
    host: w.host,
    port: w.port,
    bezpieczenstwo: w.security,
    uzytkownik: w.username,
    hasloUstawione: w.haslo_ustawione,
    nazwaNadawcy: w.from_name,
    adresNadawcy: w.from_email,
    odpowiedzDo: w.reply_to,
    rodzaj: w.relay_mode === "przekaznik" ? "przekaznik" : "wlasny_serwer",
    domenaKoperty: w.envelope_domain ?? null,
    domenaId: w.sending_domain_id,
    domenaNadawcy: w.domain,
    statusDomeny: w.status_domeny,
    polaczenieSprawdzoneAt: w.connection_verified_at,
    ostatniTestAt: w.last_tested_at,
    ostatniBladTestu: w.last_test_error,
    deweloperski: czyHostDeweloperski(w.host, w.port, hostyDeweloperskie()),
  };
}

/**
 * Zapis konfiguracji. Walidacja, bramka SSRF (już przy zapisie — adresu prywatnego
 * w ogóle nie przechowujemy), szyfrowanie hasła, odczyt zwrotny.
 *
 * Każda zmiana parametrów połączenia zeruje `connection_verified_at`: wysyłka nie
 * ruszy przez serwer, którego po zmianie nikt nie sprawdził.
 */
export async function zapiszSerwer(tenantId: string, dane: DaneSerwera, opcje: OpcjeSerwera = {}): Promise<Wynik> {
  let host: string;
  try {
    host = normalizujHost(dane.host);
  } catch (blad) {
    return { ok: false, blad: (blad as Error).message };
  }
  const port = Number(String(dane.port).trim());
  if (!Number.isInteger(port)) return { ok: false, blad: "Port musi być liczbą, np. 587." };
  const bezpieczenstwo = dane.bezpieczenstwo as Bezpieczenstwo;
  if (!["none", "starttls", "tls"].includes(bezpieczenstwo)) return { ok: false, blad: "Wybierz tryb bezpieczeństwa połączenia." };

  try {
    await rozwiazHostSmtp(host, port, { hostyDeweloperskie: hostyDeweloperskie(), lookup: opcje.lookup });
  } catch (blad) {
    if (blad instanceof BladHostaSmtp) return { ok: false, blad: blad.message };
    throw blad;
  }
  const deweloperski = czyHostDeweloperski(host, port, hostyDeweloperskie());

  const uzytkownik = dane.uzytkownik.trim() || null;
  if (uzytkownik && (uzytkownik.length > 320 || /[\r\n\x00]/.test(uzytkownik))) {
    return { ok: false, blad: "Nazwa użytkownika jest niepoprawna." };
  }
  const nazwaNadawcy = dane.nazwaNadawcy.replace(/[\r\n\x00]+/g, " ").trim();
  if (!nazwaNadawcy || nazwaNadawcy.length > 200) return { ok: false, blad: "Podaj nazwę nadawcy (do 200 znaków), np. nazwę sklepu." };
  const adresNadawcy = normalizujAdres(dane.adresNadawcy);
  if (!adresNadawcy) return { ok: false, blad: "Adres nadawcy musi być jednym adresem e-mail, np. sklep@twojadomena.pl." };
  const odpowiedzDo = dane.odpowiedzDo.trim() ? normalizujAdres(dane.odpowiedzDo) : null;
  if (dane.odpowiedzDo.trim() && !odpowiedzDo) return { ok: false, blad: "Adres odpowiedzi musi być jednym adresem e-mail." };

  // Adres nadawcy musi leżeć w domenie dodanej na TYM koncie. FR45 (zweryfikowana) jest
  // egzekwowane przy wysyłce, a nie tutaj: zapis ma się dać zrobić, zanim DNS się rozejdzie.
  const domenaAdresu = adresNadawcy.split("@")[1];
  const pool = getPool();
  const { rows: domeny } = await pool.query(
    "select id from sending_domains where tenant_id = $1 and domain = $2",
    [tenantId, domenaAdresu],
  );
  if (!domeny[0]) {
    return { ok: false, blad: `Domena ${domenaAdresu} nie jest dodana na tym koncie. Dodaj ją wyżej w sekcji „Domena wysyłkowa”, a potem zapisz serwer.` };
  }
  const domenaId: string = domeny[0].id;

  // Rodzaj serwera i domena koperty (0029). Przekaźnik (SES) wymaga domeny koperty:
  // na niej odbiorcy sprawdzają SPF. Domena koperty musi być domeną nadawcy albo jej
  // subdomeną — inaczej SPF nie da wyrównania DMARC nawet w trybie luźnym, a u SES
  // custom MAIL FROM musi być subdomeną zweryfikowanej tożsamości.
  const rodzaj: RodzajSerwera = (dane.rodzaj ?? "wlasny_serwer") === "przekaznik" ? "przekaznik" : "wlasny_serwer";
  if (dane.rodzaj && !["wlasny_serwer", "przekaznik"].includes(dane.rodzaj)) {
    return { ok: false, blad: "Wybierz rodzaj serwera: własny serwer albo przekaźnik (np. Amazon SES)." };
  }
  const surowaKoperta = (dane.domenaKoperty ?? "").trim();
  const domenaKoperty = surowaKoperta ? normalizujDomene(surowaKoperta) : null;
  if (surowaKoperta && !domenaKoperty) return { ok: false, blad: "Domenę koperty podaj jako samą nazwę, np. bounce.twojadomena.pl." };
  if (domenaKoperty && domenaKoperty !== domenaAdresu && !domenaKoperty.endsWith(`.${domenaAdresu}`)) {
    return { ok: false, blad: `Domena koperty musi być domeną nadawcy (${domenaAdresu}) albo jej subdomeną, np. bounce.${domenaAdresu}.` };
  }
  if (rodzaj === "przekaznik" && !domenaKoperty) {
    return { ok: false, blad: `Przy przekaźniku (np. Amazon SES) podaj domenę koperty — u SES to „Custom MAIL FROM domain”, np. bounce.${domenaAdresu}.` };
  }

  const klient = await pool.connect();
  try {
    await klient.query("begin");
    const { rows: obecne } = await klient.query(
      `select host, port, security, username, password_encrypted from tenant_smtp_configs where tenant_id = $1 for update`,
      [tenantId],
    );
    const obecny = obecne[0];
    const noweHaslo = dane.noweHaslo;
    let hasloZaszyfrowane: Buffer | null;
    let hasloZmienione: boolean;
    if (!uzytkownik) {
      hasloZaszyfrowane = null;
      hasloZmienione = Boolean(obecny?.password_encrypted);
    } else if (noweHaslo) {
      if (noweHaslo.length > 1024 || /[\r\n\x00]/.test(noweHaslo)) {
        await klient.query("rollback");
        return { ok: false, blad: "Hasło zawiera niedozwolone znaki (nowa linia)." };
      }
      hasloZaszyfrowane = zaszyfruj(noweHaslo);
      hasloZmienione = true;
    } else if (dane.usunHaslo) {
      hasloZaszyfrowane = null;
      hasloZmienione = Boolean(obecny?.password_encrypted);
    } else {
      // Zachowanie zapisanego hasła przy ZMIANIE serwera albo użytkownika oznaczałoby, że
      // ktoś z dostępem do panelu przepina host na własny serwer, klika „Testuj" i dostaje
      // hasło klienta w rozmowie AUTH. Po takiej zmianie hasło trzeba wpisać od nowa.
      if (obecny?.password_encrypted && (obecny.host !== host || obecny.port !== port || obecny.username !== uzytkownik)) {
        await klient.query("rollback");
        return { ok: false, blad: "Po zmianie serwera, portu albo użytkownika wpisz hasło ponownie." };
      }
      hasloZaszyfrowane = obecny?.password_encrypted ?? null;
      hasloZmienione = false;
    }

    // Hasło otwartym tekstem przez internet to wyciek, nie konfiguracja. „Brak"
    // szyfrowania dopuszczamy tylko bez logowania albo dla jawnego serwera dev.
    if (bezpieczenstwo === "none" && uzytkownik && !deweloperski) {
      await klient.query("rollback");
      return { ok: false, blad: "Z logowaniem połączenie musi być szyfrowane: wybierz STARTTLS (port 587) albo TLS (port 465)." };
    }

    const zmianaPolaczenia =
      !obecny ||
      obecny.host !== host ||
      obecny.port !== port ||
      obecny.security !== bezpieczenstwo ||
      (obecny.username ?? null) !== uzytkownik ||
      hasloZmienione;

    await klient.query(
      `insert into tenant_smtp_configs
         (tenant_id, sending_domain_id, host, port, security, username, password_encrypted,
          from_name, from_email, reply_to, connection_verified_at, updated_at, relay_mode, envelope_domain)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null, clock_timestamp(), $12, $13)
       on conflict (tenant_id) do update set
         sending_domain_id = excluded.sending_domain_id, host = excluded.host, port = excluded.port,
         security = excluded.security, username = excluded.username,
         password_encrypted = excluded.password_encrypted, from_name = excluded.from_name,
         from_email = excluded.from_email, reply_to = excluded.reply_to,
         relay_mode = excluded.relay_mode, envelope_domain = excluded.envelope_domain,
         connection_verified_at = case when $11 then null else tenant_smtp_configs.connection_verified_at end,
         -- updated_at rośnie przy KAŻDYM zapisie: wynik weryfikacji domeny starszy niż zmiana
         -- (np. rodzaju serwera albo koperty) jest przed partią sprawdzany ponownie (nadawca.ts)
         updated_at = clock_timestamp()`,
      [tenantId, domenaId, host, port, bezpieczenstwo, uzytkownik, hasloZaszyfrowane, nazwaNadawcy, adresNadawcy, odpowiedzDo, zmianaPolaczenia, rodzaj, domenaKoperty],
    );

    // Odczyt zwrotny w tej samej transakcji: każde pole i hasło po odszyfrowaniu.
    const { rows: zapisane } = await klient.query(
      `select sending_domain_id, host, port, security, username, password_encrypted, from_name, from_email, reply_to,
              relay_mode, envelope_domain
         from tenant_smtp_configs where tenant_id = $1`,
      [tenantId],
    );
    const z = zapisane[0];
    const hasloZgodne =
      hasloZaszyfrowane === null
        ? z?.password_encrypted === null
        : z?.password_encrypted !== null && Buffer.compare(z.password_encrypted, hasloZaszyfrowane) === 0 &&
          (!noweHaslo || !uzytkownik || odszyfruj(z.password_encrypted) === noweHaslo);
    if (
      !z ||
      z.sending_domain_id !== domenaId ||
      z.host !== host ||
      z.port !== port ||
      z.security !== bezpieczenstwo ||
      z.username !== uzytkownik ||
      z.from_name !== nazwaNadawcy ||
      z.from_email !== adresNadawcy ||
      z.reply_to !== odpowiedzDo ||
      z.relay_mode !== rodzaj ||
      (z.envelope_domain ?? null) !== domenaKoperty ||
      !hasloZgodne
    ) {
      await klient.query("rollback");
      return { ok: false, blad: "Zapis konfiguracji nie zgadza się z odczytem z bazy. Nic nie zostało zmienione." };
    }
    await klient.query("commit");
    return { ok: true };
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }
}

interface ZaladowanySerwer {
  adapter: AdapterNodemailer;
  wersja: string;
  host: string;
  port: number;
  deweloperski: boolean;
  od: string;
  odNazwa: string;
  odpowiedzDo: string | null;
  rodzaj: RodzajSerwera;
  domenaKoperty: string | null;
  sendingDomainId: string;
  polaczenieSprawdzone: boolean;
  domena: string;
  statusDomeny: string;
  domenaSprawdzonaAt: Date | null;
  /** moment ostatniej zmiany konfiguracji serwera */
  zmienionoAt: Date;
  /** ostatni test połączenia (udany albo nie) — do pamięci podręcznej z TTL przed partią */
  ostatniTestAt: Date | null;
  ostatniBladTestu: string | null;
}

/** Adapter z odszyfrowanym hasłem. Tylko do użytku serwerowego, nigdy do widoku. */
export async function zaladujSerwer(tenantId: string, opcje: OpcjeSerwera = {}): Promise<ZaladowanySerwer | null> {
  const { rows } = await getPool().query(
    `select c.host, c.port, c.security, c.username, c.password_encrypted, c.from_name, c.from_email,
            c.reply_to, c.sending_domain_id, c.connection_verified_at, c.updated_at::text as wersja,
            d.domain, d.status as status_domeny, d.last_checked_at, c.updated_at,
            c.last_tested_at, c.last_test_error, c.relay_mode, c.envelope_domain
       from tenant_smtp_configs c
       join sending_domains d on d.tenant_id = c.tenant_id and d.id = c.sending_domain_id
      where c.tenant_id = $1`,
    [tenantId],
  );
  const w = rows[0];
  if (!w) return null;
  const rodzaj: RodzajSerwera = w.relay_mode === "przekaznik" ? "przekaznik" : "wlasny_serwer";
  const haslo = w.password_encrypted ? new Sekret(odszyfruj(w.password_encrypted)) : null;
  const adapter = new AdapterNodemailer(
    { host: w.host, port: w.port, bezpieczenstwo: w.security, uzytkownik: w.username, haslo, rodzaj, domenaKoperty: w.envelope_domain ?? null },
    { hostyDeweloperskie: hostyDeweloperskie(), lookup: opcje.lookup },
  );
  return {
    adapter,
    wersja: w.wersja,
    host: w.host,
    port: w.port,
    deweloperski: czyHostDeweloperski(w.host, w.port, hostyDeweloperskie()),
    od: w.from_email,
    odNazwa: w.from_name,
    odpowiedzDo: w.reply_to,
    rodzaj,
    domenaKoperty: w.envelope_domain ?? null,
    sendingDomainId: w.sending_domain_id,
    polaczenieSprawdzone: w.connection_verified_at !== null,
    domena: w.domain,
    statusDomeny: w.status_domeny,
    domenaSprawdzonaAt: w.last_checked_at,
    zmienionoAt: w.updated_at,
    ostatniTestAt: w.last_tested_at,
    ostatniBladTestu: w.last_test_error,
  };
}

/**
 * Zapis wyniku testu. Warunek na wersję (`updated_at`): jeśli ktoś zmienił konfigurację
 * w trakcie testu, wynik dotyczy STAREJ konfiguracji i nie wolno nim oznaczyć nowej
 * jako sprawdzonej.
 */
export async function zapiszWynikTestu(
  tenantId: string,
  wersja: string,
  wynik: WynikTestu,
  opcje: { oznaczSprawdzony: boolean },
): Promise<void> {
  const teraz = new Date();
  await getPool().query(
    `update tenant_smtp_configs
        set last_tested_at = $3, last_test_error = $4,
            connection_verified_at = case
              when $5 and $4::text is null then $3
              when $5 then null
              else connection_verified_at end
      where tenant_id = $1 and updated_at = $2::timestamptz`,
    [tenantId, wersja, teraz, wynik.ok ? null : wynik.komunikat, opcje.oznaczSprawdzony],
  );
}

export async function testujSerwer(tenantId: string, opcje: OpcjeSerwera = {}): Promise<WynikTestu> {
  const serwer = await zaladujSerwer(tenantId, opcje);
  if (!serwer) return { ok: false, kod: "brak", komunikat: "Najpierw zapisz konfigurację serwera." };
  const wynik = await serwer.adapter.testujPolaczenie();
  await zapiszWynikTestu(tenantId, serwer.wersja, wynik, { oznaczSprawdzony: true });
  return wynik;
}

/**
 * Wiadomość testowa na adres podany przez zalogowanego użytkownika. Idzie PROSTO przez
 * adapter, poza kolejką kampanii: sprawdza serwer, a nie treść kampanii.
 */
export async function wyslijWiadomoscTestowa(
  tenantId: string,
  adresSurowy: string,
  opcje: OpcjeSerwera = {},
): Promise<Wynik<{ messageId: string; od: string }>> {
  const adres = normalizujAdres(adresSurowy);
  if (!adres) return { ok: false, blad: "Podaj jeden adres e-mail, na który ma przyjść test." };
  const serwer = await zaladujSerwer(tenantId, opcje);
  if (!serwer) return { ok: false, blad: "Najpierw zapisz konfigurację serwera." };
  if (!serwer.polaczenieSprawdzone) {
    return { ok: false, blad: "Serwer nie przeszedł testu połączenia po ostatniej zmianie. Kliknij „Testuj połączenie”." };
  }
  try {
    const wynik = await serwer.adapter.wyslijTestowa({
      do: adres,
      od: serwer.od,
      odNazwa: serwer.odNazwa,
      odpowiedzDo: serwer.odpowiedzDo ?? undefined,
      temat: "Wiadomość testowa z MidRev ESP",
      html: `<p>To jest wiadomość testowa z panelu MidRev ESP.</p>
<p>Serwer: ${html(serwer.host)}:${html(serwer.port)}<br>Nadawca: ${html(serwer.odNazwa)} &lt;${html(serwer.od)}&gt;</p>
<p>Jeśli ją widzisz, serwer przyjął pocztę od panelu. Sprawdź w nagłówkach wiadomości wyniki SPF, DKIM i DMARC (w Gmailu: „Pokaż oryginał”).</p>`,
      idempotencyKey: `test-${randomUUID()}`,
    });
    return { ok: true, messageId: wynik.providerId, od: serwer.od };
  } catch (blad) {
    const opis = blad instanceof Error ? blad.message.replace(/^SMTP: /, "") : "nieznany błąd";
    return { ok: false, blad: `Serwer nie przyjął wiadomości testowej: ${opis}` };
  }
}
