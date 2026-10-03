// Wersja skryptu on-site (src/app/s/[tenantId]/route.ts). Osobny moduł, bo plik route
// w Next może eksportować tylko handlery i konfigurację trasy: dodatkowy eksport stałej
// wywala typecheck `next build --webpack` („is not a valid Route export field”).
//
// 1.1.0 (0041): klauzula zgody przy niezaznaczonym polu wyboru, link do polityki prywatnosci,
// odsylany numer wersji klauzuli. Bez zaznaczenia zgloszenie nie wychodzi (i serwer je odrzuca).
//
// 2.0.0 (0043): builder formularzy. Wiele formularzy naraz (popup, wysuwany, osadzony), kroki,
// zapis cząstkowy z tokenem, krok sukcesu z kodem, teaser, reguły wyświetlania i częstotliwości,
// zdarzenia wyświetleń, Shadow DOM. Kontrakt zgłoszenia rozszerzony WSTECZNIE ZGODNIE: skrypt 1.1
// z cache przeglądarki dalej zapisuje (zgoda + numer wersji jak dotąd).
export const WERSJA_SKRYPTU = "2.0.0";
/** Budżet rozmiaru odpowiedzi skryptu bez treści formularzy (test pilnuje). */
export const BUDZET_SKRYPTU_B = 40_000;
