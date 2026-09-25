import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import {
  nowyBlok,
  pustyDokument,
  SILNIK_SZEROKOSC_KARTY,
  SILNIK_WCIECIE,
  SZABLONY,
  wczytajDokument,
  type Blok,
  type DokumentMaila,
} from "../src/domain/email/bloki";
import { renderujDokument } from "../src/usecases/tresc/render-blokow";
import { przygotujDokument } from "../src/usecases/tresc/zapisz-tresc";
import { linkiDoSledzenia, ocenGotowosc, stanDomeny } from "../src/usecases/tresc/lista-kontrolna";
import { domknijSurowyHtml, prawdziweLinki } from "../src/domain/email/bloki";
import { zlozWiadomosc } from "../src/usecases/wysylka/renderuj";

/**
 * Render bloków do HTML maila i jego współpraca z silnikiem wysyłki. Kluczowe testy
 * wołają PRAWDZIWE `zlozWiadomosc` — to ono przepisuje linki i dokleja stopkę, więc
 * tylko na jego wyniku widać, czy render z nim współgra.
 */

function dok(bloki: Blok[], style: Partial<DokumentMaila["style"]> = {}): DokumentMaila {
  const d = pustyDokument();
  return { ...d, style: { ...d.style, ...style }, bloki };
}

function blok<T extends Blok["typ"]>(typ: T, zmiany: Partial<Extract<Blok, { typ: T }>> = {}): Blok {
  return { ...nowyBlok(typ), ...zmiany } as Blok;
}

const PELNY = dok([
  blok("naglowek", { logoUrl: "https://cdn.sklep.pl/logo.png", logoAlt: "Sklep", link: "https://sklep.pl/" }),
  blok("tekst", { html: 'Cześć! <b>Nowości</b> są <a href="https://sklep.pl/nowosci?a=1&amp;b=2">tutaj</a>.' }),
  blok("obraz", { src: "https://cdn.sklep.pl/baner.jpg", alt: "Baner", link: "https://sklep.pl/baner" }),
  blok("przycisk", { tekst: "Kup teraz", link: "https://sklep.pl/koszyk?utm_source=mail&utm_campaign=x" }),
  blok("kolumny"),
  blok("produkt", { obrazUrl: "https://cdn.sklep.pl/p.jpg", link: "https://sklep.pl/p/1" }),
  blok("kod"),
  blok("social", { linki: [{ siec: "instagram", url: "https://instagram.com/sklep" }] }),
  blok("stopka"),
]);

function zloz(html: string) {
  return zlozWiadomosc({ trescHtml: html, clickToken: "TOKEN", unsubscribeToken: "WYPIS", nazwaSklepu: "Sklep" });
}

describe("render bloków → zlozWiadomosc (silnik wysyłki)", () => {
  it("każdy link http(s) zostaje przepisany na śledzony, a migawka ma DOKŁADNE adresy sklepu", () => {
    const { html } = renderujDokument(PELNY);
    const { html: pelny, linki } = zloz(html);
    // żaden adres sklepu nie zostaje w href po przepisaniu
    expect(pelny).not.toMatch(/href="https:\/\/(sklep\.pl|instagram\.com)/);
    for (const [i] of linki.entries()) expect(pelny).toContain(`href="${config().APP_URL}/r/TOKEN?l=${i}"`);
    // surowy & w adresie: redirect trafi dokładnie tam, dokąd link prowadził
    expect(linki).toContain("https://sklep.pl/nowosci?a=1&b=2");
    expect(linki).toContain("https://sklep.pl/koszyk?utm_source=mail&utm_campaign=x");
    expect(linki.some((l) => l.includes("&amp;"))).toBe(false);
    // przycisk: VML dla Outlooka i <a> dla reszty — oba śledzone
    expect(linki.filter((l) => l.startsWith("https://sklep.pl/koszyk")).length).toBe(2);
    expect(pelny).toContain("v:roundrect");
  });

  it("stopka z wypisem pojawia się dokładnie raz — render jej nie dubluje", () => {
    const { html } = renderujDokument(PELNY);
    expect(html).not.toMatch(/\/u\//);
    expect(html).not.toMatch(/wypisz/i);
    const { html: pelny } = zloz(html);
    expect(pelny.match(/\/u\/WYPIS/g)?.length).toBe(1);
  });

  it("wynik to fragment (bez własnego <html>/<body>), bez skryptów, obrazy z alt i adresem absolutnym", () => {
    const { html } = renderujDokument(PELNY);
    expect(html).not.toMatch(/<\/?(html|body|head)\b/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    for (const img of html.match(/<img [^>]+>/g) ?? []) {
      expect(img).toMatch(/src="https:\/\//);
      expect(img).toMatch(/alt="[^"]*"/);
    }
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain("@media only screen");
  });

  it("oprawa silnika odpowiada stałym, z których liczy płótno edytora", () => {
    const { html } = zloz("<p>x</p>");
    expect(html).toContain(`max-width:${SILNIK_SZEROKOSC_KARTY}px`);
    expect(html).toContain(`padding:${SILNIK_WCIECIE}px`);
  });

  it("preheader trafia jako ukryta pierwsza linijka i jest escapowany", () => {
    const { html } = renderujDokument(PELNY, { preheader: 'Rabat <b>"20%"</b>' });
    expect(html).toContain("Rabat &lt;b&gt;&quot;20%&quot;&lt;/b&gt;");
    expect(html.indexOf("Rabat")).toBeLessThan(html.indexOf('class="mr-mail"'));
  });

  it("wszystkie szablony renderują się i przechodzą przez silnik", () => {
    for (const s of SZABLONY) {
      const { html } = renderujDokument(s.zbuduj());
      expect(() => zloz(html)).not.toThrow();
      expect(html).toContain('class="mr-mail"');
    }
  });
});

describe("render bloków: XSS i złe adresy", () => {
  it("tekst sformatowany: skrypty, atrybuty zdarzeń i javascript: wylatują", () => {
    const { html } = renderujDokument(
      dok([
        blok("tekst", {
          html: '<script>alert(1)</script><img src=x onerror=alert(1)><b onclick="x()">B</b><a href="javascript:alert(1)">J</a><a href=" java\tscript:alert(1)">K</a><style>body{}</style><svg><script>1</script></svg>',
        }),
      ]),
    );
    expect(html).not.toMatch(/<script|onerror|onclick|javascript:|<svg|<img src=x/i);
    expect(html).toContain("<b>B</b>");
  });

  it("zwykłe pola są escapowane (nazwa produktu, kod, napis przycisku)", () => {
    const { html } = renderujDokument(
      dok([
        blok("produkt", { nazwa: '<img src=x onerror=alert(1)>"', cena: "<b>1</b>" }),
        blok("kod", { kod: "</td><script>1</script>" }),
        blok("przycisk", { tekst: '"><script>2</script>', link: "https://sklep.pl" }),
      ]),
    );
    expect(html).not.toMatch(/<script|<img src=x/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;");
  });

  it("adres z cudzysłowem nie wychodzi z atrybutu, javascript:/data: w linku i obrazie są odrzucane z uwagą", () => {
    const { html, uwagi } = renderujDokument(
      dok([
        blok("przycisk", { tekst: "A", link: 'https://sklep.pl/"><script>x</script>' }),
        blok("przycisk", { tekst: "B", link: "javascript:alert(1)" }),
        blok("obraz", { src: "data:image/png;base64,AAAA", alt: "x" }),
      ]),
    );
    expect(html).not.toMatch(/<script|javascript:|data:image/);
    expect(html).toContain("%22%3E%3Cscript%3Ex%3C/script%3E");
    expect(uwagi.join(" ")).toMatch(/Przycisk „B" nie ma poprawnego linku/);
    expect(uwagi.join(" ")).toMatch(/Obraz: adres obrazu musi zaczynać się od http/);
  });

  it("przycisk z mailto: jest klikalny (panel i render dopuszczają te same protokoły), silnik go nie przepisuje", () => {
    const { html, uwagi } = renderujDokument(dok([blok("przycisk", { tekst: "Napisz", link: "mailto:sklep@example.com" })]));
    expect(uwagi).toEqual([]);
    expect(html).toContain('href="mailto:sklep@example.com"');
    expect(zloz(html).linki).toEqual([]);
  });

  it("sanityzacja wydłużająca tekst ponad limit schematu kończy się czytelnym błędem, nie „uszkodzonym” dokumentem", () => {
    const w = przygotujDokument(JSON.stringify(dok([blok("stopka", { html: "&".repeat(3000) })])));
    expect(w.ok).toBe(false);
  });

  it("schemat odrzuca kolor z wstrzyknięciem CSS i nieznany typ bloku", () => {
    const zlyKolor = { ...PELNY, style: { ...PELNY.style, kolorMarki: "red;background:url(x)" } };
    expect(przygotujDokument(JSON.stringify(zlyKolor)).ok).toBe(false);
    const zlyTyp = { ...PELNY, bloki: [{ ...nowyBlok("tekst"), typ: "skrypt" }] };
    expect(przygotujDokument(JSON.stringify(zlyTyp)).ok).toBe(false);
    expect(przygotujDokument("{nie json").ok).toBe(false);
  });

  it("przygotujDokument sanityzuje tekst sformatowany już przy zapisie", () => {
    const w = przygotujDokument(JSON.stringify(dok([blok("tekst", { html: 'A<script>x</script><a href="https://s.pl" onclick="y">L</a>' })])));
    expect(w.ok).toBe(true);
    if (w.ok) expect((w.dokument.bloki[0] as Extract<Blok, { typ: "tekst" }>).html).toBe('A<a href="https://s.pl/">L</a>');
  });
});

describe("własny HTML nie może połknąć stopki z wypisem", () => {
  const wypis = `${config().APP_URL}/u/WYPIS`;
  for (const [opis, zly] of [
    ["niedomknięty <style>", '<a href="https://shop.test/">Oferta</a><style>'],
    ["niedomknięty komentarz", "<p>x</p><!-- zapomniany"],
    ["niedomknięty <textarea>", "<textarea>"],
    ["urwany znacznik", '<p>x</p><div title="a'],
    ["<plaintext>", "<plaintext>"],
    ["</stylex> nie zamyka <style>", "<!-- </style> --><style>abc</stylex>"],
    ["niedomknięty <template>", '<a href="https://example.com">Oferta</a><template>'],
    ["niedomknięty <select>", "<select><option>x"],
    ["urwany cudzysłów atrybutu", '<p title="abc>tekst</p>'],
    ["<template/> (samozamknięcie ignorowane)", "<template/>"],
    ["</style + NBSP>", "<style>x</style\u00a0>"],
    ["komentarz <!--> i template", '<a href="https://sklep.pl">Sklep</a><!--><template>'],
    ["cudzysłów w wartości niecytowanej", '<a href="https://sklep.pl">Sklep</a><div x=a"><template><div x=b">'],
    ["niedomknięty <details>", "<details><summary>x</summary>"],
    ["niedomknięte CDATA", "<svg><![CDATA[ x"],
  ] as const) {
    it(`${opis}: po złożeniu przez silnik link wypisu jest prawdziwym <a>`, () => {
      const surowy = zloz(zly);
      const { html } = renderujDokument(dok([blok("html", { html: zly })]));
      const naprawiony = zloz(html);
      expect(prawdziweLinki(naprawiony.html)).toContain(wypis);
      // bez domknięcia (surowy HTML prosto do silnika) wypisu nie ma — lista kontrolna musi to złapać
      if (!["urwany znacznik", "urwany cudzysłów atrybutu"].includes(opis)) expect(prawdziweLinki(surowy.html)).not.toContain(wypis);
    });
  }

  // Przypadki, których skaner listy kontrolnej nie rozpozna w SUROWYM HTML-u (reguły budowy
  // drzewa: zakres zamknięcia, odtwarzanie elementów formatujących, atrybuty na <body>).
  // Chroni przed nimi domykanie przy renderze bloku: te konstrukcje są usuwane.
  for (const [opis, zly] of [
    ["<details><table></details>", "<details><table></details>"],
    ["<div><b hidden></div>", "<div><b hidden></div>"],
    ["urwane </ na końcu", "<div hidden></"],
    ["<body hidden>", "<body hidden></body>"],
    ["<html hidden>", "<html hidden><p>x</p></html>"],
    ['<b title=">" hidden>', '<div><b title=">" hidden></div>'],
    ["<b/hidden>", "<div><b/hidden></div>"],
    ["podwójne hidden", "<div><b hidden hidden></div>"],
    ["urwane <body hidden", "<body hidden"],
    ["<audio><table></audio>", "<audio><table></audio>"],
    ["sklejenie po wycięciu", "<<body>body hidden>"],
    ["sklejone <plaintext> po wycięciu", "<pl<body>aintext>"],
    ["<noscript> przy wyłączonych skryptach", "<noscript><body hidden></noscript>"],
    ["<svg><style>", "<svg><style><body hidden></style></svg>"],
    ["<noscript><b hidden>", "<div><noscript><b hidden></noscript></div>"],
  ] as const) {
    it(`${opis}: domknięcie usuwa konstrukcję, która schowałaby stopkę`, () => {
      const out = domknijSurowyHtml(zly);
      // tekst po „&lt;” to już zwykły tekst, nie znacznik
      expect(out.replace(/&lt;[^<]*/g, "")).not.toMatch(/[\s/]hidden\b|<\/?(details|body|html|audio)\b|<\/?$/i);
      const { html } = renderujDokument(dok([blok("html", { html: zly })]));
      expect(prawdziweLinki(zloz(html).html)).toContain(wypis);
    });
  }

  it("wycinanie znacznika nie ujawnia fragmentu wartości atrybutu", () => {
    expect(domknijSurowyHtml('<details title="a>b">tekst</details>')).toBe("tekst");
    expect(domknijSurowyHtml('<p title="x" hidden class="y">a</p>')).toBe('<p title="x" class="y">a</p>');
  });

  it("niedomknięty <div style=display:none> nie chowa stopki: domknięcie wszystkich elementów operatora", () => {
    const out = domknijSurowyHtml('<div style="display:none"><p>ukryte');
    expect(out).toBe('<div style="display:none"><p>ukryte</p></div>');
    // niejawne domknięcia parsera nie dają pustych akapitów
    expect(domknijSurowyHtml("<p>a<p>b")).toBe("<p>a<p>b</p>");
    expect(domknijSurowyHtml("<ul><li>a<li>b")).toBe("<ul><li>a<li>b</li></ul>");
  });

  it("sklejony po wycięciu <script> też znika", () => {
    expect(domknijSurowyHtml("<scr<body>ipt>alert(1)</script>")).not.toMatch(/<script/i);
  });

  it("domknijSurowyHtml wycina skrypty i nie rusza poprawnego HTML", () => {
    expect(domknijSurowyHtml("<p>a</p><script>alert(1)</script><b>b</b>")).toBe("<p>a</p><b>b</b>");
    expect(domknijSurowyHtml('<table><tr><td><a href="https://s.pl">x</a></td></tr></table>')).toBe('<table><tr><td><a href="https://s.pl">x</a></td></tr></table>');
  });

  it("prawdziweLinki ignoruje linki w komentarzach, <style> i atrybutach", () => {
    expect(prawdziweLinki('<!-- <a href="https://a.pl">x</a> --><style>a{}</style><a href="https://b.pl">y</a><div title=\'<a href="https://c.pl">\'>')).toEqual(["https://b.pl"]);
  });
});

describe("kompatybilność wstecz: wczytajDokument", () => {
  it("kampania z samym content.html otwiera się jako jeden blok „Własny HTML” i renderuje ten HTML", () => {
    const { dokument, zrodlo } = wczytajDokument({ html: '<p>Stara treść <a href="https://sklep.pl">link</a></p>' });
    expect(zrodlo).toBe("html");
    expect(dokument.bloki).toHaveLength(1);
    expect(dokument.bloki[0].typ).toBe("html");
    const { linki } = zloz(renderujDokument(dokument).html);
    expect(linki).toEqual(["https://sklep.pl"]);
  });

  it("pusta treść = pusty dokument; uszkodzone bloki NIE giną po cichu — wraca HTML, który wychodzi", () => {
    expect(wczytajDokument({}).zrodlo).toBe("pusty");
    expect(wczytajDokument(null).dokument.bloki).toHaveLength(0);
    const u = wczytajDokument({ html: "<p>wysyłany</p>", bloki: [{ typ: "???" }], wersjaSchematu: 1, style: {} });
    expect(u.zrodlo).toBe("uszkodzony");
    expect((u.dokument.bloki[0] as Extract<Blok, { typ: "html" }>).html).toBe("<p>wysyłany</p>");
  });

  it("zapisany dokument bloków wraca 1:1", () => {
    const { html } = renderujDokument(PELNY);
    const { dokument, zrodlo } = wczytajDokument({ html, ...PELNY });
    expect(zrodlo).toBe("bloki");
    expect(dokument).toEqual(PELNY);
  });
});

describe("lista kontrolna (B4)", () => {
  const domenaOk = { rodzaj: "zweryfikowana", domena: "sklep.pl", adres: "a@sklep.pl" } as const;
  const baza = { temat: "Temat", docelowo: 10, kandydaci: 12, html: '<a href="https://s.pl">x</a>', maStopkeZWypisem: true, domena: domenaOk, uwagiTresci: [] };

  it("komplet danych = wszystko ok", () => {
    expect(ocenGotowosc(baza).every((p) => p.stan === "ok")).toBe(true);
  });

  it("każdy brak to osobny punkt `blad` z powodem", () => {
    const p = ocenGotowosc({ ...baza, temat: "  ", docelowo: 0, html: "<p>bez linku</p>", maStopkeZWypisem: false, domena: { rodzaj: "niezweryfikowana", domena: "sklep.pl", status: "partial" } });
    const bledy = Object.fromEntries(p.filter((x) => x.stan === "blad").map((x) => [x.klucz, x.opis]));
    expect(Object.keys(bledy).sort()).toEqual(["domena", "link", "odbiorcy", "temat", "wypis"]);
    expect(bledy.domena).toMatch(/sklep\.pl: część rekordów niepoprawna/);
  });

  it("HREF wielkimi literami albo ze spacjami wokół „=” silnik przepisuje, więc liczy się jako śledzony", () => {
    // ta sama reguła co przepiszLinki (renderuj.ts): regex bez względu na wielkość liter i spacje
    expect(linkiDoSledzenia('<a HREF="https://sklep.pl">x</a>')).toEqual(["https://sklep.pl"]);
    expect(linkiDoSledzenia('<a href = "https://sklep.pl">x</a>')).toEqual(["https://sklep.pl"]);
  });

  it("<script> w treści (kampania sprzed edytora) blokuje punkt „Treść”", () => {
    const p = ocenGotowosc({ ...baza, html: '<a href="https://s.pl">x</a><script>1</script>' });
    expect(p.find((x) => x.klucz === "tresc")?.stan).toBe("blad");
  });

  it("href schowany w innym atrybucie, komentarzu albo w nie-znaczniku nie jest linkiem; pojedynczy cudzysłów jest", () => {
    expect(linkiDoSledzenia(`<a title=' href="https://shop.example/"'>Sklep</a>`)).toEqual([]);
    // komentarz się nie liczy, prawdziwy <a> w pojedynczym cudzysłowie silnik przepisuje
    expect(linkiDoSledzenia(`<!-- href="https://shop.example/" --><a href='https://shop.example/'>Sklep</a>`)).toEqual(["https://shop.example/"]);
    expect(linkiDoSledzenia(`<a\u00a0href="https://shop.example/">x</a>`)).toEqual([]);
  });

  it("link tylko w komentarzu albo atrybucie nie spełnia punktu „link w treści”", () => {
    expect(linkiDoSledzenia('<p>Oferta</p><!-- <a href="https://example.com">Kup</a> -->')).toEqual([]);
    expect(linkiDoSledzenia('<a href="https://example.com">Kup</a>')).toEqual(["https://example.com"]);
  });

  it("link to tylko to, co przepisze silnik (mailto i względne się nie liczą)", () => {
    expect(linkiDoSledzenia('<a href="mailto:a@b.pl">m</a><a href="/x">r</a>')).toEqual([]);
    expect(linkiDoSledzenia(`<a href='https://s.pl'>pojedynczy cudzysłów</a>`)).toEqual(["https://s.pl"]);
  });

  it("uwagi z renderu nie blokują, ale są widoczne", () => {
    const p = ocenGotowosc({ ...baza, uwagiTresci: ["Obraz: brak alt"] });
    expect(p.find((x) => x.klucz === "jakosc")?.stan).toBe("uwaga");
  });

  it("stan domeny: kolejność warunków jak w wyborze nadawcy silnika", () => {
    const sys = { host: "smtp.midrev.pl", port: 587, od: "k@midrev.pl", deweloperskie: ["127.0.0.1:1025"] };
    expect(stanDomeny(null, sys).rodzaj).toBe("brak");
    expect(stanDomeny(null, { ...sys, host: "127.0.0.1", port: 1025 }).rodzaj).toBe("deweloperski");
    const serwer = {
      host: "smtp.sklep.pl", port: 587, bezpieczenstwo: "starttls", uzytkownik: null, hasloUstawione: true,
      nazwaNadawcy: "Sklep", adresNadawcy: "news@sklep.pl", odpowiedzDo: null, domenaId: "d", domenaNadawcy: "sklep.pl",
      statusDomeny: "verified", polaczenieSprawdzoneAt: new Date(), ostatniTestAt: null, ostatniBladTestu: null, deweloperski: false,
    } as any;
    expect(stanDomeny(serwer, sys).rodzaj).toBe("zweryfikowana");
    expect(stanDomeny({ ...serwer, polaczenieSprawdzoneAt: null }, sys).rodzaj).toBe("serwer-niesprawdzony");
    expect(stanDomeny({ ...serwer, statusDomeny: "failed" }, sys).rodzaj).toBe("niezweryfikowana");
    expect(stanDomeny({ ...serwer, adresNadawcy: "news@inna.pl" }, sys).rodzaj).toBe("adres-poza-domena");
    expect(stanDomeny({ ...serwer, statusDomeny: "pending", deweloperski: true }, sys).rodzaj).toBe("deweloperski");
  });
});
