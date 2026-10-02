"use client";

/** Nawigacja główna z prawdziwym stanem aktywnym i ikonami lucide. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type NazwaIkony } from "../../ui/ikona";
import { PrzyciskFormularza } from "../../ui/przycisk-formularza";
import { wylogujAkcja } from "../../logowanie/akcje";

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

export function NawigacjaMobilna({ tenantId, pozycje, email }: { tenantId: string; pozycje: Pozycja[]; email: string }) {
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
          {/* telefon nie ma bloku użytkownika z paska bocznego: wylogowanie jest tutaj */}
          <div className="mt-1.5 border-t border-[var(--color-linia-0)] px-3 pb-1.5 pt-2.5">
            <p className="tekst-meta truncate" title={email}>{email}</p>
            <form action={wylogujAkcja} className="mt-2">
              <PrzyciskFormularza variant="secondary" size="sm" trwa="Wylogowuję…" className="w-full justify-center">
                <Icon name="wyloguj" size={15} />Wyloguj
              </PrzyciskFormularza>
            </form>
          </div>
        </div>
      </details>
    </nav>
  );
}

export function Nawigacja({ tenantId, sekcje, liczniki, etykieta = "Główna nawigacja" }: { tenantId: string; sekcje: Sekcja[]; liczniki: Record<string, number>; etykieta?: string }) {
  const sciezka = usePathname();
  const baza = `/t/${tenantId}`;

  return (
    <nav aria-label={etykieta} className="mt-5 space-y-4">
      {sekcje.map((sekcja, indeks) => (
        <div key={`${sekcja.tytul}-${indeks}`}>
          {sekcja.tytul ? <div className="nawigacja-tytul mb-1.5 px-3 text-[12px] leading-4 font-semibold text-[var(--color-tekst-3)]">{sekcja.tytul}</div> : null}
          <div className="space-y-0.5">
            {sekcja.pozycje.map((p) => {
              const aktywna = aktywnyLink(sciezka, baza, p.href);
              return (
                <Link key={p.href} href={`${baza}${p.href}`} className="nawigacja-pozycja" data-etykieta={p.etykieta} aria-current={aktywna ? "page" : undefined}>
                  <Icon name={IKONY[p.ikona] ?? "dokument"} size={18} />
                  <span className="nawigacja-etykieta min-w-0 flex-1 whitespace-nowrap">{p.etykieta}</span>
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
