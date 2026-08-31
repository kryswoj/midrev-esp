// Wspólny kształt stanu formularzy przechodzących przez useActionState (React 19).
// Akcja zwraca stan TYLKO przy błędzie: komunikat + echo wpisanych wartości,
// żeby błąd walidacji nie kasował pracy operatora (audyt UX 2026-08-31, B4).
// Sukces nadal kończy się redirectem - stan nigdy nie niesie "ok".
export interface StanFormularza {
  blad?: string;
  wartosci?: Record<string, string>;
}
