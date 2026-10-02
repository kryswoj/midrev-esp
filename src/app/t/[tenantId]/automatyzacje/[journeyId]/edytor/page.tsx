import { notFound } from "next/navigation";
import { pobierzAutomatyzacje, statystykiAutomatyzacji } from "../../../../../../usecases/automatyzacje/journeye";
import { przychodPrzegladu } from "../../../../../../usecases/raport-przegladu";
import { wymaganyTenant } from "../../../../../autoryzacja";
import { TrybPelnyEkran } from "../../../../../ui/tryb-pelny-ekran";
import { Kanwa } from "./kanwa";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automatyzacja · kanwa" };

/**
 * Kanwa automatyzacji. Serwer wczytuje szkic grafu, slowniki (wiadomosci, listy, segmenty),
 * wynik bramki i statystyki startowe; dalej pracuje komponent klienta, ktory zapisuje
 * przez akcje z ./akcje (kazda sprawdza tenanta sama).
 */
export default async function EdytorAutomatyzacji({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; journeyId: string }>;
  searchParams: Promise<{ ok?: string; blad?: string }>;
}) {
  const { tenantId: zadany, journeyId } = await params;
  const { tenantId } = await wymaganyTenant(zadany);
  const { ok, blad } = await searchParams;
  const [widok, stat, przeglad] = await Promise.all([
    pobierzAutomatyzacje(tenantId, journeyId),
    statystykiAutomatyzacji(tenantId, journeyId),
    przychodPrzegladu(tenantId),
  ]);
  if (!widok || !stat) notFound();

  return (
    <>
    {/* rama zwija boczny pasek do 64 px i oddaje kanwie cala szerokosc (kontrakt strumienia R) */}
    <TrybPelnyEkran />
    <Kanwa
      tenantId={tenantId}
      flowId={widok.id}
      start={{
        name: widok.name,
        status: widok.status,
        graf: widok.graf,
        emaile: widok.emaile,
        listy: widok.listy,
        segmenty: widok.segmenty,
        metryki: widok.metryki,
        ponowneWejscieDostepne: widok.ponowneWejscieDostepne,
        grafV2Dostepny: widok.grafV2Dostepny,
        bramka: widok.bramka,
        niepublikowane: widok.niepublikowane,
        liveVersion: widok.liveVersion,
        draftVersion: widok.draftVersion,
      }}
      statStart={{ ...stat, przebiegAt: stat.przebiegAt ? new Date(stat.przebiegAt).toISOString() : null }}
      waluta={przeglad.waluta}
      komunikat={blad ? { ton: "blad", tekst: blad } : ok ? { ton: "ok", tekst: ok } : null}
    />
    </>
  );
}
