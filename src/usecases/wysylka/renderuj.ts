import { createHash } from "node:crypto";
import { adresSledzenia } from "../../config";
import { sanityzujAdresy } from "../../domain/email/szablon";

/**
 * Render treści kampanii do finalnego HTML wiadomości.
 *
 * Dwie twarde zasady:
 * 1. Każdy link przechodzi przez własną domenę z tokenem PER ODBIORCA i wiadomość
 *    (AD-33, FR54). To jest fundament atrybucji: generyczny UTM nie mówi, KTO kliknął.
 * 2. Stopka z danymi nadawcy i wypisaniem jest doklejana przez system, nie przez
 *    autora treści (FR50, FR53). Autor nie może jej zapomnieć ani usunąć.
 */
export interface Zlinkowany {
  html: string;
  linki: string[];
}

/**
 * Token pixela otwarć, wyprowadzony z tokena kliknięć tej samej wiadomości.
 *
 * Ta funkcja MUSI dawać dokładnie to, co liczy kolumna generowana `messages.open_token`
 * z migracji 0016 — inaczej pixel w mailu wskazywałby na adres, którego trasa nie
 * znajdzie, a otwarcia po cichu przestałyby się liczyć. Test sprawdza tę równość wobec
 * BAZY, a nie wobec drugiego wywołania tej samej funkcji.
 *
 * Dlaczego osobny token, a nie po prostu `clickToken`: adres pixela widzi każdy
 * pośrednik, który pobiera obrazek za odbiorcę (proxy obrazków, skaner bramki). Gdyby
 * niósł token kliknięć, dałoby się z niego złożyć `/r/<token>?l=0` i wstrzyknąć
 * kliknięcie do atrybucji przychodu. sha256 jest jednokierunkowa, więc ta droga jest
 * zamknięta.
 */
export function tokenOtwarcia(clickToken: string): string {
  return createHash("sha256").update(`otwarcie:${clickToken}`).digest("hex");
}

/** Adres pixela otwarć dla wiadomości o podanym tokenie kliknięć. */
export function adresPixela(clickToken: string): string {
  // `.gif` na końcu jest ozdobą adresu (część filtrów pocztowych patrzy krzywo na
  // obrazek bez rozszerzenia); trasa obcina je przed wyszukaniem tokena.
  return `${adresSledzenia()}/api/o/${tokenOtwarcia(clickToken)}.gif`;
}

/** Tekst od operatora (nazwa sklepu) wchodzi do HTML maila wyłącznie po escapowaniu. */
export function escapujHtml(tekst: string): string {
  return String(tekst).replace(/[&<>"']/g, (z) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[z]!);
}

/**
 * Przepisuje KAŻDY link http(s) na własną domenę: `href="…"`, `href='…'` i `href=…`
 * bez cudzysłowu (edytory i szablony z zewnątrz produkują wszystkie trzy). Wcześniej
 * łapany był tylko podwójny cudzysłów, więc link w pojedynczym wychodził bez śledzenia
 * i lista kontrolna pokazywała „brak linku" w mailu, który link miał.
 */
const ENCJE_ADRESU: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

/** Encje HTML w wartości atrybutu href (nazwane podstawowe i numeryczne) -> znaki. */
export function dekodujEncjeAdresu(url: string): string {
  return url.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|quot|apos|lt|gt);/gi, (calosc, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : calosc;
    }
    return ENCJE_ADRESU[k] ?? calosc;
  });
}

export function przepiszLinki(html: string, clickToken: string): Zlinkowany {
  const linki: string[] = [];
  // domena ŚLEDZENIA (TRACKING_URL, bez niej APP_URL): adres panelu nie leci w mailach
  const baza = adresSledzenia();
  // Linki spoza http(s) regex ponizej zostawia w spokoju, wiec `javascript:` (takze
  // zakodowany encjami) musi zniknac PRZED nim (AD-43), niezaleznie od zrodla tresci.
  // Lagodnie: jawne zle schematy odpadaja, wzgledne zostaja jak dotad (tresc po zmiennych
  // przeszla juz scisla sanityzacje w renderujHtml).
  const przepisany = sanityzujAdresy(html, { scisle: false }).replace(
    /href\s*=\s*(?:"(https?:\/\/[^"]*)"|'(https?:\/\/[^']*)'|(https?:\/\/[^\s>"']+))/gi,
    (_pelny, wDwoch: string | undefined, wJednym: string | undefined, bez: string | undefined) => {
      // Cel zapisujemy tak, jak zobaczy go przeglądarka: atrybut HTML dekoduje encje. Zmienne
      // liquid w adresie są escapowane (`=` -> `&#61;`, `&` -> `&amp;`), a link z koszyka
      // (`?mrv_cart=…`) zapisany dosłownie prowadziłby z /r na zepsuty adres (E2E Woo).
      const url = dekodujEncjeAdresu(wDwoch ?? wJednym ?? bez ?? "");
      const indeks = linki.push(url) - 1;
      return `href="${baza}/r/${clickToken}?l=${indeks}"`;
    },
  );
  return { html: przepisany, linki };
}

/** Dane nadawcy do stopki (0029, dane-nadawcy.ts). Brak pól = linia się nie pojawia. */
export interface DaneStopki {
  firma: string | null;
  adres: string | null;
  nip: string | null;
}

/** Linia identyfikacji nadawcy w stopce: „Firma · adres · NIP …" (escapowane). Pusta, gdy brak danych. */
export function liniaNadawcy(d: DaneStopki | null | undefined): string {
  if (!d) return "";
  const czesci = [d.firma, d.adres?.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(", "), d.nip ? `NIP ${d.nip}` : null]
    .map((c) => (c ?? "").trim())
    .filter(Boolean)
    .map(escapujHtml);
  return czesci.length ? `\n    <p style="margin:0 0 4px">${czesci.join(" · ")}</p>` : "";
}

export function zlozWiadomosc(opcje: {
  trescHtml: string;
  clickToken: string;
  unsubscribeToken: string;
  nazwaSklepu: string;
  /**
   * Dane nadawcy do stopki (nazwa firmy, adres pocztowy, NIP). Bez nich stopka zostaje
   * w dotychczasowej postaci; lista kontrolna kampanii blokuje wysyłkę bez adresu.
   */
  nadawca?: DaneStopki | null;
  /**
   * Zgoda na śledzenie kliknięć, rozstrzygnięta przy budowie wiadomości (Blok A, A5).
   * Gdy `false`, linki zostają ORYGINALNE, a snapshot `linki` jest pusty — odbiorca
   * klika prosto w sklep, a `/r` nie ma czego mu podstawić. Domyślne `true` zachowuje
   * dotychczasowe zachowanie i nie zmienia nic tam, gdzie tej decyzji jeszcze nie ma.
   */
  sledzKlikniecia?: boolean;
  /**
   * Zgoda na śledzenie OTWARĆ, rozstrzygnięta przy budowie wiadomości (Blok A, A5).
   * Gdy `false`, pixel w ogóle nie trafia do treści — i o to chodzi. Bramka po stronie
   * trasy (`zapiszZaangazowanie` czyta migawkę `open_tracking_allowed`) pilnuje danych,
   * ale samo POBRANIE obrazka jest już śledzeniem: mail bez zgody ma wyjść bez pixela,
   * a nie z pixelem, który my potem grzecznie zignorujemy.
   *
   * Domyślne `true` jest tą samą konwencją co przy `sledzKlikniecia`: wołający, który
   * o zgodzie nie wie, dostaje dotychczasowe zachowanie. Ścieżka wysyłki kampanii ma
   * tę decyzję policzoną (`zgody.otwarcia`) i MUSI ją tu przekazać jawnie — bez tego
   * odbiorca z wycofaną zgodą na otwarcia dostanie pixel, którego nie powinien dostać.
   */
  sledzOtwarcia?: boolean;
}): Zlinkowany {
  const baza = adresSledzenia();
  // bez sledzenia klikniec linki zostaja oryginalne, ale niebezpieczne schematy i tak znikaja
  const { html, linki } =
    opcje.sledzKlikniecia === false
      ? { html: sanityzujAdresy(opcje.trescHtml, { scisle: false }), linki: [] as string[] }
      : przepiszLinki(opcje.trescHtml, opcje.clickToken);
  const stopka = `
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;color:#8a8a8a;font:12px/1.6 -apple-system,Segoe UI,sans-serif">
    <p style="margin:0 0 4px">Otrzymujesz tę wiadomość, bo wyraziłaś/eś zgodę na komunikację od ${escapujHtml(opcje.nazwaSklepu)}.</p>${liniaNadawcy(opcje.nadawca)}
    <p style="margin:0"><a href="${baza}/u/${opcje.unsubscribeToken}" style="color:#8a8a8a">Wypisz się jednym kliknięciem</a></p>
  </div>`;
  // Pixel na samym końcu ciała, POZA kontenerem treści: nie wpływa na układ, a klient
  // pocztowy, który obcina długie maile ("[Message clipped]" w Gmailu), obcina go razem
  // z końcem treści — czyli nie zapisujemy otwarcia komuś, kto maila nie rozwinął.
  const pixel =
    opcje.sledzOtwarcia === false
      ? ""
      : `<img src="${adresPixela(opcje.clickToken)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;overflow:hidden">`;
  const pelny = `<!doctype html><html lang="pl"><body style="margin:0;padding:24px;background:#f5f5f5">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;font:14px/1.6 -apple-system,Segoe UI,sans-serif;color:#1c1c1e">
  ${html}
  ${stopka}
  </div>${pixel}</body></html>`;
  return { html: pelny, linki };
}
