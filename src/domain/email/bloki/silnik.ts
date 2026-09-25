/**
 * Oprawa, którą silnik wysyłki (`src/usecases/wysylka/renderuj.ts`, `zlozWiadomosc`)
 * nakłada na treść kampanii. Edytor jej nie zmienia — tylko ją ODWZOROWUJE, żeby płótno
 * pokazywało maila w tej szerokości, w jakiej dostanie go odbiorca.
 *
 * Silnik opakowuje treść w kartę `max-width:560px; padding:32px` na tle #f5f5f5, a pod
 * treścią dokleja stopkę z wypisem. `max-width` liczy się bez wcięcia (content-box),
 * więc:
 *  - treść bloków ma realnie 560 px szerokości (karta razem z wcięciem: 624 px),
 *  - „tło maila" i „szerokość" z globalnych stylów nie są dziś widoczne u odbiorcy
 *    (panel pokazuje je jako zablokowane z powodem, a nie jako działające kontrolki).
 *
 * Test `render-blokow.test.ts` sprawdza te liczby wobec PRAWDZIWEGO wyniku
 * `zlozWiadomosc` — gdy silnik zmieni oprawę, test to złapie.
 */
export const SILNIK_SZEROKOSC_KARTY = 560;
export const SILNIK_WCIECIE = 32;
export const SILNIK_TLO = "#f5f5f5";
export const SILNIK_TLO_KARTY = "#ffffff";
export const SZEROKOSC_TRESCI = SILNIK_SZEROKOSC_KARTY;
