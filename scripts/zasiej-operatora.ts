import { randomBytes } from "node:crypto";
import { closePool } from "../src/adapters/db/pool";
import { utworzUzytkownika, uzytkownikPoEmailu } from "../src/adapters/db/auth";
import { zahaszujHaslo } from "../src/usecases/auth/hasla";

// Zasiew pierwszego administratora (Story 1.4). Idempotentny: istniejacego konta
// NIE nadpisuje, w szczegolnosci nie resetuje hasla - reset po cichu przy kazdym
// deployu to gotowy scenariusz "ktos ustawil wlasne haslo i wrocilo stare".
//
// Uzycie: node --env-file=.env --import tsx scripts/zasiej-operatora.ts [haslo]
// Bez argumentu haslo jest generowane i wypisane na stdout DOKLADNIE RAZ -
// w bazie zostaje tylko hash, wiec zgubione haslo znaczy nowy zasiew recznie.

const EMAIL = "krystian@midrev.pl";

async function main() {
  const istniejacy = await uzytkownikPoEmailu(EMAIL);
  if (istniejacy) {
    console.log(`Konto ${EMAIL} już istnieje (rola: ${istniejacy.role}). Nic nie zmieniam.`);
    return;
  }

  const podane = process.argv[2];
  // 18 losowych bajtow -> 24 znaki base64url; entropia poza zasiegiem slownika
  const haslo = podane ?? randomBytes(18).toString("base64url");

  await utworzUzytkownika(EMAIL, await zahaszujHaslo(haslo), "Krystian", "admin");

  if (podane) {
    // podanego hasla nie powtarzamy na stdout - moglo trafic do logu CI
    console.log(`Utworzono administratora ${EMAIL} z podanym hasłem.`);
  } else {
    console.log(`Utworzono administratora ${EMAIL}.`);
    console.log(`Hasło (wypisane tylko ten jeden raz): ${haslo}`);
  }
}

main()
  .catch((blad) => {
    // wyscig dwoch rownoleglych zasiewow konczy unikalny indeks e-maila; to nie awaria
    if (blad && typeof blad === "object" && (blad as { code?: string }).code === "23505") {
      console.log(`Konto ${EMAIL} właśnie utworzył równoległy zasiew. Nic nie zmieniam.`);
      return;
    }
    console.error("Zasiew operatora nie powiódł się:", blad);
    process.exitCode = 1;
  })
  .finally(() => closePool());
