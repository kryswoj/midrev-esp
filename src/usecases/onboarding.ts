import { getPool } from "../adapters/db/pool";
import { odmien } from "../domain/liczebniki";
import { sklepyZeStanemWebhookow } from "../adapters/store/stan-webhookow";
import { wszystkieAktywne } from "../adapters/store/webhooki";

/**
 * Lista kroków wdrożenia na ekranie startowym (DESIGN.md, komponent `.krok`).
 *
 * Wzorzec to zakładka „Goals" z Omnisenda (PANELE-ESP-NAWIGACJA-2026-09-22, sekcja 3.2):
 * konto nowe widzi checklistę startową, konto z historią widzi raport. Klaviyo takiej
 * listy nie ma i to jest dokładnie ta rzecz, której u nas brakowało — nowy klient trafiał
 * na pusty raport przychodu i nie miał skąd wiedzieć, czego jeszcze nie zrobił.
 *
 * ZASADA: każdy krok jest WYLICZANY ZE STANU BAZY, nie odhaczany ręcznie. Lista na sztywno
 * z checkboxem „zrobione" kłamie w chwili, w której ktoś odłączy sklep albo wygasną klucze.
 * Dlatego tu nie ma żadnej tabeli `onboarding_steps` i nie będzie.
 *
 * DŁUG DO SPŁACENIA: cały SQL projektu ma mieszkać w `adapters/db/repozytoria.ts` (AD-18).
 * Te zapytania leżą tutaj z tego samego powodu, co zapytania w `adapters/store/stan-webhookow.ts`:
 * `repozytoria.ts` należy w tej rundzie do innego agenta i równoległa edycja skończyłaby się
 * konfliktem. Przy przenoszeniu nic się nie zmienia poza miejscem. Każde zapytanie ma
 * predykat `tenant_id` (AD-2) niezależnie od tego, gdzie leży.
 */

export interface KrokWdrozenia {
  klucz: string;
  tytul: string;
  /** Jedno zdanie: po co to jest. Nie instrukcja obsługi, tylko powód. */
  poCo: string;
  zrobiony: boolean;
  /**
   * Krok, którego NIE DA SIĘ dziś zrobić, bo moduł nie powstał. Osobny stan od
   * „niezrobiony", bo wysłanie kogoś po coś, czego nie ma, jest gorsze niż
   * powiedzenie wprost, że tego nie ma.
   */
  wBudowie: boolean;
  /** Dokąd się idzie, żeby to zrobić. Ścieżka względem `/t/{tenantId}`. */
  href: string;
  akcja: string;
  /** Liczba albo fakt ze stanu konta, który uzasadnia werdykt kroku. */
  szczegol: string;
}

export interface StanOnboardingu {
  kroki: KrokWdrozenia[];
  zrobione: number;
  wszystkie: number;
  /** Wszystko odhaczone: ekran startowy ma wtedy pokazać sam raport przychodu. */
  gotowe: boolean;
}

interface LiczbyKont {
  sklepy: number;
  sklepyPolaczone: number;
  zamowienia: number;
  kampanieWyslane: number;
  testyWyslane: number;
  popupy: number;
  firma: boolean;
  adres: boolean;
  pierwszyTestAt: Date | null;
}

/**
 * Stan wysyłki konta (0040). Dwa tryby:
 *   platforma      — domena podłączona kreatorem; „gotowa" = ten sam warunek co bramka
 *                    przed partią (status verified + potwierdzenie SES),
 *   własny serwer  — dotychczasowy model (Zaawansowane): domena adresu nadawcy verified
 *                    i serwer po udanym teście (FR45).
 */
interface StanWysylki {
  tryb: "platforma" | "wlasny_serwer";
  host: string | null;
  adresNadawcy: string | null;
  domena: string;
  statusDomeny: string;
  gotowa: boolean;
  polaczenieSprawdzone: boolean;
}

async function stanWysylki(tenantId: string): Promise<StanWysylki | null> {
  const { rows } = await getPool().query(
    `select c.host, c.from_email, d.domain, d.status, (c.connection_verified_at is not null) as sprawdzone
       from tenant_smtp_configs c
       join sending_domains d on d.tenant_id = c.tenant_id and d.id = c.sending_domain_id
      where c.tenant_id = $1`,
    [tenantId],
  );
  const w = rows[0];
  if (w) {
    return {
      tryb: "wlasny_serwer",
      host: w.host,
      adresNadawcy: w.from_email,
      domena: w.domain,
      statusDomeny: w.status,
      polaczenieSprawdzone: w.sprawdzone,
      gotowa: w.status === "verified" && w.sprawdzone,
    };
  }
  const { rows: p } = await getPool().query(
    `select d.domain, d.status, d.ses_verified_for_sending, s.from_email
       from sending_domains d
       left join tenant_platform_senders s on s.tenant_id = d.tenant_id and s.sending_domain_id = d.id
      where d.tenant_id = $1 and d.managed_by = 'platforma'
      order by d.created_at limit 1`,
    [tenantId],
  );
  const d = p[0];
  return d
    ? {
        tryb: "platforma",
        host: null,
        adresNadawcy: d.from_email ?? null,
        domena: d.domain,
        statusDomeny: d.status,
        polaczenieSprawdzone: true,
        gotowa: d.status === "verified" && d.ses_verified_for_sending === true,
      }
    : null;
}

/**
 * Odbiorcy, do których wolno dziś wysłać maila — ta sama bramka, którą przed wysyłką
 * przepuszcza `policz-odbiorcow.ts` (zgoda z rejestru, wykluczenie globalne, wykluczenie
 * tenanta, brak adresu), tylko policzona dla całego konta zamiast dla jednej kampanii.
 *
 * Liczba profili NIE nadaje się na ten krok: import historii tworzy kartoteki bez zgody,
 * więc „13 profili" przy zerze zgód wyglądałoby jak gotowa baza, a wysyłka poszłaby do zera.
 */
async function odbiorcyZeZgoda(tenantId: string): Promise<number> {
  // adresy kandydatów wracają do aplikacji: wykluczenie globalne po haszu (0022)
  // umie policzyć tylko ona, SQL nie zna klucza
  const { rows } = await getPool().query<{ email: string }>(
    `with ostatnia_zgoda as (
       select distinct on (profile_id) profile_id, state
         from consents
        where tenant_id = $1 and channel = 'email'
        order by profile_id, occurred_at desc
     ),
     lokalne as (
       select distinct on (lower(btrim(email))) lower(btrim(email)) as klucz, action
         from tenant_suppressions
        where tenant_id = $1
        order by lower(btrim(email)), occurred_at desc
     )
     select p.email
       from profiles p
       join ostatnia_zgoda z on z.profile_id = p.id
      where p.tenant_id = $1
        and z.state = 'granted'
        and p.email is not null
        and not exists (
          select 1 from lokalne l
           where l.klucz = lower(btrim(p.email)) and l.action = 'suppressed'
        )`,
    [tenantId],
  );
  const { wykluczoneGlobalnie } = await import("../adapters/db/wykluczenia");
  const { znormalizujAdres } = await import("../adapters/hash-adresu");
  const globalne = await wykluczoneGlobalnie(rows.map((r) => r.email));
  const ilu = rows.filter((r) => !globalne.has(znormalizujAdres(r.email))).length;
  return ilu;
}


async function liczbyKonta(tenantId: string): Promise<LiczbyKont> {
  const { rows } = await getPool().query(
    `select
       (select count(*)::int from stores where tenant_id = $1) as sklepy,
       (select count(*)::int from stores where tenant_id = $1 and status = 'connected') as sklepy_polaczone,
       (select count(*)::int from orders where tenant_id = $1) as zamowienia,
       (select count(*)::int from campaigns where tenant_id = $1 and status = 'sent') as kampanie_wyslane,
       -- test kampanii z edytora, który naprawdę wyszedł (stan wiadomości, nie kliknięcie)
       (select count(*)::int from messages where tenant_id = $1 and source_type = 'test'
          and current_state in ('sent', 'delivered')) as testy_wyslane,
       (select count(*)::int from popups where tenant_id = $1) as popupy,
       t.sender_company_name, t.sender_postal_address, t.first_test_email_at
       from tenants t where t.id = $1`,
    [tenantId],
  );
  const w = rows[0] ?? {};
  return {
    sklepy: w.sklepy ?? 0,
    sklepyPolaczone: w.sklepy_polaczone ?? 0,
    zamowienia: w.zamowienia ?? 0,
    kampanieWyslane: w.kampanie_wyslane ?? 0,
    testyWyslane: w.testy_wyslane ?? 0,
    popupy: w.popupy ?? 0,
    firma: Boolean(String(w.sender_company_name ?? "").trim()),
    adres: Boolean(String(w.sender_postal_address ?? "").trim()),
    pierwszyTestAt: w.first_test_email_at ?? null,
  };
}

export async function stanOnboardingu(tenantId: string): Promise<StanOnboardingu> {
  const [liczby, odbiorcy, sklepy, wysylka] = await Promise.all([
    liczbyKonta(tenantId),
    odbiorcyZeZgoda(tenantId),
    sklepyZeStanemWebhookow(tenantId),
    stanWysylki(tenantId),
  ]);

  // Webhooki: „aktywne" wolno napisać wyłącznie na podstawie ODCZYTU ZWROTNEGO ze sklepu
  // (wszystkieAktywne sprawdza potwierdzonyAt), bo Woo oddaje 201 i zostawia webhooka
  // wstrzymanego. Sklep bez zapisanego stanu = webhooki nieustawione, nie „nie wiemy".
  const zWebhookami = sklepy.filter((s) => wszystkieAktywne(s.stan));
  const sklepGotowy = liczby.sklepyPolaczone > 0 && sklepy.length > 0 && zWebhookami.length === sklepy.length;
  const testZrobiony = liczby.pierwszyTestAt !== null || liczby.testyWyslane > 0 || liczby.kampanieWyslane > 0;

  // 0040: kolejność = prosty przepływ z kreatora. Dane firmy są PIERWSZE, bo bez adresu
  // pocztowego w stopce silnik i tak nie wypuści ani jednego maila (nadawca.ts).
  const kroki: KrokWdrozenia[] = [
    {
      klucz: "firma",
      tytul: "Uzupełnij dane firmy do stopki",
      poCo: "Każdy newsletter musi mieć w stopce nazwę i adres firmy. Bez nich nic nie wyjdzie.",
      zrobiony: liczby.firma && liczby.adres,
      wBudowie: false,
      href: "/ustawienia/wysylka#dane-firmy",
      akcja: "Uzupełnij",
      szczegol: liczby.adres ? (liczby.firma ? "dane w stopce są kompletne" : "brakuje nazwy firmy") : "brakuje adresu firmy",
    },
    {
      klucz: "domena",
      tytul: "Podłącz domenę",
      poCo: "Maile wyjdą z adresu w Twojej domenie, np. newsletter@news.twojsklep.pl.",
      zrobiony: wysylka !== null,
      wBudowie: false,
      href: "/ustawienia/wysylka",
      akcja: "Podłącz domenę",
      szczegol: wysylka ? `${wysylka.domena} podłączona` : "żadna domena nie jest podłączona",
    },
    {
      klucz: "domena_gotowa",
      tytul: "Poczekaj na weryfikację domeny",
      poCo: "Sprawdzamy rekordy sami, co kilka minut. Dopóki domena nie jest gotowa, nic nie wysyłamy.",
      zrobiony: wysylka?.gotowa ?? false,
      wBudowie: false,
      href: "/ustawienia/wysylka",
      akcja: wysylka ? "Zobacz, czego brakuje" : "Najpierw podłącz domenę",
      szczegol: !wysylka
        ? "najpierw podłącz domenę"
        : wysylka.gotowa
          ? `${wysylka.domena} gotowa do wysyłki`
          : wysylka.tryb === "wlasny_serwer" && !wysylka.polaczenieSprawdzone
            ? `serwer ${wysylka.host} nie przeszedł testu połączenia`
            : `${wysylka.domena}: ${wysylka.statusDomeny === "partial" ? "część rekordów jest już na miejscu" : "czekamy na rekordy DNS"}`,
    },
    {
      klucz: "sklep",
      tytul: "Podłącz sklep",
      poCo: "Ze sklepu przychodzą klienci i zamówienia, a automatyzacje reagują na zakupy.",
      zrobiony: sklepGotowy,
      wBudowie: false,
      href: "/sklepy",
      akcja: liczby.sklepy > 0 ? "Sprawdź połączenie" : "Podłącz sklep",
      szczegol: sklepGotowy
        ? `${odmien(liczby.zamowienia, "zamówienie", "zamówienia", "zamówień")} w bazie`
        : liczby.sklepy === 0
          ? "żaden sklep nie jest podłączony"
          : liczby.sklepyPolaczone === 0
            ? "sklep nie odpowiada"
            : "sklep odpowiada, ale powiadomienia o zamówieniach nie są jeszcze włączone",
    },
    {
      klucz: "odbiorcy",
      tytul: "Dodaj odbiorców",
      poCo: "Wysyłamy tylko do osób, które zgodziły się na newsletter: z formularza zapisu albo z importu.",
      zrobiony: odbiorcy > 0,
      wBudowie: false,
      href: odbiorcy > 0 ? "/zgody" : liczby.popupy > 0 ? "/import" : "/popupy",
      akcja: odbiorcy > 0 ? "Zobacz odbiorców" : liczby.popupy > 0 ? "Zaimportuj listę" : "Dodaj formularz zapisu",
      szczegol:
        odbiorcy > 0
          ? `${odmien(odbiorcy, "osoba może", "osoby mogą", "osób może")} dostać newsletter`
          : "nikt jeszcze nie zgodził się na newsletter",
    },
    {
      klucz: "test",
      tytul: "Wyślij pierwszy mail testowy",
      poCo: "Zobaczysz, jak mail wygląda w prawdziwej skrzynce, zanim dostaną go klienci.",
      zrobiony: testZrobiony,
      wBudowie: false,
      href: "/ustawienia/wysylka#test",
      akcja: "Wyślij test",
      szczegol: testZrobiony ? "test wyszedł" : wysylka?.gotowa ? "domena gotowa, możesz wysłać test" : "test wyślesz, gdy domena będzie gotowa",
    },
  ];

  const zrobione = kroki.filter((k) => k.zrobiony).length;
  return { kroki, zrobione, wszystkie: kroki.length, gotowe: zrobione === kroki.length };
}
