import Link from "next/link";
import { wymaganyTenant } from "../../../../autoryzacja";
import { getPool } from "../../../../../adapters/db/pool";
import { zGroszy } from "../../../../../domain/kwoty";
import { odmien } from "../../../../../domain/liczebniki";
import { raportKampanii } from "../../../../../usecases/przelicz-atrybucje";
import { policzOdbiorcow } from "../../../../../usecases/policz-odbiorcow";
import { config } from "../../../../../config";
import { formatujDateICzas } from "../../../../../domain/daty";
import { RaportZaangazowania } from "./raport-zaangazowania";
import {
  doAkceptacjiAkcja,
  odwolajKampanieAkcja,
  przeliczAtrybucjeAkcja,
  wstrzymajKampanieAkcja,
  wyslijTerazAkcja,
  wyslijTestAkcja,
  wznowKampanieAkcja,
  wznowWysylkeSklepuAkcja,
  zaplanujWysylkeAkcja,
} from "../../../../akcje";
import { stanKampanii, OKNO_SPOZNIENIA_GODZIN } from "../../../../../usecases/wysylka/sterowanie";
import { stanWysylkiTenanta } from "../../../../../usecases/wysylka/reputacja";
import { Stat } from "../../../../ui";
import { PrzyciskKopiuj } from "./kopiuj";
import { PrzyciskDuplikuj } from "../akcje-kampanii";
import { Komunikat, kampaniaKreatora, RamaKreatora } from "./kreator";
import { listaKontrolnaKampanii, type PunktListy } from "../../../../../usecases/tresc/lista-kontrolna";
import { zlozWiadomosc } from "../../../../../usecases/wysylka/renderuj";
import { naPoleCzasuPolskiego } from "../../../../../usecases/wysylka/strefa";

export const dynamic = "force-dynamic";


/**
 * Wartość dla <input type="datetime-local">. Pole nie zna strefy, więc i renderowanie,
 * i parsowanie dzieją się po stronie serwera w JEDNEJ strefie — inaczej plan zapisany
 * o 10:00 wracałby do pola jako 12:00.
 */
function naPoleDatyICzasu(d: Date | string | null | undefined): string {
  if (!d) return "";
  const data = new Date(d);
  if (Number.isNaN(data.getTime())) return "";
  const dwa = (n: number) => String(n).padStart(2, "0");
  return `${data.getFullYear()}-${dwa(data.getMonth() + 1)}-${dwa(data.getDate())}T${dwa(data.getHours())}:${dwa(data.getMinutes())}`;
}

/**
 * Powód przy zablokowanym przycisku. DESIGN.md: przycisk zablokowany ZAWSZE z widocznym
 * powodem obok, nigdy sam wyszarzony — operator ma wiedzieć, czego brakuje, bez zgadywania.
 */
function Powod({ tekst }: { tekst: string }) {
  return <span className="ml-2 self-center text-[12px] text-[var(--color-tekst-2)]">{tekst}</span>;
}

export default async function Kampania({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; campaignId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string; link?: string }>;
}) {
  const { tenantId, campaignId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const { ok, blad, link: surowyLink } = await searchParams;
  // ?link= to parametr z URL-a, czyli wejście atakującego: renderujemy go jako
  // "link do akceptacji" wyłącznie, gdy faktycznie prowadzi na naszą stronę
  // akceptacji (review Codeksa, runda 1 - podrzucony URL panelu z obcym linkiem
  // wyglądałby jak wygenerowany przez system)
  const link =
    surowyLink && surowyLink.startsWith(`${config().APP_URL}/akceptacja/`)
      ? surowyLink
      : undefined;
  const kampania = await kampaniaKreatora(tenantId, campaignId);

  const [odbiorcy, raport, akceptacje, stanWysylki, wstrzymanieSklepu] = await Promise.all([
    policzOdbiorcow(tenantId, campaignId),
    raportKampanii(tenantId, campaignId),
    // najnowsza runda akceptacji: stan bramki ma byc widoczny NA STALE na karcie,
    // nie tylko w znikajacym banerze po wygenerowaniu linku (audyt P3)
    getPool().query(
      `select created_at, expires_at, decided_at, decision, comment
         from campaign_approvals
        where tenant_id = $1 and campaign_id = $2
        order by created_at desc limit 1`,
      [tenantId, campaignId],
    ),
    // liczby, które muszą być na ekranie PRZED decyzją o wstrzymaniu i odwołaniu
    stanKampanii(tenantId, campaignId),
    stanWysylkiTenanta(tenantId),
  ]);
  const [lista, sklep] = await Promise.all([
    listaKontrolnaKampanii(tenantId, campaignId, { odbiorcy }),
    getPool().query("select name, sender_company_name, sender_postal_address, sender_tax_id from tenants where id = $1", [tenantId]),
  ]);
  const akceptacja = akceptacje.rows[0];
  const html = String((kampania.content as any)?.html ?? "");
  // Podgląd = to, co dostanie odbiorca: PRAWDZIWE złożenie wiadomości przez silnik
  // (oprawa i stopka z wypisem), z tokenami-atrapami, bez pixela i bez przepisania linków.
  const podglad = html.trim()
    ? zlozWiadomosc({
        trescHtml: html,
        clickToken: "podglad",
        unsubscribeToken: "podglad",
        nazwaSklepu: String(sklep.rows[0]?.name ?? ""),
        nadawca: {
          firma: sklep.rows[0]?.sender_company_name ?? null,
          adres: sklep.rows[0]?.sender_postal_address ?? null,
          nip: sklep.rows[0]?.sender_tax_id ?? null,
        },
        sledzKlikniecia: false,
        sledzOtwarcia: false,
      }).html
    : "";
  // "po wysyłce" = część odbiorców już dostała maila ALBO sprawa jest zamknięta.
  // Wstrzymana i odwołana należą tu razem z sending i sent: treści nie wolno już ruszyć.
  const poWysylce = ["sending", "paused", "sent", "cancelled"].includes(kampania.status);
  const wWysylce = kampania.status === "sending";
  const wstrzymana = kampania.status === "paused";
  const przedWysylka = ["draft", "awaiting_approval", "approved", "scheduled"].includes(kampania.status);
  const planPrzeterminowany =
    kampania.status === "approved" &&
    Boolean(kampania.scheduled_at) &&
    new Date(kampania.scheduled_at ?? 0).getTime() < Date.now() - OKNO_SPOZNIENIA_GODZIN * 3600_000;
  // B4: twarda bramka. Każdy niespełniony punkt listy kontrolnej to osobny powód przy
  // zablokowanym przycisku, w kolejności, w jakiej operator je usuwa.
  const niespelnione = lista.punkty.filter((p) => p.stan === "blad");
  const powodyBlokadyWysylki = [
    ...(wstrzymanieSklepu.wstrzymany ? [`wysyłka sklepu wstrzymana: ${wstrzymanieSklepu.powod ?? "bez podanego powodu"}`] : []),
    ...niespelnione.map((p) => `${p.etykieta.toLowerCase()}: ${p.opis}`),
    ...(kampania.status !== "approved" ? ["wysyłka rusza dopiero po akceptacji klienta"] : []),
  ];
  // Jeden nadrzędny stan decyzji: zielony wyłącznie wtedy, gdy NIC nie blokuje wysyłki.
  // Kompletna konfiguracja bez akceptacji klienta to wciąż „czeka", nie „gotowe".
  const stanDecyzji = !przedWysylka
    ? { etykieta: kampania.status === "sent" ? "wysłana" : kampania.status === "cancelled" ? "odwołana" : kampania.status === "paused" ? "wstrzymana" : "w wysyłce", klasa: kampania.status === "cancelled" ? "plakietka-blad" : kampania.status === "sent" ? "plakietka-ok" : "plakietka-uwaga" }
    : powodyBlokadyWysylki.length === 0
      ? { etykieta: "gotowa do wysyłki", klasa: "plakietka-ok" }
      : niespelnione.length || wstrzymanieSklepu.wstrzymany
        ? { etykieta: "wymaga poprawek", klasa: "plakietka-blad" }
        : kampania.status === "awaiting_approval"
          ? { etykieta: "czeka na klienta", klasa: "plakietka-uwaga" }
          : { etykieta: "wymaga akceptacji klienta", klasa: "plakietka-uwaga" };
  const linkWygasl = Boolean(akceptacja && !akceptacja.decided_at && new Date(akceptacja.expires_at) < new Date());
  const stanAkceptacji =
    kampania.status === "approved"
      ? { etykieta: "zaakceptowana", klasa: "plakietka-ok", opis: `Klient zaakceptował tę wersję${akceptacja?.decided_at ? ` ${formatujDateICzas(akceptacja.decided_at)}` : ""}.` }
      : akceptacja?.decided_at && akceptacja.decision !== "approved"
        ? { etykieta: "klient zgłosił uwagi", klasa: "plakietka-blad", opis: `${formatujDateICzas(akceptacja.decided_at)}${akceptacja.comment ? `: „${akceptacja.comment}"` : ""}. Popraw treść i wyślij nowy link.` }
        : kampania.status === "awaiting_approval" && akceptacja && !linkWygasl
          ? { etykieta: "link aktywny", klasa: "plakietka-uwaga", opis: `Czeka na decyzję klienta. Link wygenerowany ${formatujDateICzas(akceptacja.created_at)}, ważny do ${formatujDateICzas(akceptacja.expires_at)}. Pełnego linku nie przechowujemy — zgubiony link zastąp nowym.` }
          : linkWygasl
            ? { etykieta: "link wygasł", klasa: "plakietka-blad", opis: "Klient nie zdecydował przed wygaśnięciem linku. Wygeneruj nowy." }
            : { etykieta: "link nieutworzony", klasa: "plakietka-szkic", opis: "Klient akceptuje maila z linku, bez logowania. Bez akceptacji kampania nie wyjdzie." };
  const baza = `/t/${tenantId}/kampanie/${campaignId}`;
  const sciezkaKroku: Record<PunktListy["krok"], string> = {
    odbiorcy: `${baza}/odbiorcy`,
    tresc: `${baza}/tresc`,
    ustawienia: `${baza}/ustawienia`,
    przeglad: baza,
  };

  return (
    <>
      <RamaKreatora
        tenantId={tenantId}
        kampania={kampania}
        aktywny="przeglad"
        akcja={<PrzyciskDuplikuj tenantId={tenantId} campaignId={campaignId} />}
      />
      <Komunikat ok={ok} blad={blad} />

      {/* Pasek stanu (DESIGN.md): rzecz wymagająca decyzji ma być widoczna od razu,
          bez wchodzenia w zakładkę. Wstrzymanie dotyczy CAŁEGO sklepu, nie tej jednej
          kampanii, więc stoi nad kampanią, a nie w jej ścieżce wysyłki. */}
      {wstrzymanieSklepu.wstrzymany ? (
        <div className="px-5 pt-4">
          <div
            className="flex flex-wrap items-center gap-3 rounded-[10px] px-4 py-3"
            style={{
              background: "var(--color-blad-tlo)",
              border: "1px solid var(--color-blad)",
            }}
            role="status"
          >
            <span className="plakietka plakietka-blad font-medium">Wysyłka sklepu wstrzymana</span>
            <span className="text-[var(--color-tekst-2)]">
              {wstrzymanieSklepu.powod ?? "bez podanego powodu"}
              {wstrzymanieSklepu.od ? `, od ${formatujDateICzas(wstrzymanieSklepu.od)}` : ""}.
              Nic nie wyjdzie — ani kampanie, ani automatyzacje, ani testy.
            </span>
            <form action={wznowWysylkeSklepuAkcja} className="ml-auto">
              <input type="hidden" name="tenantId" value={tenantId} />
              <input type="hidden" name="wrocDo" value={`/t/${tenantId}/kampanie/${campaignId}`} />
              <button className="przycisk przycisk-wtorny" type="submit">
                Wznów wysyłkę sklepu
              </button>
            </form>
          </div>
        </div>
      ) : null}

      {/* Wyniki na górze dopiero, gdy jest z czego liczyć: przed wysyłką byłyby samymi
          zerami i wypychałyby decyzję w dół strony. Kolejność kafli: PRZYCHÓD PIERWSZY
          (PANELE-ESP 2.5, 3.5) — otwarcie po Apple MPP jest metryką kaleką. */}
      {poWysylce ? (
        <div className="space-y-5 px-5 pt-5">
          <div className="karta siatka-wloskiem grid sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Przychód" value={zGroszy(Number(raport.przychod_minor))} description={`${odmien(Number(raport.zamowien), "zamówienie", "zamówienia", "zamówień")}, ostatni przebieg atrybucji`} />
            <Stat label="Kliknięcia" value={String(raport.klikniecia)} description="odbiorcy, którzy kliknęli" />
            <Stat label="Wysłane" value={String(raport.wyslane)} description={raport.zatrzymane ? `${raport.zatrzymane} zatrzymanych bramką` : "wiadomości u odbiorców"} />
            <Stat label="Do wysyłki" value={String(odbiorcy.docelowo)} description={`z ${odbiorcy.kandydaci} kandydatów, stan na teraz`} />
          </div>
          <div className="flex justify-end">
            <form action={przeliczAtrybucjeAkcja}>
              <input type="hidden" name="tenantId" value={tenantId} />
              <input type="hidden" name="campaignId" value={campaignId} />
              <button className="przycisk przycisk-wtorny przycisk-maly" type="submit">
                Przelicz atrybucję
              </button>
            </form>
          </div>
        </div>
      ) : null}

      <div className="grid items-start gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* ── Lewa kolumna: co wychodzi i czy jest gotowe ── */}
        <div className="min-w-0 space-y-5">
          {/* B4: lista kontrolna przed wysyłką. Twarda bramka: każdy punkt „brakuje"
              blokuje „Wyślij teraz" i planowanie, także w akcji serwera. */}
          {/* po starcie wysyłki lista kontrolna jest historią, nie decyzją — ekran prowadzą wyniki */}
          {!poWysylce ? (
          <section className="karta overflow-hidden">
            <div className="karta-naglowek">
              <h2>Lista kontrolna przed wysyłką</h2>
              <span className={`plakietka ml-auto ${lista.gotowa ? "plakietka-ok" : "plakietka-blad"}`}>
                {lista.gotowa
                  ? "treść i ustawienia kompletne"
                  : `${niespelnione.length} ${niespelnione.length === 1 ? "rzecz do poprawy" : "rzeczy do poprawy"}`}
              </span>
            </div>
            <ul>
              {lista.punkty.map((p) => (
                <li key={p.klucz} className="grid grid-cols-[96px_minmax(0,1fr)_auto] items-start gap-3 border-b border-[var(--color-linia-0)] px-4 py-3.5 last:border-b-0">
                  <span
                    className={`plakietka mt-px justify-center ${
                      p.stan === "ok" ? "plakietka-ok" : p.stan === "blad" ? "plakietka-blad" : "plakietka-uwaga"
                    }`}
                  >
                    {p.stan === "ok" ? "gotowe" : p.stan === "blad" ? "brakuje" : "uwaga"}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold">{p.etykieta}</div>
                    <div className="mt-0.5 break-words text-[13px] leading-[19px] text-[var(--color-tekst-2)]">{p.opis}</div>
                  </div>
                  {p.stan !== "ok" && !poWysylce && p.krok !== "przeglad" ? (
                    <Link
                      href={p.klucz === "domena" ? `/t/${tenantId}/ustawienia/wysylka` : sciezkaKroku[p.krok]}
                      className="przycisk przycisk-wtorny przycisk-maly"
                    >
                      Popraw
                    </Link>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          </section>
          ) : null}

          <section className="karta overflow-hidden">
            <div className="karta-naglowek">
              <h2>Podgląd wiadomości</h2>
              {!poWysylce ? (
                <Link href={`${baza}/tresc`} className="przycisk przycisk-wtorny przycisk-maly ml-auto">
                  Edytuj treść
                </Link>
              ) : null}
            </div>
            <dl className="grid gap-x-4 gap-y-2 border-b border-[var(--color-linia)] px-4 py-3 text-[13px] sm:grid-cols-[88px_minmax(0,1fr)]">
              <dt className="text-[var(--color-tekst-3)]">Temat</dt>
              <dd className="truncate font-medium">{kampania.subject || <span className="text-[var(--color-blad)]">brak</span>}</dd>
              <dt className="text-[var(--color-tekst-3)]">Preheader</dt>
              <dd className="truncate text-[var(--color-tekst-2)]">{kampania.preheader || "—"}</dd>
              <dt className="text-[var(--color-tekst-3)]">Odbiorcy</dt>
              <dd className="truncate text-[var(--color-tekst-2)]">
                {odbiorcy.zrodla.filter((z) => z.mode === "include").map((z) => z.nazwa).join(", ") || "nie wybrani"}
                {odbiorcy.zrodla.some((z) => z.mode === "exclude")
                  ? ` · bez: ${odbiorcy.zrodla.filter((z) => z.mode === "exclude").map((z) => z.nazwa).join(", ")}`
                  : ""}
                {" · "}
                <span className="liczba font-medium text-[var(--color-tekst)]">{odbiorcy.docelowo}</span> po sprawdzeniu zgód i wykluczeń
              </dd>
            </dl>
            {podglad ? (
              <iframe title="Podgląd wiadomości" srcDoc={podglad} className="block h-[640px] w-full border-0 bg-[#f5f5f5]" sandbox="" />
            ) : (
              <div className="pusty-stan">
                <h2>Kampania nie ma jeszcze treści.</h2>
                <p>Zbuduj maila w edytorze: przeciągnij bloki albo zacznij od szablonu.</p>
                <Link href={`${baza}/tresc`} className="przycisk">
                  Otwórz edytor
                </Link>
              </div>
            )}
          </section>

          {poWysylce ? (
            <RaportZaangazowania
              tenantId={tenantId}
              campaignId={campaignId}
              wyslane={raport.wyslane}
              przychodMinor={Number(raport.przychod_minor)}
              zamowien={Number(raport.zamowien)}
            />
          ) : null}
        </div>

        {/* ── Prawa kolumna: decyzja. Przyklejona, żeby główny przycisk był zawsze pod ręką. ── */}
        <div className="min-w-0 space-y-5 xl:sticky xl:top-[76px]">
          <section className="karta overflow-hidden">
            <div className="karta-naglowek">
              <h2>Wysyłka</h2>
              <span className={`plakietka ml-auto ${stanDecyzji.klasa}`}>{stanDecyzji.etykieta}</span>
            </div>
            <div className="space-y-4 p-4">
              {link ? (
                <div className="rounded-[10px] border border-[var(--color-akcent-ramka)] bg-[var(--color-akcent-tlo)] p-3">
                  <div className="mb-2 text-[13px] font-semibold">Link do akceptacji dla klienta</div>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-white px-2.5 py-1.5 text-[12px]">{link}</code>
                    <PrzyciskKopiuj tekst={link} />
                  </div>
                  <p className="mt-2 text-[12px] leading-[17px] text-[var(--color-tekst-2)]">
                    Skopiuj go teraz — w bazie trzymamy tylko skrót, więc po opuszczeniu strony linku nie da się odzyskać. Zawsze możesz wygenerować nowy.
                  </p>
                </div>
              ) : null}

              {przedWysylka ? (
                <>
                  {/* Krok 1 ścieżki: akceptacja klienta (FR41) */}
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${kampania.status === "approved" ? "bg-[var(--color-ok)] text-white" : "border-[1.5px] border-[var(--color-linia-mocna)] text-[var(--color-tekst-3)]"}`}>1</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-semibold">Akceptacja klienta</span>
                        <span className={`plakietka ${stanAkceptacji.klasa}`}>{stanAkceptacji.etykieta}</span>
                      </div>
                      <p className="mt-1 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">{stanAkceptacji.opis}</p>
                      {kampania.status !== "approved" ? (
                        <form action={doAkceptacjiAkcja} className="mt-2.5">
                          <input type="hidden" name="tenantId" value={tenantId} />
                          <input type="hidden" name="campaignId" value={campaignId} />
                          <button className={kampania.status === "awaiting_approval" ? "przycisk przycisk-wtorny" : "przycisk"} type="submit" disabled={!html.trim() || !kampania.subject}>
                            {akceptacja && !akceptacja.decided_at ? "Utwórz nowy link do akceptacji" : "Utwórz link do akceptacji"}
                          </button>
                          {!html.trim() || !kampania.subject ? <Powod tekst=" najpierw temat i treść" /> : null}
                          <p className="mt-2 text-[12px] leading-[17px] text-[var(--color-tekst-3)]">
                            Powstanie link ważny 7 dni. Nic nie wysyłamy automatycznie — link przekazujesz klientowi sam (mail, czat).
                          </p>
                        </form>
                      ) : null}
                    </div>
                  </div>

                  {/* Krok 2 ścieżki: wysyłka, za bramką listy kontrolnej */}
                  <div className="flex items-start gap-3 border-t border-[var(--color-linia-0)] pt-4">
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-[1.5px] border-[var(--color-linia-mocna)] text-[12px] font-semibold text-[var(--color-tekst-3)]">2</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold">Wysyłka do {odmien(odbiorcy.docelowo, "odbiorcy", "odbiorców", "odbiorców")}</div>
                      <form action={wyslijTerazAkcja} className="mt-2.5">
                        <input type="hidden" name="tenantId" value={tenantId} />
                        <input type="hidden" name="campaignId" value={campaignId} />
                        <button className={kampania.status === "approved" ? "przycisk" : "przycisk przycisk-wtorny"} type="submit" disabled={powodyBlokadyWysylki.length > 0}>
                          Wyślij teraz
                        </button>
                      </form>
                      {powodyBlokadyWysylki.length ? (
                        <ul className="mt-2.5 space-y-1.5 text-[12px] leading-[17px] text-[var(--color-tekst-2)]" aria-label="Dlaczego wysyłka jest zablokowana">
                          {wstrzymanieSklepu.wstrzymany ? <li>• wysyłka sklepu wstrzymana (baner u góry)</li> : null}
                          {niespelnione.map((p) => (
                            <li key={p.klucz}>
                              • {p.etykieta.toLowerCase()}:{" "}
                              <Link href={p.klucz === "domena" ? `/t/${tenantId}/ustawienia/wysylka` : sciezkaKroku[p.krok]} className="font-medium text-[var(--color-akcent)] hover:underline">
                                popraw →
                              </Link>
                            </li>
                          ))}
                          {kampania.status !== "approved" ? <li>• czeka na akceptację klienta (krok 1)</li> : null}
                        </ul>
                      ) : null}

                      {/* B1: plan wysyłki — czyta go dispatcher workera, co minutę. */}
                      <form action={zaplanujWysylkeAkcja} className="mt-4 space-y-2">
                        <input type="hidden" name="tenantId" value={tenantId} />
                        <input type="hidden" name="campaignId" value={campaignId} />
                        <label className="block">
                          <span className="etykieta mb-1.5 block">albo zaplanuj na (czas polski)</span>
                          <div className="grid gap-2">
                            <input type="datetime-local" name="kiedy" defaultValue={naPoleCzasuPolskiego(kampania.scheduled_at)} className="pole disabled:opacity-50" disabled={niespelnione.length > 0 && !kampania.scheduled_at} aria-label="Termin wysyłki" />
                            <button className="przycisk przycisk-wtorny w-full" type="submit" disabled={niespelnione.length > 0 && !kampania.scheduled_at}>
                              {kampania.scheduled_at ? "Zmień albo zdejmij plan" : kampania.status === "approved" ? "Zaplanuj" : "Zaplanuj po akceptacji"}
                            </button>
                          </div>
                        </label>
                        <p className="text-[12px] leading-[17px] text-[var(--color-tekst-3)]">
                          {niespelnione.length > 0 && !kampania.scheduled_at
                            ? "Planowanie odblokuje się, gdy lista kontrolna będzie kompletna."
                            : kampania.scheduled_at
                            ? planPrzeterminowany
                              ? `Termin ${formatujDateICzas(kampania.scheduled_at)} minął ponad ${OKNO_SPOZNIENIA_GODZIN} h temu i wysyłka NIE ruszy sama. Ustaw nowy termin albo wyślij ręcznie.`
                              : `Ruszy sama ${formatujDateICzas(kampania.scheduled_at)}, o ile będzie miała akceptację klienta. Puste pole zdejmuje plan.`
                            : "Termin uruchamia kampanię sam, ale wyłącznie po akceptacji klienta i przy spełnionej liście kontrolnej."}
                        </p>
                      </form>
                    </div>
                  </div>
                </>
              ) : null}

              {/* B2: hamulec. Wstrzymanie działa MIĘDZY partiami — panel mówi to wprost. */}
              {wWysylce ? (
                <form action={wstrzymajKampanieAkcja}>
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <input type="hidden" name="campaignId" value={campaignId} />
                  <button className="przycisk przycisk-wtorny" type="submit">
                    Wstrzymaj wysyłkę
                  </button>
                  <p className="mt-2 text-[12px] leading-[17px] text-[var(--color-tekst-2)]">
                    Odwołanie kampanii w wysyłce idzie przez wstrzymanie — dopiero wtedy widać, ile wiadomości już poszło.
                  </p>
                </form>
              ) : null}
              {wstrzymana ? (
                <form action={wznowKampanieAkcja} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <input type="hidden" name="campaignId" value={campaignId} />
                  <button className="przycisk" type="submit" disabled={wstrzymanieSklepu.wstrzymany}>
                    Wznów wysyłkę
                  </button>
                  {wstrzymanieSklepu.wstrzymany ? <Powod tekst="najpierw wznów wysyłkę całego sklepu" /> : null}
                </form>
              ) : null}
              {kampania.status === "sent" ? (
                <p className="text-[13px] text-[var(--color-tekst-2)]">Kampania wysłana — treść i ścieżka są zamknięte.</p>
              ) : null}

              {/* Liczby przy nieodwracalnej decyzji: ile już poszło, ile stoi w kolejce, ile w locie. */}
              {(wstrzymana || wWysylce || kampania.status === "sent" || kampania.status === "cancelled") && stanWysylki ? (
                <div className="border-t border-[var(--color-linia-0)] pt-4 text-[13px] text-[var(--color-tekst-2)]">
                  <h3 className="text-[13px] font-semibold text-[var(--color-tekst)]">Stan wysyłki</h3>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {[
                      ["przekazane dostawcy", stanWysylki.przekazane],
                      ["w kolejce", stanWysylki.wKolejce],
                      ["w locie", stanWysylki.wLocie],
                      ["zatrzymane", stanWysylki.zatrzymane],
                    ].map(([e, w]) => (
                      <div key={String(e)} className="flex justify-between">
                        <dt className="etykieta">{e}</dt>
                        <dd className="liczba">{w}</dd>
                      </div>
                    ))}
                  </dl>
                  {wstrzymana ? (
                    <p className="mt-3">
                      Wstrzymana {kampania.paused_at ? formatujDateICzas(kampania.paused_at) : ""}. Wiadomości przekazanych dostawcy nie da się cofnąć. Wiadomości w locie (najwyżej jedna partia) dojdą do końca.
                    </p>
                  ) : null}
                  {kampania.status === "cancelled" ? (
                    <p className="mt-3">
                      Odwołana {kampania.cancelled_at ? formatujDateICzas(kampania.cancelled_at) : ""}. Kolejka zatrzymana, wysłanych nie da się cofnąć.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* Stan bramki akceptacji NA STALE na karcie (audyt P3). */}
              {akceptacja ? (
                <div className="space-y-1 border-t border-[var(--color-linia-0)] pt-4 text-[12px] leading-[17px] text-[var(--color-tekst-2)]">
                  <h3 className="text-[13px] font-semibold text-[var(--color-tekst)]">Historia akceptacji</h3>
                  <div>
                    Link wygenerowany {formatujDateICzas(akceptacja.created_at)}
                    {new Date(akceptacja.expires_at) < new Date() && !akceptacja.decided_at
                      ? ", wygasł — wygeneruj nowy"
                      : `, ważny do ${formatujDateICzas(akceptacja.expires_at)}`}
                    .
                  </div>
                  {akceptacja.decided_at ? (
                    <>
                      <div>
                        {akceptacja.decision === "approved" ? "Klient zaakceptował" : "Klient zgłosił uwagi"} {formatujDateICzas(akceptacja.decided_at)}.
                      </div>
                      {akceptacja.comment ? <div>Uwagi: „{akceptacja.comment}"</div> : null}
                    </>
                  ) : (
                    <div>Klient jeszcze nie zdecydował. Nowy link nie unieważnia starego — stary działa do wygaśnięcia.</div>
                  )}
                </div>
              ) : null}
            </div>
          </section>

          <section className="karta p-4">
            <h2 className="text-[14px]">Wysyłka testowa</h2>
            <p className="mt-0.5 text-[12px] leading-[17px] text-[var(--color-tekst-3)]">
              Ta sama ścieżka co wysyłka właściwa: nadawca, stopka z wypisem, kolejka. Linki w teście prowadzą prosto do sklepu, bez śledzenia. Tu trafia do Mailpita.
            </p>
            <form action={wyslijTestAkcja} className="mt-3 flex gap-2">
              <input type="hidden" name="tenantId" value={tenantId} />
              <input type="hidden" name="campaignId" value={campaignId} />
              <input name="adres" type="email" required className="pole" placeholder="twoj@adres.pl" aria-label="Adres testowy" />
              <button className="przycisk przycisk-wtorny shrink-0" type="submit" disabled={!html.trim() || !kampania.subject}>
                Wyślij test
              </button>
            </form>
            {!html.trim() || !kampania.subject ? <p className="mt-2 text-[12px] text-[var(--color-tekst-2)]">Najpierw temat i treść.</p> : null}
          </section>

          {/* Odwołanie: nieodwracalne, więc osobno, za potwierdzeniem i zawsze przy liczbach. */}
          {przedWysylka || wstrzymana ? (
            <section className="karta border-[#f5c6c2] p-4">
              <h2 className="text-[14px]">{wstrzymana ? "Odwołanie reszty wysyłki" : "Anulowanie kampanii"}</h2>
              <p className="mt-0.5 text-[12px] leading-[17px] text-[var(--color-tekst-3)]">
                {wstrzymana
                  ? "Zatrzymuje wiadomości, które jeszcze czekają w kolejce. Nieodwracalne."
                  : "Kampania nie wyjdzie ani teraz, ani z planu. Nieodwracalne — do ponownej wysyłki potrzebna nowa kampania."}
              </p>
              <form action={odwolajKampanieAkcja} className="mt-3 space-y-2.5">
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="campaignId" value={campaignId} />
                <label className="flex items-start gap-2.5 text-[13px] text-[var(--color-tekst-2)]">
                  <input type="checkbox" name="potwierdzam" value="tak" className="mt-0.5" />
                  <span>
                    {wstrzymana && stanWysylki
                      ? `Rozumiem, że ${stanWysylki.przekazane} wiadomości już poszło i tego nie da się cofnąć. Odwołanie zatrzyma pozostałe ${stanWysylki.wKolejce} z kolejki.`
                      : "Rozumiem, że anulowanej kampanii nie da się wznowić."}
                  </span>
                </label>
                <button className="przycisk przycisk-niebezpieczny" type="submit">
                  {wstrzymana ? "Odwołaj resztę wysyłki" : "Anuluj kampanię"}
                </button>
              </form>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
