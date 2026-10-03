import { stosKroju, type StylFormularza } from "./model";

/**
 * Jeden arkusz stylów formularza dla skryptu na stronie sklepu (wstawiany do Shadow DOM,
 * więc style sklepu go nie psują, a on nie psuje sklepu) i dla podglądu w builderze
 * (ta sama struktura klas `mf-*`). Dzięki temu podgląd wygląda tak, jak formularz u klienta.
 *
 * Arkusz jest STAŁY: nie ma w nim treści od operatora. Kolory, krój, szerokość i
 * zaokrąglenie wchodzą przez zmienne CSS ustawiane `style.setProperty` z wartości
 * zwalidowanych schematem (#rrggbb, liczby, krój z listy), patrz `zmienneStylu`.
 *
 * Układ telefonu przez container query na `.mf-root`: działa i na prawdziwym telefonie,
 * i w ramce 390 px w builderze, bez zgadywania szerokości okna.
 */
export const CSS_FORMULARZA = `
.mf-root{all:initial;container:mf/inline-size;display:block;font-family:var(--mf-font);color:var(--mf-tekst);line-height:1.45;-webkit-font-smoothing:antialiased}
.mf-root *,.mf-root *::before,.mf-root *::after{box-sizing:border-box}
.mf-nakladka{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(10,10,12,var(--mf-nakladka));animation:mf-wej .18s ease-out}
.mf-flyout{position:fixed;bottom:20px;z-index:2147483000;width:min(calc(100vw - 32px),var(--mf-szer));animation:mf-wysun .22s ease-out}
.mf-flyout.mf-rog-prawo{right:20px}.mf-flyout.mf-rog-lewo{left:20px}
.mf-embed{width:100%;max-width:var(--mf-szer);margin:0 auto}
.mf-karta{position:relative;display:flex;width:100%;max-width:var(--mf-szer);max-height:calc(100dvh - 32px);overflow:auto;background:var(--mf-tlo);color:var(--mf-tekst);border-radius:var(--mf-radius);box-shadow:0 24px 64px rgba(0,0,0,.28);text-align:var(--mf-wyr)}
.mf-embed .mf-karta{box-shadow:none;border:1px solid color-mix(in srgb,var(--mf-tekst) 14%,transparent);max-height:none}
.mf-flyout .mf-karta{box-shadow:0 12px 40px rgba(0,0,0,.22)}
.mf-karta.mf-obraz-prawo{flex-direction:row-reverse}
.mf-karta.mf-obraz-gora{flex-direction:column}
.mf-obraz{flex:0 0 42%;min-height:220px;background-size:cover;background-position:center}
.mf-obraz-gora .mf-obraz{flex:0 0 auto;min-height:0;height:180px}
.mf-karta.mf-obraz-tlo{background-size:cover;background-position:center}
.mf-tresc{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:12px;padding:40px 32px 28px}
.mf-flyout .mf-tresc{padding:32px 22px 20px}
.mf-obraz-tlo .mf-tresc{margin:20px;padding:28px 24px 20px;background:color-mix(in srgb,var(--mf-tlo) 88%,transparent);border-radius:calc(var(--mf-radius) * .75)}
.mf-blok{margin:0}
.mf-naglowek{margin:0;font-weight:700;line-height:1.12;letter-spacing:-.01em;color:inherit;font-family:inherit;overflow-wrap:anywhere}
.mf-tekst{margin:0;font-size:15px;line-height:1.5;opacity:.82;white-space:pre-line;overflow-wrap:anywhere}
.mf-img{display:block;max-width:100%;height:auto;border-radius:calc(var(--mf-radius) * .5);margin:0 auto}
.mf-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.mf-pole{display:block;width:100%;height:48px;padding:0 14px;font:inherit;font-size:16px;color:var(--mf-tekst);background:color-mix(in srgb,var(--mf-tlo) 92%,var(--mf-tekst));border:1px solid color-mix(in srgb,var(--mf-tekst) 22%,transparent);border-radius:calc(var(--mf-radius) * .6);outline:none;text-align:left;-webkit-appearance:none;appearance:none}
.mf-pole::placeholder{color:color-mix(in srgb,var(--mf-tekst) 50%,transparent)}
.mf-pole:focus{border-color:var(--mf-przycisk);box-shadow:0 0 0 3px color-mix(in srgb,var(--mf-przycisk) 25%,transparent)}
.mf-pole[aria-invalid=true]{border-color:#d0342c}
.mf-pytanie{border:0;margin:0;padding:0;min-width:0;text-align:left}
.mf-pytanie legend{padding:0;margin:0 0 8px;font-size:14px;font-weight:600;text-align:var(--mf-wyr);width:100%}
.mf-opcje{display:flex;flex-wrap:wrap;gap:8px;justify-content:var(--mf-wyr-flex)}
.mf-opcja{position:relative;display:inline-flex;align-items:center;min-height:40px;padding:8px 14px;font-size:14px;border:1px solid color-mix(in srgb,var(--mf-tekst) 22%,transparent);border-radius:999px;cursor:pointer;user-select:none}
.mf-opcja input{position:absolute;opacity:0;pointer-events:none}
.mf-opcja:has(input:checked){background:var(--mf-przycisk);color:var(--mf-przycisk-tekst);border-color:var(--mf-przycisk)}
.mf-opcja:has(input:focus-visible){outline:2px solid var(--mf-przycisk);outline-offset:2px}
.mf-zgoda{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.45;text-align:left;opacity:.86}
.mf-zgoda input{flex:none;width:18px;height:18px;margin:0;accent-color:var(--mf-przycisk);cursor:pointer}
.mf-zgoda label{cursor:pointer;white-space:pre-line}
.mf-zgoda a{color:inherit;text-decoration:underline}
.mf-przycisk{display:flex;align-items:center;justify-content:center;width:100%;min-height:50px;padding:10px 18px;font:inherit;font-size:16px;font-weight:650;color:var(--mf-przycisk-tekst);background:var(--mf-przycisk);border:0;border-radius:calc(var(--mf-radius) * .6);cursor:pointer;transition:filter .15s}
.mf-przycisk:hover{filter:brightness(1.08)}
.mf-przycisk:focus-visible,.mf-nie:focus-visible,.mf-zamknij:focus-visible,.mf-teaser:focus-visible{outline:2px solid var(--mf-przycisk);outline-offset:2px}
.mf-przycisk[disabled]{opacity:.6;cursor:default}
.mf-przycisk.mf-drugi{background:transparent;color:inherit;border:1px solid color-mix(in srgb,var(--mf-tekst) 25%,transparent)}
.mf-nie{display:block;margin:0 auto;padding:6px;font:inherit;font-size:13px;color:inherit;opacity:.7;background:none;border:0;text-decoration:underline;cursor:pointer}
.mf-kod{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 12px 12px 18px;border:2px dashed color-mix(in srgb,var(--mf-tekst) 35%,transparent);border-radius:calc(var(--mf-radius) * .6)}
.mf-kod-wartosc{font-size:22px;font-weight:700;letter-spacing:.08em;user-select:all;overflow-wrap:anywhere;text-align:left}
.mf-kod-opis{margin:0;font-size:13px;opacity:.7}
.mf-kopiuj{flex:none;min-height:38px;padding:0 14px;font:inherit;font-size:13px;font-weight:600;color:var(--mf-przycisk-tekst);background:var(--mf-przycisk);border:0;border-radius:calc(var(--mf-radius) * .5);cursor:pointer}
.mf-blad{margin:0;font-size:13px;color:#d0342c;text-align:left}
.mf-zamknij{position:absolute;top:8px;right:8px;z-index:2;display:grid;place-items:center;width:40px;height:40px;padding:0;font:inherit;font-size:24px;line-height:1;color:inherit;opacity:.7;background:color-mix(in srgb,var(--mf-tlo) 70%,transparent);border:0;border-radius:999px;cursor:pointer}
.mf-zamknij:hover{opacity:1}
.mf-teaser{position:fixed;bottom:20px;z-index:2147482999;display:flex;align-items:center;gap:8px;min-height:44px;padding:0 6px 0 18px;font-family:var(--mf-font);font-size:15px;font-weight:650;color:var(--mf-przycisk-tekst);background:var(--mf-przycisk);border-radius:999px;box-shadow:0 10px 30px rgba(0,0,0,.25);animation:mf-wysun .22s ease-out}
.mf-teaser.mf-rog-prawo{right:20px}.mf-teaser.mf-rog-lewo{left:20px}
.mf-teaser button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:10px 4px}
.mf-teaser .mf-teaser-x{display:grid;place-items:center;width:36px;height:36px;padding:0;font-size:18px;opacity:.75;border-radius:999px}
@keyframes mf-wej{from{opacity:0}to{opacity:1}}
@keyframes mf-wysun{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.mf-nakladka,.mf-flyout,.mf-teaser{animation:none}}
@container mf (max-width:560px){
.mf-karta.mf-obraz-lewo,.mf-karta.mf-obraz-prawo{flex-direction:column}
.mf-obraz{flex:0 0 auto;min-height:0;height:150px}
.mf-tresc{padding:36px 20px 20px}
.mf-flyout,.mf-teaser{bottom:12px}
}
`;

/** Zmienne CSS formularza z zwalidowanego stylu (kolory #rrggbb, liczby z zakresów). */
export function zmienneStylu(s: StylFormularza): Record<string, string> {
  return {
    "--mf-tlo": s.tlo,
    "--mf-tekst": s.kolorTekstu,
    "--mf-przycisk": s.kolorPrzycisku,
    "--mf-przycisk-tekst": s.kolorTekstuPrzycisku,
    "--mf-radius": `${s.zaokraglenie}px`,
    "--mf-szer": `${s.obrazPozycja === "lewo" || s.obrazPozycja === "prawo" ? Math.max(s.szerokosc, 560) : s.szerokosc}px`,
    "--mf-font": stosKroju(s.kroj),
    "--mf-wyr": s.wyrownanie === "srodek" ? "center" : "left",
    "--mf-wyr-flex": s.wyrownanie === "srodek" ? "center" : "flex-start",
    "--mf-nakladka": String(s.nakladka / 100),
  };
}
