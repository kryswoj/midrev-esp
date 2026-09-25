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
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId, profileId } = await params;
  await wymaganyTenant(tenantId);
  const { ok, blad } = await searchParams;
  const widok = await widokProfilu(tenantId, profileId);
  if (!widok) notFound();
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
