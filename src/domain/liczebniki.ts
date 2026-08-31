/**
 * Polska odmiana liczebników: "1 zamówienie / 2 zamówienia / 5 zamówień".
 * Reguła: 1 → pojedyncza; końcówka 2–4 poza 12–14 → mnoga "kilka"; reszta → dopełniacz.
 */
export function odmien(n: number, jeden: string, kilka: string, wiele: string): string {
  return `${n} ${formaOdmiany(n, jeden, kilka, wiele)}`;
}

export function formaOdmiany(n: number, jeden: string, kilka: string, wiele: string): string {
  const abs = Math.abs(n);
  if (abs === 1) return jeden;
  const dziesiatki = abs % 100;
  const jednosci = abs % 10;
  if (jednosci >= 2 && jednosci <= 4 && !(dziesiatki >= 12 && dziesiatki <= 14)) return kilka;
  return wiele;
}
