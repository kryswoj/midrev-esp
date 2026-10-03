/**
 * JSON od Shopify z identyfikatorami 64-bitowymi. Webhooki (kształt REST) niosą id jako LICZBY,
 * które bywają większe niż 2^53 (np. 820982911946154500 w przykładach dokumentacji); zwykły
 * `JSON.parse` po cichu je zaokrągla i zamówienie dostałoby cudze id, a `orders_to_redact`
 * z żądania RODO nie trafiłoby w nasze zamówienia. Liczba całkowita spoza bezpiecznego zakresu
 * zostaje TEKSTEM ze źródła (reviver z dostępem do tekstu źródłowego, Node ≥ 21).
 */
export function parsujJsonShopify(tekst: string): unknown {
  return JSON.parse(tekst, function (this: unknown, _klucz: string, wartosc: unknown, kontekst?: { source?: string }) {
    if (typeof wartosc === "number" && !Number.isSafeInteger(wartosc) && kontekst?.source && /^-?\d+$/.test(kontekst.source)) {
      return kontekst.source;
    }
    return wartosc;
  } as (this: unknown, k: string, v: unknown) => unknown);
}
