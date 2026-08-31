// Limit prob logowania w pamieci procesu (zero zaleznosci). Chroni przed
// online brute force na konkretne konto i przed sprayem z jednego adresu,
// a przy okazji przed tanim DoS-em: kazda proba logowania to scrypt za
// ~150 ms i 128 MB, wiec odmowa MUSI zapadac przed liczeniem hashu.
//
// Swiadome ograniczenie: stan zyje w pamieci jednego procesu. Przy kilku
// instancjach panelu limit dziala per instancja - to akceptowalne na start
// (panel to jeden proces), a przejscie na licznik w bazie nie zmieni API.

const OKNO_MS = 15 * 60 * 1000;

// czasy nieudanych prob per klucz; udane logowanie czysci klucz konta
const rejestr = new Map<string, number[]>();

function zywe(klucz: string, teraz: number): number[] {
  const czasy = (rejestr.get(klucz) ?? []).filter((t) => teraz - t < OKNO_MS);
  if (czasy.length === 0) rejestr.delete(klucz);
  else rejestr.set(klucz, czasy);
  return czasy;
}

export function przekroczonyLimit(klucz: string, maksymalnie: number): boolean {
  return zywe(klucz, Date.now()).length >= maksymalnie;
}

export function zanotujPorazke(klucz: string): void {
  const teraz = Date.now();
  const czasy = zywe(klucz, teraz);
  czasy.push(teraz);
  rejestr.set(klucz, czasy);
  // zawor bezpieczenstwa na pamiec: przy zalewie unikalnymi kluczami (np. spray
  // po tysiacach e-maili) wyrzucamy wpisy przeterminowane, zanim mapa urosnie
  if (rejestr.size > 10_000) {
    for (const k of rejestr.keys()) zywe(k, teraz);
  }
}

export function wyczyscLimit(klucz: string): void {
  rejestr.delete(klucz);
}
