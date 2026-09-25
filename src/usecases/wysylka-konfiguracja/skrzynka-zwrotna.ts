import { getPool } from "../../adapters/db/pool";
import { odszyfruj, Sekret, zaszyfruj } from "../../adapters/crypto";
import {
  BladHostaSmtp,
  DOZWOLONE_PORTY_IMAP,
  czyHostDeweloperski,
  normalizujHost,
  rozwiazHostSmtp,
  type FunkcjaLookup,
} from "../../adapters/email/bezpieczny-host";
import { BladImap, KlientImap, type BezpieczenstwoImap } from "../../adapters/email/imap";
import { config } from "../../config";

/**
 * Konfiguracja skrzynki zwrotnej (IMAP) tenanta: zapis, odczyt do formularza, test,
 * ładowanie klienta dla workera, kursor UID, ostatnie raporty do panelu.
 *
 * Te same zasady co dla serwera SMTP (serwer.ts): bramka SSRF już przy zapisie, hasło
 * szyfrowane i odszyfrowywane WYŁĄCZNIE przy budowie klienta (Sekret), widok dla
 * formularza bez hasła i bez szyfrogramu, zmiana połączenia zeruje „sprawdzone".
 */

export interface WidokSkrzynki {
  host: string;
  port: number;
  bezpieczenstwo: BezpieczenstwoImap;
  uzytkownik: string;
  hasloUstawione: boolean;
  skrzynka: string;
  polaczenieSprawdzoneAt: Date | null;
  ostatniTestAt: Date | null;
  ostatniBladTestu: string | null;
  ostatniOdczytAt: Date | null;
  ostatniBladOdczytu: string | null;
  deweloperski: boolean;
}

export interface DaneSkrzynki {
  host: string;
  port: string | number;
  bezpieczenstwo: string;
  uzytkownik: string;
  /** puste = zostaw obecne hasło */
  noweHaslo: string;
  skrzynka: string;
}

export interface OpcjeSkrzynki {
  lookup?: FunkcjaLookup;
  /** limit czasu na komendę IMAP (testy); domyślnie 30 s */
  limitCzasuMs?: number;
}

type Wynik<T = object> = ({ ok: true } & T) | { ok: false; blad: string };

function hostyDeweloperskie(): string[] {
  return config().SMTP_HOSTY_DEWELOPERSKIE;
}

export async function odczytajSkrzynke(tenantId: string): Promise<WidokSkrzynki | null> {
  const { rows } = await getPool().query(
    `select bounce_imap_host, bounce_imap_port, bounce_imap_security, bounce_imap_username,
            (bounce_imap_password_encrypted is not null) as haslo_ustawione, bounce_imap_mailbox,
            bounce_connection_verified_at, bounce_last_tested_at, bounce_last_test_error,
            bounce_last_checked_at, bounce_last_error
       from tenant_smtp_configs where tenant_id = $1 and bounce_imap_host is not null`,
    [tenantId],
  );
  const w = rows[0];
  if (!w) return null;
  return {
    host: w.bounce_imap_host,
    port: w.bounce_imap_port,
    bezpieczenstwo: w.bounce_imap_security,
    uzytkownik: w.bounce_imap_username,
    hasloUstawione: w.haslo_ustawione,
    skrzynka: w.bounce_imap_mailbox,
    polaczenieSprawdzoneAt: w.bounce_connection_verified_at,
    ostatniTestAt: w.bounce_last_tested_at,
    ostatniBladTestu: w.bounce_last_test_error,
    ostatniOdczytAt: w.bounce_last_checked_at,
    ostatniBladOdczytu: w.bounce_last_error,
    deweloperski: czyHostDeweloperski(w.bounce_imap_host, w.bounce_imap_port, hostyDeweloperskie()),
  };
}

export async function zapiszSkrzynke(tenantId: string, dane: DaneSkrzynki, opcje: OpcjeSkrzynki = {}): Promise<Wynik> {
  let host: string;
  try {
    host = normalizujHost(dane.host);
  } catch (blad) {
    return { ok: false, blad: (blad as Error).message.replace("smtp.twojadomena.pl", "imap.twojadomena.pl") };
  }
  const port = Number(String(dane.port).trim());
  if (!Number.isInteger(port)) return { ok: false, blad: "Port musi być liczbą, np. 993." };
  const bezpieczenstwo = dane.bezpieczenstwo as BezpieczenstwoImap;
  if (!["none", "starttls", "tls"].includes(bezpieczenstwo)) return { ok: false, blad: "Wybierz tryb szyfrowania połączenia IMAP." };
  try {
    await rozwiazHostSmtp(host, port, { hostyDeweloperskie: hostyDeweloperskie(), lookup: opcje.lookup, dozwolonePorty: DOZWOLONE_PORTY_IMAP, usluga: "imap" });
  } catch (blad) {
    if (blad instanceof BladHostaSmtp) return { ok: false, blad: blad.message };
    throw blad;
  }
  const deweloperski = czyHostDeweloperski(host, port, hostyDeweloperskie());
  if (bezpieczenstwo === "none" && !deweloperski) {
    return { ok: false, blad: "Połączenie ze skrzynką musi być szyfrowane: wybierz TLS (port 993) albo STARTTLS (port 143)." };
  }
  const uzytkownik = dane.uzytkownik.trim();
  if (!uzytkownik || uzytkownik.length > 320 || /[\r\n\x00]/.test(uzytkownik)) {
    return { ok: false, blad: "Podaj użytkownika skrzynki (zwykle pełny adres e-mail)." };
  }
  const skrzynka = dane.skrzynka.trim() || "INBOX";
  if (skrzynka.length > 200 || /[\r\n"]/.test(skrzynka)) return { ok: false, blad: "Nazwa folderu jest niepoprawna." };
  const noweHaslo = dane.noweHaslo;
  if (noweHaslo && (noweHaslo.length > 1024 || /[\r\n\x00]/.test(noweHaslo))) {
    return { ok: false, blad: "Hasło zawiera niedozwolone znaki (nowa linia)." };
  }

  const pool = getPool();
  const klient = await pool.connect();
  try {
    await klient.query("begin");
    const { rows: obecne } = await klient.query(
      `select bounce_imap_host, bounce_imap_port, bounce_imap_security, bounce_imap_username, bounce_imap_password_encrypted
         from tenant_smtp_configs where tenant_id = $1 for update`,
      [tenantId],
    );
    const obecny = obecne[0];
    if (!obecny) {
      await klient.query("rollback");
      return { ok: false, blad: "Najpierw zapisz serwer wysyłkowy (sekcja 2) — skrzynka zwrotna należy do tej samej konfiguracji." };
    }
    let hasloZaszyfrowane: Buffer | null;
    if (noweHaslo) {
      hasloZaszyfrowane = zaszyfruj(noweHaslo);
    } else {
      if (!obecny.bounce_imap_password_encrypted) {
        await klient.query("rollback");
        return { ok: false, blad: "Podaj hasło do skrzynki." };
      }
      // to samo zabezpieczenie co przy SMTP: przepięcie hosta/użytkownika na cudzy serwer
      // z zachowanym hasłem klienta = wyciek hasła w rozmowie LOGIN
      if (obecny.bounce_imap_host !== host || obecny.bounce_imap_port !== port || obecny.bounce_imap_username !== uzytkownik) {
        await klient.query("rollback");
        return { ok: false, blad: "Po zmianie serwera, portu albo użytkownika wpisz hasło ponownie." };
      }
      hasloZaszyfrowane = obecny.bounce_imap_password_encrypted;
    }
    const zmianaPolaczenia =
      obecny.bounce_imap_host !== host ||
      obecny.bounce_imap_port !== port ||
      obecny.bounce_imap_security !== bezpieczenstwo ||
      obecny.bounce_imap_username !== uzytkownik ||
      Boolean(noweHaslo);
    await klient.query(
      `update tenant_smtp_configs
          set bounce_imap_host = $2, bounce_imap_port = $3, bounce_imap_security = $4, bounce_imap_username = $5,
              bounce_imap_password_encrypted = $6, bounce_imap_mailbox = $7,
              bounce_connection_verified_at = case when $8 then null else bounce_connection_verified_at end,
              -- zmiana serwera albo folderu = inna skrzynka = inny kursor
              bounce_uidvalidity = case when $8 or bounce_imap_mailbox is distinct from $7 then null else bounce_uidvalidity end,
              bounce_last_uid = case when $8 or bounce_imap_mailbox is distinct from $7 then null else bounce_last_uid end,
              bounce_updated_at = clock_timestamp()
        where tenant_id = $1`,
      [tenantId, host, port, bezpieczenstwo, uzytkownik, hasloZaszyfrowane, skrzynka, zmianaPolaczenia],
    );
    const { rows: zapisane } = await klient.query(
      `select bounce_imap_host, bounce_imap_port, bounce_imap_security, bounce_imap_username, bounce_imap_password_encrypted, bounce_imap_mailbox
         from tenant_smtp_configs where tenant_id = $1`,
      [tenantId],
    );
    const z = zapisane[0];
    const hasloZgodne =
      z?.bounce_imap_password_encrypted != null &&
      Buffer.compare(z.bounce_imap_password_encrypted, hasloZaszyfrowane!) === 0 &&
      (!noweHaslo || odszyfruj(z.bounce_imap_password_encrypted) === noweHaslo);
    if (
      !z || z.bounce_imap_host !== host || z.bounce_imap_port !== port || z.bounce_imap_security !== bezpieczenstwo ||
      z.bounce_imap_username !== uzytkownik || z.bounce_imap_mailbox !== skrzynka || !hasloZgodne
    ) {
      await klient.query("rollback");
      return { ok: false, blad: "Zapis skrzynki nie zgadza się z odczytem z bazy. Nic nie zostało zmienione." };
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

/** Usunięcie konfiguracji skrzynki (worker przestaje ją czytać). Historia raportów zostaje. */
export async function usunSkrzynke(tenantId: string): Promise<void> {
  await getPool().query(
    `update tenant_smtp_configs
        set bounce_imap_host = null, bounce_imap_port = null, bounce_imap_security = null, bounce_imap_username = null,
            bounce_imap_password_encrypted = null, bounce_connection_verified_at = null, bounce_last_tested_at = null,
            bounce_last_test_error = null, bounce_uidvalidity = null, bounce_last_uid = null, bounce_updated_at = clock_timestamp()
      where tenant_id = $1`,
    [tenantId],
  );
}

export interface ZaladowanaSkrzynka {
  klient: KlientImap;
  host: string;
  port: number;
  polaczenieSprawdzone: boolean;
  wersja: string;
  kursor: { uidvalidity: number | null; ostatniUid: number | null };
}

/** Klient z odszyfrowanym hasłem. Tylko dla serwera, nigdy do widoku. */
export async function zaladujSkrzynke(tenantId: string, opcje: OpcjeSkrzynki = {}): Promise<ZaladowanaSkrzynka | null> {
  const { rows } = await getPool().query(
    `select bounce_imap_host, bounce_imap_port, bounce_imap_security, bounce_imap_username, bounce_imap_password_encrypted,
            bounce_imap_mailbox, bounce_connection_verified_at, bounce_uidvalidity, bounce_last_uid,
            coalesce(bounce_updated_at, updated_at)::text as wersja
       from tenant_smtp_configs where tenant_id = $1 and bounce_imap_host is not null`,
    [tenantId],
  );
  const w = rows[0];
  if (!w || !w.bounce_imap_password_encrypted) return null;
  const klient = new KlientImap(
    {
      host: w.bounce_imap_host,
      port: w.bounce_imap_port,
      bezpieczenstwo: w.bounce_imap_security,
      uzytkownik: w.bounce_imap_username,
      haslo: new Sekret(odszyfruj(w.bounce_imap_password_encrypted)),
      skrzynka: w.bounce_imap_mailbox,
    },
    { hostyDeweloperskie: hostyDeweloperskie(), lookup: opcje.lookup, limitCzasuMs: opcje.limitCzasuMs },
  );
  return {
    klient,
    host: w.bounce_imap_host,
    port: w.bounce_imap_port,
    polaczenieSprawdzone: w.bounce_connection_verified_at !== null,
    wersja: w.wersja,
    kursor: {
      uidvalidity: w.bounce_uidvalidity == null ? null : Number(w.bounce_uidvalidity),
      ostatniUid: w.bounce_last_uid == null ? null : Number(w.bounce_last_uid),
    },
  };
}

export type WynikTestuSkrzynki = { ok: true; nieprzeczytane: number; wiadomosci: number } | { ok: false; kod: string; komunikat: string };

/** Test: połączenie, logowanie, otwarcie folderu, liczba nieprzeczytanych. Nie rzuca. */
export async function testujSkrzynke(tenantId: string, opcje: OpcjeSkrzynki = {}): Promise<WynikTestuSkrzynki> {
  const s = await zaladujSkrzynke(tenantId, opcje);
  if (!s) return { ok: false, kod: "brak", komunikat: "Najpierw zapisz skrzynkę zwrotną." };
  let wynik: WynikTestuSkrzynki;
  try {
    const { wiadomosci } = await s.klient.otworz();
    const nieprzeczytane = (await s.klient.nieprzeczytaneOd(0)).length;
    wynik = { ok: true, nieprzeczytane, wiadomosci };
  } catch (blad) {
    wynik = blad instanceof BladImap
      ? { ok: false, kod: blad.kod, komunikat: blad.message }
      : { ok: false, kod: "inny", komunikat: `Nie udało się połączyć ze skrzynką: ${String((blad as Error)?.message ?? blad).replace(/[\r\n]+/g, " ").slice(0, 200)}` };
  } finally {
    await s.klient.zamknij().catch(() => {});
  }
  await getPool().query(
    `update tenant_smtp_configs
        set bounce_last_tested_at = now(), bounce_last_test_error = $3,
            bounce_connection_verified_at = case when $3::text is null then now() else null end
      where tenant_id = $1 and coalesce(bounce_updated_at, updated_at)::text = $2`,
    [tenantId, s.wersja, wynik.ok ? null : wynik.komunikat],
  );
  return wynik;
}

/** Wynik przebiegu workera: kursor i ostatni błąd (null = przebieg bez błędu). */
export async function zapiszPrzebiegSkrzynki(
  tenantId: string,
  wynik: { uidvalidity?: number; ostatniUid?: number; blad: string | null },
): Promise<void> {
  // kursor podawany tylko po udanym przebiegu (pobierzOdbicia liczy go od poprzedniego,
  // więc nigdy nie cofa); po błędzie zostaje stary i następny tik czyta od tego miejsca
  await getPool().query(
    `update tenant_smtp_configs
        set bounce_last_checked_at = now(), bounce_last_error = $2,
            bounce_uidvalidity = coalesce($3::bigint, bounce_uidvalidity),
            bounce_last_uid = coalesce($4::bigint, bounce_last_uid)
      where tenant_id = $1`,
    [tenantId, wynik.blad, wynik.uidvalidity ?? null, wynik.ostatniUid ?? null],
  );
}

export interface RaportWPanelu {
  id: string;
  kiedy: Date;
  adres: string | null;
  rodzaj: string;
  wynik: string;
  typZdarzenia: string | null;
  klasa: string | null;
  kodSmtp: string | null;
  temat: string | null;
}

export async function ostatnieRaporty(tenantId: string, limit = 20): Promise<RaportWPanelu[]> {
  const { rows } = await getPool().query(
    `select id, received_at, recipient, kind, outcome, event_type, bounce_class, smtp_code, subject
       from bounce_reports where tenant_id = $1 and kind <> 'nie_odbicie'
      order by received_at desc limit $2`,
    [tenantId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kiedy: r.received_at,
    adres: r.recipient,
    rodzaj: r.kind,
    wynik: r.outcome,
    typZdarzenia: r.event_type,
    klasa: r.bounce_class,
    kodSmtp: r.smtp_code,
    temat: r.subject,
  }));
}

export async function statystykaRaportow(tenantId: string, dni = 7): Promise<{ odbicia: number; skargi: number; niedopasowane: number }> {
  const { rows } = await getPool().query(
    `select count(*) filter (where event_type = 'bounced')::int as odbicia,
            count(*) filter (where event_type = 'complained')::int as skargi,
            count(*) filter (where outcome = 'brak_wiadomosci')::int as niedopasowane
       from bounce_reports where tenant_id = $1 and received_at > now() - make_interval(days => $2::int)`,
    [tenantId, dni],
  );
  return rows[0];
}
