import Link from "next/link";
import { wymaganyTenant } from "../../../autoryzacja";
import { getPool } from "../../../../adapters/db/pool";
import { formatujDate, formatujDateICzas } from "../../../../domain/daty";
import { zGroszy } from "../../../../domain/kwoty";
import { odmien } from "../../../../domain/liczebniki";
import { kampanieTenanta } from "../../../../adapters/db/repozytoria";
import { utworzKampanieAkcja } from "../../../akcje";
import { OKNO_SPOZNIENIA_GODZIN } from "../../../../usecases/wysylka/sterowanie";
import { liczbyKampaniiTenanta } from "../../../../usecases/tresc/kampanie";
import { Button, Card, CardHeader, EmptyState, MobileList, MobileListItem, ResponsiveTable, Table, TBody, Td, Th, THead } from "../../../ui";
import { Komunikat, Naglowek } from "../naglowek";
import { STANY, stanKampaniiNaEkran } from "./stany";
import { PrzyciskDuplikuj, PrzyciskUsunSzkic } from "./akcje-kampanii";

export const dynamic = "force-dynamic";

export const metadata = { title: "Kampanie" };

/**
 * Lista kampanii: tabela na desktopie, osobna lista na telefonie (DESIGN.md: „nie ściskaj
 * tabeli desktopowej"; audyt 24.09, sekcja 5 — ten ekran był jedynym, który na 390 px
 * łamał kanon). Sortowanie, wyszukiwarka i filtr statusu działają w obu widokach: nagłówki
 * kolumn sortują na desktopie, pole „Kolejność" w pasku narzędzi — wszędzie.
 *
 * Filtrowanie i sortowanie dzieje się na już pobranej liście, w pamięci: zapytanie do bazy
 * zostaje proste, a kontrolki naprawdę działają. Formularz jest GET-em, więc widok da się
 * zakładkować i wysłać linkiem.
 *
 * Poziomy padding należy do layoutu (DESIGN.md) — ekran nie dodaje własnego.
 */
type Kolumna = "nazwa" | "status" | "plan" | "zmiana" | "wyslane" | "przychod";

const KOLUMNY: { klucz: Kolumna; etykieta: string; num?: boolean }[] = [
  { klucz: "nazwa", etykieta: "Kampania" },
  { klucz: "status", etykieta: "Status" },
  { klucz: "plan", etykieta: "Plan wysyłki" },
  { klucz: "zmiana", etykieta: "Ostatnia zmiana" },
  { klucz: "wyslane", etykieta: "Wysłane", num: true },
  { klucz: "przychod", etykieta: "Przychód", num: true },
];

const KOLEJNOSCI: { wartosc: string; etykieta: string }[] = [
  { wartosc: "zmiana:desc", etykieta: "Ostatnio zmieniane" },
  { wartosc: "zmiana:asc", etykieta: "Najdawniej zmieniane" },
  { wartosc: "nazwa:asc", etykieta: "Nazwa A–Z" },
  { wartosc: "nazwa:desc", etykieta: "Nazwa Z–A" },
  { wartosc: "status:asc", etykieta: "Status A–Z" },
  { wartosc: "status:desc", etykieta: "Status Z–A" },
  { wartosc: "plan:desc", etykieta: "Plan wysyłki: najpóźniejszy" },
  { wartosc: "plan:asc", etykieta: "Plan wysyłki: najwcześniejszy" },
  { wartosc: "wyslane:desc", etykieta: "Najwięcej wysłanych" },
  { wartosc: "wyslane:asc", etykieta: "Najmniej wysłanych" },
  { wartosc: "przychod:desc", etykieta: "Największy przychód" },
  { wartosc: "przychod:asc", etykieta: "Najmniejszy przychód" },
];

function czas(d: string | Date | null | undefined): number {
  if (!d) return 0;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export default async function Kampanie({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{
    ok?: string;
    blad?: string;
    q?: string;
    stan?: string;
    sort?: string;
    kier?: string;
    kolejnosc?: string;
  }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const { ok, blad, q, stan: stanFiltr, sort, kier, kolejnosc } = await searchParams;
  const [kampanie, { liczby, atrybucjaPoliczona }, { rows: odbiorcy }] = await Promise.all([
    kampanieTenanta(tenantId),
    liczbyKampaniiTenanta(tenantId),
    getPool().query(
      `select a.campaign_id, a.mode, coalesce(s.name, l.name) as nazwa
         from campaign_audience a
         left join segments s on s.tenant_id = a.tenant_id and s.id = a.source_id
         left join lists l on l.tenant_id = a.tenant_id and l.id = a.source_id
        where a.tenant_id = $1`,
      [tenantId],
    ),
  ]);

  const szukane = (q ?? "").trim().toLowerCase();
  const filtrStanu = stanFiltr && STANY[stanFiltr] ? stanFiltr : "";
  // „kolejnosc" (pole z paska narzędzi, działa też na telefonie) wygrywa z sort/kier
  // z nagłówków kolumn — to ostatnia rzecz, którą operator ustawił
  const [kolZPola, kierZPola] = KOLEJNOSCI.some((k) => k.wartosc === kolejnosc) ? String(kolejnosc).split(":") : [sort, kier];
  const kolumna: Kolumna = KOLUMNY.find((k) => k.klucz === kolZPola)?.klucz ?? "zmiana";
  const rosnaco = kierZPola === "asc";

  const dane = (id: string) => liczby.get(id) ?? { wyslane: 0, przychodMinor: 0 };
  const widoczne = kampanie
    .filter((k: any) => {
      if (filtrStanu && k.status !== filtrStanu) return false;
      if (!szukane) return true;
      return `${k.name ?? ""} ${k.subject ?? ""}`.toLowerCase().includes(szukane);
    })
    .sort((a: any, b: any) => {
      const znak = rosnaco ? 1 : -1;
      if (kolumna === "nazwa") return znak * String(a.name ?? "").localeCompare(String(b.name ?? ""), "pl");
      if (kolumna === "status") return znak * stanKampaniiNaEkran(a.status).etykieta.localeCompare(stanKampaniiNaEkran(b.status).etykieta, "pl");
      if (kolumna === "plan") return znak * (czas(a.scheduled_at) - czas(b.scheduled_at));
      if (kolumna === "wyslane") return znak * (dane(a.id).wyslane - dane(b.id).wyslane);
      if (kolumna === "przychod") return znak * (dane(a.id).przychodMinor - dane(b.id).przychodMinor);
      return znak * (czas(a.updated_at ?? a.created_at) - czas(b.updated_at ?? b.created_at));
    });

  const filtrujeSie = Boolean(szukane || filtrStanu);
  const stanyWUzyciu = Object.keys(STANY).filter((s) => kampanie.some((k: any) => k.status === s));

  function linkSortu(k: Kolumna): string {
    const p = new URLSearchParams();
    if (szukane) p.set("q", q!.trim());
    if (filtrStanu) p.set("stan", filtrStanu);
    p.set("sort", k);
    // powtórne kliknięcie tej samej kolumny odwraca kierunek — inaczej strzałka
    // byłaby ozdobą, a nie kontrolką
    p.set("kier", kolumna === k && !rosnaco ? "asc" : "desc");
    return `?${p.toString()}`;
  }

  const przyWierszu = (k: any) => {
    const stan = stanKampaniiNaEkran(k.status);
    const planMinal =
      k.status === "approved" &&
      Boolean(k.scheduled_at) &&
      new Date(k.scheduled_at).getTime() < Date.now() - OKNO_SPOZNIENIA_GODZIN * 3600_000;
    const moi = odbiorcy.filter((o: any) => o.campaign_id === k.id);
    const wlaczone = moi.filter((o: any) => o.mode === "include").map((o: any) => o.nazwa ?? "źródło usunięte");
    const wylaczone = moi.filter((o: any) => o.mode === "exclude").map((o: any) => o.nazwa ?? "źródło usunięte");
    const d = dane(k.id);
    const poWysylce = ["sending", "paused", "sent", "cancelled"].includes(k.status);
    // przed wysyłką i bez przebiegu atrybucji zero złotych nie jest wynikiem: pokazujemy „—"
    const przychod = poWysylce && atrybucjaPoliczona ? zGroszy(d.przychodMinor) : "—";
    return { stan, planMinal, wlaczone, wylaczone, wyslane: d.wyslane, przychod, poWysylce };
  };

  const Akcje = ({ k }: { k: any }) => (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <PrzyciskDuplikuj tenantId={tenantId} campaignId={k.id} />
      {k.status === "draft" ? <PrzyciskUsunSzkic tenantId={tenantId} campaignId={k.id} nazwa={k.name} /> : null}
    </div>
  );

  return (
    <>
      <Naglowek
        tytul="Kampanie"
        opis="Kampania idzie ścieżką szkic, akceptacja klienta, wysyłka. Klient akceptuje z maila, bez logowania, a kampania bez akceptacji nie wychodzi — także o zaplanowanej porze. Zaplanowaną wysyłkę uruchamia worker, co minutę. Wysyłkę w toku można wstrzymać i wznowić; wiadomości już przekazanych dostawcy nie da się cofnąć. Usunąć można tylko szkic; kampania po akceptacji albo wysyłce zostaje w historii."
        akcja={<Button href="#nowa-kampania">Nowa kampania</Button>}
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="tresc-strony">
        <Card>
          <form method="get" className="flex flex-wrap items-end gap-3 border-b border-[var(--color-linia)] p-4 md:px-6">
            <label className="min-w-0 flex-[1_1_220px]">
              <span className="etykieta mb-1.5 block">Szukaj kampanii</span>
              <input type="search" name="q" defaultValue={q ?? ""} placeholder="nazwa albo temat wiadomości" className="pole" />
            </label>
            <label className="min-w-0 flex-[1_1_160px] md:max-w-52">
              <span className="etykieta mb-1.5 block">Status</span>
              <select name="stan" defaultValue={filtrStanu} className="pole">
                <option value="">wszystkie</option>
                {stanyWUzyciu.map((s) => (
                  <option key={s} value={s}>
                    {STANY[s].etykieta}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 flex-[1_1_160px] md:max-w-60">
              <span className="etykieta mb-1.5 block">Kolejność</span>
              <select name="kolejnosc" defaultValue={`${kolumna}:${rosnaco ? "asc" : "desc"}`} className="pole">
                {KOLEJNOSCI.map((k) => (
                  <option key={k.wartosc} value={k.wartosc}>
                    {k.etykieta}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-2">
              <button className="przycisk przycisk-wtorny" type="submit">
                Pokaż
              </button>
              {filtrujeSie ? (
                <Link href="?" className="przycisk przycisk-wtorny">
                  Wyczyść
                </Link>
              ) : null}
            </div>
            <span className="tekst-licznik ml-auto self-center text-[13px] !text-[var(--color-tekst-3)]">
              {filtrujeSie
                ? `${odmien(widoczne.length, "kampania", "kampanie", "kampanii")} z ${kampanie.length}`
                : odmien(kampanie.length, "kampania", "kampanie", "kampanii")}
            </span>
          </form>

          {widoczne.length === 0 ? (
            filtrujeSie ? (
              <EmptyState
                icon="kampania"
                title="Żadna kampania nie pasuje do filtra"
                description={`Masz ${odmien(kampanie.length, "kampanię", "kampanie", "kampanii")} w sklepie. Zdejmij filtr, żeby zobaczyć wszystkie.`}
                action={<Button href="?" variant="secondary">Wyczyść filtr</Button>}
              />
            ) : (
              <EmptyState
                icon="kampania"
                title="Nie ma jeszcze żadnej kampanii"
                description="Pierwszą zakładasz formularzem poniżej. Powstaje jako szkic: nic nie wyjdzie, dopóki klient jej nie zaakceptuje."
              />
            )
          ) : (
            <ResponsiveTable
              table={
                <Table className="min-w-[960px]">
                  <THead>
                    <tr>
                      {KOLUMNY.map((k) => (
                        <Th
                          key={k.klucz}
                          num={k.num}
                          className={k.klucz === "nazwa" ? undefined : "w-px whitespace-nowrap"}
                          aria-sort={kolumna === k.klucz ? (rosnaco ? "ascending" : "descending") : "none"}
                        >
                          <Link href={linkSortu(k.klucz)} className="inline-flex items-center gap-1.5 hover:text-[var(--color-tekst)]">
                            {k.etykieta}
                            <span aria-hidden="true" className="text-[var(--color-tekst-3)]">
                              {kolumna === k.klucz ? (rosnaco ? "↑" : "↓") : "↕"}
                            </span>
                          </Link>
                        </Th>
                      ))}
                      <Th>Odbiorcy</Th>
                      <Th className="w-px">
                        <span className="sr-only">Akcje</span>
                      </Th>
                    </tr>
                  </THead>
                  <TBody>
                    {widoczne.map((k: any) => {
                      const w = przyWierszu(k);
                      return (
                        <tr key={k.id} className="wiersz-link">
                          <Td>
                            <Link href={`/t/${tenantId}/kampanie/${k.id}`} className="wiersz-link-cel">
                              {k.name}
                            </Link>
                            <span className="mt-1 block text-[13px] text-[var(--color-tekst-2)]">{k.subject ?? "brak tematu"}</span>
                          </Td>
                          <Td className="whitespace-nowrap">
                            <span className={`plakietka ${w.stan.klasa}`}>{w.stan.etykieta}</span>
                          </Td>
                          <Td className="whitespace-nowrap">
                            {k.scheduled_at ? (
                              <>
                                <span className="liczba">{formatujDateICzas(k.scheduled_at)}</span>
                                {/* plan, którego dispatcher już nie wykona, ma być widoczny z listy —
                                    inaczej „planowana" kłamie do końca świata */}
                                {w.planMinal ? <span className="plakietka plakietka-blad mt-1.5 flex w-fit">termin minął, nie wyjdzie sama</span> : null}
                              </>
                            ) : (
                              <span className="text-[var(--color-tekst-3)]">bez planu</span>
                            )}
                          </Td>
                          <Td className="liczba whitespace-nowrap text-[var(--color-tekst-2)]">{formatujDate(k.updated_at ?? k.created_at)}</Td>
                          <Td num>{w.poWysylce ? w.wyslane : <span className="text-[var(--color-tekst-3)]">—</span>}</Td>
                          <Td num title={w.poWysylce && !atrybucjaPoliczona ? "Atrybucja nie była jeszcze liczona" : undefined}>
                            {w.przychod === "—" ? <span className="text-[var(--color-tekst-3)]">—</span> : w.przychod}
                          </Td>
                          <Td className="max-w-56 text-[13px] text-[var(--color-tekst-2)]">
                            {w.wlaczone.join(", ") || <span className="text-[var(--color-tekst-3)]">nie wybrani</span>}
                            {w.wylaczone.length > 0 ? <span className="mt-1 block text-[var(--color-tekst-3)]">bez: {w.wylaczone.join(", ")}</span> : null}
                          </Td>
                          <Td className="whitespace-nowrap">
                            <Akcje k={k} />
                          </Td>
                        </tr>
                      );
                    })}
                  </TBody>
                </Table>
              }
              mobile={
                <MobileList>
                  {widoczne.map((k: any) => {
                    const w = przyWierszu(k);
                    return (
                      <MobileListItem key={k.id}>
                        <Link href={`/t/${tenantId}/kampanie/${k.id}`} className="block text-inherit no-underline">
                          <div className="lista-mobilna-wiersz">
                            <div className="min-w-0">
                              <div className="lista-mobilna-tytul truncate">{k.name}</div>
                              <div className="lista-mobilna-meta truncate">{k.subject ?? "brak tematu"}</div>
                            </div>
                            <div className="lista-mobilna-wartosc">
                              {w.przychod}
                              <div className="text-[12px] font-normal text-[var(--color-tekst-3)]">
                                {w.poWysylce ? `wysłane ${w.wyslane}` : "przychód"}
                              </div>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                            <span className={`plakietka ${w.planMinal ? "plakietka-blad" : w.stan.klasa}`}>
                              {w.planMinal ? "termin minął" : w.stan.etykieta}
                            </span>
                            <span className="tekst-licznik text-[12px]">
                              {k.scheduled_at ? (
                                <>plan <span className="liczba">{formatujDateICzas(k.scheduled_at)}</span></>
                              ) : (
                                <>zmiana <span className="liczba">{formatujDate(k.updated_at ?? k.created_at)}</span></>
                              )}
                            </span>
                          </div>
                        </Link>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <PrzyciskDuplikuj tenantId={tenantId} campaignId={k.id} />
                          {k.status === "draft" ? <PrzyciskUsunSzkic tenantId={tenantId} campaignId={k.id} nazwa={k.name} /> : null}
                        </div>
                      </MobileListItem>
                    );
                  })}
                </MobileList>
              }
            />
          )}
        </Card>

        <Card id="nowa-kampania" className="scroll-mt-6">
          <CardHeader
            title="Nowa kampania"
            description="Powstaje jako szkic. Dalej: odbiorcy, treść w edytorze bloków, temat i nadawca, na końcu przegląd z listą kontrolną i akceptacją klienta."
          />
          <form action={utworzKampanieAkcja} className="flex flex-wrap items-end gap-4 p-6 max-md:p-4">
            <input type="hidden" name="tenantId" value={tenantId} />
            <label className="min-w-0 flex-[1_1_220px]">
              <span className="etykieta mb-1.5 block">Nazwa robocza</span>
              <input name="nazwa" required placeholder="np. Black Friday" className="pole" />
            </label>
            <label className="min-w-0 flex-[1_1_220px]">
              <span className="etykieta mb-1.5 block">Temat wiadomości</span>
              <input name="temat" placeholder="to zobaczy odbiorca" className="pole" />
            </label>
            <button className="przycisk max-md:w-full max-md:justify-center" type="submit">
              Utwórz i wybierz odbiorców
            </button>
          </form>
        </Card>
      </div>
    </>
  );
}
