import { usunSesjePoHashu } from "../../adapters/db/auth";
import { zahaszujToken } from "./sesja";

/**
 * Wylogowanie uniewaznia sesje PO STRONIE SERWERA, nie tylko kasuje ciasteczko.
 * Skopiowany wczesniej token przestaje dzialac natychmiast - usuniecie samego
 * ciasteczka zostawiloby zywa sesje na 14 dni.
 */
export async function wyloguj(token: string): Promise<void> {
  if (!token) return;
  await usunSesjePoHashu(zahaszujToken(token));
}
