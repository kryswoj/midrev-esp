/**
 * JSON od Shopify z identyfikatorami 64-bitowymi. Webhooki (kształt REST) niosą id jako LICZBY,
 * które bywają większe niż 2^53 (np. 820982911946154500 w przykładach dokumentacji); zwykły
 * `JSON.parse` po cichu je zaokrągla i zamówienie dostałoby cudze id, a `orders_to_redact`
 * z żądania RODO nie trafiłoby w nasze zamówienia.
 *
 * Bez zależności od wersji Node (review Codeksa r1: reviver z tekstem źródłowym nie istnieje
 * w Node 20): skaner przechodzi tekst, pamięta, czy jest w napisie (z ucieczkami `\"`), i liczbę
 * CAŁKOWITĄ spoza bezpiecznego zakresu, stojącą poza napisem, owija w cudzysłów. Ułamki i liczby
 * z wykładnikiem zostają liczbami (kwoty Shopify i tak są napisami).
 */
export function parsujJsonShopify(tekst: string): unknown {
  return JSON.parse(owinDuzeLiczby(tekst));
}

export function owinDuzeLiczby(tekst: string): string {
  let wynik = "";
  let ostatni = 0;
  let wNapisie = false;
  for (let i = 0; i < tekst.length; i++) {
    const z = tekst.charCodeAt(i);
    if (wNapisie) {
      if (z === 92 /* \ */) i++;
      else if (z === 34 /* " */) wNapisie = false;
      continue;
    }
    if (z === 34) {
      wNapisie = true;
      continue;
    }
    // początek liczby: cyfra albo minus poza napisem
    if (z === 45 || (z >= 48 && z <= 57)) {
      let j = i + 1;
      while (j < tekst.length) {
        const c = tekst.charCodeAt(j);
        if ((c >= 48 && c <= 57) || c === 46 || c === 101 || c === 69 || c === 43 || c === 45) j++;
        else break;
      }
      const token = tekst.slice(i, j);
      if (/^-?\d{16,}$/.test(token) && !Number.isSafeInteger(Number(token))) {
        wynik += tekst.slice(ostatni, i) + `"${token}"`;
        ostatni = j;
      }
      i = j - 1;
    }
  }
  return ostatni === 0 ? tekst : wynik + tekst.slice(ostatni);
}
