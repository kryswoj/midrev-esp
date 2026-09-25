import Link from "next/link";
import { wymaganyTenant } from "../../../../../autoryzacja";
import { config } from "../../../../../../config";
import { getPool } from "../../../../../../adapters/db/pool";
import { odczytajSerwer } from "../../../../../../usecases/wysylka-konfiguracja/serwer";
import { Komunikat, kampaniaKreatora, RamaKreatora } from "../kreator";
import { FormularzUstawien } from "./formularz-ustawien";

export const dynamic = "force-dynamic";
export const metadata = { title: "Kampania · temat i nadawca" };

/**
 * Krok 3: temat, preheader i nadawca. Nadawca NIE jest polem kampanii — silnik bierze go
 * z konfiguracji konta (Ustawienia → Wysyłka i domeny), więc tu pokazujemy go do wglądu
 * z linkiem do zmiany, zamiast pola, które niczego by nie zmieniło.
 */
export default async function KrokUstawienia({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; campaignId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId: surowy, campaignId } = await params;
  const { tenantId } = await wymaganyTenant(surowy);
  const { ok, blad } = await searchParams;
  const kampania = await kampaniaKreatora(tenantId, campaignId);
  const [serwer, tenant] = await Promise.all([
    odczytajSerwer(tenantId),
    getPool().query("select name from tenants where id = $1", [tenantId]),
  ]);
  const nazwaKonta = String(tenant.rows[0]?.name ?? "").trim();
  const nadawca = serwer
    ? { nazwa: serwer.nazwaNadawcy, adres: serwer.adresNadawcy, odpowiedzDo: serwer.odpowiedzDo, zrodlo: `serwer ${serwer.host}:${serwer.port}` }
    : { nazwa: nazwaKonta || config().MAIL_FROM, adres: config().MAIL_FROM, odpowiedzDo: null, zrodlo: "serwer systemowy MidRev" };

  return (
    <>
      <RamaKreatora tenantId={tenantId} kampania={kampania} aktywny="ustawienia" />
      <Komunikat ok={ok} blad={blad} />
      <FormularzUstawien
        tenantId={tenantId}
        campaignId={campaignId}
        nazwa={kampania.name}
        temat={kampania.subject ?? ""}
        preheader={kampania.preheader ?? ""}
        nadawcaNazwa={nadawca.nazwa}
        poWysylce={kampania.poWysylce}
        autozapis={kampania.status === "draft"}
      >
        <section className="karta">
          <div className="karta-naglowek">
            <h2>Nadawca</h2>
            <Link href={`/t/${tenantId}/ustawienia/wysylka`} className="przycisk przycisk-wtorny przycisk-maly ml-auto">
              Zmień w ustawieniach konta
            </Link>
          </div>
          <dl className="grid gap-x-6 gap-y-3 p-4 text-[14px] sm:grid-cols-3">
            <div>
              <dt className="etykieta">Nazwa nadawcy</dt>
              <dd className="mt-0.5 font-medium">{nadawca.nazwa}</dd>
            </div>
            <div>
              <dt className="etykieta">Adres</dt>
              <dd className="mt-0.5 font-medium">{nadawca.adres}</dd>
            </div>
            <div>
              <dt className="etykieta">Odpowiedzi trafiają do</dt>
              <dd className="mt-0.5 font-medium">{nadawca.odpowiedzDo ?? nadawca.adres}</dd>
            </div>
          </dl>
          <div className="karta-stopka">
            Nadawca jest wspólny dla wszystkich kampanii konta ({nadawca.zrodlo}). Silnik wysyłki bierze go z Ustawień →
            Wysyłka i domeny.
          </div>
        </section>
      </FormularzUstawien>
    </>
  );
}
