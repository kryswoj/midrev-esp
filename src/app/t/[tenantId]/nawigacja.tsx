"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Nawigacja z realnym stanem aktywnym (aria-current). Bez tego panel wygląda jak
 * zbiór podstron, a nie jak narzędzie: operator nie wie, gdzie jest.
 * Ikony są celowo ciemniejsze od tekstu obok, tak jak w Linearze i Attio.
 */
const IKONY: Record<string, React.ReactNode> = {
  przeglad: <path d="M3 9.5 8 4l5 5.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5Z" />,
  sklepy: <path d="M3 6h10l-.8 7.1a1 1 0 0 1-1 .9H4.8a1 1 0 0 1-1-.9L3 6Zm2.5 0V4.5a2.5 2.5 0 0 1 5 0V6" />,
  profile: <path d="M8 8.5A2.75 2.75 0 1 0 8 3a2.75 2.75 0 0 0 0 5.5ZM3 14c0-2.2 2.2-3.5 5-3.5s5 1.3 5 3.5" />,
  zamowienia: <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
  zgodnosc: <path d="M8 2.5 13 5v3.5c0 3-2.1 4.6-5 5.5-2.9-.9-5-2.5-5-5.5V5l5-2.5Z" />,
  kampanie: <path d="M2.5 5.5h11v7h-11z M2.5 5.5 8 9.5l5.5-4" />,
  segmenty: <path d="M13 3H3l4 4.7V13l2-1.2V7.7L13 3Z" />,
  listy: <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.8 4.5h.01M2.8 8h.01M2.8 11.5h.01" />,
  zgody: <path d="m3.5 8.2 3 3 6-6.4" />,
  popupy: <path d="M2.5 3.5h11v6h-11z M5.5 12.5h5 M8 9.5v3" />,
  automatyzacje: <path d="M8 2.5v3 M8 10.5v3 M2.5 8h3 M10.5 8h3 M8 6.5A1.5 1.5 0 1 0 8 9.5 1.5 1.5 0 0 0 8 6.5Z" />,
};

function Ikona({ nazwa }: { nazwa: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {IKONY[nazwa]}
    </svg>
  );
}

export function Nawigacja({
  tenantId,
  sekcje,
  liczniki,
}: {
  tenantId: string;
  sekcje: { tytul: string; pozycje: { href: string; etykieta: string; ikona: string }[] }[];
  liczniki: Record<string, number>;
}) {
  const sciezka = usePathname();
  const baza = `/t/${tenantId}`;

  return (
    <nav className="mt-4 space-y-4">
      {sekcje.map((sekcja) => (
        <div key={sekcja.tytul}>
          <div className="etykieta mb-1 px-2">{sekcja.tytul}</div>
          <div className="space-y-px">
            {sekcja.pozycje.map((p) => {
              const cel = `${baza}${p.href}`;
              const aktywna = p.href === "" ? sciezka === baza : sciezka.startsWith(cel);
              return (
                <Link
                  key={p.href}
                  href={cel}
                  className="nawigacja-pozycja"
                  aria-current={aktywna ? "page" : undefined}
                >
                  <Ikona nazwa={p.ikona} />
                  {p.etykieta}
                  {liczniki[p.ikona] !== undefined ? (
                    <span className="nawigacja-licznik">{liczniki[p.ikona]}</span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
