"use client";

/** Nawigacja główna z prawdziwym stanem aktywnym i ikonami lucide. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type NazwaIkony } from "../../ui/ikona";

const IKONY: Record<string, NazwaIkony> = {
  przeglad: "przeglad",
  sklepy: "sklep",
  kluczeApi: "ustawienia",
  profile: "profil",
  zamowienia: "zamowienie",
  zgodnosc: "zgodnosc",
  kampanie: "kampania",
  segmenty: "segment",
  listy: "lista",
  zgody: "zgodnosc",
  popupy: "formularz",
  automatyzacje: "automatyzacja",
  wysylka: "wysylka",
  import: "dokument",
};

type Pozycja = { href: string; etykieta: string; ikona: string };
type Sekcja = { tytul: string; pozycje: Pozycja[] };

function aktywnyLink(sciezka: string, baza: string, href: string) {
  const cel = `${baza}${href}`;
  return href === "" ? sciezka === baza : sciezka.startsWith(cel);
}

export function NawigacjaMobilna({ tenantId, pozycje }: { tenantId: string; pozycje: Pozycja[] }) {
  const sciezka = usePathname();
  const baza = `/t/${tenantId}`;
  const glowneSciezki = new Set(["", "/kampanie", "/profile"]);
  const glowne = pozycje.filter((pozycja) => glowneSciezki.has(pozycja.href));
  const pozostale = pozycje
    .filter((pozycja) => !glowneSciezki.has(pozycja.href))
    .sort((a, b) => Number(b.href === "/automatyzacje") - Number(a.href === "/automatyzacje"));
  const aktywnaPozostala = pozostale.some((pozycja) => aktywnyLink(sciezka, baza, pozycja.href));

  return (
    <nav aria-label="Główna nawigacja" className="relative z-30 grid h-14 grid-cols-4 border-b border-[var(--color-linia)] bg-white px-1 md:hidden">
      {glowne.map((p) => {
        const aktywna = aktywnyLink(sciezka, baza, p.href);
        return (
          <Link
            key={p.href}
            href={`${baza}${p.href}`}
            aria-current={aktywna ? "page" : undefined}
            className={`relative flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 text-center text-[12px] leading-4 ${aktywna ? "font-semibold text-[var(--color-tekst)] after:absolute after:inset-x-4 after:bottom-0 after:h-[3px] after:rounded-t-full after:bg-[var(--color-akcent)]" : "font-medium text-[var(--color-tekst-2)]"}`}
          >
            <Icon name={IKONY[p.ikona] ?? "dokument"} size={18} />
            <span>{p.etykieta}</span>
          </Link>
        );
      })}
      <details className="group relative min-w-0">
        <summary className={`relative flex min-h-11 cursor-pointer list-none flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 text-[12px] leading-4 ${aktywnaPozostala ? "font-semibold text-[var(--color-tekst)] after:absolute after:inset-x-4 after:bottom-0 after:h-[3px] after:rounded-t-full after:bg-[var(--color-akcent)]" : "font-medium text-[var(--color-tekst-2)]"}`}>
          <Icon name="lista" size={18} />
          <span>Więcej</span>
        </summary>
        <div className="absolute right-0 top-[calc(100%+8px)] w-[min(280px,calc(100vw-16px))] overflow-hidden rounded-[10px] border border-[var(--color-linia)] bg-white p-1.5 shadow-[var(--cien-uniesiony)]">
          {pozostale.map((p) => {
            const aktywna = aktywnyLink(sciezka, baza, p.href);
            return (
              <Link
                key={p.href}
                href={`${baza}${p.href}`}
                aria-current={aktywna ? "page" : undefined}
                onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
                className={`flex min-h-11 items-center gap-3 rounded-[7px] px-3 text-[14px] leading-5 ${aktywna ? "bg-[var(--color-powierzchnia-2)] font-semibold text-[var(--color-tekst)]" : "font-medium text-[var(--color-tekst-2)]"}`}
              >
                <Icon name={IKONY[p.ikona] ?? "dokument"} size={17} className={aktywna ? "text-[var(--color-akcent)]" : "text-[var(--color-tekst-3)]"} />
                <span>{p.etykieta}</span>
              </Link>
            );
          })}
        </div>
      </details>
    </nav>
  );
}

export function Nawigacja({ tenantId, sekcje, liczniki }: { tenantId: string; sekcje: Sekcja[]; liczniki: Record<string, number> }) {
  const sciezka = usePathname();
  const baza = `/t/${tenantId}`;

  return (
    <nav aria-label="Główna nawigacja" className="mt-5 space-y-4">
      {sekcje.map((sekcja, indeks) => (
        <div key={`${sekcja.tytul}-${indeks}`}>
          {sekcja.tytul ? <div className="mb-1.5 px-3 text-[12px] leading-4 font-semibold text-[var(--color-tekst-3)]">{sekcja.tytul}</div> : null}
          <div className="space-y-0.5">
            {sekcja.pozycje.map((p) => {
              const aktywna = aktywnyLink(sciezka, baza, p.href);
              return (
                <Link key={p.href} href={`${baza}${p.href}`} className="nawigacja-pozycja" aria-current={aktywna ? "page" : undefined}>
                  <Icon name={IKONY[p.ikona] ?? "dokument"} size={18} />
                  <span className="min-w-0 flex-1 whitespace-nowrap">{p.etykieta}</span>
                  {liczniki[p.ikona] !== undefined ? <span className="nawigacja-licznik">{liczniki[p.ikona]}</span> : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
