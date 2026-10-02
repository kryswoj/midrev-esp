/** Stały szkielet panelu z boczną nawigacją desktopową i paskiem mobilnym. */
import Link from "next/link";
import { licznikiNawigacji, listaTenantow } from "../../../adapters/db/repozytoria";
import { wylogujAkcja } from "../../logowanie/akcje";
import { wymaganyTenant } from "../../autoryzacja";
import { Icon } from "../../ui/ikona";
import { StraznikWersji } from "../../ui/straznik-wersji";
import { PrzelacznikTenanta } from "./przelacznik";
import { Nawigacja, NawigacjaMobilna } from "./nawigacja";
import { RozwinPasek } from "./rozwin-pasek";

export const dynamic = "force-dynamic";

const SEKCJE = [
  {
    tytul: "",
    pozycje: [
      { href: "", etykieta: "Przegląd", ikona: "przeglad" },
      { href: "/kampanie", etykieta: "Kampanie", ikona: "kampanie" },
      { href: "/automatyzacje", etykieta: "Automatyzacje", ikona: "automatyzacje" },
      { href: "/popupy", etykieta: "Formularze zapisu", ikona: "popupy" },
    ],
  },
  {
    tytul: "Odbiorcy",
    pozycje: [
      { href: "/profile", etykieta: "Profile", ikona: "profile" },
      { href: "/segmenty", etykieta: "Segmenty", ikona: "segmenty" },
      { href: "/listy", etykieta: "Listy", ikona: "listy" },
      { href: "/import", etykieta: "Import", ikona: "import" },
      { href: "/zgody", etykieta: "Zgody i wykluczenia", ikona: "zgody" },
    ],
  },
  {
    tytul: "Analiza",
    pozycje: [
      { href: "/zamowienia", etykieta: "Zamówienia", ikona: "zamowienia" },
      { href: "/zgodnosc", etykieta: "Zgodność danych", ikona: "zgodnosc" },
    ],
  },
];

const USTAWIENIA = [
  { href: "/sklepy", etykieta: "Sklep i integracje", ikona: "sklepy" },
  { href: "/ustawienia/wysylka", etykieta: "Wysyłka i domeny", ikona: "wysylka" },
  { href: "/ustawienia/klucze-api", etykieta: "Klucze API", ikona: "kluczeApi" },
];

function Marka({ href }: { href: string }) {
  return (
    <Link href={href} className="uklad-marka flex min-h-10 items-center gap-2.5 rounded-lg px-3 py-1 max-md:min-h-9 max-md:px-0">
      <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] bg-[var(--color-akcent)] text-[13px] font-bold text-white shadow-sm">m</span>
      <span className="uklad-pasek-ukryj text-[15px] leading-[22px] font-[650] tracking-[-0.01em]">midrev esp</span>
    </Link>
  );
}

export default async function Uklad({ children, params }: { children: React.ReactNode; params: Promise<{ tenantId: string }> }) {
  const { tenantId: zadany } = await params;
  const { tenantId, sesja } = await wymaganyTenant(zadany);
  const wszyscy = (await listaTenantow()).filter((t) => sesja.tenantIds.includes(t.id));
  const liczniki = await licznikiNawigacji(tenantId);
  const wszystkiePozycje = [...SEKCJE.flatMap((s) => s.pozycje), ...USTAWIENIA];

  // Klasy uklad-* steruje tryb pełnego ekranu (src/app/ui/tryb-pelny-ekran.tsx, globals.css):
  // szerokość paska i kontenera treści są w CSS, nie w utility, żeby tryb mógł je nadpisać.
  return (
    <div className="uklad-panelu min-h-screen bg-[var(--color-plotno)] md:flex">
      <a href="#tresc" className="link-pomin">Przejdź do treści</a>
      <aside className="uklad-pasek hidden shrink-0 border-r border-[var(--color-linia)] bg-white md:block">
        <div className="uklad-pasek-wnetrze sticky top-0 flex h-screen flex-col bg-white px-4 pb-4 pt-5">
          <Marka href={`/t/${tenantId}`} />
          <RozwinPasek />
          <div className="uklad-pasek-ukryj-blok mt-4 border-y border-[var(--color-linia-0)] py-2.5"><PrzelacznikTenanta tenanci={wszyscy} biezacyId={tenantId} /></div>
          <div className="uklad-pasek-przewijany min-h-0 flex-1 overflow-y-auto pb-5">
            <Nawigacja tenantId={tenantId} sekcje={SEKCJE} liczniki={liczniki} />
          </div>

          <div className="border-t border-[var(--color-linia)] pt-3">
            <Nawigacja tenantId={tenantId} sekcje={[{ tytul: "Ustawienia", pozycje: USTAWIENIA }]} liczniki={{}} etykieta="Ustawienia" />
          </div>
          <div className="uklad-uzytkownik mt-4 flex items-center gap-3 border-t border-[var(--color-linia)] px-2 pb-1 pt-4">
            <span className="uklad-pasek-ukryj-blok grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-akcent-tlo)] text-[12px] font-semibold text-[var(--color-akcent)]">
              {sesja.email.slice(0, 1).toUpperCase()}
            </span>
            <span className="uklad-pasek-ukryj-blok tekst-pomocniczy min-w-0 flex-1 truncate font-medium" title={sesja.email}>{sesja.email}</span>
            <form action={wylogujAkcja}>
              <button type="submit" title="Wyloguj" aria-label="Wyloguj" className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)] hover:text-[var(--color-tekst)]">
                <Icon name="wyloguj" size={16} />
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="flex h-[52px] items-center gap-3 border-b border-[var(--color-linia-0)] bg-white px-4 md:hidden">
          <Marka href={`/t/${tenantId}`} />
          <PrzelacznikTenanta tenanci={wszyscy} biezacyId={tenantId} compact />
        </header>
        <NawigacjaMobilna tenantId={tenantId} pozycje={wszystkiePozycje} email={sesja.email} />
        {/* Jedyny poziomy padding treści daje layout; nagłówek i sekcje stron nie dodają własnego. */}
        <main id="tresc" tabIndex={-1} className="uklad-tresc outline-none">{children}</main>
        <StraznikWersji />
      </div>
    </div>
  );
}
