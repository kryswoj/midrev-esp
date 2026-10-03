import {
  bezpiecznyKolor,
  bezpiecznyUrl,
  domknijSurowyHtml,
  escapuj,
  KROJE,
  przykladoweDane,
  sanityzujTekst,
  SIECI,
  STYLE_DOMYSLNE,
  SZEROKOSC_TRESCI,
  tekstNaTle,
  tekstPusty,
  ROZMIARY_PRZYCISKU,
  WARIANTY_TEKSTU,
  type Blok,
  type BlokTypu,
  type DokumentMaila,
  type Kolumna,
  type StyleMaila,
} from "../../domain/email/bloki";

/**
 * Render dokumentu bloków do HTML-a maila.
 *
 * Wynik trafia do `campaigns.content.html`, skąd czyta go silnik wysyłki (`zlozWiadomosc`).
 * Silnik OPAKOWUJE tę treść własnym dokumentem, przepisuje linki pod śledzenie i dokleja
 * stopkę z wypisem. Z tego wynikają zasady tego pliku:
 *
 *  1. Wynik to FRAGMENT, nie dokument. Bez <html>/<head>/<body> — silnik ma już swoje,
 *     a zagnieżdżony dokument klienci pocztowi „naprawiają" każdy inaczej. `<style>`
 *     i `<meta>` stoją na początku fragmentu; tam czytają je Apple Mail, iOS, Outlook.com
 *     i Gmail (Gmail obsługuje <style> także poza <head>).
 *  2. Każdy link to `href="https://…"` w PODWÓJNYM cudzysłowie, z surowym `&`. Tylko taki
 *     zapis łapie `przepiszLinki`, a cel zapisany w migawce ma być dokładnie adresem sklepu.
 *  3. Zero stopki z wypisem. Blok „Stopka" niesie dane firmy; link wypisu dokleja silnik
 *     i nie da się go ani zapomnieć, ani zdublować.
 *  4. Zero JS, style inline, układ na tabelach, przycisk kuloodporny (VML dla Outlooka),
 *     obrazy tylko z bezwzględnym adresem http(s) i z `alt`.
 *
 * Czysta funkcja: bez bazy, bez configu. Ten sam kod renderuje podgląd w przeglądarce.
 */

export interface WynikRenderu {
  html: string;
  /** uwagi dla operatora: rzeczy, które nie zablokują zapisu, ale psują maila */
  uwagi: string[];
}

interface Kontekst {
  s: StyleMaila;
  font: string;
  szerTresci: number;
  uwagi: string[];
  /** treść automatyzacji: zmienne liquid (koszyk, produkt ze zdarzenia) podstawi silnik flow */
  dynamiczne: boolean;
}

const PRZERWA = "&#847;&zwnj;&nbsp;".repeat(40);

export { tekstNaTle };

function styleLinkow(html: string, kolor: string): string {
  return html.replace(/<a href="/g, `<a style="color:${kolor};text-decoration:underline" href="`);
}

function wyrownanieTabeli(w: string): string {
  return w === "left" ? "left" : w === "right" ? "right" : "center";
}

function przycisk(
  k: Kontekst,
  o: { tekst: string; link: string; tlo: string; kolor: string; promien: number; rozmiar: "maly" | "sredni" | "duzy"; pelna: boolean; wyrownanie: string; szerMax: number },
): string {
  const wymiary = ROZMIARY_PRZYCISKU[o.rozmiar];
  const wys = wymiary.fs + 2 * wymiary.py + 4;
  const tekst = escapuj(o.tekst.trim() || "Przycisk");
  // przycisk może prowadzić też do mailto: (panel to dopuszcza, render musi tak samo);
  // silnik przepisuje na śledzone tylko http(s), mailto zostaje jak jest
  const href = bezpiecznyUrl(o.link, "www-lub-mail");
  if (!href) {
    const napis = o.tekst.trim() || "Przycisk";
    k.uwagi.push(
      o.link.trim()
        ? `Przycisk „${napis}" ma niepoprawny link. Wpisz pełny adres strony (https://…) albo adres e-mail (mailto:…).`
        : `Przycisk „${napis}" nie ma linku, więc w mailu nie da się go kliknąć.`,
    );
  }
  // szerokość VML szacowana z długości napisu: Outlook nie umie „dopasuj do treści"
  const szer = o.pelna
    ? o.szerMax
    : Math.min(o.szerMax, Math.max(120, Math.round(o.tekst.trim().length * wymiary.fs * 0.6 + 2 * wymiary.px)));
  const luk = Math.min(50, Math.round((o.promien / wys) * 100));
  const stylA =
    `display:${o.pelna ? "block" : "inline-block"};padding:${wymiary.py}px ${wymiary.px}px;font-family:${k.font};` +
    `font-size:${wymiary.fs}px;line-height:${wymiary.fs + 4}px;font-weight:600;color:${o.kolor};text-decoration:none;` +
    `border-radius:${o.promien}px;background-color:${o.tlo};text-align:center;mso-hide:all`;
  const vml = href
    ? `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:${wys}px;v-text-anchor:middle;width:${szer}px;" arcsize="${luk}%" stroke="f" fillcolor="${o.tlo}"><w:anchorlock/><center style="color:${o.kolor};font-family:Arial,sans-serif;font-size:${wymiary.fs}px;font-weight:bold;">${tekst}</center></v:roundrect><![endif]-->`
    : "";
  const a = href
    ? `<!--[if !mso]><!--><a href="${href}" target="_blank" style="${stylA}">${tekst}</a><!--<![endif]-->`
    : `<span style="${stylA.replace("mso-hide:all", "")}">${tekst}</span>`;
  return (
    `<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="${wyrownanieTabeli(o.wyrownanie)}"${o.pelna ? ' width="100%"' : ""} style="border-collapse:separate${o.pelna ? ";width:100%" : ""}">` +
    `<tr><td align="center" bgcolor="${o.tlo}" style="border-radius:${o.promien}px;background-color:${o.tlo}">${vml}${a}</td></tr></table>`
  );
}

function obraz(k: Kontekst, o: { src: string; alt: string; link: string; szerPx: number; promien: number; wyrownanie: string; opis: string }): string {
  const src = bezpiecznyUrl(o.src);
  if (!src) {
    if (o.src.trim()) k.uwagi.push(`${o.opis}: adres obrazu musi zaczynać się od https:// (wgraj plik albo wybierz z biblioteki), inaczej w mailu go nie będzie.`);
    else k.uwagi.push(`${o.opis}: nie wybrano obrazu, więc w mailu go nie będzie.`);
    return "";
  }
  if (!o.alt.trim()) k.uwagi.push(`${o.opis}: brak opisu obrazu. Część skrzynek nie pokazuje obrazków od razu i wtedy widać właśnie opis.`);
  const img =
    `<img src="${src}" alt="${escapuj(o.alt)}" width="${o.szerPx}" style="display:block;width:100%;max-width:${o.szerPx}px;height:auto;border:0;outline:none;text-decoration:none;` +
    `${o.promien ? `border-radius:${o.promien}px;` : ""}${o.wyrownanie === "center" ? "margin:0 auto;" : o.wyrownanie === "right" ? "margin-left:auto;" : ""}" class="mr-img">`;
  const href = bezpiecznyUrl(o.link);
  if (o.link.trim() && !href) k.uwagi.push(`${o.opis}: link po kliknięciu w obraz musi być pełnym adresem strony (https://…).`);
  return href ? `<a href="${href}" target="_blank" style="text-decoration:none">${img}</a>` : img;
}

const WARIANTY = WARIANTY_TEKSTU;

function tekstSformatowany(k: Kontekst, html: string, o: { fs: number; lh: number; fw: number; kolor: string; wyrownanie: string; kolorLinku: string }): string {
  const czysty = styleLinkow(sanityzujTekst(html), o.kolorLinku);
  return `<div style="margin:0;font-family:${k.font};font-size:${o.fs}px;line-height:${o.lh}px;font-weight:${o.fw};color:${o.kolor};text-align:${wyrownanieTabeli(o.wyrownanie)}">${czysty}</div>`;
}

function kolumna(k: Kontekst, kol: Kolumna, szerPx: number, wyrownanie: string, kolorTekstu: string, nr: string): string {
  const czesci: string[] = [];
  if (kol.obrazUrl.trim() || kol.obrazAlt.trim()) {
    const img = obraz(k, { src: kol.obrazUrl, alt: kol.obrazAlt, link: kol.przyciskLink, szerPx, promien: 0, wyrownanie: "center", opis: `Kolumna ${nr}` });
    if (img) czesci.push(`<div style="margin:0 0 12px">${img}</div>`);
  }
  if (!tekstPusty(sanityzujTekst(kol.html))) {
    czesci.push(tekstSformatowany(k, kol.html, { fs: 15, lh: 23, fw: 400, kolor: kolorTekstu, wyrownanie, kolorLinku: k.s.kolorMarki }));
  }
  if (kol.przyciskTekst.trim()) {
    czesci.push(
      `<div style="margin:12px 0 0">${przycisk(k, { tekst: kol.przyciskTekst, link: kol.przyciskLink, tlo: k.s.kolorMarki, kolor: tekstNaTle(k.s.kolorMarki), promien: 8, rozmiar: "maly", pelna: false, wyrownanie, szerMax: szerPx })}</div>`,
    );
  }
  return czesci.join("");
}

function trescBloku(k: Kontekst, blok: Blok, tloBloku: string): string {
  const szer = Math.max(80, k.szerTresci - 2 * blok.boki);
  const kolorNaTle = blok.tlo ? tekstNaTle(tloBloku, "#ffffff", k.s.kolorTekstu) : k.s.kolorTekstu;
  switch (blok.typ) {
    case "naglowek": {
      const logo = blok.logoUrl.trim()
        ? obraz(k, { src: blok.logoUrl, alt: blok.logoAlt || blok.nazwa, link: blok.link, szerPx: Math.min(blok.logoSzerokosc, szer), promien: 0, wyrownanie: blok.wyrownanie, opis: "Nagłówek (logo)" })
        : "";
      if (logo) return logo;
      // Bez logo i bez nazwy nagłówek znika z maila. Kiedyś wstawiał „Twój sklep": odbiorca
      // dostawał wtedy maila od sklepu bez nazwy, podpisanego cudzą atrapą (audyt UX P0-2).
      if (!blok.nazwa.trim()) {
        k.uwagi.push("Nagłówek nie ma logo ani nazwy sklepu, więc w mailu go nie będzie.");
        return "";
      }
      const nazwa = escapuj(blok.nazwa.trim());
      const href = bezpiecznyUrl(blok.link);
      const napis = `<div style="margin:0;font-family:${k.font};font-size:22px;line-height:28px;font-weight:700;letter-spacing:-0.01em;color:${kolorNaTle};text-align:${wyrownanieTabeli(blok.wyrownanie)}">${href ? `<a href="${href}" target="_blank" style="color:${kolorNaTle};text-decoration:none">${nazwa}</a>` : nazwa}</div>`;
      return napis;
    }
    case "tekst": {
      const w = WARIANTY[blok.wariant];
      const kolor = bezpiecznyKolor(blok.kolor, kolorNaTle);
      return tekstSformatowany(k, blok.html, { ...w, kolor, wyrownanie: blok.wyrownanie, kolorLinku: blok.tlo ? kolor : k.s.kolorMarki });
    }
    case "obraz":
      return obraz(k, { src: blok.src, alt: blok.alt, link: blok.link, szerPx: Math.round((szer * blok.szerokosc) / 100), promien: blok.zaokraglenie, wyrownanie: blok.wyrownanie, opis: "Obraz" });
    case "przycisk": {
      const tlo = bezpiecznyKolor(blok.kolorTla, k.s.kolorMarki);
      return przycisk(k, { tekst: blok.tekst, link: blok.link, tlo, kolor: bezpiecznyKolor(blok.kolorTekstu, tekstNaTle(tlo)), promien: blok.zaokraglenie, rozmiar: blok.rozmiar, pelna: blok.pelnaSzerokosc, wyrownanie: blok.wyrownanie, szerMax: szer });
    }
    case "separator":
      return (
        `<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="${blok.szerokosc}%" align="center" style="width:${blok.szerokosc}%">` +
        `<tr><td style="border-top:${blok.grubosc}px ${blok.styl} ${bezpiecznyKolor(blok.kolor, "#e3e6ea")};font-size:1px;line-height:1px;height:1px">&nbsp;</td></tr></table>`
      );
    case "odstep":
      return `<div style="height:${blok.wysokosc}px;line-height:${blok.wysokosc}px;font-size:1px">&nbsp;</div>`;
    case "kolumny": {
      const [pl, pp] = blok.proporcja === "33-67" ? [33.33, 66.67] : blok.proporcja === "67-33" ? [66.67, 33.33] : [50, 50];
      const pol = Math.round(blok.odstepKolumn / 2);
      const szerL = Math.round((szer * pl) / 100) - pol;
      const szerP = Math.round((szer * pp) / 100) - pol;
      const lewa = kolumna(k, blok.lewa, szerL, blok.wyrownanie, kolorNaTle, "lewa");
      const prawa = kolumna(k, blok.prawa, szerP, blok.wyrownanie, kolorNaTle, "prawa");
      // Układ hybrydowy: dwa inline-blocki w procentach (działa także tam, gdzie media
      // query nie działa), media query zamienia je w stos na telefonie, a Outlook
      // dostaje prawdziwą tabelę przez komentarz warunkowy.
      return (
        `<div style="font-size:0;line-height:0;text-align:left">` +
        `<!--[if mso]><table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%"><tr><td width="${pl}%" valign="top"><![endif]-->` +
        `<div class="mr-kol" style="display:inline-block;width:${pl}%;vertical-align:top;font-size:16px;line-height:normal"><div class="mr-kol-l" style="padding-right:${pol}px">${lewa}</div></div>` +
        `<!--[if mso]></td><td width="${pp}%" valign="top"><![endif]-->` +
        `<div class="mr-kol" style="display:inline-block;width:${pp}%;vertical-align:top;font-size:16px;line-height:normal"><div class="mr-kol-p" style="padding-left:${pol}px">${prawa}</div></div>` +
        `<!--[if mso]></td></tr></table><![endif]-->` +
        `</div>`
      );
    }
    case "produkt": {
      const czesci: string[] = [];
      const img = obraz(k, { src: blok.obrazUrl, alt: blok.obrazAlt || blok.nazwa, link: blok.link, szerPx: Math.min(szer, 360), promien: 8, wyrownanie: blok.wyrownanie, opis: `Produkt „${blok.nazwa}"` });
      if (img) czesci.push(`<div style="margin:0 0 16px">${img}</div>`);
      const al = wyrownanieTabeli(blok.wyrownanie);
      czesci.push(`<div style="margin:0 0 6px;font-family:${k.font};font-size:18px;line-height:26px;font-weight:600;color:${kolorNaTle};text-align:${al}">${escapuj(blok.nazwa)}</div>`);
      if (blok.opis.trim()) {
        czesci.push(`<div style="margin:0 0 10px;font-family:${k.font};font-size:15px;line-height:22px;color:${kolorNaTle};opacity:0.8;text-align:${al}">${escapuj(blok.opis)}</div>`);
      }
      if (blok.cena.trim() || blok.cenaPrzed.trim()) {
        czesci.push(
          `<div style="margin:0 0 14px;font-family:${k.font};font-size:18px;line-height:24px;text-align:${al}">` +
            (blok.cenaPrzed.trim() ? `<span style="color:#868d97;text-decoration:line-through;font-size:15px">${escapuj(blok.cenaPrzed)}</span>&nbsp;&nbsp;` : "") +
            `<span style="color:${blok.cenaPrzed.trim() ? k.s.kolorMarki : kolorNaTle};font-weight:700">${escapuj(blok.cena)}</span></div>`,
        );
      }
      if (blok.przyciskTekst.trim()) {
        czesci.push(przycisk(k, { tekst: blok.przyciskTekst, link: blok.link, tlo: k.s.kolorMarki, kolor: tekstNaTle(k.s.kolorMarki), promien: 8, rozmiar: "sredni", pelna: false, wyrownanie: blok.wyrownanie, szerMax: szer }));
      }
      return czesci.join("");
    }
    case "koszyk": {
      // Lista wstawiana PRZY WYSYŁCE (liquid): `cart` = koszyk osoby z `carts` (porzucony koszyk
      // i checkout), `products` = produkt(y) ze zdarzenia wyzwalającego (przeglądany produkt).
      // Kontekst buduje silnik automatyzacji (przetworz-zdarzenia.ts); każda wartość jest
      // escapowana przez liquid, adresy poza http(s) usuwa sanityzacja po renderze. Bez
      // koszyka (kampania, koszyk po zakupie) blok znika w całości.
      if (!k.dynamiczne) {
        // kampania nie ma osoby ani zdarzenia, a jej treść nie przechodzi przez liquid:
        // surowe znaczniki trafiłyby do odbiorców
        k.uwagi.push("Blok „Produkty z koszyka” działa tylko w mailach automatyzacji, w kampanii go nie będzie.");
        return "";
      }
      const zrodlo = blok.zrodlo === "koszyk" ? "cart" : "products";
      const al = wyrownanieTabeli(blok.wyrownanie);
      const lista = blok.zrodlo === "koszyk" ? "cart.items" : "products.items";
      const wiersz =
        `<tr>` +
        `<td width="88" valign="top" style="padding:0 16px 16px 0">{% if p.image_url %}<a href="{{ p.url }}" target="_blank"><img src="{{ p.image_url }}" alt="{{ p.title }}" width="80" style="display:block;width:80px;height:auto;border:0;border-radius:8px"></a>{% endif %}</td>` +
        `<td valign="top" style="padding:0 0 16px;font-family:${k.font};font-size:15px;line-height:22px;color:${kolorNaTle};text-align:left">` +
        `<a href="{{ p.url }}" target="_blank" style="color:${kolorNaTle};font-weight:600;text-decoration:none">{{ p.title }}</a>` +
        (blok.pokazCeny ? `<div style="opacity:0.8">{% if p.qty > 1 %}{{ p.qty }} × {% endif %}{{ p.price }}</div>` : "") +
        `</td></tr>`;
      const tytul = blok.tytul.trim()
        ? `<div style="margin:0 0 14px;font-family:${k.font};font-size:18px;line-height:26px;font-weight:600;color:${kolorNaTle};text-align:${al}">${escapuj(blok.tytul)}</div>`
        : "";
      // przycisk: link z koszyka (link powrotu) albo z produktu; wstawiany liquidem, więc
      // poza `bezpiecznyUrl` panelu - sanityzacja po renderze zostawia tylko http(s)
      const cel = blok.zrodlo === "koszyk" ? "{{ cart.url }}" : "{{ products.url }}";
      const guzik = blok.przyciskTekst.trim()
        ? `{% if ${zrodlo}.url %}<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="${al}" style="border-collapse:separate"><tr><td align="center" bgcolor="${k.s.kolorMarki}" style="border-radius:8px;background-color:${k.s.kolorMarki}">` +
          `<a href="${cel}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${k.font};font-size:16px;line-height:20px;font-weight:600;color:${tekstNaTle(k.s.kolorMarki)};text-decoration:none;border-radius:8px;background-color:${k.s.kolorMarki}">${escapuj(blok.przyciskTekst)}</a>` +
          `</td></tr></table>{% endif %}`
        : "";
      return (
        `{% if ${zrodlo} and ${lista}.size > 0 %}${tytul}` +
        `<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse">` +
        `{% for p in ${lista} limit:${blok.maks} %}${wiersz}{% endfor %}</table>${guzik}{% endif %}`
      );
    }
    case "kod": {
      const ramka = bezpiecznyKolor(blok.kolorRamki, k.s.kolorMarki);
      const tlo = bezpiecznyKolor(blok.tloKodu, "#f4eefc");
      const napis = tekstNaTle(tlo, "#ffffff", "#1f2328");
      return (
        `<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" style="border-collapse:separate">` +
        `<tr><td align="center" bgcolor="${tlo}" style="padding:20px 16px;border:2px dashed ${ramka};border-radius:10px;background-color:${tlo};text-align:center">` +
        (blok.tytul.trim() ? `<div style="margin:0 0 6px;font-family:${k.font};font-size:14px;line-height:20px;font-weight:600;color:${napis}">${escapuj(blok.tytul)}</div>` : "") +
        `<div style="margin:0;font-family:'Courier New',Courier,monospace;font-size:28px;line-height:36px;font-weight:700;letter-spacing:3px;color:${ramka}">${escapuj(blok.kod || "KOD")}</div>` +
        (blok.opis.trim() ? `<div style="margin:6px 0 0;font-family:${k.font};font-size:13px;line-height:19px;color:${napis};opacity:0.8">${escapuj(blok.opis)}</div>` : "") +
        `</td></tr></table>`
      );
    }
    case "social": {
      const linki = blok.linki
        .map((l) => ({ ...l, href: bezpiecznyUrl(l.url) }))
        .filter((l) => {
          if (!l.href) k.uwagi.push(`Social: profil ${SIECI[l.siec].etykieta} nie ma linku, więc w mailu go nie będzie.`);
          return Boolean(l.href);
        });
      if (!linki.length) return "";
      const al = wyrownanieTabeli(blok.wyrownanie);
      const pastylki = linki
        .map((l) => {
          const siec = SIECI[l.siec];
          const [tlo, kolor, obrys] =
            blok.styl === "kolor" ? [siec.kolor, "#ffffff", siec.kolor] : blok.styl === "ciemny" ? ["#1f2328", "#ffffff", "#1f2328"] : ["#ffffff", "#1f2328", "#cdd2d9"];
          return `<a href="${l.href}" target="_blank" style="display:inline-block;margin:0 4px 8px;padding:7px 14px;border:1px solid ${obrys};border-radius:999px;background-color:${tlo};color:${kolor};font-family:${k.font};font-size:13px;line-height:16px;font-weight:600;text-decoration:none">${escapuj(siec.etykieta)}</a>`;
        })
        .join("");
      return `<div style="text-align:${al};font-size:0">${pastylki}</div>`;
    }
    case "stopka": {
      const kolor = bezpiecznyKolor(blok.kolor, "#868d97");
      return tekstSformatowany(k, blok.html, { fs: 12, lh: 19, fw: 400, kolor, wyrownanie: blok.wyrownanie, kolorLinku: kolor });
    }
    case "html":
      // Własny HTML operatora — bez białej listy (tak działało pole treści przed edytorem),
      // ale DOMKNIĘTY: niedomknięty <style>, komentarz czy atrybut nie może połknąć stopki
      // z wypisem, którą silnik dokleja za treścią. Podgląd w panelu — tylko w <iframe sandbox>.
      return domknijSurowyHtml(blok.html);
  }
}

function wiersz(k: Kontekst, blok: Blok): string {
  const tlo = bezpiecznyKolor(blok.tlo, "");
  const tresc = trescBloku(k, blok, tlo || k.s.tloTresci);
  if (!tresc) return "";
  return (
    `<tr><td${blok.boki > 16 ? ' class="mr-p"' : ""}${tlo ? ` bgcolor="${tlo}"` : ""} style="padding:${blok.gora}px ${blok.boki}px ${blok.dol}px ${blok.boki}px${tlo ? `;background-color:${tlo}` : ""}">` +
    `${tresc}</td></tr>`
  );
}

/** Style do bloku <style>: responsywność i tryb ciemny. Wszystko z `!important`, bo walczy ze stylami inline. */
function arkusz(s: StyleMaila): string {
  return (
    `<style type="text/css">` +
    `:root{color-scheme:light;supported-color-schemes:light}` +
    `.mr-mail a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}` +
    `@media only screen and (max-width:${s.szerokosc + 20}px){` +
    `.mr-kontener{width:100%!important;max-width:100%!important}` +
    `.mr-p{padding-left:16px!important;padding-right:16px!important}` +
    `.mr-kol{display:block!important;width:100%!important;max-width:100%!important}` +
    `.mr-kol-l{padding-right:0!important;padding-bottom:20px!important}` +
    `.mr-kol-p{padding-left:0!important}` +
    `.mr-img{width:100%!important;height:auto!important}` +
    `}` +
    `</style>`
  );
}

/**
 * Dokument → HTML maila (fragment dla `zlozWiadomosc`).
 *
 * `preheader` ląduje jako ukryta pierwsza linijka: silnik wysyłki go nie wstawia,
 * a bez niej skrzynka pokazuje w podglądzie pierwsze słowa treści albo alt logo.
 */
export function renderujDokument(dokument: DokumentMaila, opcje: { preheader?: string | null; dynamiczne?: boolean } = {}): WynikRenderu {
  const s: StyleMaila = {
    ...STYLE_DOMYSLNE,
    ...dokument.style,
    tlo: bezpiecznyKolor(dokument.style.tlo, STYLE_DOMYSLNE.tlo),
    tloTresci: bezpiecznyKolor(dokument.style.tloTresci, STYLE_DOMYSLNE.tloTresci),
    kolorTekstu: bezpiecznyKolor(dokument.style.kolorTekstu, STYLE_DOMYSLNE.kolorTekstu),
    kolorMarki: bezpiecznyKolor(dokument.style.kolorMarki, STYLE_DOMYSLNE.kolorMarki),
    szerokosc: Math.min(700, Math.max(480, Math.round(dokument.style.szerokosc) || 600)),
  };
  const k: Kontekst = { s, font: (KROJE[s.kroj] ?? KROJE.systemowy).stos, // wymiary w pikselach (atrybut width obrazów, szerokość VML) liczone od REALNEJ
    // szerokości treści w karcie silnika, a nie od deklarowanej szerokości maila
    szerTresci: Math.min(s.szerokosc, SZEROKOSC_TRESCI), uwagi: [], dynamiczne: opcje.dynamiczne === true };
  const wiersze = dokument.bloki.map((b) => wiersz(k, b)).join("");
  for (const p of przykladoweDane(dokument)) k.uwagi.push(`W treści zostały przykładowe dane: ${p}. Zastąp je swoimi albo usuń.`);
  const preheader = (opcje.preheader ?? "").trim();

  const html =
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
    arkusz(s) +
    (preheader
      ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escapuj(preheader)}${PRZERWA}</div>`
      : "") +
    `<table role="presentation" class="mr-mail" border="0" cellspacing="0" cellpadding="0" width="100%" bgcolor="${s.tlo}" style="width:100%;background-color:${s.tlo};border-collapse:collapse">` +
    `<tr><td align="center" style="padding:0">` +
    `<!--[if mso]><table role="presentation" border="0" cellspacing="0" cellpadding="0" width="${s.szerokosc}" align="center"><tr><td><![endif]-->` +
    `<table role="presentation" class="mr-kontener" border="0" cellspacing="0" cellpadding="0" width="100%" bgcolor="${s.tloTresci}" style="width:100%;max-width:${s.szerokosc}px;background-color:${s.tloTresci};border-collapse:collapse;font-family:${k.font};color:${s.kolorTekstu}">` +
    (wiersze || `<tr><td style="padding:0;font-size:1px;line-height:1px">&nbsp;</td></tr>`) +
    `</table>` +
    `<!--[if mso]></td></tr></table><![endif]-->` +
    `</td></tr></table>`;

  return { html, uwagi: k.uwagi };
}

/** Dokument bez żadnej treści, którą zobaczy odbiorca (same odstępy, pusty HTML). */
export function dokumentPusty(dokument: DokumentMaila): boolean {
  return !dokument.bloki.some((b) => b.typ !== "odstep" && b.typ !== "separator" && !(b.typ === "html" && !b.html.trim()));
}

export type { BlokTypu };
