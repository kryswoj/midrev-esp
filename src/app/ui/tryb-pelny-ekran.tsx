/**
 * Tryb pełnego ekranu dla edytora maili i kanwy automatyzacji.
 *
 * Użycie: wyrenderuj `<TrybPelnyEkran />` gdziekolwiek w drzewie strony pod
 * `src/app/t/[tenantId]/layout.tsx`. Dopóki znacznik jest w DOM-ie:
 * - boczny pasek (desktop) zwija się do 64 px: logo, ikony z podpowiedzią, przycisk „Rozwiń”,
 * - `<main>` traci max-width 1240 i poziomy padding, staje się kolumną flex na całą wysokość,
 * - na telefonie paski u góry zostają (to jedyna nawigacja), znika tylko padding treści.
 * Po opuszczeniu strony znacznik znika i rama wraca do normalnego układu.
 *
 * Mechanika: czysty CSS (`.uklad-panelu:has(.uklad-tresc [data-esp-pelny-ekran])` w globals.css).
 * Znacznik renderuje się już w HTML-u z serwera, więc nie ma migotania przy pierwszym
 * wejściu ani przy nawigacji klienckiej; nie trzeba kontekstu ani efektów. Bez dyrektywy
 * "use client": działa w drzewie serwerowym i klienckim (czysty znacznik, zero JS).
 *
 * Wysokość obszaru roboczego: `var(--wysokosc-pelnego-ekranu)` (desktop 100dvh, telefon
 * 100dvh minus dwa paski u góry). Strona sama decyduje, czy chce `h-[…]` czy `min-h-[…]`.
 * Nie dokładaj ujemnych marginesów (`-mx-4 md:-mx-8`): w tym trybie padding wynosi 0.
 */
export function TrybPelnyEkran() {
  return <span data-esp-pelny-ekran="" hidden aria-hidden="true" />;
}
