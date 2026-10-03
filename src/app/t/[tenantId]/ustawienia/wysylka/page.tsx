import { getPool } from "../../../../../adapters/db/pool";
import { portSes } from "../../../../../adapters/aws/fabryka";
import { odczytajDaneNadawcy } from "../../../../../usecases/wysylka-konfiguracja/dane-nadawcy";
import {
  domenaPlatformowa,
  przygotujPropozycje,
  type DomenaPlatformowa,
} from "../../../../../usecases/wysylka-konfiguracja/domena-platformowa";
import { odczytajSerwer } from "../../../../../usecases/wysylka-konfiguracja/serwer";
import { JedenWpis } from "../../../../_dns/jeden-wpis";
import { TabelaRekordow } from "../../../../_dns/tabela-rekordow";
import { WskazowkaDostawcy } from "../../../../_dns/wskazowka-dostawcy";
import { wymaganyTenant } from "../../../../autoryzacja";
import { Alert, Badge, Icon } from "../../../../ui";
import { Komunikat, Naglowek } from "../../naglowek";
import { odlaczDomeneAkcja, sprawdzPlatformoweAkcja, wyslijTestPlatformyAkcja, zapiszNadawcePlatformyAkcja } from "./akcje";
import { SekcjaDanychFirmy } from "./dane-firmy";
import { FormularzPodlaczenia, InstrukcjaInformatyka, Odswiezanie } from "./kreator-klient";
import { PrzyciskAkcji } from "./przycisk";
import { WlasnySerwer } from "./wlasny-serwer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wysyłka" };

/**
 * Ekran wysyłki (01.10, „ma być banalne"). Domyślnie wysyłka platformowa: klient podaje
 * adres, kopiuje kilka rekordów, a my sprawdzamy je sami. Słowa SES/SMTP/IMAP/MAIL FROM
 * nie pojawiają się poza sekcją „Zaawansowane: własny serwer wysyłki".
 */

function ileTemu(d: Date | null): string {
  if (!d) return "jeszcze nie sprawdzaliśmy";
  const min = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60_000));
  if (min < 1) return "sprawdzone przed chwilą";
  if (min < 60) return `sprawdzone ${min} min temu`;
  const h = Math.round(min / 60);
  return h < 24 ? `sprawdzone ${h} godz. temu` : `sprawdzone ${new Date(d).toLocaleDateString("pl-PL")}`;
}

function KrokiKreatora({ aktywny, gotowe }: { aktywny: 1 | 2 | 3; gotowe: boolean }) {
  const kroki = ["Adres", "Rekordy", "Gotowe"];
  return (
    <ol className="flex items-center gap-2 text-[13px] leading-[18px]" aria-label="Kroki podłączania domeny">
      {kroki.map((nazwa, i) => {
        const nr = (i + 1) as 1 | 2 | 3;
        const zrobiony = gotowe || nr < aktywny;
        const biezacy = !gotowe && nr === aktywny;
        return (
          <li key={nazwa} className="flex items-center gap-2" aria-current={biezacy ? "step" : undefined}>
            {i > 0 ? <span className="h-px w-5 bg-[var(--color-linia-mocna)] max-sm:w-3" aria-hidden="true" /> : null}
            <span
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[12px] font-semibold ${
                zrobiony
                  ? "border-[var(--color-ok)] bg-[var(--color-ok)] text-white"
                  : biezacy
                    ? "border-[var(--color-akcent)] bg-[var(--color-akcent)] text-white"
                    : "border-[var(--color-linia-mocna)] bg-white text-[var(--color-tekst-3)]"
              }`}
              aria-hidden="true"
            >
              {zrobiony ? <Icon name="check" size={13} strokeWidth={2.6} /> : nr}
            </span>
            <span className={biezacy ? "font-semibold text-[var(--color-tekst)]" : "text-[var(--color-tekst-2)]"}>{nazwa}</span>
          </li>
        );
      })}
    </ol>
  );
}

async function KrokAdresu({ tenantId, wpis, prefiks, lokalna, nazwaKonta, email }: {
  tenantId: string;
  wpis?: string;
  prefiks?: string;
  lokalna?: string;
  nazwaKonta: string;
  email: string;
}) {
  const propozycja = wpis ? await przygotujPropozycje(wpis, { prefiks, lokalna }) : null;
  return (
    <section className="karta overflow-hidden">
      <div className="karta-naglowek">
        <div className="min-w-0 flex-1">
          <h2>Podłącz domenę</h2>
          <p className="karta-opis">Trzy kroki. Nie musisz znać się na poczcie — powiemy dokładnie, co gdzie wkleić.</p>
        </div>
      </div>
      <div className="space-y-5 p-6 max-md:p-4">
        <KrokiKreatora aktywny={1} gotowe={false} />
        {!portSes() ? (
          <Alert tone="uwaga" title="Podłączanie domen uruchomimy wkrótce">
            Po naszej stronie trwa ostatnia konfiguracja. Wróć tu za chwilę albo napisz do nas.
          </Alert>
        ) : propozycja?.ok ? (
          <>
            <a href={`/t/${tenantId}/ustawienia/wysylka`} className="inline-flex text-[13px] font-medium text-[var(--color-akcent)] hover:underline">
              ← Wpisz inną domenę
            </a>
            <FormularzPodlaczenia
              tenantId={tenantId}
              wpis={propozycja.propozycja.wpis}
              strefa={propozycja.propozycja.strefa}
              prefiks={propozycja.propozycja.prefiks}
              lokalna={propozycja.propozycja.lokalna}
              nazwaNadawcy={nazwaKonta}
              odpowiedzDo={email}
              wpisJestSubdomena={propozycja.propozycja.uklad.domenaWysylkowa !== propozycja.propozycja.strefa && !propozycja.propozycja.prefiks && !propozycja.propozycja.uklad.domenaGlowna}
            />
          </>
        ) : (
          <form method="get" className="max-w-[520px] space-y-3">
            <label className="block">
              <span className="text-[15px] font-semibold leading-[22px]">Z jakiego adresu mają wychodzić maile?</span>
              <span className="tekst-pomocniczy mb-2 mt-1 block">Wpisz adres swojej strony albo firmowy e-mail. Resztę zaproponujemy sami.</span>
              <input name="wpis" required defaultValue={wpis ?? ""} placeholder="sklep.pl albo kontakt@sklep.pl" className="pole" autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </label>
            {propozycja && !propozycja.ok ? (
              <p role="alert" className="rounded-md border border-[var(--color-blad-ramka)] bg-[var(--color-blad-tlo)] px-3 py-2 text-[13px] text-[var(--color-blad)]">
                {propozycja.blad}
              </p>
            ) : null}
            <button className="przycisk" type="submit">
              Dalej
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

function StatusDomeny({ d }: { d: DomenaPlatformowa }) {
  if (d.gotowa) return <Badge ton="ok">gotowa</Badge>;
  // wpis NS działa: rekordy są nasze, czekamy tylko na potwierdzenie (nie „czeka na rekordy")
  if (d.tryb === "delegacja" && (d.delegacja?.ocena?.stan === "dziala" || d.delegacja?.ocena?.stan === "czeka")) return <Badge ton="uwaga">sprawdzamy</Badge>;
  if (d.status === "partial") return <Badge ton="uwaga">w trakcie</Badge>;
  return <Badge ton="szkic">czeka na rekordy</Badge>;
}

function WidokDomeny({ tenantId, d }: { tenantId: string; d: DomenaPlatformowa }) {
  const oceny = d.raport?.rekordy ?? {};
  const doZrobienia = d.rekordy.filter((r) => oceny[r.klucz]?.stan !== "ok").length;
  const licz = (stan: string) => d.rekordy.filter((r) => (oceny[r.klucz]?.stan ?? "brak") === stan).length;
  const podsumowanie = [
    licz("brak") ? `do dodania: ${licz("brak")}` : "",
    licz("zle") ? `do poprawy: ${licz("zle")}` : "",
    licz("czeka") ? `sprawdzamy: ${licz("czeka")}` : "",
  ].filter(Boolean).join(" · ");
  const pilne = (d.raport?.ostrzezenia ?? []).filter((o) => o.startsWith("PILNE"));
  const inne = (d.raport?.ostrzezenia ?? []).filter((o) => !o.startsWith("PILNE"));
  // „jeden wpis" jako główna droga albo jako alternatywa pod tabelą ręczną
  const jedenWpis = d.delegacja && d.tryb === "delegacja" ? d.delegacja : null;
  const alternatywaNs = d.delegacja && d.tryb === "reczny" ? d.delegacja : null;
  const stanNs = d.delegacja?.ocena?.stan ?? null;
  // krok 3 („Gotowe" = czekamy na potwierdzenie) dopiero, gdy klient wpisał WSZYSTKO
  const wszystkieWpisane = jedenWpis
    ? stanNs === "czeka" || stanNs === "dziala"
    : d.rekordy.length > 0 && d.rekordy.every((r) => ["ok", "czeka"].includes(oceny[r.klucz]?.stan ?? ""));
  const powodRecznych =
    d.delegacjaNiedostepna === "dostawca"
      ? `Panel ${d.dostawca.nazwa} nie pozwala dodać jednego wpisu dla subdomeny, dlatego potrzebne są rekordy poniżej.`
      : d.delegacjaNiedostepna === "zajeta_nazwa"
        ? `Pod adresem ${d.domena} coś już działa, więc nie przejmujemy go jednym wpisem. Dodaj rekordy poniżej.`
        : null;
  const tabelaReczna = (
    <div className="overflow-hidden rounded-[10px] border border-[var(--color-linia)]">
      <TabelaRekordow rekordy={d.rekordy} oceny={oceny} />
    </div>
  );
  const aktywny: 2 | 3 = wszystkieWpisane ? 3 : 2;
  return (
    <section className="karta overflow-hidden">
      <Odswiezanie aktywne={!d.gotowa} />
      <div className="karta-naglowek">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-all">{d.domena}</h2>
            <StatusDomeny d={d} />
          </div>
          <p className="karta-opis">
            {d.nadawca ? <>Maile wychodzą jako <span className="font-medium text-[var(--color-tekst)]">{d.nadawca.nazwa}</span> &lt;{d.nadawca.adres}&gt;</> : null}
          </p>
        </div>
      </div>
      <div className="space-y-5 p-6 max-md:p-4">
        <KrokiKreatora aktywny={aktywny} gotowe={d.gotowa} />

        {pilne.map((o) => (
          <Alert key={o} tone="blad" title={o.includes("MX") ? "Twoja zwykła poczta może nie działać" : "Wpis jest w złym miejscu"}>{o.replace(/^PILNE:\s*/, "")}</Alert>
        ))}

        {d.gotowa ? (
          <Alert tone="ok" title="Domena gotowa">
            Wszystkie rekordy są na miejscu. Możesz wysyłać kampanie i automatyzacje.
            <span className="mt-3 flex flex-wrap gap-2">
              <a href="#test" className="przycisk przycisk-maly">Wyślij mail testowy</a>
              <a href={`/t/${tenantId}/kampanie`} className="przycisk przycisk-wtorny przycisk-maly">Przygotuj kampanię</a>
            </span>
          </Alert>
        ) : jedenWpis ? (
          <div className="space-y-1">
            <p className="text-[15px] font-semibold leading-[22px]">
              {stanNs === "dziala" ? "Wpis działa. Resztę ustawiliśmy sami" : "Najprościej: jeden rekord u dostawcy domeny"}
            </p>
            <p className="tekst-pomocniczy">
              {stanNs === "dziala"
                ? "Czekamy na ostatnie potwierdzenie, zwykle kilka minut. Damy znać mailem, gdy wszystko będzie gotowe."
                : `Dodaj rekord NS dla nazwy ${jedenWpis.nazwa} w panelu domeny ${d.strefa}. Wszystkie pozostałe ustawimy i będziemy pilnować sami. Sprawdzamy co kilka minut, możesz zamknąć tę stronę.`}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-[15px] font-semibold leading-[22px]">
              {doZrobienia === d.rekordy.length
                ? `Dodaj ${d.rekordy.length} rekordów u dostawcy domeny`
                : `Gotowe: ${d.rekordy.length - doZrobienia} z ${d.rekordy.length} rekordów`}
            </p>
            {podsumowanie ? <p className="text-[13px] leading-[19px] text-[var(--color-tekst-2)]">{podsumowanie}</p> : null}
            {powodRecznych ? <p className="text-[13px] leading-[19px] text-[var(--color-tekst-2)]">{powodRecznych}</p> : null}
            <p className="tekst-pomocniczy">
              Skopiuj każdy wiersz z tabeli do panelu, w którym zarządzasz domeną {d.strefa}. Sprawdzamy sami co kilka minut — możesz zamknąć tę stronę, damy znać mailem, gdy wszystko będzie gotowe.
            </p>
          </div>
        )}

        {inne.map((o) => (
          <Alert key={o} tone="uwaga">{o}</Alert>
        ))}


        {d.gotowa ? (
          <details className="rounded-[10px] border border-[var(--color-linia)]">
            <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium text-[var(--color-tekst-2)]">Pokaż rekordy DNS</summary>
            <div className="border-t border-[var(--color-linia)]">
              {jedenWpis ? (
                <div className="space-y-2 p-4">
                  <JedenWpis nazwa={jedenWpis.nazwa} serwery={jedenWpis.serwery} dostawca={d.dostawca} ocena={jedenWpis.ocena} strefa={d.strefa} />
                  <p className="tekst-meta">Rekordy pod {d.domena} ustawiamy i aktualizujemy sami.</p>
                </div>
              ) : (
                <TabelaRekordow rekordy={d.rekordy} oceny={oceny} />
              )}
            </div>
          </details>
        ) : jedenWpis ? (
          <>
            <JedenWpis nazwa={jedenWpis.nazwa} serwery={jedenWpis.serwery} dostawca={d.dostawca} ocena={jedenWpis.ocena} strefa={d.strefa} />
            <details className="rounded-[10px] border border-[var(--color-linia)]">
              <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium text-[var(--color-tekst-2)]">Wolisz wpisać rekordy samodzielnie?</summary>
              <div className="space-y-3 border-t border-[var(--color-linia)] p-4 max-md:p-3">
                <p className="text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
                  Zamiast jednego wpisu możesz dodać {d.rekordy.length} rekordów. Wybierz jedną drogę, nie obie.
                </p>
                {tabelaReczna}
              </div>
            </details>
          </>
        ) : (
          <>
            {tabelaReczna}
            {alternatywaNs ? (
              <details className="rounded-[10px] border border-[var(--color-linia)]">
                <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium text-[var(--color-tekst-2)]">Prościej: jeden rekord NS zamiast {d.rekordy.length}</summary>
                <div className="border-t border-[var(--color-linia)] p-4 max-md:p-3">
                  <JedenWpis nazwa={alternatywaNs.nazwa} serwery={alternatywaNs.serwery} dostawca={d.dostawca} ocena={alternatywaNs.ocena} strefa={d.strefa} />
                </div>
              </details>
            ) : null}
          </>
        )}

        {!d.gotowa ? (
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_280px]">
            <WskazowkaDostawcy dostawca={d.dostawca} strefa={d.strefa} jedenWpis={Boolean(jedenWpis)} />
            <div className="karta-plaska space-y-2 p-4">
              <p className="text-[13px] font-semibold leading-[19px]">Domeną zajmuje się ktoś inny?</p>
              <p className="text-[13px] leading-[19px] text-[var(--color-tekst-2)]">Wyślij mu link z rekordami. Nie dostanie dostępu do konta.</p>
              <InstrukcjaInformatyka tenantId={tenantId} domena={d.domena} />
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {!d.gotowa ? (
            <span className="inline-flex items-center gap-2 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-czeka)]" aria-hidden="true" />
              Sprawdzamy automatycznie co kilka minut · {ileTemu(d.sprawdzonoAt)}
            </span>
          ) : (
            <span className="tekst-meta">{ileTemu(d.sprawdzonoAt)}</span>
          )}
          <form action={sprawdzPlatformoweAkcja}>
            <input type="hidden" name="tenantId" value={tenantId} />
            <PrzyciskAkcji trwa="Sprawdzam…" wariant="przycisk-wtorny">
              Sprawdź ponownie
            </PrzyciskAkcji>
          </form>
        </div>
      </div>

      <details className="border-t border-[var(--color-linia)] px-6 py-4 max-md:px-4">
        <summary className="cursor-pointer text-[13px] font-medium text-[var(--color-tekst-2)]">Zmień nazwę nadawcy albo adres</summary>
        {d.nadawca ? (
          <form action={zapiszNadawcePlatformyAkcja} className="mt-4 grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="tenantId" value={tenantId} />
            <label className="block">
              <span className="etykieta mb-1.5 block">Nazwa nadawcy</span>
              <input name="nazwaNadawcy" required maxLength={200} defaultValue={d.nadawca.nazwa} className="pole" />
            </label>
            <label className="block">
              <span className="etykieta mb-1.5 block">Adres nadawcy</span>
              <span className="flex items-center gap-1.5">
                <input name="lokalna" required maxLength={64} defaultValue={d.nadawca.adres.split("@")[0]} className="pole w-[150px]" autoComplete="off" />
                <span className="truncate text-[14px] text-[var(--color-tekst-2)]">@{d.domena}</span>
              </span>
            </label>
            <label className="block sm:col-span-2">
              <span className="etykieta mb-1.5 block">Odpowiedzi trafią na</span>
              <input name="odpowiedzDo" type="email" maxLength={320} defaultValue={d.nadawca.odpowiedzDo ?? ""} className="pole sm:max-w-[360px]" />
            </label>
            <div className="sm:col-span-2">
              <PrzyciskAkcji trwa="Zapisuję…" maly={false}>Zapisz nadawcę</PrzyciskAkcji>
            </div>
          </form>
        ) : null}
      </details>

      <details className="border-t border-[var(--color-linia)] px-6 py-4 max-md:px-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-[var(--color-blad)]">
          <Icon name="uwaga" size={16} />
          Odłącz domenę
        </summary>
        <form action={odlaczDomeneAkcja} className="mt-3 flex flex-wrap items-end gap-3 rounded-[10px] border border-[var(--color-blad-ramka)] bg-white p-4">
          <input type="hidden" name="tenantId" value={tenantId} />
          <p className="w-full text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
            Wysyłka zatrzyma się do czasu podłączenia domeny ponownie. Rekordy w DNS możesz potem usunąć.
          </p>
          <label className="block">
            <span className="etykieta mb-1.5 block">Wpisz „odłącz”, żeby potwierdzić</span>
            <input name="potwierdzenie" required className="pole w-[200px]" autoComplete="off" />
          </label>
          <PrzyciskAkcji trwa="Odłączam…" wariant="przycisk-niebezpieczny" maly={false}>Odłącz domenę</PrzyciskAkcji>
        </form>
      </details>
    </section>
  );
}

function MailTestowy({ tenantId, email, gotowa }: { tenantId: string; email: string; gotowa: boolean }) {
  return (
    <section id="test" className="karta overflow-hidden scroll-mt-24">
      <div className="karta-naglowek">
        <div className="min-w-0">
          <h2>Mail testowy</h2>
          <p className="karta-opis">Wyślij sobie próbny mail i zobacz, jak wygląda w prawdziwej skrzynce.</p>
        </div>
      </div>
      <form action={wyslijTestPlatformyAkcja} className="flex flex-wrap items-end gap-3 p-6 max-md:p-4">
        <input type="hidden" name="tenantId" value={tenantId} />
        <label className="block min-w-0 flex-1 sm:max-w-[320px]">
          <span className="etykieta mb-1.5 block">Wyślij na adres</span>
          <input name="adres" type="email" required defaultValue={email} className="pole" disabled={!gotowa} />
        </label>
        {gotowa ? (
          <PrzyciskAkcji trwa="Wysyłam…" wariant="przycisk-wtorny" maly={false}>Wyślij test</PrzyciskAkcji>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2">
            <button type="button" className="przycisk przycisk-wtorny" disabled>Wyślij test</button>
            <span className="tekst-meta !text-[var(--color-tekst-2)]">Dostępne, gdy domena będzie gotowa.</span>
          </span>
        )}
      </form>
    </section>
  );
}

export default async function Wysylka({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string; wpis?: string; prefiks?: string; lokalna?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21) — layout nie jest granicą autoryzacji
  const { sesja } = await wymaganyTenant(tenantId);
  const sp = await searchParams;
  const [serwer, domena, konto, daneFirmy] = await Promise.all([
    odczytajSerwer(tenantId),
    domenaPlatformowa(tenantId),
    getPool().query("select name from tenants where id = $1", [tenantId]),
    odczytajDaneNadawcy(tenantId),
  ]);
  const nazwaKonta = String(konto.rows[0]?.name ?? "");
  const wlasnySerwer = serwer !== null;

  return (
    <>
      <Naglowek tytul="Wysyłka" podtytul="Z jakiego adresu wychodzą Twoje newslettery." />
      <Komunikat ok={sp.ok} blad={sp.blad} />
      <div className="max-w-[920px] space-y-6 pb-12 max-md:space-y-4">
        {wlasnySerwer ? (
          <>
            <Alert tone="info" title="To konto wysyła przez własny serwer">
              Ustawienia serwera, domeny i odbić są niżej. Konta bez własnego serwera wysyłają przez MidRev i nie muszą niczego z tego ustawiać.
            </Alert>
            <WlasnySerwer tenantId={tenantId} nazwaKonta={nazwaKonta} />
            <SekcjaDanychFirmy tenantId={tenantId} dane={daneFirmy} />
          </>
        ) : (
          <>
            {domena ? (
              <WidokDomeny tenantId={tenantId} d={domena} />
            ) : (
              <KrokAdresu tenantId={tenantId} wpis={sp.wpis} prefiks={sp.prefiks} lokalna={sp.lokalna} nazwaKonta={nazwaKonta} email={sesja.email} />
            )}
            <MailTestowy tenantId={tenantId} email={sesja.email} gotowa={domena?.gotowa ?? false} />
            <SekcjaDanychFirmy tenantId={tenantId} dane={daneFirmy} />
            <details className="karta overflow-hidden">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-6 py-4 text-[14px] font-semibold max-md:px-4">
                <Icon name="ustawienia" size={16} className="text-[var(--color-tekst-3)]" />
                Zaawansowane: własny serwer wysyłki
                <Icon name="chevronDown" size={16} className="ml-auto text-[var(--color-tekst-3)]" />
              </summary>
              <div className="space-y-4 border-t border-[var(--color-linia)] bg-[var(--color-plotno)] p-4">
                <p className="tekst-pomocniczy">
                  Dla firm, które mają własny serwer pocztowy i chcą wysyłać przez niego. Zapisanie serwera przełącza całą wysyłkę konta na ten serwer.
                </p>
                <WlasnySerwer tenantId={tenantId} nazwaKonta={nazwaKonta} />
              </div>
            </details>
          </>
        )}
      </div>
    </>
  );
}
