/**
 * Statusy zamówień w języku interfejsu. Surowy enum platformy sklepowej ("processing",
 * "on-hold") nie ma czego szukać w polskim panelu: operator czyta to codziennie, a klient
 * sklepu w ogóle nie musi wiedzieć, że pod spodem jest WooCommerce.
 */
const NAZWY: Record<string, string> = {
  completed: "zrealizowane",
  processing: "w realizacji",
  "on-hold": "wstrzymane",
  pending: "oczekuje na zapłatę",
  cancelled: "anulowane",
  refunded: "zwrócone",
  failed: "nieudane",
};

export type WagaStatusu = "ok" | "uwaga" | "blad";

export function nazwaStatusu(status: string): string {
  return NAZWY[status] ?? status;
}

export function wagaStatusu(status: string): WagaStatusu {
  if (status === "completed") return "ok";
  if (status === "cancelled" || status === "refunded" || status === "failed") return "blad";
  return "uwaga";
}

/** Źródła zgód z rejestru. Wpis "popup:Nazwa" niesie nazwę popupu w sobie. */
const ZRODLA_ZGOD: Record<string, string> = {
  checkout_woocommerce: "checkout sklepu",
  link_wypisania: "link wypisania w stopce",
};

export function zrodloZgody(source: string): string {
  if (source.startsWith("popup:")) return `popup „${source.slice("popup:".length)}”`;
  return ZRODLA_ZGOD[source] ?? source;
}

/** Uprawnienia sklepu (klucze MozliwosciPlatformy) w języku interfejsu. */
const NAZWY_MOZLIWOSCI: Record<string, string> = {
  zamowienia: "zamówienia",
  klienci: "klienci",
  produkty: "produkty",
  porzuconyKoszyk: "porzucony koszyk",
  webhooki: "webhooki",
};

export function nazwaMozliwosci(klucz: string): string {
  return NAZWY_MOZLIWOSCI[klucz] ?? klucz;
}
