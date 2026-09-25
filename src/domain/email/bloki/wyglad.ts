/**
 * Wymiary typograficzne wspólne dla renderu maila i płótna edytora. Jedno źródło:
 * płótno ma wyglądać jak mail, więc nie może mieć własnej kopii liczb.
 */
export const WARIANTY_TEKSTU = {
  h1: { fs: 28, lh: 36, fw: 700, etykieta: "Nagłówek 1" },
  h2: { fs: 22, lh: 30, fw: 700, etykieta: "Nagłówek 2" },
  h3: { fs: 18, lh: 26, fw: 600, etykieta: "Nagłówek 3" },
  akapit: { fs: 16, lh: 26, fw: 400, etykieta: "Akapit" },
  maly: { fs: 13, lh: 20, fw: 400, etykieta: "Drobny tekst" },
} as const;

export const ROZMIARY_PRZYCISKU = {
  maly: { fs: 14, py: 10, px: 18, etykieta: "Mały" },
  sredni: { fs: 16, py: 14, px: 28, etykieta: "Średni" },
  duzy: { fs: 18, py: 18, px: 36, etykieta: "Duży" },
} as const;

/** Jasność koloru 0..1 — do doboru tekstu na tle (biały na ciemnym, grafit na jasnym). */
export function jasnosc(hex: string): number {
  const h = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(h)) return 1;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function tekstNaTle(tlo: string, jasny = "#ffffff", ciemny = "#1f2328"): string {
  return jasnosc(tlo) < 0.4 ? jasny : ciemny;
}
