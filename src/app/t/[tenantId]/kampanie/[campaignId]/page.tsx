import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "../../../../../adapters/db/pool";
import { policzOdbiorcow } from "../../../../../usecases/policz-odbiorcow";
import { Kafelek, Naglowek } from "../../naglowek";

export const dynamic = "force-dynamic";

export default async function Kampania({
  params,
}: {
  params: Promise<{ tenantId: string; campaignId: string }>;
}) {
  const { tenantId, campaignId } = await params;
  const { rows } = await getPool().query(
    "select id, name, subject, preheader, status, scheduled_at from campaigns where tenant_id = $1 and id = $2",
    [tenantId, campaignId],
  );
  const kampania = rows[0];
  if (!kampania) notFound();

  const odbiorcy = await policzOdbiorcow(tenantId, campaignId);
  const odjete = [
    { etykieta: "bez adresu e-mail", ile: odbiorcy.bezAdresu },
    { etykieta: "wykluczenia globalne", ile: odbiorcy.wykluczeniGlobalnie },
    { etykieta: "wypisani z tego sklepu", ile: odbiorcy.wykluczeniLokalnie },
    { etykieta: "bez zgody na e-mail", ile: odbiorcy.bezZgody },
  ].filter((p) => p.ile > 0);

  return (
    <>
      <Naglowek
        tytul={kampania.name}
        opis={kampania.subject ?? "Temat wiadomości nie jest jeszcze ustawiony."}
        akcja={
          <Link href={`/t/${tenantId}/kampanie`} className="przycisk przycisk-wtorny">
            Wróć do kampanii
          </Link>
        }
      />

      <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kafelek etykieta="Kandydaci" wartosc={String(odbiorcy.kandydaci)} opis="z wybranych segmentów i list" />
        <Kafelek etykieta="Odjęci" wartosc={String(odbiorcy.kandydaci - odbiorcy.docelowo)} opis="wykluczenia, brak zgody, brak adresu" />
        <Kafelek etykieta="Do wysyłki" wartosc={String(odbiorcy.docelowo)} opis="stan na teraz, nie na moment wysyłki" />
        <Kafelek
          etykieta="Status"
          wartosc={kampania.status === "awaiting_approval" ? "akceptacja" : kampania.status}
          opis={
            kampania.scheduled_at
              ? `plan: ${new Date(kampania.scheduled_at).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" })}`
              : "bez harmonogramu"
          }
        />
      </div>

      <div className="grid gap-6 px-4 pb-4 xl:grid-cols-[1fr_360px]">
        <section className="karta overflow-hidden">
          <div className="border-b border-[var(--color-line)] px-5 py-4">
            <h2 className="text-sm font-semibold">Jak powstała lista odbiorców</h2>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">
              To są kandydaci, a nie odbiorcy. Wiążące sprawdzenie „komu wolno wysłać" odbywa się
              tuż przed samą wysyłką, w tej samej transakcji co zapis wiadomości. Między
              przygotowaniem kampanii a jej wyjściem mijają dni: akceptacja klienta, harmonogram,
              limit warmupu. W tym czasie ktoś zdąży się wypisać, a lista policzona dzisiaj
              o tym nie wie.
            </p>
          </div>

          <div className="space-y-3 px-5 py-4">
            {odbiorcy.zrodla.map((z, i) => (
              <div key={i} className="flex items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className={`plakietka ${z.mode === "include" ? "plakietka-ok" : "plakietka-blad"}`}>
                    {z.mode === "include" ? "dodaje" : "odejmuje"}
                  </span>
                  <span>{z.nazwa}</span>
                  <span className="text-xs text-[var(--color-faint)]">
                    {z.typ === "segment" ? "segment" : "lista"}
                  </span>
                </div>
                <span className="liczba text-[var(--color-muted)]">{z.ile}</span>
              </div>
            ))}

            <div className="mt-4 border-t border-[var(--color-line)] pt-4">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="font-medium">Kandydaci</span>
                <span className="liczba">{odbiorcy.kandydaci}</span>
              </div>
              {odjete.map((p) => (
                <div key={p.etykieta} className="flex items-center justify-between py-1 text-sm text-[var(--color-muted)]">
                  <span>− {p.etykieta}</span>
                  <span className="liczba">{p.ile}</span>
                </div>
              ))}
              <div className="mt-2 flex items-center justify-between border-t border-[var(--color-line)] pt-3">
                <span className="font-medium">Do wysyłki</span>
                <span className="wielkosc text-xl">{odbiorcy.docelowo}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="karta h-fit overflow-hidden">
          <div className="border-b border-[var(--color-line)] px-5 py-4">
            <h2 className="text-sm font-semibold">Kto dostanie tę kampanię</h2>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Próbka z listy docelowej, do sprawdzenia okiem przed wysyłką.
            </p>
          </div>
          {odbiorcy.probka.length === 0 ? (
            <p className="px-5 py-4 text-sm text-[var(--color-muted)]">
              Nikt nie przechodzi przez bramkę. Sprawdź zgody i wykluczenia albo dobór segmentów.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {odbiorcy.probka.map((o) => (
                <li key={o.email} className="px-5 py-2.5">
                  <div className="text-sm">{[o.imie, o.nazwisko].filter(Boolean).join(" ") || "—"}</div>
                  <div className="text-xs text-[var(--color-faint)]">{o.email}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
