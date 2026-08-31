import { cookies } from "next/headers";
import { zweryfikujTokenSesji, type SesjaAktora } from "../usecases/auth/sesja";

export type { SesjaAktora } from "../usecases/auth/sesja";

// Nazwa ciasteczka powtorzona doslownie w middleware.ts (root repo), ktory jako
// kod edge nie moze importowac tego modulu - przy zmianie popraw oba miejsca.
export const CIASTECZKO_SESJI = "midrev_sesja";

/**
 * Odczyt sesji dla server components i server actions: ciasteczko -> twarda
 * weryfikacja tokenu w bazie -> SesjaAktora albo null. Middleware przepuszcza
 * kazde zadanie z JAKIMKOLWIEK ciasteczkiem (edge nie ma bazy), wiec dopiero
 * ta funkcja jest faktyczna bramka - layout chronionej strefy wola ja i przy
 * null przekierowuje na /logowanie.
 */
export async function aktualnaSesja(): Promise<SesjaAktora | null> {
  const sloik = await cookies();
  const token = sloik.get(CIASTECZKO_SESJI)?.value;
  if (!token) return null;
  return zweryfikujTokenSesji(token);
}

// alias pod nazwa uzgodniona w planie Story 1.4, zeby wpiecie w layout nie
// zalezalo od odmiany gramatycznej
export const aktualnySesja = aktualnaSesja;
