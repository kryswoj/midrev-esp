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
  if (source.startsWith("strona:")) return `formularz na stronie „${source.slice("strona:".length)}”`;
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

/**
 * Status sklepu (kolumna `stores.status`) w języku interfejsu. "connected" na ekranie
 * sklepów to surowy enum bazy, a nie słowo dla operatora (audyt UX, P6 bis).
 */
const NAZWY_STATUSOW_SKLEPU: Record<string, string> = {
  pending: "w trakcie podłączania",
  connected: "podłączony",
  error: "błąd połączenia",
};

export function nazwaStatusuSklepu(status: string): string {
  return NAZWY_STATUSOW_SKLEPU[status] ?? status;
}

export function wagaStatusuSklepu(status: string): WagaStatusu {
  if (status === "connected") return "ok";
  if (status === "error") return "blad";
  return "uwaga";
}
