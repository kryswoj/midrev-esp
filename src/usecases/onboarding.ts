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
  domeny: number;
  domenyZweryfikowane: number;
  kampanieWyslane: number;
}

/**
 * Stan wysyłki konta dla kroku „domena": serwer SMTP klienta i domena JEGO adresu
 * nadawcy. Krok jest zrobiony dopiero wtedy, gdy obie rzeczy przechodzą to samo, co
 * sprawdza silnik przed partią (FR45): domena `verified` i serwer po udanym teście.
 * Sama zweryfikowana domena bez serwera nie wystarcza — nie ma czym wysłać.
 */
interface StanWysylki {
  host: string;
  adresNadawcy: string;
  domena: string;
  statusDomeny: string;
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
  return w
    ? { host: w.host, adresNadawcy: w.from_email, domena: w.domain, statusDomeny: w.status, polaczenieSprawdzone: w.sprawdzone }
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
       (select count(*)::int from sending_domains where tenant_id = $1) as domeny,
       (select count(*)::int from sending_domains where tenant_id = $1 and status = 'verified') as domeny_zweryfikowane,
       (select count(*)::int from campaigns where tenant_id = $1 and status = 'sent') as kampanie_wyslane`,
    [tenantId],
  );
  const w = rows[0];
  return {
    sklepy: w.sklepy,
    sklepyPolaczone: w.sklepy_polaczone,
    zamowienia: w.zamowienia,
    domeny: w.domeny,
    domenyZweryfikowane: w.domeny_zweryfikowane,
    kampanieWyslane: w.kampanie_wyslane,
  };
}

/** Werdykt i opis kroku domeny — z tego samego stanu, który sprawdza silnik (FR45). */
function krokDomeny(liczby: LiczbyKont, wysylka: StanWysylki | null): { zrobiony: boolean; akcja: string; szczegol: string } {
  if (wysylka) {
    const domenaOk = wysylka.statusDomeny === "verified";
    if (domenaOk && wysylka.polaczenieSprawdzone) {
      return { zrobiony: true, akcja: "Zobacz ustawienia", szczegol: `wysyłka z ${wysylka.adresNadawcy} przez ${wysylka.host}, domena zweryfikowana` };
    }
    if (!wysylka.polaczenieSprawdzone) {
      return { zrobiony: false, akcja: "Przetestuj serwer", szczegol: `serwer ${wysylka.host} nie przeszedł testu połączenia` };
    }
    return {
      zrobiony: false,
      akcja: "Sprawdź domenę",
      szczegol: `domena ${wysylka.domena} ${wysylka.statusDomeny === "partial" ? "zweryfikowana częściowo" : "niezweryfikowana"} — wysyłka z niej jest zablokowana`,
    };
  }
  if (liczby.domeny === 0) {
    return { zrobiony: false, akcja: "Dodaj domenę", szczegol: "żadna domena nie jest dodana" };
  }
  return {
    zrobiony: false,
    akcja: "Ustaw serwer",
    szczegol:
      liczby.domenyZweryfikowane > 0
        ? "domena zweryfikowana, ale serwer wysyłkowy nie jest ustawiony"
        : `${odmien(liczby.domeny, "domena dodana", "domeny dodane", "domen dodanych")}, żadna nie jest zweryfikowana, serwer wysyłkowy nieustawiony`,
  };
}

export async function stanOnboardingu(tenantId: string): Promise<StanOnboardingu> {
  const [liczby, odbiorcy, sklepy, wysylka] = await Promise.all([
    liczbyKonta(tenantId),
    odbiorcyZeZgoda(tenantId),
    sklepyZeStanemWebhookow(tenantId),
    stanWysylki(tenantId),
  ]);
  const domena = krokDomeny(liczby, wysylka);

  // Webhooki: „aktywne" wolno napisać wyłącznie na podstawie ODCZYTU ZWROTNEGO ze sklepu
  // (wszystkieAktywne sprawdza potwierdzonyAt), bo Woo oddaje 201 i zostawia webhooka
  // wstrzymanego. Sklep bez zapisanego stanu = webhooki nieustawione, nie „nie wiemy".
  const zWebhookami = sklepy.filter((s) => wszystkieAktywne(s.stan));
  const milczace = sklepy.filter((s) => s.ostatnie_zdarzenie_at === null);

  const kroki: KrokWdrozenia[] = [
    {
      klucz: "sklep",
      tytul: "Podłącz sklep",
      poCo: "Bez sklepu panel nie ma skąd wziąć ani zamówień, ani kartotek klientów.",
      zrobiony: liczby.sklepyPolaczone > 0,
      wBudowie: false,
      href: "/sklepy",
      akcja: liczby.sklepy > 0 ? "Sprawdź połączenie" : "Podłącz sklep",
      szczegol:
        liczby.sklepyPolaczone > 0
          ? liczby.sklepy === 1
            ? "sklep odpowiada"
            : `${liczby.sklepyPolaczone} z ${liczby.sklepy} sklepów odpowiada`
          : liczby.sklepy > 0
            ? `${odmien(liczby.sklepy, "sklep dodany", "sklepy dodane", "sklepów dodanych")}, żaden nie odpowiada`
            : "żaden sklep nie jest dodany",
    },
    {
      klucz: "historia",
      tytul: "Zaimportuj historię zamówień",
      poCo: "Segmenty i raport przychodu liczą się z zamówień, więc puste konto pokazuje zero.",
      zrobiony: liczby.zamowienia > 0,
      wBudowie: false,
      href: "/sklepy",
      akcja: liczby.zamowienia > 0 ? "Zobacz importy" : "Uruchom import",
      szczegol:
        liczby.zamowienia > 0
          ? `${odmien(liczby.zamowienia, "zamówienie", "zamówienia", "zamówień")} w bazie`
          : "brak zamówień w bazie",
    },
    {
      klucz: "webhooki",
      tytul: "Włącz webhooki w sklepie",
      poCo: "Bez nich dane stają po imporcie: nowe zamówienie nie dojdzie, a automatyzacja nigdy nie wystrzeli.",
      zrobiony: sklepy.length > 0 && zWebhookami.length === sklepy.length,
      wBudowie: false,
      href: "/sklepy",
      akcja: "Sprawdź webhooki",
      szczegol:
        sklepy.length === 0
          ? "najpierw sklep"
          : zWebhookami.length === sklepy.length
            ? milczace.length > 0
              ? `tematy potwierdzone, ale ${odmien(milczace.length, "sklep nie przysłał", "sklepy nie przysłały", "sklepów nie przysłało")} jeszcze żadnego zdarzenia`
              : "wszystkie tematy potwierdzone odczytem ze sklepu"
            : sklepy.length === 1
              ? "tematy nie są potwierdzone odczytem ze sklepu"
              : `potwierdzone w ${zWebhookami.length} z ${sklepy.length} sklepów`,
    },
    {
      klucz: "domena",
      tytul: "Zweryfikuj domenę i ustaw serwer wysyłkowy",
      poCo: "Maile z niepodpisanej domeny lądują w spamie i psują reputację nadawcy na miesiące.",
      zrobiony: domena.zrobiony,
      wBudowie: false,
      href: "/ustawienia/wysylka",
      akcja: domena.akcja,
      szczegol: domena.szczegol,
    },
    {
      klucz: "odbiorcy",
      tytul: "Zbierz odbiorców ze zgodą",
      poCo: "Wysyłka przepuszcza tylko profile z aktualną zgodą i bez wykluczenia — reszta odpada tuż przed nadaniem.",
      zrobiony: odbiorcy > 0,
      wBudowie: false,
      href: "/zgody",
      akcja: odbiorcy > 0 ? "Zobacz zgody" : "Sprawdź zgody",
      szczegol:
        odbiorcy > 0
          ? `${odmien(odbiorcy, "profil przechodzi", "profile przechodzą", "profili przechodzi")} bramkę wysyłki`
          : "żaden profil nie przechodzi bramki wysyłki",
    },
    {
      klucz: "kampania",
      tytul: "Wyślij pierwszą kampanię",
      poCo: "Dopóki nic nie wyszło, raport przychodu nie ma czego przypisać do e-maila.",
      zrobiony: liczby.kampanieWyslane > 0,
      wBudowie: false,
      href: "/kampanie",
      akcja: liczby.kampanieWyslane > 0 ? "Zobacz kampanie" : "Przygotuj kampanię",
      szczegol:
        liczby.kampanieWyslane > 0
          ? `${odmien(liczby.kampanieWyslane, "kampania wyszła", "kampanie wyszły", "kampanii wyszło")}`
          : "żadna kampania jeszcze nie wyszła",
    },
  ];

  // `gotowe` steruje zniknięciem całej sekcji z ekranu startowego: zapala się dopiero,
  // gdy konto wysyła z własnej, zweryfikowanej domeny przez sprawdzony serwer.
  const zrobione = kroki.filter((k) => k.zrobiony).length;
  return { kroki, zrobione, wszystkie: kroki.length, gotowe: zrobione === kroki.length };
}
