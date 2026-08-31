import Link from "next/link";
import { getPool } from "../../../../adapters/db/pool";
import { kampanieTenanta } from "../../../../adapters/db/repozytoria";
import { utworzKampanieAkcja } from "../../../akcje";
import { Komunikat, Naglowek } from "../naglowek";

export const dynamic = "force-dynamic";

const STANY: Record<string, { etykieta: string; klasa: string }> = {
  draft: { etykieta: "szkic", klasa: "" },
  awaiting_approval: { etykieta: "czeka na akceptację klienta", klasa: "plakietka-uwaga" },
  approved: { etykieta: "zaakceptowana", klasa: "plakietka-ok" },
  scheduled: { etykieta: "zaplanowana", klasa: "plakietka-ok" },
  sending: { etykieta: "w wysyłce", klasa: "plakietka-ok" },
  sent: { etykieta: "wysłana", klasa: "plakietka-ok" },
  cancelled: { etykieta: "odwołana", klasa: "plakietka-blad" },
};

export default async function Kampanie({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId } = await params;
  const { ok, blad } = await searchParams;
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

  return (
    <>
      <Naglowek
        tytul="Kampanie"
        opis="Kampania idzie ścieżką szkic, akceptacja klienta, wysyłka. Klient akceptuje z maila, bez logowania, a kampania bez akceptacji nie wychodzi o zaplanowanej porze. W fazie 1 ścieżka kończy się na akceptacji, bo silnik wysyłki jest w Epiku 3."
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="grid gap-6 p-4 lg:grid-cols-[1fr_320px]">
        <section className="space-y-3">
          {kampanie.map((k: any) => {
            const moi = odbiorcy.filter((o: any) => o.campaign_id === k.id);
            const stan = STANY[k.status] ?? { etykieta: k.status, klasa: "" };
            return (
              <Link key={k.id} href={`/t/${tenantId}/kampanie/${k.id}`} className="karta block p-4 transition hover:border-[var(--color-akcent)]">
                <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-medium">{k.name}</h2>
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                      {k.subject ?? "brak tematu"}
                    </p>
                  </div>
                  <span className={`plakietka ${stan.klasa}`}>{stan.etykieta}</span>
                </div>

                <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[var(--color-muted)]">
                  <span>
                    <span className="etykieta">odbiorcy</span>{" "}
                    {moi.filter((o: any) => o.mode === "include").map((o: any) => o.nazwa).join(", ") ||
                      "nie wybrani"}
                  </span>
                  {moi.some((o: any) => o.mode === "exclude") ? (
                    <span>
                      <span className="etykieta">bez</span>{" "}
                      {moi.filter((o: any) => o.mode === "exclude").map((o: any) => o.nazwa).join(", ")}
                    </span>
                  ) : null}
                  {k.scheduled_at ? (
                    <span>
                      <span className="etykieta">planowana</span>{" "}
                      {new Date(k.scheduled_at).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                  ) : null}
                </div>
              </Link>
            );
          })}
          {kampanie.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">Nie ma jeszcze żadnej kampanii.</p>
          ) : null}
        </section>

        <section className="karta h-fit p-4">
          <h2 className="mb-4 text-sm font-semibold">Nowa kampania</h2>
          <form action={utworzKampanieAkcja} className="space-y-3">
            <input type="hidden" name="tenantId" value={tenantId} />
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Nazwa robocza</span>
              <input name="nazwa" required placeholder="np. Black Friday" className="pole" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">Temat wiadomości</span>
              <input name="temat" placeholder="to zobaczy odbiorca" className="pole" />
            </label>
            <button className="przycisk w-full justify-center" type="submit">
              Utwórz szkic
            </button>
          </form>
          <p className="mt-3 text-xs leading-relaxed text-[var(--color-muted)]">
            Edytor treści wchodzi razem z Epikiem 4. Będzie to Maily.to: licencja MIT,
            w całości na naszym serwerze, bez dokładania kolejnego podprocesora do umowy
            powierzenia.
          </p>
        </section>
      </div>
    </>
  );
}
