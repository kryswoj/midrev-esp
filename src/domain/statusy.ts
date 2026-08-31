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
