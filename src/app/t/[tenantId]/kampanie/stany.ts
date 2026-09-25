/**
 * JEDEN słownik statusów kampanii dla listy i dla szczegółu.
 *
 * Powód wydzielenia: oba ekrany miały własne kopie i zdążyły się rozjechać. Lista znała
 * `scheduled`, szczegół nie, więc kampania zaplanowana pokazywała na szczegółach SUROWY
 * enum z bazy w plakietce bez klasy. DESIGN.md zakazuje tego wprost („nie pokazuj surowych
 * enumów platformy"), a rozjazd jest nieunikniony, dopóki słownik stoi w dwóch miejscach:
 * kolejny status dołożony w silniku trafi do jednej kopii i nie trafi do drugiej.
 *
 * Plakietka niesie KSZTAŁT, nie sam kolor (NFR33), więc klasa nie jest tu dekoracją:
 * `plakietka-ok` to kwadrat, `plakietka-uwaga` trójkąt, `plakietka-blad` okrąg,
 * `plakietka-szkic` pusty kwadrat (brak stanu, nie stan dobry).
 */
export type StanKampanii = { etykieta: string; klasa: string };

export const STANY: Record<string, StanKampanii> = {
  draft: { etykieta: "szkic", klasa: "plakietka-szkic" },
  awaiting_approval: { etykieta: "czeka na akceptację", klasa: "plakietka-uwaga" },
  approved: { etykieta: "zaakceptowana", klasa: "plakietka-ok" },
  scheduled: { etykieta: "zaplanowana", klasa: "plakietka-ok" },
  // wysyłka w toku to nie jest stan „dobry", tylko stan, który trzeba mieć na oku:
  // trójkąt uwagi, a nie kwadrat OK
  sending: { etykieta: "w wysyłce", klasa: "plakietka-uwaga" },
  paused: { etykieta: "wysyłka wstrzymana", klasa: "plakietka-uwaga" },
  sent: { etykieta: "wysłana", klasa: "plakietka-ok" },
  cancelled: { etykieta: "odwołana", klasa: "plakietka-blad" },
};

/**
 * Status nieznany słownikowi nie może wypaść na ekran jako enum. Pokazujemy uczciwie,
 * że czegoś nie umiemy nazwać, zamiast udawać, że to poprawna etykieta.
 */
export function stanKampaniiNaEkran(status: string): StanKampanii {
  return STANY[status] ?? { etykieta: `stan nieznany (${status})`, klasa: "plakietka-uwaga" };
}
