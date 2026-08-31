import Link from "next/link";
import {
  kampanieTenanta,
  podsumowanieTenanta,
  przebiegiImportu,
  segmentyTenanta,
  sklepyTenanta,
  statystykiZgod,
  zamowieniaTenanta,
} from "../../../adapters/db/repozytoria";
import { zGroszy } from "../../../domain/kwoty";
import { nazwaStatusu, wagaStatusu } from "../../../domain/statusy";
import { Komunikat, MetrykaWiodaca, Naglowek, PasekMetryk } from "./naglowek";

export const dynamic = "force-dynamic";

function data(d: Date | string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("pl-PL", { day: "2-digit", month: "short", year: "numeric" });
}

export default async function Przeglad({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  const { ok, blad } = await searchParams;
  const [dane, sklepy, zamowienia, importy, segmenty, kampanie, zgody] = await Promise.all([
    podsumowanieTenanta(tenantId),
    sklepyTenanta(tenantId),
    zamowieniaTenanta(tenantId, 10),
    przebiegiImportu(tenantId, 2),
    segmentyTenanta(tenantId),
    kampanieTenanta(tenantId),
    statystykiZgod(tenantId),
  ]);

  const doAkceptacji = kampanie.filter((k: any) => k.status === "awaiting_approval").length;

  return (
    <>
      <Naglowek
        tytul="Przegląd"
        opis="Dane pochodzą wprost ze sklepu klienta. Daty zamówień są datami ze źródła, nie datami importu, bo raport przychodu liczony po dacie importu kłamie po cichu i nikt tego nie zauważa."
        akcja={
          doAkceptacji > 0 ? (
            <Link href={`/t/${tenantId}/kampanie`} className="przycisk przycisk-wtorny">
              <span className="plakietka plakietka-uwaga">{doAkceptacji}</span>
              czeka na akceptację
            </Link>
          ) : null
        }
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="space-y-4 p-4">
        <MetrykaWiodaca
          etykieta="Przychód ze zsynchronizowanych zamówień"
          wartosc={zGroszy(Number(dane.przychod_minor))}
          opis={`${dane.zamowienia} zamówień od ${data(dane.najstarsze)} · opłacone i w realizacji`}
          dodatek={
            <div className="flex items-end gap-1" aria-hidden="true">
              {[38, 52, 30, 64, 44, 72, 58, 80].map((h, i) => (
                <span
                  key={i}
                  className="w-2 rounded-t-[2px] bg-[var(--color-akcent)]/35"
                  style={{ height: `${h * 0.5}px` }}
                />
              ))}
            </div>
          }
        />

        <PasekMetryk
          pozycje={[
            { etykieta: "Profile", wartosc: String(dane.profile), opis: "kartoteki klientów" },
            { etykieta: "Segmenty", wartosc: String(segmenty.length), opis: "przeliczane na żywo" },
            { etykieta: "Kampanie", wartosc: String(kampanie.length), opis: `${doAkceptacji} u klienta` },
            {
              etykieta: "Zgody na e-mail",
              wartosc: String(zgody.zgody_email),
              opis: `${zgody.wycofane_email} wycofanych`,
            },
          ]}
        />

        <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
          <section className="karta overflow-hidden">
            <div className="flex h-10 items-center justify-between border-b border-[var(--color-linia)] px-3">
              <h2>Ostatnie zamówienia</h2>
              <Link href={`/t/${tenantId}/zamowienia`} className="text-[12px] text-[var(--color-tekst-3)] hover:text-[var(--color-tekst)]">
                wszystkie
              </Link>
            </div>
            {zamowienia.length === 0 ? (
              <p className="px-3 py-6 text-center text-[var(--color-tekst-3)]">
                Brak danych. Podłącz sklep i uruchom import w zakładce Sklepy.
              </p>
            ) : (
              <div className="p-1.5">
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>Numer</th>
                      <th>Klient</th>
                      <th>Status</th>
                      <th className="num">Kwota</th>
                      <th className="num">Data zamówienia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zamowienia.map((z) => (
                      <tr key={z.id}>
                        <td className="liczba text-[var(--color-tekst-3)]">#{z.number ?? z.external_id}</td>
                        <td>{z.email ?? "—"}</td>
                        <td>
                          <span className={`plakietka plakietka-${wagaStatusu(z.status)}`}>
                            {nazwaStatusu(z.status)}
                          </span>
                        </td>
                        <td className="num">{zGroszy(Number(z.total_minor), z.currency)}</td>
                        <td className="num text-[var(--color-tekst-3)]">{data(z.occurred_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="space-y-4">
            <section className="karta overflow-hidden">
              <div className="flex h-10 items-center border-b border-[var(--color-linia)] px-3">
                <h2>Sklepy</h2>
              </div>
              {sklepy.length === 0 ? (
                <p className="px-3 py-4 text-[var(--color-tekst-3)]">Żaden sklep nie jest podłączony.</p>
              ) : (
                <ul>
                  {sklepy.map((s) => (
                    <li key={s.id} className="px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{s.base_url.replace(/^https?:\/\//, "")}</span>
                        <span className={`plakietka ${s.status === "connected" ? "plakietka-ok" : "plakietka-uwaga"}`}>
                          {s.status === "connected" ? "połączony" : s.status}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[12px] text-[var(--color-tekst-3)]">
                        {s.platform}
                        {s.capabilities?.porzuconyKoszyk === false ? " · bez porzuconego koszyka" : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="karta overflow-hidden">
              <div className="flex h-10 items-center border-b border-[var(--color-linia)] px-3">
                <h2>Ostatni import</h2>
              </div>
              {importy.length === 0 ? (
                <p className="px-3 py-4 text-[var(--color-tekst-3)]">Nie było jeszcze importu.</p>
              ) : (
                <ul>
                  {importy.map((i: any) => (
                    <li key={i.id} className="px-3 py-2.5 text-[12px]">
                      <div className="mb-1 flex items-center justify-between">
                        <span className={`plakietka ${i.status === "done" ? "plakietka-ok" : "plakietka-blad"}`}>
                          {i.status === "done" ? "zakończony" : i.status}
                        </span>
                        <span className="liczba text-[var(--color-tekst-3)]">{data(i.created_at)}</span>
                      </div>
                      <div className="text-[var(--color-tekst-3)]">
                        zapowiedziano {i.planned?.zamowienia ?? "?"} zamówień i {i.planned?.noweProfile ?? "?"} profili,
                        zapisano {i.counters?.utworzoneZamowienia ?? 0} i {i.counters?.utworzoneProfile ?? 0}
                      </div>
                      {i.last_error ? <div className="mt-1 text-[var(--color-blad)]">{i.last_error}</div> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
