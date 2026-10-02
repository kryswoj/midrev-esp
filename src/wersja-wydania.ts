/**
 * Krótki identyfikator wydania z treści pliku REVISION (deploy/deploy.sh zapisuje go
 * w katalogu wydania przed `next build`):
 * - „<sha> <ref>” (wdrożenie z repo) → pierwsze 12 znaków SHA,
 * - „archiwum <plik> sha256:<hash>” (wdrożenie z archiwum) → pierwsze 12 znaków hasha.
 * Cokolwiek innego (pusty plik, śmieci) → "" = wersja nieznana, mechanizmy wyłączone.
 * Czysta funkcja bez fs: czyta ją next.config.ts i test tests/wersja-wydania.test.ts.
 */
export function wersjaZRevision(tresc: string): string {
  const t = tresc.trim();
  // nazwa archiwum może mieć spacje, więc hash wyciągamy wzorcem, nie pozycją
  const surowa = t.startsWith("archiwum ") ? (/sha256:([0-9a-f]+)/i.exec(t)?.[1] ?? "") : (t.split(/\s+/)[0] ?? "");
  return /^[0-9a-f]{12,}$/i.test(surowa) ? surowa.slice(0, 12).toLowerCase() : "";
}
