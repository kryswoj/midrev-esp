import { createHash, randomBytes } from "node:crypto";
import {
  sesjaZUzytkownikiem,
  tenantyDlaUzytkownika,
  type Rola,
} from "../../adapters/db/auth";

/**
 * Kontekst dzialajacego zbudowany z sesji (AD-21). Pole tenantIds to CALA
 * prawda o dostepie: use-case porownuje zadany tenant z ta lista i nigdy
 * nie ufa identyfikatorowi z ciala ani z parametrow zadania.
 */
export interface SesjaAktora {
  userId: string;
  email: string;
  displayName: string;
  role: Rola;
  tenantIds: string[];
}

export const WAZNOSC_SESJI_DNI = 14;

/** 32 losowe bajty = 256 bitow entropii; zgadywanie tokenu nie jest scenariuszem. */
export function nowyTokenSesji(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * W bazie zyje wylacznie SHA-256 tokenu. Token to 256 bitow czystej losowosci,
 * wiec szybki hash bez soli wystarcza - slownik na taki input nie istnieje,
 * a wyciek zrzutu bazy nie daje gotowych ciasteczek.
 */
export function zahaszujToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Twarda weryfikacja tokenu: sesja musi istniec w bazie i byc niewygasla.
 * Middleware sprawdza tylko OBECNOSC ciasteczka (edge nie ma bazy); to tutaj
 * jest faktyczna bramka i tedy przechodzi kazdy server component i action.
 */
export async function zweryfikujTokenSesji(token: string): Promise<SesjaAktora | null> {
  if (!token) return null;
  const wiersz = await sesjaZUzytkownikiem(zahaszujToken(token));
  if (!wiersz) return null;
  const tenantIds = await tenantyDlaUzytkownika(wiersz.user_id, wiersz.role);
  return {
    userId: wiersz.user_id,
    email: wiersz.email,
    displayName: wiersz.display_name,
    role: wiersz.role,
    tenantIds,
  };
}
