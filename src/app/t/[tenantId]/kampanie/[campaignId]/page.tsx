import Link from "next/link";
import { wymaganyTenant } from "../../../../autoryzacja";
import { notFound } from "next/navigation";
import { getPool } from "../../../../../adapters/db/pool";
import { zGroszy } from "../../../../../domain/kwoty";
import { odmien } from "../../../../../domain/liczebniki";
import { raportKampanii } from "../../../../../usecases/przelicz-atrybucje";
import { policzOdbiorcow } from "../../../../../usecases/policz-odbiorcow";
import { config } from "../../../../../config";
import { formatujDateICzas } from "../../../../../domain/daty";
import {
  doAkceptacjiAkcja,
  przeliczAtrybucjeAkcja,
  wyslijTerazAkcja,
  wyslijTestAkcja,
} from "../../../../akcje";
import { Kafelek, Komunikat, Naglowek } from "../../naglowek";
import { FormularzTresci } from "./formularz-tresci";
import { PrzyciskKopiuj } from "./kopiuj";

export const dynamic = "force-dynamic";

const STANY: Record<string, { etykieta: string; klasa: string }> = {
  draft: { etykieta: "szkic", klasa: "plakietka-szkic" },
  awaiting_approval: { etykieta: "czeka na akceptację klienta", klasa: "plakietka-uwaga" },
  approved: { etykieta: "zaakceptowana", klasa: "plakietka-ok" },
  sending: { etykieta: "w wysyłce", klasa: "plakietka-uwaga" },
  sent: { etykieta: "wysłana", klasa: "plakietka-ok" },
  cancelled: { etykieta: "odwołana", klasa: "plakietka-blad" },
};

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
  const { rows } = await getPool().query(
    "select id, name, subject, preheader, content, status, scheduled_at from campaigns where tenant_id = $1 and id = $2",
    [tenantId, campaignId],
  );
  const kampania = rows[0];
  if (!kampania) notFound();

  const [odbiorcy, raport, akceptacje] = await Promise.all([
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
  ]);
  const akceptacja = akceptacje.rows[0];
  const stan = STANY[kampania.status] ?? { etykieta: kampania.status, klasa: "" };
  const html = String((kampania.content as any)?.html ?? "");
  const poWysylce = ["sending", "sent"].includes(kampania.status);

  return (
    <>
      <Naglowek
        tytul={kampania.name}
        akcja={
          <div className="flex items-center gap-2">
            <span className={`plakietka ${stan.klasa}`}>{stan.etykieta}</span>
            <Link href={`/t/${tenantId}/kampanie`} className="przycisk przycisk-wtorny">
              Wróć
            </Link>
          </div>
        }
      />
      <Komunikat ok={ok} blad={blad} />

      <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kafelek etykieta="Do wysyłki" wartosc={String(odbiorcy.docelowo)} opis={`z ${odbiorcy.kandydaci} kandydatów, stan na teraz`} />
        <Kafelek etykieta="Wysłane" wartosc={String(raport.wyslane)} opis={raport.zatrzymane ? `${raport.zatrzymane} zatrzymanych bramką` : "wiadomości u odbiorców"} />
        <Kafelek etykieta="Kliknięcia" wartosc={String(raport.klikniecia)} opis="odbiorcy, którzy kliknęli" />
        <Kafelek etykieta="Przychód" wartosc={zGroszy(Number(raport.przychod_minor))} opis={`${odmien(Number(raport.zamowien), "zamówienie", "zamówienia", "zamówień")}, ostatni przebieg atrybucji`} />
      </div>

      <div className="grid gap-4 px-4 pb-4 xl:grid-cols-2">
        <section className="karta">
          <div className="flex h-10 items-center justify-between border-b border-[var(--color-linia)] px-3">
            <h2>Treść</h2>
          </div>
          <FormularzTresci
            tenantId={tenantId}
            campaignId={campaignId}
            temat={kampania.subject ?? ""}
            preheader={kampania.preheader ?? ""}
            html={html}
            poWysylce={poWysylce}
          />

          <div className="border-t border-[var(--color-linia)] p-3">
            <form action={wyslijTestAkcja} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="tenantId" value={tenantId} />
              <input type="hidden" name="campaignId" value={campaignId} />
              <label className="min-w-56 flex-1">
                <span className="mb-1 block text-[12px] text-[var(--color-tekst-3)]">Wysyłka testowa</span>
                <input name="adres" type="email" required className="pole" placeholder="twoj@adres.pl" />
              </label>
              <button className="przycisk przycisk-wtorny" type="submit">Wyślij test</button>
              <span className="w-full text-[12px] text-[var(--color-tekst-3)]">
                test idzie dokładnie tą samą ścieżką co wysyłka właściwa, do skrzynki Mailpit na porcie 8026
              </span>
            </form>
          </div>
        </section>

        <div className="space-y-4">
          <section className="karta overflow-hidden">
            <div className="flex h-10 items-center border-b border-[var(--color-linia)] px-3">
              <h2>Podgląd</h2>
            </div>
            <iframe
              title="Podgląd"
              srcDoc={`<!doctype html><body style="margin:16px;font:14px/1.6 -apple-system,Segoe UI,sans-serif;color:#111;background:#fff">${html || "<p style='color:#888'>(brak treści)</p>"}</body>`}
              className="h-[320px] w-full border-0 bg-white"
              sandbox=""
            />
          </section>

          <section className="karta p-3">
            <h2 className="mb-2">Ścieżka wysyłki</h2>

            {link ? (
              <div className="mb-3 rounded-md border border-[var(--color-linia)] bg-[var(--color-powierzchnia-2)] p-2.5">
                <div className="mb-1.5 text-[12px] font-medium text-[var(--color-tekst-2)]">
                  Link do akceptacji dla klienta
                </div>
                <div className="flex items-center gap-2">
                  <code className="karta-plaska min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-2 py-1.5 text-[12px]">
                    {link}
                  </code>
                  <PrzyciskKopiuj tekst={link} />
                </div>
                <p className="mt-1.5 text-[12px] text-[var(--color-tekst-3)]">
                  Skopiuj go teraz - w bazie trzymamy tylko skrót, więc po opuszczeniu tej
                  strony linku nie da się odzyskać. Zawsze możesz wygenerować nowy.
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <form action={doAkceptacjiAkcja}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="campaignId" value={campaignId} />
                <button className="przycisk przycisk-wtorny" type="submit" disabled={poWysylce}>
                  {akceptacja && !akceptacja.decided_at
                    ? "Wygeneruj nowy link"
                    : "Wyślij do akceptacji klienta"}
                </button>
              </form>
              <form action={wyslijTerazAkcja}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="campaignId" value={campaignId} />
                <button className="przycisk" type="submit" disabled={kampania.status !== "approved"}>
                  Wyślij teraz
                </button>
              </form>
              <form action={przeliczAtrybucjeAkcja}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="campaignId" value={campaignId} />
                <button className="przycisk przycisk-wtorny" type="submit">
                  Przelicz atrybucję
                </button>
              </form>
            </div>
            {kampania.status !== "approved" && !poWysylce ? (
              <p className="mt-2 text-[12px] text-[var(--color-tekst-3)]">
                Przycisk wysyłki odblokowuje się po akceptacji klienta. Kampania bez akceptacji
                nie wychodzi, także o zaplanowanej porze.
              </p>
            ) : null}
            {poWysylce ? (
              <p className="mt-2 text-[12px] text-[var(--color-tekst-3)]">
                Kampania {kampania.status === "sent" ? "wysłana" : "w wysyłce"} — treść
                i ścieżka są zamknięte.
              </p>
            ) : null}

            {/* Stan bramki akceptacji NA STALE na karcie (audyt P3): kiedy poszedl
                link, czy klient zdecydowal, jaka decyzja i z jakimi uwagami. */}
            {akceptacja ? (
              <div className="mt-3 space-y-1 border-t border-[var(--color-linia)] pt-2.5 text-[12px] text-[var(--color-tekst-3)]">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em]">
                  Akceptacja klienta
                </div>
                <div>
                  Link wygenerowany {formatujDateICzas(akceptacja.created_at)}
                  {new Date(akceptacja.expires_at) < new Date() && !akceptacja.decided_at
                    ? ", wygasł - wygeneruj nowy"
                    : `, ważny do ${formatujDateICzas(akceptacja.expires_at)}`}
                  .
                </div>
                {akceptacja.decided_at ? (
                  <>
                    <div className="text-[var(--color-tekst-2)]">
                      {akceptacja.decision === "approved"
                        ? "Klient zaakceptował"
                        : "Klient zgłosił uwagi"}{" "}
                      {formatujDateICzas(akceptacja.decided_at)}.
                    </div>
                    {akceptacja.comment ? (
                      <div className="text-[var(--color-tekst-2)]">
                        Uwagi: „{akceptacja.comment}"
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div>
                    Klient jeszcze nie zdecydował. Nowy link nie unieważnia starego — stary
                    działa do wygaśnięcia.
                  </div>
                )}
              </div>
            ) : null}
          </section>

          <section className="karta p-3">
            <h2 className="mb-2">Odbiorcy</h2>
            {odbiorcy.zrodla.map((z, i) => (
              <div key={i} className="flex items-center justify-between py-1 text-[13px]">
                <span className="flex items-center gap-2">
                  {/* to nie jest stan, tylko rola zrodla — plakietka-blad na poprawnej regule
                      wykluczajacej wygladalaby jak blad konfiguracji */}
                  <span className="liczba text-[12px] text-[var(--color-tekst-2)]">
                    {z.mode === "include" ? "+ dodaje" : "− odejmuje"}
                  </span>
                  {z.nazwa}
                </span>
                <span className="liczba text-[var(--color-tekst-2)]">{z.ile}</span>
              </div>
            ))}
            <div className="mt-2 flex items-center justify-between border-t border-[var(--color-linia)] pt-2">
              <span className="font-medium">Do wysyłki po bramce</span>
              <span className="wielkosc">{odbiorcy.docelowo}</span>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
