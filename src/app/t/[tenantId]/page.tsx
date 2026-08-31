import Link from "next/link";
import { wymaganyTenant } from "../../autoryzacja";
import {
  kampanieTenanta,
  podsumowanieTenanta,
  przebiegiImportu,
  segmentyTenanta,
  sklepyTenanta,
  statystykiZgod,
  zamowieniaTenanta,
} from "../../../adapters/db/repozytoria";
import { formatujDate } from "../../../domain/daty";
import { zGroszy } from "../../../domain/kwoty";
import { odmien } from "../../../domain/liczebniki";
import { nazwaStatusu, wagaStatusu } from "../../../domain/statusy";
import { Komunikat, MetrykaWiodaca, Naglowek, PasekMetryk } from "./naglowek";

export const dynamic = "force-dynamic";

export default async function Przeglad({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  // strona weryfikuje sama (AD-21): layout nie jest granica auth (RSC potrafi
  // renderowac sam segment strony) - patrz src/app/autoryzacja.ts
  await wymaganyTenant(tenantId);
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
          opis={`${odmien(Number(dane.zamowienia), "zamówienie", "zamówienia", "zamówień")} od ${formatujDate(dane.najstarsze)} · opłacone i w realizacji`}
        />

        <PasekMetryk
          pozycje={[
            { etykieta: "Profile", wartosc: String(dane.profile), opis: "kartoteki klientów" },
            { etykieta: "Segmenty", wartosc: String(segmenty.length), opis: "przeliczane na żywo" },
            { etykieta: "Kampanie", wartosc: String(kampanie.length), opis: `${doAkceptacji} u klienta` },
            {
              etykieta: "Zgody na e-mail",
              wartosc: String(zgody.zgody_email),
              opis: odmien(Number(zgody.wycofane_email), "wycofana", "wycofane", "wycofanych"),
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
              <div className="overflow-x-auto p-1.5">
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
                        <td className="num text-[var(--color-tekst-3)]">{formatujDate(z.occurred_at)}</td>
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
                        <span className="liczba text-[var(--color-tekst-3)]">{formatujDate(i.created_at)}</span>
                      </div>
                      <div className="text-[var(--color-tekst-3)]">
                        zapowiedziano {i.planned?.zamowienia != null ? odmien(Number(i.planned.zamowienia), "zamówienie", "zamówienia", "zamówień") : "? zamówień"} i {i.planned?.noweProfile != null ? odmien(Number(i.planned.noweProfile), "profil", "profile", "profili") : "? profili"},
                        zapisano {odmien(Number(i.counters?.utworzoneZamowienia ?? 0), "zamówienie", "zamówienia", "zamówień")} i {odmien(Number(i.counters?.utworzoneProfile ?? 0), "profil", "profile", "profili")}
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
