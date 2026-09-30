import Link from "next/link";
import { notFound } from "next/navigation";
import { formatujDate, formatujDateICzas } from "../../../../../domain/daty";
import { zGroszy } from "../../../../../domain/kwoty";
import { odmien } from "../../../../../domain/liczebniki";
import { nazwaStatusu, wagaStatusu, zrodloZgody } from "../../../../../domain/statusy";
import {
  POWODY_BRAMKI,
  danePodstawowe,
  stanWiadomosci,
  widokProfilu,
  type StanKanalu,
  type ZdarzenieOsi,
} from "../../../../../usecases/profil";
import { wymaganyTenant } from "../../../../autoryzacja";
import { SciezkaOsoby } from "../../automatyzacje/sciezka-osoby";
import { Card, CardHeader, EmptyState, Icon, ResponsiveTable, type NazwaIkony, Table, TBody, Td, Th, THead } from "../../../../ui";
import { Komunikat, Naglowek, PasekMetryk } from "../../naglowek";
import { FormularzUsunieciaDanych } from "./formularz-rodo";
import { RozwinZdarzenie } from "./rozwin-zdarzenie";
import { MAKS_METRYK_FILTRA, osProfilu, type KursorOsi } from "../../../../../usecases/zdarzenia/odczyt";
import { metrykiProfilu, wlasciwosciProfilu } from "../../../../../usecases/profil-wlasciwosci";
import { wykladnikWaluty } from "../../../../../domain/zdarzenia/limity";

export const dynamic = "force-dynamic";

const KLASA_WAGI: Record<"ok" | "uwaga" | "blad", string> = {
  ok: "plakietka-ok",
  uwaga: "plakietka-uwaga",
  blad: "plakietka-blad",
};
const NAZWY_KANALOW: Record<string, string> = { email: "E-mail", sms: "SMS" };
const ZRODLA_LIST: Record<string, string> = {
  reczny: "dodana ręcznie",
  import_woocommerce: "z importu ze sklepu",
  popup: "z zapisu w popupie",
};
const NAZWY_ZDARZEN: Record<string, string> = {
  "popup.submitted": "Zapis przez popup",
  order_placed: "Zamówienie ze sklepu",
  "rodo.eksport": "Eksport danych osoby",
  "rodo.anonimizacja": "Usunięcie danych osobowych",
};
const ETYKIETY_OSI: Record<ZdarzenieOsi["rodzaj"], string> = {
  zamowienie: "zamówienie",
  wiadomosc: "wiadomość",
  klikniecie: "kliknięcie",
  zgoda: "zgoda",
  wykluczenie: "wykluczenie",
  zdarzenie: "zdarzenie",
};
const IKONY_OSI: Record<ZdarzenieOsi["rodzaj"], NazwaIkony> = {
  zamowienie: "zamowienie",
  wiadomosc: "wiadomosc",
  klikniecie: "klikniecie",
  zgoda: "zgodnosc",
  wykluczenie: "alert",
  zdarzenie: "dokument",
};

function zrodloWpisu(source: string): string {
  if (source === "rodo:usuniecie_danych") return "żądanie usunięcia danych";
  return zrodloZgody(source);
}

function opiszZdarzenie(z: ZdarzenieOsi): { tekst: string; drugiWiersz?: string } {
  switch (z.rodzaj) {
    case "zamowienie":
      return { tekst: `Zamówienie ${z.tytul} — ${nazwaStatusu(z.detal ?? "")}` };
    case "wiadomosc":
      return { tekst: `Wysłana wiadomość „${z.tytul}”`, drugiWiersz: `stan: ${stanWiadomosci(z.detal ?? "").etykieta}` };
    case "klikniecie":
      return { tekst: "Kliknięcie w link z wiadomości", drugiWiersz: z.tytul };
    case "zgoda": {
      const [kanal, stan] = (z.detal ?? ":").split(":");
      return {
        tekst: `${stan === "granted" ? "Zgoda udzielona" : "Zgoda wycofana"} — ${NAZWY_KANALOW[kanal] ?? kanal}`,
        drugiWiersz: `źródło: ${zrodloWpisu(z.tytul)}`,
      };
    }
    case "wykluczenie":
      return { tekst: z.detal === "released" ? "Zdjęcie wykluczenia w tym sklepie" : "Wykluczenie w tym sklepie", drugiWiersz: z.tytul };
    default:
      return { tekst: NAZWY_ZDARZEN[z.tytul] ?? z.tytul, drugiWiersz: z.detal ?? undefined };
  }
}

/** Etykiety PL metryk wbudowanych (AD-37: nazwa w bazie jak w Klaviyo, po polsku tylko w UI). */
const ETYKIETY_METRYK: Record<string, string> = {
  "Submitted Form": "Zapis przez formularz",
  "Placed Order": "Złożone zamówienie",
  "Ordered Product": "Zamówiony produkt",
  "customer.created": "Konto w sklepie założone",
  "customer.updated": "Konto w sklepie zmienione",
  "rodo.eksport": "Eksport danych osoby",
  "rodo.anonimizacja": "Usunięcie danych osobowych",
};
const ZRODLA_ZDARZEN: Record<string, string> = {
  api: "API", client: "przeglądarka", webhook: "sklep", system: "system", import: "import historii",
};

function jedenLubWiele(w: string | string[] | undefined): string[] {
  if (w === undefined) return [];
  return Array.isArray(w) ? w : [w];
}

/** Kwota z jednostek minor wg wykładnika waluty (JPY 0, KWD 3), bez liczb zmiennoprzecinkowych. */
function kwotaWaluty(minor: string, waluta: string): string {
  const exp = wykladnikWaluty(waluta);
  if (exp === 2) return zGroszy(Number(minor), waluta);
  const ujemna = minor.startsWith("-");
  const cyfry = (ujemna ? minor.slice(1) : minor).padStart(exp + 1, "0");
  const calosc = cyfry.slice(0, cyfry.length - exp).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  return `${ujemna ? "-" : ""}${calosc}${exp ? "," + cyfry.slice(-exp) : ""}\u00a0${waluta}`;
}

function kursorZParametru(w: string | undefined): KursorOsi | null {
  if (!w) return null;
  const i = w.lastIndexOf("|");
  if (i < 1) return null;
  return { occurredAt: w.slice(0, i), id: w.slice(i + 1) };
}

function PlakietkaZgody({ kanal }: { kanal: StanKanalu }) {
  if (kanal.stan === null) return <span className="plakietka plakietka-szkic">brak wpisu</span>;
  if (kanal.stan === "granted") return <span className="plakietka plakietka-ok">zgoda</span>;
  return <span className="plakietka plakietka-blad">wycofana</span>;
}

export async function generateMetadata({ params }: { params: Promise<{ tenantId: string; profileId: string }> }) {
  const { tenantId, profileId } = await params;
  await wymaganyTenant(tenantId);
  const profil = await danePodstawowe(tenantId, profileId);
  if (!profil) return { title: "Profil" };
  if (profil.zanonimizowany) return { title: "Dane usunięte" };
  return { title: [profil.first_name, profil.last_name].filter(Boolean).join(" ") || profil.email || "Profil" };
}

export default async function Profil({ params, searchParams }: {
  params: Promise<{ tenantId: string; profileId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string; m?: string | string[]; od?: string; do?: string; po?: string }>;
}) {
  const { tenantId, profileId } = await params;
  await wymaganyTenant(tenantId);
  const sp = await searchParams;
  const { ok, blad } = sp;
  const widok = await widokProfilu(tenantId, profileId);
  if (!widok) notFound();
  // Oś ze strumienia metryk (6.4, MVP): filtr do 5 metryk, zakres dat, kursor po 50.
  const filtrMetryk = jedenLubWiele(sp.m).slice(0, MAKS_METRYK_FILTRA);
  const [strumien, metrykiOsi, wlasne] = await Promise.all([
    osProfilu(tenantId, profileId, { metryki: filtrMetryk, odDnia: sp.od, doDnia: sp.do, kursor: kursorZParametru(sp.po) }),
    metrykiProfilu(tenantId, profileId),
    wlasciwosciProfilu(tenantId, profileId),
  ]);
  const parametryFiltra = new URLSearchParams();
  for (const m of filtrMetryk) parametryFiltra.append("m", m);
  if (sp.od) parametryFiltra.set("od", sp.od);
  if (sp.do) parametryFiltra.set("do", sp.do);
  const nastepnaStrona = strumien.nastepna
    ? `?${new URLSearchParams([...parametryFiltra, ["po", `${strumien.nastepna.occurredAt}|${strumien.nastepna.id}`]]).toString()}#zdarzenia`
    : null;
  const { profil, kanaly, zgody, wykluczenia, bramka, os, wysylki, listy, segmenty } = widok;

  const nazwa = [profil.first_name, profil.last_name].filter(Boolean).join(" ");
  const tytul = profil.zanonimizowany ? "Dane usunięte na żądanie" : nazwa || profil.email || "Profil bez danych kontaktowych";
  const powodOdmowy = bramka.powod ? POWODY_BRAMKI[bramka.powod] : null;
  const inicjaly = profil.zanonimizowany
    ? "—"
    : ([profil.first_name, profil.last_name].filter(Boolean).map((x) => String(x).slice(0, 1)).join("") || profil.email?.slice(0, 1) || "?").toUpperCase();

  const szczegolyProfilu = (
    <div>
      <dl className="space-y-4 p-6 max-md:p-4">
        <div><dt className="etykieta">Imię i nazwisko</dt><dd className="mt-1 break-words font-medium">{nazwa || "—"}</dd></div>
        <div><dt className="etykieta">E-mail</dt><dd className="mt-1 break-all">{profil.email ?? "—"}</dd></div>
        <div><dt className="etykieta">Telefon</dt><dd className="liczba mt-1">{profil.phone ?? "—"}</dd></div>
        <div><dt className="etykieta">W bazie od</dt><dd className="liczba mt-1">{formatujDate(profil.created_at)}</dd></div>
        <details className="border-t border-[var(--color-linia-0)] pt-3">
          <summary className="tekst-pomocniczy cursor-pointer font-medium !text-[var(--color-tekst-3)]">Identyfikator techniczny</summary>
          <dd className="mt-2 break-all rounded-md bg-[var(--color-powierzchnia-2)] p-2 font-mono text-[12px] leading-4 text-[var(--color-tekst-2)]">{profil.id}</dd>
        </details>
      </dl>
      <div className="space-y-5 border-t border-[var(--color-linia-0)] p-6 max-md:p-4">
        <div><div className="etykieta mb-2">Listy</div>{listy.length === 0 ? <p className="tekst-pomocniczy">Brak członkostwa na listach.</p> : <ul className="space-y-2.5">{listy.map((l) => <li key={l.id} className="flex items-start justify-between gap-3"><span className="font-medium">{l.nazwa}</span><span className="tekst-pomocniczy text-right !text-[var(--color-tekst-3)]">{ZRODLA_LIST[l.opis ?? ""] ?? l.opis}</span></li>)}</ul>}</div>
        <div><div className="etykieta mb-2">Segmenty</div>{segmenty.length === 0 ? <p className="tekst-pomocniczy">Żaden segment nie obejmuje dziś tej osoby.</p> : <ul className="space-y-2">{segmenty.map((s) => <li key={s.id} className="tekst-pomocniczy rounded-md border border-[var(--color-linia-0)] bg-[var(--color-powierzchnia-2)] px-3 py-2 !text-[var(--color-tekst)]">{s.nazwa}</li>)}</ul>}</div>
      </div>
    </div>
  );

  return (
    <>
      <Naglowek
        tytul={tytul}
        opis="Ten ekran odpowiada na dwa pytania, które klient zadaje przez telefon: co wysłaliśmy tej osobie i skąd mamy jej zgodę. Stan zgody liczy się z rejestru wpisów, nie z pola na profilu, więc widać datę, źródło i treść klauzuli. Oś czasu łączy zamówienia, wysyłki, kliknięcia, zapisy i wypisy w jedną listę."
        powrot={{ href: `/t/${tenantId}/profile`, etykieta: "Profile" }}
        oznaczenie={<span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--color-akcent-tlo)] text-[14px] font-semibold text-[var(--color-akcent)] md:h-14 md:w-14 md:text-[17px]">{inicjaly}</span>}
        podtytul={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="inline-flex min-w-0 items-center gap-1.5"><Icon name="wiadomosc" size={14} className="shrink-0 text-[var(--color-tekst-3)]" /><span className="break-all">{profil.email ?? "brak adresu e-mail"}</span></span>
            <span className="inline-flex items-center gap-1.5"><Icon name="telefon" size={14} className="text-[var(--color-tekst-3)]" />{profil.phone ?? "brak telefonu"}</span>
            <span className="inline-flex items-center gap-1.5"><Icon name="kalendarz" size={14} className="text-[var(--color-tekst-3)]" />w bazie od <span className="liczba">{formatujDate(profil.created_at)}</span></span>
            <span className={`plakietka ${bramka.wolno ? "plakietka-ok" : "plakietka-blad"}`}>{bramka.wolno ? "można wysyłać" : "wysyłka zablokowana"}</span>
          </div>
        }
        akcja={
          <form method="post" action={`/t/${tenantId}/profile/${profileId}/eksport`} className="max-md:w-full">
            <button className="przycisk przycisk-wtorny max-md:w-full" type="submit"><Icon name="dokument" size={16} />Pobierz dane</button>
          </form>
        }
        akcjaMobilnaPelna
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        {!bramka.wolno ? (
          <div className="pasek-stanu border-[var(--color-blad-ramka)] bg-[var(--color-blad-tlo)] text-[var(--color-blad)]">
            <Icon name="alert" size={18} className="mt-0.5 shrink-0" />
            <div><span className="font-semibold">Nie wolno wysyłać na ten adres.</span> <span className="text-[var(--color-tekst-2)]">{powodOdmowy}</span></div>
          </div>
        ) : null}

        <PasekMetryk pozycje={[
          { etykieta: "Wysłane", wartosc: String(profil.wiadomosci), opis: wysylki[0] ? `ostatnia ${formatujDate(wysylki[0].wyslano ?? wysylki[0].created_at)}` : "brak wysyłek" },
          { etykieta: "Kliknięcia", wartosc: String(profil.klikniec), opis: "w linki z wiadomości" },
          { etykieta: "Zamówienia", wartosc: String(profil.zamowien), opis: profil.ostatnie_zamowienie ? `ostatnie ${formatujDate(profil.ostatnie_zamowienie)}` : "brak zamówień" },
          { etykieta: "Wartość", wartosc: zGroszy(Number(profil.wydal_minor)), opis: "opłacone i w realizacji" },
        ]} />

        <div className="grid items-start gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-4 md:space-y-6">
            <Card>
              <CardHeader title="Oś czasu" description="Zamówienia, wiadomości, kliknięcia i zmiany zgód w jednej historii." action={<span className="karta-naglowek-licznik">{odmien(os.length, "zdarzenie", "zdarzenia", "zdarzeń")}</span>} />
              {os.length === 0 ? (
                <EmptyState icon="raport" title="Brak aktywności" description="Pierwsze zdarzenie pojawi się po imporcie historii sklepu albo po zapisie z formularza." action={<Link href={`/t/${tenantId}/sklepy`} className="przycisk przycisk-wtorny">Przejdź do sklepu</Link>} />
              ) : (
                <ul className="space-y-4 p-6 max-md:p-4">
                  {os.map((z, i) => {
                    const opis = opiszZdarzenie(z);
                    const anulowane = wagaStatusu(z.detal ?? "") === "blad";
                    return (
                      <li key={`${z.rodzaj}-${i}`} className="relative flex min-h-12 gap-3">
                        {i < os.length - 1 ? <span aria-hidden="true" className="absolute bottom-[-16px] left-[13px] top-7 w-px bg-[var(--color-linia)]" /> : null}
                        <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full border border-[var(--color-linia)] bg-white text-[var(--color-tekst-2)]"><Icon name={IKONY_OSI[z.rodzaj]} size={14} /></span>
                        <div className="min-w-0 flex-1 md:grid md:grid-cols-[minmax(0,1fr)_112px] md:gap-x-5">
                          <span className="min-w-0 text-[14px] leading-5 font-semibold text-[var(--color-tekst)]">{opis.tekst}</span>
                          {z.kwota_minor ? <span className={`profil-kwota-osi liczba w-[112px] shrink-0 border-l border-[var(--color-linia-0)] pl-4 text-right font-semibold ${anulowane ? "text-[var(--color-tekst-3)] line-through" : ""}`}>{zGroszy(Number(z.kwota_minor))}</span> : <span aria-hidden="true" className="hidden md:block" />}
                          {/* Meta zawsze w pierwszej kolumnie siatki: bez pustego zamiennika kwoty data wpadała
                              do wąskiej kolumny kwot i była ucinana. */}
                          <div className="tekst-pomocniczy mt-1 min-w-0 truncate !text-[var(--color-tekst-3)] md:col-start-1">
                            <span className="liczba">{formatujDateICzas(z.occurred_at)}</span>
                            <span> · {ETYKIETY_OSI[z.rodzaj]}{opis.drugiWiersz ? ` · ${opis.drugiWiersz}` : ""}</span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card id="zdarzenia">
              <CardHeader title="Zdarzenia" description="Strumień metryk tej osoby: formularze, zamówienia ze sklepu i zdarzenia z API (n8n). Rozwiń wpis, żeby zobaczyć jego właściwości." />
              <form method="get" action={`/t/${tenantId}/profile/${profileId}#zdarzenia`} className="flex flex-wrap items-end gap-3 border-b border-[var(--color-linia-0)] px-6 py-4 max-md:px-4">
                {metrykiOsi.length > 0 ? (
                  <fieldset className="min-w-0 flex-1">
                    <legend className="etykieta mb-1">Metryki (najwyżej {MAKS_METRYK_FILTRA})</legend>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {metrykiOsi.map((m) => (
                        <label key={m.id} className="tekst-pomocniczy inline-flex items-center gap-1.5">
                          <input type="checkbox" name="m" value={m.id} defaultChecked={filtrMetryk.includes(m.id)} />
                          {ETYKIETY_METRYK[m.nazwa] ?? m.nazwa}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
                <label className="tekst-pomocniczy">Od<input type="date" name="od" defaultValue={sp.od ?? ""} className="pole mt-1 block" /></label>
                <label className="tekst-pomocniczy">Do<input type="date" name="do" defaultValue={sp.do ?? ""} className="pole mt-1 block" /></label>
                <button type="submit" className="przycisk przycisk-wtorny przycisk-maly">Filtruj</button>
              </form>
              {strumien.wpisy.length === 0 ? (
                <p className="tekst-pomocniczy p-6 max-md:p-4">{filtrMetryk.length || sp.od || sp.do || sp.po ? "Brak zdarzeń dla tego filtra." : "Ta osoba nie ma jeszcze zdarzeń w strumieniu metryk."}</p>
              ) : (
                <ul className="divide-y divide-[var(--color-linia-0)]">
                  {strumien.wpisy.map((z) => (
                    <li key={z.id} className="px-6 py-3 max-md:px-4">
                      <div className="flex items-start justify-between gap-3">
                        <span className="min-w-0 text-[14px] leading-5 font-semibold">{ETYKIETY_METRYK[z.nazwa] ?? z.nazwa}</span>
                        {z.valueMinor !== null ? <span className="liczba shrink-0 font-semibold">{kwotaWaluty(z.valueMinor, z.valueCurrency ?? "PLN")}</span> : null}
                      </div>
                      <div className="tekst-pomocniczy mt-0.5 !text-[var(--color-tekst-3)]">
                        <span className="liczba">{formatujDateICzas(z.occurredAt)}</span> · {ZRODLA_ZDARZEN[z.source] ?? z.source}
                      </div>
                      <RozwinZdarzenie tenantId={tenantId} profileId={profileId} id={z.id} occurredAt={z.occurredAt.toISOString()} ile={z.wlasciwosci} />
                    </li>
                  ))}
                </ul>
              )}
              {nastepnaStrona || sp.po ? (
                <div className="flex gap-3 border-t border-[var(--color-linia-0)] px-6 py-3 max-md:px-4">
                  {sp.po ? <Link className="przycisk przycisk-wtorny przycisk-maly" href={`?${parametryFiltra.toString()}#zdarzenia`}>Od najnowszych</Link> : null}
                  {nastepnaStrona ? <Link className="przycisk przycisk-wtorny przycisk-maly" href={nastepnaStrona}>Starsze</Link> : null}
                </div>
              ) : null}
            </Card>

            <SciezkaOsoby tenantId={tenantId} profileId={profileId} />

            <Card>
              <CardHeader title="Historia wysyłek" description="Wiadomości wysłane do tej osoby i ich aktualny stan." action={<span className="karta-naglowek-licznik">{odmien(wysylki.length, "wiadomość", "wiadomości", "wiadomości")}</span>} />
              {wysylki.length === 0 ? (
                <EmptyState icon="wiadomosc" title="Nie wysłano jeszcze żadnej wiadomości" description="Pierwsza wiadomość pojawi się tu razem ze stanem doręczenia." action={<Link href={`/t/${tenantId}/kampanie`} className="przycisk przycisk-wtorny">Przejdź do kampanii</Link>} />
              ) : (
                <ResponsiveTable table={<Table className="min-w-[680px]">
                  <THead><tr><Th>Wiadomość</Th><Th>Stan</Th><Th num>Kliknięcia</Th><Th num>Wysłano</Th></tr></THead>
                  <TBody>
                    {wysylki.map((w) => {
                      const stan = stanWiadomosci(w.current_state);
                      return <tr key={w.id}>
                        <Td><div className="font-medium">{w.subject}</div><div className="tekst-meta mt-0.5">{w.source_type === "journey" ? "automatyzacja" : "kampania"}{w.zrodlo_nazwa ? `: ${w.zrodlo_nazwa}` : ""} · {w.email}</div></Td>
                        <Td><span className={`plakietka ${KLASA_WAGI[stan.waga]}`}>{stan.etykieta}</span></Td>
                        <Td num>{w.klikniec}</Td>
                        <Td num className="text-[var(--color-tekst-2)]">{formatujDateICzas(w.wyslano ?? w.created_at)}</Td>
                      </tr>;
                    })}
                  </TBody>
                </Table>} mobile={<div>
                  {wysylki.map((w) => {
                    const stan = stanWiadomosci(w.current_state);
                    return <div key={w.id} className="lista-mobilna-element">
                      <div className="lista-mobilna-tytul">{w.subject}</div>
                      <div className="lista-mobilna-meta">{w.source_type === "journey" ? "automatyzacja" : "kampania"}{w.zrodlo_nazwa ? `: ${w.zrodlo_nazwa}` : ""}</div>
                      <div className="mt-2 flex items-center justify-between gap-3"><span className={`plakietka ${KLASA_WAGI[stan.waga]}`}>{stan.etykieta}</span><span className="tekst-licznik text-right">{formatujDateICzas(w.wyslano ?? w.created_at)}</span></div>
                    </div>;
                  })}
                </div>} />
              )}
            </Card>
          </div>

          <aside className="min-w-0 space-y-4 md:space-y-6">
            <Card>
              <div className="max-md:hidden"><CardHeader title="Dane profilu" description="Kontakt, listy i segmenty tej osoby." /></div>
              {/* Desktop: zawsze rozwinięte. Telefon: zwinięte w <details>. Dwa drzewa zamiast
                  CSS-owego wymuszania treści zamkniętego <details>, którego Chromium nie renderuje. */}
              <div className="max-md:hidden">{szczegolyProfilu}</div>
              <details className="profil-szczegoly md:hidden">
                <summary className="karta-naglowek cursor-pointer list-none md:hidden"><div><h2>Dane profilu</h2><div className="karta-opis">Kontakt, listy i segmenty tej osoby.</div></div><span className="ml-auto inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-akcent)]">Pokaż<Icon name="chevronDown" size={17} className="profil-szczegoly-chevron text-[var(--color-akcent)]" /></span></summary>
                {szczegolyProfilu}
              </details>
            </Card>

            <Card>
              <CardHeader title="Właściwości" description="Właściwości niestandardowe profilu (import, API, n8n). Tylko do odczytu." action={<span className="karta-naglowek-licznik">{odmien(wlasne?.wlasciwosci.length ?? 0, "właściwość", "właściwości", "właściwości")}</span>} />
              {wlasne && (wlasne.identyfikatory.externalId || wlasne.identyfikatory.organizacja || wlasne.identyfikatory.jezyk || Object.keys(wlasne.identyfikatory.lokalizacja).length) ? (
                <dl className="space-y-2 border-b border-[var(--color-linia-0)] px-6 py-4 max-md:px-4 text-[13px]">
                  {wlasne.identyfikatory.externalId ? <div><dt className="etykieta">Identyfikator zewnętrzny</dt><dd className="break-all">{wlasne.identyfikatory.externalId}</dd></div> : null}
                  {wlasne.identyfikatory.organizacja ? <div><dt className="etykieta">Organizacja</dt><dd>{wlasne.identyfikatory.organizacja}{wlasne.identyfikatory.stanowisko ? `, ${wlasne.identyfikatory.stanowisko}` : ""}</dd></div> : null}
                  {wlasne.identyfikatory.jezyk ? <div><dt className="etykieta">Język</dt><dd>{wlasne.identyfikatory.jezyk}</dd></div> : null}
                  {Object.keys(wlasne.identyfikatory.lokalizacja).length ? <div><dt className="etykieta">Lokalizacja</dt><dd className="break-words">{Object.entries(wlasne.identyfikatory.lokalizacja).filter(([, w]) => w !== null && w !== "").map(([k, w]) => `${k}: ${String(w)}`).join(", ")}</dd></div> : null}
                </dl>
              ) : null}
              {!wlasne || wlasne.wlasciwosci.length === 0 ? (
                <p className="tekst-pomocniczy p-6 max-md:p-4">Profil nie ma właściwości niestandardowych.</p>
              ) : (
                <>
                  <dl className="divide-y divide-[var(--color-linia-0)]">
                    {wlasne.wlasciwosci.slice(0, 20).map((w) => (
                      <div key={w.klucz} className="px-6 py-2.5 max-md:px-4">
                        <dt className="tekst-meta break-all">{w.klucz}</dt>
                        <dd className="mt-0.5 break-all text-[13px]">{w.wartosc === "" ? <span className="text-[var(--color-tekst-3)]">(pusty)</span> : w.wartosc.length > 300 ? `${w.wartosc.slice(0, 300)}…` : w.wartosc}</dd>
                      </div>
                    ))}
                  </dl>
                  {wlasne.wlasciwosci.length > 20 ? (
                    <details className="border-t border-[var(--color-linia)]">
                      <summary className="cursor-pointer px-5 py-3.5 text-[13px] font-medium text-[var(--color-tekst-2)]">Pozostałe ({wlasne.wlasciwosci.length - 20})</summary>
                      <dl className="divide-y divide-[var(--color-linia-0)]">
                        {wlasne.wlasciwosci.slice(20).map((w) => (
                          <div key={w.klucz} className="px-6 py-2.5 max-md:px-4">
                            <dt className="tekst-meta break-all">{w.klucz}</dt>
                            <dd className="mt-0.5 break-all text-[13px]">{w.wartosc === "" ? <span className="text-[var(--color-tekst-3)]">(pusty)</span> : w.wartosc.length > 300 ? `${w.wartosc.slice(0, 300)}…` : w.wartosc}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  ) : null}
                </>
              )}
            </Card>

            <Card>
              <CardHeader title="Zgody kanałami" action={<span className="karta-naglowek-licznik">{odmien(zgody.length, "wpis", "wpisy", "wpisów")}</span>} />
              <div className="divide-y divide-[var(--color-linia-0)]">
                {kanaly.map((kanal) => <div key={kanal.kanal} className="p-6 max-md:p-4">
                  <div className="flex items-center justify-between gap-3"><h3>{NAZWY_KANALOW[kanal.kanal]}</h3><PlakietkaZgody kanal={kanal} /></div>
                  {kanal.stan ? <div className="tekst-pomocniczy mt-3"><span className="liczba">{formatujDateICzas(kanal.odKiedy)}</span><br />{zrodloWpisu(kanal.zrodlo ?? "")}{kanal.klauzula ? <blockquote className="mt-2 border-l-2 border-[var(--color-akcent-ramka)] pl-3 text-[var(--color-tekst-3)]">„{kanal.klauzula}”</blockquote> : null}</div> : <p className="tekst-pomocniczy mt-2">Brak wpisu blokuje wysyłkę tym kanałem.</p>}
                </div>)}
              </div>
              {zgody.length > 0 ? <details className="border-t border-[var(--color-linia)]">
                <summary className="cursor-pointer px-5 py-3.5 text-[13px] font-medium text-[var(--color-tekst-2)]">Pełny rejestr zgód</summary>
                <Table className="min-w-[560px]"><THead><tr><Th>Data</Th><Th>Kanał</Th><Th>Stan</Th><Th>Źródło</Th></tr></THead><TBody>{zgody.map((z, i) => <tr key={`${z.channel}-${z.occurred_at}-${i}`}><Td className="liczba">{formatujDateICzas(z.occurred_at)}</Td><Td>{NAZWY_KANALOW[z.channel] ?? z.channel}</Td><Td><span className={`plakietka ${z.state === "granted" ? "plakietka-ok" : "plakietka-blad"}`}>{z.state === "granted" ? "zgoda" : "wycofana"}</span></Td><Td>{zrodloWpisu(z.source)}</Td></tr>)}</TBody></Table>
              </details> : null}
              {wykluczenia.length > 0 ? <div className="border-t border-[var(--color-linia)] p-6 max-md:p-4"><div className="etykieta mb-2">Wykluczenia</div><ul className="space-y-2">{wykluczenia.map((w, i) => <li key={i} className="tekst-pomocniczy"><span className={`plakietka mr-2 ${w.action === "released" ? "plakietka-szkic" : "plakietka-blad"}`}>{w.zakres === "globalne" ? "cała platforma" : "ten sklep"}</span>{w.action === "released" ? `zdjęte — ${w.reason}` : w.reason} · <span className="liczba">{formatujDate(w.occurred_at)}</span></li>)}</ul></div> : null}
            </Card>

            <Card>
              <CardHeader title="Dane osobowe (RODO)" description="Eksport danych i obsługa żądania usunięcia profilu." />
              <form method="post" action={`/t/${tenantId}/profile/${profileId}/eksport`} className="p-6 max-md:p-4"><p className="tekst-pomocniczy mb-3">Pobierz kompletny zapis profilu, zgód, wykluczeń, zamówień i wysyłek.</p><button className="przycisk przycisk-wtorny przycisk-maly" type="submit">Pobierz dane osoby (JSON)</button></form>
              <details className="group m-4 overflow-hidden rounded-[9px] border border-[var(--color-blad-ramka)] bg-white">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3.5 text-[14px] font-semibold text-[var(--color-blad)]"><span className="grid h-7 w-7 place-items-center rounded-full border border-[var(--color-blad-ramka)] bg-white"><Icon name="alert" size={15} /></span><span><span className="block">Usuń dane osobowe</span><span className="mt-0.5 block text-[13px] font-normal text-[var(--color-tekst-2)]">Nieodwracalna anonimizacja profilu.</span></span><Icon name="chevronDown" size={16} className="ml-auto" /></summary>
                <div className="border-t border-[var(--color-blad-ramka)] bg-white p-4"><p className="tekst-pomocniczy mb-3">Usunięcie kasuje dane kontaktowe i surowe dane zamówień, zdejmuje osobę z list i wycofuje zgody. Kwoty i daty zamówień zostają w raportach, a historia wysyłek zostaje bez adresu.</p><p className="tekst-pomocniczy mb-4 !text-[var(--color-tekst-3)]">Jeśli osoba wróci przez import sklepu, powstanie nowy profil. Operacji nie da się cofnąć.</p><FormularzUsunieciaDanych tenantId={tenantId} profileId={profileId} juzUsuniete={profil.zanonimizowany} /></div>
              </details>
            </Card>
          </aside>
        </div>
      </div>
    </>
  );
}
