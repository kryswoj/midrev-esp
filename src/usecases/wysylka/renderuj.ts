import { config } from "../../config";

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

export function przepiszLinki(html: string, clickToken: string): Zlinkowany {
  const linki: string[] = [];
  const baza = config().APP_URL;
  const przepisany = html.replace(
    /href="(https?:\/\/[^"]+)"/g,
    (_pelny, url: string) => {
      const indeks = linki.push(url) - 1;
      return `href="${baza}/r/${clickToken}?l=${indeks}"`;
    },
  );
  return { html: przepisany, linki };
}

export function zlozWiadomosc(opcje: {
  trescHtml: string;
  clickToken: string;
  unsubscribeToken: string;
  nazwaSklepu: string;
}): Zlinkowany {
  const baza = config().APP_URL;
  const { html, linki } = przepiszLinki(opcje.trescHtml, opcje.clickToken);
  const stopka = `
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;color:#8a8a8a;font:12px/1.6 -apple-system,Segoe UI,sans-serif">
    <p style="margin:0 0 4px">Otrzymujesz tę wiadomość, bo wyraziłaś/eś zgodę na komunikację od ${opcje.nazwaSklepu}.</p>
    <p style="margin:0"><a href="${baza}/u/${opcje.unsubscribeToken}" style="color:#8a8a8a">Wypisz się jednym kliknięciem</a></p>
  </div>`;
  const pelny = `<!doctype html><html lang="pl"><body style="margin:0;padding:24px;background:#f5f5f5">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;font:14px/1.6 -apple-system,Segoe UI,sans-serif;color:#1c1c1e">
  ${html}
  ${stopka}
  </div></body></html>`;
  return { html: pelny, linki };
}
