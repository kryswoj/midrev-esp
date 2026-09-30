import { getPool } from "../../adapters/db/pool";
import { AdapterSmtp } from "../../adapters/email/smtp";
import { config, trybSandbox } from "../../config";
import type { DostawcaWysylki } from "../../domain/email/port";
import { sprawdzDomene, type OpcjeDns } from "./domeny";
import { zaladujSerwer, zapiszWynikTestu } from "./serwer";

/**
 * Wybór dostawcy i nadawcy dla partii wysyłki tenanta (moduł „Wysyłka i domeny").
 *
 * Dwie drogi:
 *   domyślna        — tenant bez własnego serwera: WYŁĄCZNIE w sandboksie (MIDREV_SANDBOX)
 *                     adapter SMTP z SMTP_HOST/SMTP_PORT (Mailpit), adres MAIL_FROM, nazwa
 *                     nadawcy = nazwa konta. Poza sandboksem: blokada z jasnym powodem.
 *   serwer klienta  — tenant ze skonfigurowanym i SPRAWDZONYM serwerem SMTP: jego serwer,
 *                     jego adres nadawcy, jego reply-to.
 *
 * FR45 — blokada wysyłki z niezweryfikowanej domeny: przez prawdziwy serwer klienta
 * wysyłamy wyłącznie z domeny w stanie `verified` (SPF, DKIM i DMARC poprawne). Wynik
 * starszy niż doba jest sprawdzany ponownie przed partią — DNS klienta zmienia się bez
 * pytania nas o zdanie. Serwer z jawnej listy SMTP_HOSTY_DEWELOPERSKIE (Mailpit) jest
 * zwolniony z FR45, bo nic przez niego nie wychodzi do internetu.
 *
 * Ten plik NIE dotyka bramek zgód, kolejki, klasyfikacji odbić ani idempotencji —
 * odpowiada tylko na pytanie „którędy i od kogo".
 */

export interface Nadawca {
  od: string;
  odNazwa: string;
  odpowiedzDo?: string;
}

export type WyborWysylki =
  | {
      rodzaj: "domyslny" | "serwer_klienta";
      dostawca: DostawcaWysylki;
      nadawca: Nadawca;
      /** `updated_at` konfiguracji SMTP (tekst z bazy), z którą wybrano serwer klienta */
      wersjaSerwera?: string;
    }
  | { rodzaj: "blokada"; powod: string };

/** Po tylu godzinach wynik weryfikacji DNS uznajemy za przeterminowany. */
const WAZNOSC_WERYFIKACJI_H = 24;

/**
 * Tyle minut ważny jest UDANY test połączenia przed partią. Wcześniej `verify()` szło
 * przed KAŻDĄ partią 25 wiadomości, czyli przy 10 tys. odbiorców 400 dodatkowych sesji
 * TLS + AUTH (audyt 24.09, #5). Pamięć podręczna leży w bazie (`last_tested_at`), nie
 * w procesie: wszystkie workery widzą ten sam wynik, a restart go nie gubi.
 */
export const WAZNOSC_TESTU_POLACZENIA_MIN = 10;

const NAZWY_REKORDOW: Record<string, string> = { ok: "poprawny", brak: "brak", bledny: "błędny", niesprawdzony: "niesprawdzony" };

/** Adres nadawcy tenanta — do przypisania domeny wysyłkowej przy budowie wiadomości (A3). */
export async function adresNadawcyTenanta(tenantId: string): Promise<string> {
  const { rows } = await getPool().query("select from_email from tenant_smtp_configs where tenant_id = $1", [tenantId]);
  return rows[0]?.from_email ?? config().MAIL_FROM;
}

export async function wybierzWysylke(
  tenantId: string,
  opcje: { dostawca?: DostawcaWysylki; dns?: OpcjeDns } = {},
): Promise<WyborWysylki> {
  // Adres pocztowy nadawcy w stopce: twarda bramka w SILNIKU, nie tylko w liście kontrolnej
  // kampanii (review Codeksa r2): flowy, wysyłka testowa i dispatcher zaplanowanych kampanii
  // idą tędy, a lista kontrolna ich nie widzi. Poza sandboksem bez adresu nic nie wychodzi.
  if (!trybSandbox()) {
    const { rows: nadawcaTenanta } = await getPool().query(
      "select sender_postal_address from tenants where id = $1",
      [tenantId],
    );
    if (!String(nadawcaTenanta[0]?.sender_postal_address ?? "").trim()) {
      return {
        rodzaj: "blokada",
        powod: "Stopka nie ma adresu pocztowego nadawcy (wymóg CAN-SPAM, Gmail/Yahoo, UŚUDE). Ustawienia → Wysyłka i domeny → „Dane nadawcy w stopce”.",
      };
    }
  }

  const serwer = await zaladujSerwer(tenantId, { lookup: opcje.dns?.lookup });

  if (!serwer) {
    // Poza sandboksem ścieżki domyślnej NIE MA (audyt 28.09, P1-1): adapter systemowy to
    // klient pod Mailpita (bez TLS, bez AUTH, EHLO midrev-esp.local, adres
    // kampanie@midrev-esp.local) i nie przechodzi przez FR45. Wysyłka poszłaby w pętlę
    // błędów albo, przy SMTP_HOST ustawionym na prawdziwy serwer, gołym SMTP z domeny
    // .local. Blokada obejmuje wszystko, co idzie przez silnik: kampanie, flowy i testy.
    if (!trybSandbox()) {
      return {
        rodzaj: "blokada",
        powod:
          "Konto nie ma skonfigurowanego serwera wysyłki. Ustawienia → Wysyłka i domeny: dodaj domenę, serwer SMTP (np. Amazon SES) i przejdź weryfikację DNS.",
      };
    }
    const { rows } = await getPool().query("select name from tenants where id = $1", [tenantId]);
    return {
      rodzaj: "domyslny",
      dostawca: opcje.dostawca ?? new AdapterSmtp(config().SMTP_HOST, config().SMTP_PORT),
      // nazwa konta zamiast zaszytego na sztywno „Sklep Testowy MidRev"
      nadawca: { od: config().MAIL_FROM, odNazwa: String(rows[0]?.name ?? "").trim() || config().MAIL_FROM },
    };
  }

  if (!serwer.polaczenieSprawdzone) {
    return {
      rodzaj: "blokada",
      powod: `Serwer SMTP ${serwer.host}:${serwer.port} nie przeszedł testu połączenia po ostatniej zmianie. Ustawienia → Wysyłka i domeny → „Testuj połączenie”.`,
    };
  }

  // Adres nadawcy musi być w domenie, na którą wskazuje konfiguracja (FK pilnuje tenanta,
  // ten warunek pilnuje, że to TA domena, a nie inna domena tego samego konta).
  if (serwer.od.split("@")[1] !== serwer.domena) {
    return { rodzaj: "blokada", powod: `Adres nadawcy ${serwer.od} nie należy do domeny ${serwer.domena}. Zapisz serwer ponownie.` };
  }

  if (!serwer.deweloperski) {
    let status = serwer.statusDomeny;
    let opisRekordow = "";
    // Przeterminowany jest wynik starszy niż doba ALBO starszy niż ostatnia zmiana
    // serwera: SPF ocenia się względem adresu serwera, więc po jego zmianie stary wynik
    // nic nie mówi o nowym.
    const sprawdzonaMs = serwer.domenaSprawdzonaAt ? new Date(serwer.domenaSprawdzonaAt).getTime() : 0;
    const przeterminowana =
      Date.now() - sprawdzonaMs > WAZNOSC_WERYFIKACJI_H * 3600_000 ||
      sprawdzonaMs < new Date(serwer.zmienionoAt).getTime();
    if (status === "verified" && przeterminowana) {
      const ponowne = await sprawdzDomene(tenantId, serwer.sendingDomainId, opcje.dns);
      if (!ponowne.ok || ponowne.wynik.awariaDns) {
        // Nie da się POTWIERDZIĆ, że domena wciąż jest poprawna — nie wysyłamy. Status
        // w panelu zostaje (chwilowa awaria nie „psuje" domeny), ale partia czeka.
        return {
          rodzaj: "blokada",
          powod: `Nie udało się potwierdzić rekordów DNS domeny ${serwer.domena} przed wysyłką (${ponowne.ok ? ponowne.domena.bladSprawdzenia ?? "DNS nie odpowiedział" : ponowne.blad}). Wysyłka ruszy po udanym sprawdzeniu.`,
        };
      }
      status = ponowne.domena.status;
      opisRekordow = `SPF: ${NAZWY_REKORDOW[ponowne.domena.spf ?? ""] ?? "?"}, DKIM: ${NAZWY_REKORDOW[ponowne.domena.dkim ?? ""] ?? "?"}, DMARC: ${NAZWY_REKORDOW[ponowne.domena.dmarc ?? ""] ?? "?"}`;
    }
    if (status !== "verified") {
      return {
        rodzaj: "blokada",
        powod:
          `Domena ${serwer.domena} nie jest zweryfikowana${opisRekordow ? ` (${opisRekordow})` : ""} — ` +
          `wysyłka z niej jest zablokowana (FR45). Ustawienia → Wysyłka i domeny → „Sprawdź teraz”.`,
      };
    }
  }

  // Wstrzyknięty dostawca (testy) zastępuje transport, ale nie zasady: nadawca i FR45
  // są te same co w produkcji.
  if (opcje.dostawca) {
    return { rodzaj: "serwer_klienta", dostawca: opcje.dostawca, nadawca: nadawcaSerwera(serwer), wersjaSerwera: serwer.wersja };
  }

  // Test połączenia PRZED zajęciem partii: zły login albo leżący serwer ma zatrzymać
  // wysyłkę, zanim jakakolwiek wiadomość przejdzie w `sending`. Inaczej każda wiadomość
  // partii zostałaby osobno „nieznana" i poszła do held. Wynik zapisujemy do panelu,
  // ale nie odbieramy statusu „sprawdzony" — chwilowa awaria sieci nie może wymagać
  // ręcznego klikania „Testuj".
  // Udany test nie starszy niż TTL i nie starszy niż ostatnia zmiana konfiguracji
  // zwalnia z ponownego `verify()`. Nieudany test NIGDY nie jest buforowany: po
  // naprawie serwera następna partia ma ruszyć bez czekania na wygaśnięcie wpisu.
  const ostatniMs = serwer.ostatniTestAt ? new Date(serwer.ostatniTestAt).getTime() : 0;
  const testSwiezy =
    ostatniMs > 0 &&
    !serwer.ostatniBladTestu &&
    Date.now() - ostatniMs < WAZNOSC_TESTU_POLACZENIA_MIN * 60_000 &&
    ostatniMs >= new Date(serwer.zmienionoAt).getTime();
  if (!testSwiezy) {
    const test = await serwer.adapter.testujPolaczenie();
    // wynik (także udany) zapisywany do panelu; status „sprawdzony" nie jest nadawany
    // ani odbierany — to robi wyłącznie ręczny test z ekranu
    await zapiszWynikTestu(tenantId, serwer.wersja, test, { oznaczSprawdzony: false });
    if (!test.ok) {
      return { rodzaj: "blokada", powod: `Serwer SMTP ${serwer.host}:${serwer.port} nie przyjmuje połączenia: ${test.komunikat}` };
    }
  }
  return { rodzaj: "serwer_klienta", dostawca: serwer.adapter, nadawca: nadawcaSerwera(serwer), wersjaSerwera: serwer.wersja };
}

function nadawcaSerwera(serwer: { od: string; odNazwa: string; odpowiedzDo: string | null }): Nadawca {
  return { od: serwer.od, odNazwa: serwer.odNazwa, ...(serwer.odpowiedzDo ? { odpowiedzDo: serwer.odpowiedzDo } : {}) };
}
