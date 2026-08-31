import Link from "next/link";
import { licznikiNawigacji, listaTenantow } from "../../../adapters/db/repozytoria";
import { wylogujAkcja } from "../../logowanie/akcje";
import { wymaganyTenant } from "../../autoryzacja";
import { PrzelacznikTenanta } from "./przelacznik";
import { Nawigacja, NawigacjaMobilna } from "./nawigacja";

export const dynamic = "force-dynamic";

const SEKCJE = [
  {
    tytul: "Dane",
    pozycje: [
      { href: "", etykieta: "Przegląd", ikona: "przeglad" },
      { href: "/sklepy", etykieta: "Sklepy", ikona: "sklepy" },
      { href: "/profile", etykieta: "Profile", ikona: "profile" },
      { href: "/zamowienia", etykieta: "Zamówienia", ikona: "zamowienia" },
      { href: "/zgodnosc", etykieta: "Zgodność danych", ikona: "zgodnosc" },
    ],
  },
  {
    tytul: "Marketing",
    pozycje: [
      { href: "/kampanie", etykieta: "Kampanie", ikona: "kampanie" },
      { href: "/automatyzacje", etykieta: "Automatyzacje", ikona: "automatyzacje" },
      { href: "/popupy", etykieta: "Popupy", ikona: "popupy" },
      { href: "/segmenty", etykieta: "Segmenty", ikona: "segmenty" },
      { href: "/listy", etykieta: "Listy", ikona: "listy" },
      { href: "/zgody", etykieta: "Zgody i wykluczenia", ikona: "zgody" },
    ],
  },
];

export default async function Uklad({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId: zadany } = await params;
  // Bramka calej strefy /t/ (AD-21): sesja z ciasteczka, membership z bazy.
  // Zamyka odczyt kazdej strony ponizej; akcje mimo to weryfikuja same, bo
  // server action da sie wywolac bez renderowania layoutu. Membership implikuje
  // istnienie tenanta (FK), wiec osobne pobierzTenanta() jest zbedne.
  const { tenantId, sesja } = await wymaganyTenant(zadany);
  // przelacznik pokazuje wylacznie tenanty widoczne w sesji - client nie ma
  // widziec nazw pozostalych klientow agencji
  const wszyscy = (await listaTenantow()).filter((t) => sesja.tenantIds.includes(t.id));
  const liczniki = await licznikiNawigacji(tenantId);

  return (
    <div className="flex min-h-screen bg-[var(--color-plotno)]">
      <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col border-r border-[var(--color-linia)] bg-[var(--color-panel)] px-2.5 py-3 md:flex">
        <Link href="/" className="mb-3 flex items-center gap-2 px-2 py-1">
          <span className="grid h-[18px] w-[18px] place-items-center rounded-[5px] bg-[var(--color-akcent-tlo)] text-[10px] font-semibold text-[var(--color-akcent)] ring-1 ring-[var(--color-akcent-ramka)]">
            m
          </span>
          <span className="text-[13px] font-[590] tracking-[-0.011em]">midrev esp</span>
        </Link>

        <PrzelacznikTenanta tenanci={wszyscy} biezacyId={tenantId} />
        <Nawigacja tenantId={tenantId} sekcje={SEKCJE} liczniki={liczniki} />

        <div className="mt-auto rounded-md border border-[var(--color-linia)] bg-[var(--color-powierzchnia)] px-2.5 py-2 text-[12px] leading-[16px] text-[var(--color-tekst-3)]">
          <span className="font-medium text-[var(--color-tekst-2)]">Faza 1.</span> Dane sklepu,
          segmentacja i zgody działają. Wysyłka wchodzi w Epiku 3, dlatego kampanie
          zatrzymują się na akceptacji.
        </div>

        {/* Tożsamość operatora + wylogowanie (audyt P1): panel bywa otwarty na
            wspólnym komputerze agencji, więc musi być widać, kto pracuje, i da
            się zamknąć sesję bez czekania na jej wygaśnięcie. */}
        <div className="mt-2 flex items-center justify-between gap-2 px-2.5 pb-0.5 text-[11px] leading-[16px] text-[var(--color-tekst-3)]">
          <span className="truncate" title={sesja.email}>
            {sesja.email}
          </span>
          <form action={wylogujAkcja}>
            <button
              type="submit"
              className="cursor-pointer whitespace-nowrap underline decoration-dotted underline-offset-2 hover:text-[var(--color-tekst)]"
            >
              Wyloguj
            </button>
          </form>
        </div>
      </aside>

      {/* Na telefonie nawigacja boczna znika, więc musi być jej odpowiednik u góry:
          właściciel sklepu wchodzi tu głównie z telefonu (NFR32). */}
      <div className="min-w-0 flex-1 md:py-3 md:pr-3">
        <NawigacjaMobilna tenantId={tenantId} pozycje={SEKCJE.flatMap((s) => s.pozycje)} />
        <div className="min-h-full overflow-hidden bg-[var(--color-app)] md:rounded-md md:border md:border-[var(--color-linia)]">
          {children}
        </div>
      </div>
    </div>
  );
}
