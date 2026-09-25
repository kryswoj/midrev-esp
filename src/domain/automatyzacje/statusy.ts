/** Statusy automatyzacji: slowo po polsku + ton plakietki (ksztalt nadaje klasa CSS). */
export type StatusAutomatyzacji = "szkic" | "wlaczony" | "wstrzymany";

export const STATUSY: Record<StatusAutomatyzacji, { etykieta: string; ton: "szkic" | "ok" | "uwaga" }> = {
  szkic: { etykieta: "szkic", ton: "szkic" },
  wlaczony: { etykieta: "włączona", ton: "ok" },
  wstrzymany: { etykieta: "wstrzymana", ton: "uwaga" },
};
