/**
 * Wgrywanie obrazów do biblioteki sklepu (0028) z przeglądarki: z pola obrazu, z zakładki
 * „Obrazy" i z upuszczenia pliku na płótno. Jedna ścieżka dla wszystkich trzech.
 *
 * Walidacja tutaj jest tylko dla wygody (szybki, czytelny komunikat bez wysyłania 40 MB).
 * Autorytatywna jest trasa `/api/obrazy/[tenantId]`: sesja rozstrzyga tenanta, limit 5 MB
 * liczony na bajtach, które przyszły, a format rozpoznawany po zawartości pliku, nie po
 * nazwie ani typie podanym przez przeglądarkę.
 */

export const MAKS_BAJTOW_OBRAZU = 5 * 1024 * 1024;
export const TYPY_OBRAZOW = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const AKCEPTOWANE_OBRAZY = TYPY_OBRAZOW.join(",");
/** ile plików naraz przyjmujemy z jednego upuszczenia */
export const MAKS_PLIKOW_NARAZ = 5;

export interface ObrazBiblioteki {
  id: string;
  url: string;
  sciezka: string;
  nazwa: string;
  rozmiar: number;
  szerokosc: number;
  wysokosc: number;
  wgranoO: string;
  blokadaUsuniecia: string | null;
  szkice: number;
}

export function rozmiarPliku(bajty: number): string {
  if (bajty >= 1024 * 1024) return `${(bajty / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(bajty / 1024))} KB`;
}

/** Wstępna ocena pliku przed wysłaniem. `null` = można wysyłać. */
export function ocenPlikObrazu(plik: { name: string; size: number; type: string }): string | null {
  const nazwa = plik.name || "plik";
  // Pusty MIME (bywa przy plikach z niektórych aplikacji i dysków sieciowych): decyduje
  // rozszerzenie, a serwer i tak rozpoznaje format po bajtach i odrzuci podróbkę.
  const typOk = plik.type ? (TYPY_OBRAZOW as readonly string[]).includes(plik.type) : /\.(png|jpe?g|gif|webp)$/i.test(nazwa);
  if (!typOk) {
    return `„${nazwa}" to nie jest obraz, który obsługują skrzynki. Wgraj PNG, JPEG, GIF albo WebP.`;
  }
  if (plik.size === 0) return `„${nazwa}" jest pusty.`;
  if (plik.size > MAKS_BAJTOW_OBRAZU) return `„${nazwa}" ma ${rozmiarPliku(plik.size)}. Limit to 5 MB (do maila wystarczy 1200 px szerokości).`;
  return null;
}

/** Czy przeciągane są pliki z dysku (a nie blok edytora ani zaznaczony tekst). */
export function przeciaganePliki(dt: DataTransfer | null): boolean {
  return Boolean(dt && Array.from(dt.types ?? []).includes("Files"));
}

export async function wyslijObraz(
  tenantId: string,
  plik: File,
): Promise<{ ok: true; obraz: ObrazBiblioteki } | { ok: false; blad: string }> {
  const blad = ocenPlikObrazu(plik);
  if (blad) return { ok: false, blad };
  try {
    const odp = await fetch(`/api/obrazy/${encodeURIComponent(tenantId)}`, {
      method: "POST",
      headers: { "x-nazwa-pliku": encodeURIComponent(plik.name), "content-type": "application/octet-stream" },
      body: plik,
    });
    const dane = await odp.json().catch(() => null);
    if (!odp.ok || !dane?.ok) return { ok: false, blad: dane?.blad ?? `Serwer odrzucił plik (${odp.status}).` };
    return { ok: true, obraz: dane.obraz };
  } catch {
    return { ok: false, blad: "Nie udało się wysłać pliku — sprawdź połączenie i spróbuj ponownie." };
  }
}

export async function pobierzBiblioteke(tenantId: string): Promise<{ ok: true; obrazy: ObrazBiblioteki[] } | { ok: false; blad: string }> {
  try {
    const odp = await fetch(`/api/obrazy/${encodeURIComponent(tenantId)}`, { cache: "no-store" });
    const dane = await odp.json().catch(() => null);
    if (!odp.ok || !dane?.ok) return { ok: false, blad: dane?.blad ?? `Nie udało się wczytać biblioteki (${odp.status}).` };
    return { ok: true, obrazy: dane.obrazy };
  } catch {
    return { ok: false, blad: "Nie udało się wczytać biblioteki — sprawdź połączenie." };
  }
}
