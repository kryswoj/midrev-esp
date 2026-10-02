/**
 * Rozpoznanie błędu „stara karta po wdrożeniu” (audyt UX 02.10, P0-1).
 *
 * Po deployu karta otwarta wcześniej ma stare ID server actions i stare chunki JS.
 * Next zgłasza wtedy:
 * - UnrecognizedActionError („Server Action "…" was not found on the server”),
 * - „Server action not found.” (tekst odpowiedzi 404 przekazany jako komunikat),
 * - „Failed to find Server Action. This request might be from an older or newer deployment”,
 * - ChunkLoadError / „Loading chunk … failed” / „Failed to fetch dynamically imported module”.
 *
 * Wąsko i po komunikacie: każdy inny błąd ma dalej trafić na ogólny ekran błędu,
 * a nie udawać, że wystarczy odświeżyć.
 */
import { unstable_isUnrecognizedActionError } from "next/navigation";

const WZORCE = [
  /server action .* was not found on the server/i,
  /^server action not found\.?$/i,
  /failed to find server action/i,
  /older or newer deployment/i,
  /loading (css )?chunk [\w-]+ failed/i,
  /failed to fetch dynamically imported module/i,
];

export function czyBladWersji(blad: unknown): boolean {
  if (!blad || typeof blad !== "object") return false;
  try {
    if (unstable_isUnrecognizedActionError(blad)) return true;
  } catch {
    // starsza/nowsza wersja Nexta bez tej funkcji: zostają wzorce
  }
  const { name, message } = blad as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  return typeof message === "string" && WZORCE.some((w) => w.test(message.trim()));
}
