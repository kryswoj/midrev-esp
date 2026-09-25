import Link from "next/link";
import { wymaganyTenant } from "../../../autoryzacja";
import { getPool } from "../../../../adapters/db/pool";
import { formatujDate, formatujDateICzas } from "../../../../domain/daty";
import { odmien } from "../../../../domain/liczebniki";
import { kampanieTenanta } from "../../../../adapters/db/repozytoria";
import { utworzKampanieAkcja } from "../../../akcje";
import { OKNO_SPOZNIENIA_GODZIN } from "../../../../usecases/wysylka/sterowanie";
import { Komunikat, Naglowek } from "../naglowek";
import { STANY, stanKampaniiNaEkran } from "./stany";

export const dynamic = "force-dynamic";

export const metadata = { title: "Kampanie" };


/**
 * Kolumny, sortowanie i wyszukiwarka zamiast listy kart (PANELE-ESP 1.3 vs 4.3).
 * Przy jednym sklepie karty wystarczały, przy trzech operator nie znajdzie kampanii
 * sprzed miesiąca. Klaviyo i Omnisend mają tu tabelę ze statusem i sortowaniem po
 * dowolnej kolumnie, więc mamy to i my.
 *
 * Filtrowanie i sortowanie dzieje się na już pobranej liście, w pamięci: zapytanie
 * do bazy zostaje takie, jakie było, a panel dostaje kontrolki, które naprawdę działają.
 */
type Kolumna = "nazwa" | "status" | "plan" | "zmiana";

const KOLUMNY: { klucz: Kolumna; etykieta: string; waska?: boolean }[] = [
  { klucz: "nazwa", etykieta: "Kampania" },
  { klucz: "status", etykieta: "Status", waska: true },
  { klucz: "plan", etykieta: "Plan wysyłki", waska: true },
  { klucz: "zmiana", etykieta: "Ostatnia zmiana", waska: true },
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
  }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
  const { ok, blad, q, stan: stanFiltr, sort, kier } = await searchParams;
  const kampanie = await kampanieTenanta(tenantId);

  const { rows: odbiorcy } = await getPool().query(
    `select a.campaign_id, a.mode, a.source_type,
            coalesce(s.name, l.name) as nazwa
       from campaign_audience a
       left join segments s on s.tenant_id = a.tenant_id and s.id = a.source_id
       left join lists l on l.tenant_id = a.tenant_id and l.id = a.source_id
      where a.tenant_id = $1`,
    [tenantId],
  );

  const szukane = (q ?? "").trim().toLowerCase();
  const filtrStanu = stanFiltr && STANY[stanFiltr] ? stanFiltr : "";
  const kolumna: Kolumna = (KOLUMNY.find((k) => k.klucz === sort)?.klucz ?? "zmiana") as Kolumna;
  const rosnaco = kier === "asc";

  const widoczne = kampanie
    .filter((k: any) => {
      if (filtrStanu && k.status !== filtrStanu) return false;
      if (!szukane) return true;
      return `${k.name ?? ""} ${k.subject ?? ""}`.toLowerCase().includes(szukane);
    })
    .sort((a: any, b: any) => {
      const znak = rosnaco ? 1 : -1;
      if (kolumna === "nazwa") return znak * String(a.name ?? "").localeCompare(String(b.name ?? ""), "pl");
      if (kolumna === "status") {
        const eA = STANY[a.status]?.etykieta ?? a.status;
        const eB = STANY[b.status]?.etykieta ?? b.status;
        return znak * String(eA).localeCompare(String(eB), "pl");
      }
      if (kolumna === "plan") return znak * (czas(a.scheduled_at) - czas(b.scheduled_at));
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

  return (
    <>
      <Naglowek
        tytul="Kampanie"
        opis="Kampania idzie ścieżką szkic, akceptacja klienta, wysyłka. Klient akceptuje z maila, bez logowania, a kampania bez akceptacji nie wychodzi — także o zaplanowanej porze. Zaplanowaną wysyłkę uruchamia worker, co minutę. Wysyłkę w toku można wstrzymać i wznowić; wiadomości już przekazanych dostawcy nie da się cofnąć."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="karta min-w-0 overflow-hidden">
          {/* Pasek narzędzi: wyszukiwarka po nazwie i temacie plus filtr statusu.
              Formularz jest GET-em, więc widok da się zakładkować i wysłać linkiem. */}
          <form
            method="get"
            className="flex flex-wrap items-end gap-3 border-b border-[var(--color-linia)] px-4 py-4"
          >
            <label className="min-w-56 flex-1">
              <span className="etykieta mb-1.5 block">Szukaj kampanii</span>
              <input
                type="search"
                name="q"
                defaultValue={q ?? ""}
                placeholder="nazwa albo temat wiadomości"
                className="pole"
              />
            </label>
            <label className="w-52">
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
            <input type="hidden" name="sort" value={kolumna} />
            <input type="hidden" name="kier" value={rosnaco ? "asc" : "desc"} />
            <button className="przycisk przycisk-wtorny" type="submit">
              Filtruj
            </button>
            {filtrujeSie ? (
              <Link href="?" className="przycisk przycisk-wtorny">
                Wyczyść
              </Link>
            ) : null}
            <span className="ml-auto self-center text-[13px] text-[var(--color-tekst-3)]">
              {filtrujeSie
                ? `${odmien(widoczne.length, "kampania", "kampanie", "kampanii")} z ${kampanie.length}`
                : odmien(kampanie.length, "kampania", "kampanie", "kampanii")}
            </span>
          </form>

          {widoczne.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="tabela">
                <thead>
                  <tr>
                    {KOLUMNY.map((k) => (
                      <th
                        key={k.klucz}
                        className={k.waska ? "w-px whitespace-nowrap" : undefined}
                        aria-sort={
                          kolumna === k.klucz ? (rosnaco ? "ascending" : "descending") : "none"
                        }
                      >
                        <Link
                          href={linkSortu(k.klucz)}
                          className="inline-flex items-center gap-1.5 hover:text-[var(--color-tekst)]"
                        >
                          {k.etykieta}
                          <span aria-hidden="true" className="text-[var(--color-tekst-3)]">
                            {kolumna === k.klucz ? (rosnaco ? "↑" : "↓") : "↕"}
                          </span>
                        </Link>
                      </th>
                    ))}
                    <th>Odbiorcy</th>
                  </tr>
                </thead>
                <tbody>
                  {widoczne.map((k: any) => {
                    const moi = odbiorcy.filter((o: any) => o.campaign_id === k.id);
                    const wlaczone = moi
                      .filter((o: any) => o.mode === "include")
                      .map((o: any) => o.nazwa);
                    const wylaczone = moi
                      .filter((o: any) => o.mode === "exclude")
                      .map((o: any) => o.nazwa);
                    const stan = stanKampaniiNaEkran(k.status);
                    const planMinal =
                      k.status === "approved" &&
                      Boolean(k.scheduled_at) &&
                      new Date(k.scheduled_at).getTime() <
                        Date.now() - OKNO_SPOZNIENIA_GODZIN * 3600_000;
                    return (
                      <tr key={k.id} className="wiersz-link">
                        <td>
                          <Link
                            href={`/t/${tenantId}/kampanie/${k.id}`}
                            className="wiersz-link-cel"
                          >
                            {k.name}
                          </Link>
                          <span className="mt-1 block text-[13px] text-[var(--color-tekst-2)]">
                            {k.subject ?? "brak tematu"}
                          </span>
                        </td>
                        <td className="whitespace-nowrap">
                          <span className={`plakietka ${stan.klasa}`}>{stan.etykieta}</span>
                        </td>
                        <td className="whitespace-nowrap">
                          {k.scheduled_at ? (
                            <>
                              <span className="liczba">{formatujDateICzas(k.scheduled_at)}</span>
                              {/* plan, którego dispatcher już nie wykona, ma być widoczny z listy —
                                  inaczej "planowana" kłamie do końca świata */}
                              {planMinal ? (
                                <span className="plakietka plakietka-blad mt-1.5 flex w-fit">
                                  termin minął, nie wyjdzie sama
                                </span>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-[var(--color-tekst-3)]">bez planu</span>
                          )}
                        </td>
                        <td className="liczba whitespace-nowrap text-[var(--color-tekst-2)]">
                          {formatujDate(k.updated_at ?? k.created_at)}
                        </td>
                        <td className="text-[var(--color-tekst-2)]">
                          {wlaczone.join(", ") || (
                            <span className="text-[var(--color-tekst-3)]">nie wybrani</span>
                          )}
                          {wylaczone.length > 0 ? (
                            <span className="mt-1 block text-[13px] text-[var(--color-tekst-3)]">
                              bez: {wylaczone.join(", ")}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="pusty-stan">
              {filtrujeSie ? (
                <>
                  <h2>Żadna kampania nie pasuje do filtra.</h2>
                  <p>
                    Masz {odmien(kampanie.length, "kampanię", "kampanie", "kampanii")} w sklepie.
                    Zdejmij filtr, żeby zobaczyć wszystkie.
                  </p>
                  <Link href="?" className="przycisk przycisk-wtorny mt-2 w-fit">
                    Wyczyść filtr
                  </Link>
                </>
              ) : (
                <>
                  <h2>Nie ma jeszcze żadnej kampanii.</h2>
                  <p>
                    Pierwszą zakładasz formularzem obok. Powstaje jako szkic: nic nie wyjdzie,
                    dopóki klient jej nie zaakceptuje.
                  </p>
                </>
              )}
            </div>
          )}
        </section>

        <section className="karta h-fit p-5">
          <h2 className="mb-4">Nowa kampania</h2>
          <form action={utworzKampanieAkcja} className="space-y-4">
            <input type="hidden" name="tenantId" value={tenantId} />
            <label className="block">
              <span className="etykieta mb-1.5 block">Nazwa robocza</span>
              <input name="nazwa" required placeholder="np. Black Friday" className="pole" />
            </label>
            <label className="block">
              <span className="etykieta mb-1.5 block">Temat wiadomości</span>
              <input name="temat" placeholder="to zobaczy odbiorca" className="pole" />
            </label>
            <button className="przycisk w-full justify-center" type="submit">
              Utwórz i wybierz odbiorców
            </button>
          </form>
          <ol className="mt-4 space-y-1.5 text-[13px] leading-[19px] text-[var(--color-tekst-2)]">
            <li>1. Odbiorcy — listy i segmenty, z wykluczeniami.</li>
            <li>2. Treść — edytor bloków: przeciągasz, piszesz na płótnie.</li>
            <li>3. Temat, preheader i nadawca.</li>
            <li>4. Przegląd z listą kontrolną, akceptacja klienta, wysyłka.</li>
          </ol>
        </section>
      </div>
    </>
  );
}
