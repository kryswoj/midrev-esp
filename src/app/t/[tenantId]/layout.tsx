import Link from "next/link";
import { notFound } from "next/navigation";
import { licznikiNawigacji, listaTenantow, tenant as pobierzTenanta } from "../../../adapters/db/repozytoria";
import { PrzelacznikTenanta } from "./przelacznik";
import { Nawigacja } from "./nawigacja";

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
  const { tenantId } = await params;
  const biezacy = await pobierzTenanta(tenantId);
  if (!biezacy) notFound();
  const wszyscy = await listaTenantow();
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
      </aside>

      {/* Na telefonie nawigacja boczna znika, więc musi być jej odpowiednik u góry:
          właściciel sklepu wchodzi tu głównie z telefonu (NFR32). */}
      <div className="min-w-0 flex-1 md:py-3 md:pr-3">
        <nav className="flex gap-1 overflow-x-auto border-b border-[var(--color-linia)] bg-[var(--color-panel)] px-3 py-2 md:hidden">
          {SEKCJE.flatMap((s) => s.pozycje).map((p) => (
            <Link
              key={p.href}
              href={`/t/${tenantId}${p.href}`}
              className="whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] text-[var(--color-tekst-2)]"
            >
              {p.etykieta}
            </Link>
          ))}
        </nav>
        <div className="min-h-full overflow-hidden bg-[var(--color-app)] md:rounded-md md:border md:border-[var(--color-linia)]">
          {children}
        </div>
      </div>
    </div>
  );
}
