import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "../../../../../adapters/db/pool";
import { zGroszy } from "../../../../../domain/kwoty";
import { raportKampanii } from "../../../../../usecases/przelicz-atrybucje";
import { policzOdbiorcow } from "../../../../../usecases/policz-odbiorcow";
import {
  doAkceptacjiAkcja,
  przeliczAtrybucjeAkcja,
  wyslijTerazAkcja,
  wyslijTestAkcja,
  zapiszTrescAkcja,
} from "../../../../akcje";
import { Kafelek, Komunikat, Naglowek } from "../../naglowek";

export const dynamic = "force-dynamic";

const STANY: Record<string, { etykieta: string; klasa: string }> = {
  draft: { etykieta: "szkic", klasa: "" },
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
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId, campaignId } = await params;
  const { ok, blad } = await searchParams;
  const { rows } = await getPool().query(
    "select id, name, subject, preheader, content, status, scheduled_at from campaigns where tenant_id = $1 and id = $2",
    [tenantId, campaignId],
  );
  const kampania = rows[0];
  if (!kampania) notFound();

  const [odbiorcy, raport] = await Promise.all([
    policzOdbiorcow(tenantId, campaignId),
    raportKampanii(tenantId, campaignId),
  ]);
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
        <Kafelek etykieta="Przychód" wartosc={zGroszy(Number(raport.przychod_minor))} opis={`${raport.zamowien} zamówień, ostatni przebieg atrybucji`} />
      </div>

      <div className="grid gap-4 px-4 pb-4 xl:grid-cols-2">
        <section className="karta">
          <div className="flex h-10 items-center justify-between border-b border-[var(--color-linia)] px-3">
            <h2>Treść</h2>
          </div>
          <form action={zapiszTrescAkcja} className="space-y-3 p-3">
            <input type="hidden" name="tenantId" value={tenantId} />
            <input type="hidden" name="campaignId" value={campaignId} />
            <label className="block">
              <span className="mb-1 block text-[12px] text-[var(--color-tekst-3)]">Temat</span>
              <input name="temat" defaultValue={kampania.subject ?? ""} className="pole" placeholder="to zobaczy odbiorca w skrzynce" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-[var(--color-tekst-3)]">Preheader</span>
              <input name="preheader" defaultValue={kampania.preheader ?? ""} className="pole" placeholder="szara linijka obok tematu" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-[var(--color-tekst-3)]">
                Treść HTML · linki zostaną automatycznie przepisane na śledzone, stopka z wypisaniem dokleja się sama
              </span>
              <textarea
                name="html"
                rows={12}
                defaultValue={html}
                className="pole font-mono text-[12px] leading-[18px]"
                placeholder={'<h1>Nagłówek</h1>\n<p>Treść…</p>\n<p><a href="https://sklep.pl/promocja">Zobacz promocję</a></p>'}
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button className="przycisk przycisk-wtorny" type="submit" disabled={poWysylce}>
                Zapisz treść
              </button>
              {poWysylce ? (
                <span className="text-[12px] text-[var(--color-tekst-3)]">
                  po starcie wysyłki treść jest zamrożona: odbiorcy dostali to, co zaakceptował klient
                </span>
              ) : null}
            </div>
          </form>

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
            <div className="flex flex-wrap gap-2">
              <form action={doAkceptacjiAkcja}>
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="campaignId" value={campaignId} />
                <button className="przycisk przycisk-wtorny" type="submit" disabled={poWysylce}>
                  Wyślij do akceptacji klienta
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
          </section>

          <section className="karta p-3">
            <h2 className="mb-2">Odbiorcy</h2>
            {odbiorcy.zrodla.map((z, i) => (
              <div key={i} className="flex items-center justify-between py-1 text-[13px]">
                <span className="flex items-center gap-2">
                  <span className={`plakietka ${z.mode === "include" ? "plakietka-ok" : "plakietka-blad"}`}>
                    {z.mode === "include" ? "dodaje" : "odejmuje"}
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
