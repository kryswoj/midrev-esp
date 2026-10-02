// Wersja skryptu on-site (src/app/s/[tenantId]/route.ts). Osobny moduł, bo plik route
// w Next może eksportować tylko handlery i konfigurację trasy: dodatkowy eksport stałej
// wywala typecheck `next build --webpack` („is not a valid Route export field”).
//
// 1.1.0 (0041): klauzula zgody przy niezaznaczonym polu wyboru, link do polityki prywatnosci,
// odsylany numer wersji klauzuli. Bez zaznaczenia zgloszenie nie wychodzi (i serwer je odrzuca).
export const WERSJA_SKRYPTU = "1.1.0";
