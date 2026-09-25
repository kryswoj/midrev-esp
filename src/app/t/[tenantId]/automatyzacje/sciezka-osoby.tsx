import Link from "next/link";
import { formatujDateICzas } from "../../../../domain/daty";
import { sciezkaOsobyWeFlow } from "../../../../usecases/automatyzacje/sciezka-osoby";
import { STATUSY } from "../../../../usecases/automatyzacje/journeye";
import { Badge, Card, CardHeader, Icon, type NazwaIkony } from "../../../ui";
import { wymaganyTenant } from "../../../autoryzacja";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Sciezka osoby" (pomysl z edrone): jak TEN czlowiek przeszedl przez automatyzacje.
 * Komponent serwerowy do osadzenia na profilu osoby (`profile/[profileId]/page.tsx`,
 * cudzy plik): <SciezkaOsoby tenantId={tenantId} profileId={profileId} />. Strona,
 * ktora go osadza, MUSI wczesniej przejsc wymaganyTenant() - komponent sam nie jest
 * jedyna granica autoryzacji; od review sam tez wola wymaganyTenant().
 */

const ETYKIETY: Record<string, { tekst: string; ton: "ok" | "uwaga" | "blad" | "szkic" | "nieaktywna" }> = {
  w_toku: { tekst: "w toku", ton: "uwaga" },
  zakonczony: { tekst: "zakończona", ton: "ok" },
  wyszedl: { tekst: "wyszła wcześniej", ton: "nieaktywna" },
  przerwany: { tekst: "przerwana", ton: "blad" },
};

const IKONY: Record<string, NazwaIkony> = {
  wejscie: "automatyzacja",
  wyslano: "wiadomosc",
  warunek: "segment",
  podzial: "segment",
  oczekiwanie: "kalendarz",
  profil: "lista",
  wyjscie: "alert",
  koniec: "gotowe",
  przerwanie: "blad",
  przejscie: "dokument",
};

export async function SciezkaOsoby({ tenantId: surowy, profileId }: { tenantId: string; profileId: string }) {
  // Komponent sprawdza tenanta SAM (review #13): osadzajacy moze kiedys zapomniec bramki,
  // a ten komponent czyta sciezki osob. wymaganyTenant jest deduplikowany cache() w renderze.
  const { tenantId } = await wymaganyTenant(surowy);
  if (!UUID.test(profileId)) return null;
  const sciezki = await sciezkaOsobyWeFlow(tenantId, profileId);
  return (
    <Card>
      <CardHeader
        title="Ścieżka w automatyzacjach"
        description="Krok po kroku: kiedy weszła, którą gałąź wybrał warunek, co dostała i dlaczego wyszła."
        action={<span className="text-[13px] text-[var(--color-tekst-3)]">{sciezki.length ? `${sciezki.length} automatyzacji` : ""}</span>}
      />
      {sciezki.length === 0 ? (
        <p className="px-6 py-5 text-[13px] text-[var(--color-tekst-2)] max-md:px-4">Ta osoba nie weszła jeszcze do żadnej automatyzacji.</p>
      ) : (
        <div className="divide-y divide-[var(--color-linia-0)]">
          {sciezki.map((s) => {
            const e = ETYKIETY[s.status];
            const st = STATUSY[s.statusFlow as keyof typeof STATUSY];
            return (
              <section key={`${s.flowId}-${s.wszedl}`} className="px-6 py-5 max-md:px-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/t/${tenantId}/automatyzacje/${s.flowId}/edytor`} className="text-[14px] font-semibold text-[var(--color-akcent)] hover:underline">{s.nazwa}</Link>
                  <Badge ton={e.ton}>{e.tekst}</Badge>
                  {st ? <span className="text-[12px] text-[var(--color-tekst-3)]">automatyzacja {st.etykieta} · wersja {s.wersja}</span> : null}
                </div>
                <p className="mt-1 text-[13px] text-[var(--color-tekst-2)]">
                  Weszła {formatujDateICzas(s.wszedl)}
                  {s.biezacyKrok ? <> · teraz w kroku „{s.biezacyKrok}”{s.wznowienie ? `, rusza dalej ${formatujDateICzas(s.wznowienie)}` : ""}</> : null}
                  {s.zakonczyl ? <> · koniec {formatujDateICzas(s.zakonczyl)}</> : null}
                  {s.powodWyjscia ? <> · powód: {s.powodWyjscia}</> : null}
                </p>
                <ol className="mt-3 space-y-0">
                  {s.kroki.map((k, i) => (
                    <li key={i} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 pb-3">
                      {i < s.kroki.length - 1 ? <span aria-hidden="true" className="absolute bottom-[-4px] left-[13px] top-7 w-px bg-[var(--color-linia)]" /> : null}
                      <span className="relative z-10 grid h-7 w-7 place-items-center rounded-full border border-[var(--color-linia)] bg-white text-[var(--color-tekst-2)]"><Icon name={IKONY[k.rodzaj] ?? "dokument"} size={14} /></span>
                      <div className="min-w-0 pt-0.5">
                        <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]"><span className="font-medium text-[var(--color-tekst)]">{k.tytul}</span><span className="text-[12px] text-[var(--color-tekst-3)]">{formatujDateICzas(k.kiedy)}</span></div>
                        {k.opis ? <div className="text-[12px] text-[var(--color-tekst-2)]">{k.opis}</div> : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}
