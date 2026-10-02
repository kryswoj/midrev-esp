import { describe, expect, it } from "vitest";
import { nowyBlok, przykladoweDane, przykladyWBloku, przykladyWHtml, pustyDokument, STOPKA_STARTOWA, SZABLONY, type DokumentMaila } from "../src/domain/email/bloki";
import { renderujDokument } from "../src/usecases/tresc/render-blokow";
import { ocenGotowosc } from "../src/usecases/tresc/lista-kontrolna";
import { akcjaKlawisza, type KontekstKlawisza } from "../src/app/t/[tenantId]/kampanie/[campaignId]/tresc/edytor/klawisze";
import { MAKS_BAJTOW_OBRAZU, ocenPlikObrazu } from "../src/app/t/[tenantId]/kampanie/[campaignId]/tresc/edytor/obrazy-klient";

// Fala 1 UX, strumień K (audyt 02.10.2026): szablony bez fałszywych danych firmy,
// skróty klawiszowe, które nie kasują treści w trakcie pisania, walidacja upuszczanych plików.

const PRZYKLADY = /Przykładowa|00-001|Twój sklep/;

describe("szablony i nowe bloki: zero fałszywych danych firmy (P0-2)", () => {
  it("nagłówek bierze nazwę sklepu z konta, bez konta jest pusty (a nie „Twój sklep”)", () => {
    expect(nowyBlok("naglowek", { nazwaSklepu: "Kawa z Gór" }).nazwa).toBe("Kawa z Gór");
    expect(nowyBlok("naglowek", { nazwaSklepu: "", firma: "Kawa sp. z o.o." }).nazwa).toBe("Kawa sp. z o.o.");
    expect(nowyBlok("naglowek").nazwa).toBe("");
    // znaki nowej linii z bazy nie rozbijają jednolinijkowego nagłówka
    expect(nowyBlok("naglowek", { nazwaSklepu: "A\r\nB" }).nazwa).toBe("A B");
  });

  it("stopka nie zawiera adresu: dane firmy dokleja silnik z ustawień konta", () => {
    const s = nowyBlok("stopka", { nazwaSklepu: "Kawa", firma: "Kawa sp. z o.o.", adres: "ul. Leśna 2, 30-001 Kraków" });
    expect(s.html).toBe(STOPKA_STARTOWA);
    expect(s.html).not.toMatch(PRZYKLADY);
  });

  it("żaden szablon (z kontem i bez) nie ma przykładowej nazwy ani adresu", () => {
    for (const sz of SZABLONY) {
      for (const konto of [undefined, { nazwaSklepu: "Kawa z Gór" }]) {
        const d = sz.zbuduj(konto);
        expect(JSON.stringify(d.bloki)).not.toMatch(PRZYKLADY);
        expect(przykladoweDane(d)).toEqual([]);
        const naglowek = d.bloki.find((b) => b.typ === "naglowek");
        if (naglowek && naglowek.typ === "naglowek") expect(naglowek.nazwa).toBe(konto?.nazwaSklepu ?? "");
      }
    }
  });

  it("stary szkic z „ul. Przykładowa 1” i „Twój sklep” jest wykrywany i blokuje listę kontrolną", () => {
    const d: DokumentMaila = {
      ...pustyDokument(),
      bloki: [
        { ...nowyBlok("naglowek"), nazwa: "Twój sklep" },
        { ...nowyBlok("stopka"), html: "Twój sklep sp. z o.o. · ul. Przykładowa 1, 00-001 Warszawa<br>Masz pytanie?" },
      ],
    };
    const przyklady = przykladoweDane(d);
    expect(przyklady.length).toBe(4);
    expect(przyklady.join(" ")).toMatch(/Przykładowa 1/);
    expect(renderujDokument(d).uwagi.join(" ")).toMatch(/przykładowe dane/);
    const punkty = ocenGotowosc({ temat: "T", docelowo: 1, kandydaci: 1, html: '<a href="https://s.pl">x</a>', maStopkeZWypisem: true, domena: { rodzaj: "zweryfikowana", domena: "s.pl", adres: "a@s.pl" }, uwagiTresci: [], przyklady });
    const p = punkty.find((x) => x.klucz === "przyklady");
    expect(p?.stan).toBe("blad");
    expect(p?.akcja).toBe("Popraw w edytorze");
    // logo w nagłówku = nazwa i tak nie trafia do maila, więc nie ma czego zgłaszać
    expect(przykladyWBloku({ ...nowyBlok("naglowek"), nazwa: "Twój sklep", logoUrl: "https://s.pl/logo.png" })).toEqual([]);
  });

  it("nagłówek bez logo i bez nazwy znika z maila z uwagą, zamiast podpisać maila „Twój sklep”", () => {
    const { html, uwagi } = renderujDokument({ ...pustyDokument(), bloki: [nowyBlok("naglowek"), { ...nowyBlok("tekst"), html: "Treść" }] });
    expect(html).not.toContain("Twój sklep");
    expect(uwagi.join(" ")).toMatch(/Nagłówek nie ma logo ani nazwy sklepu/);
    const zNazwa = renderujDokument({ ...pustyDokument(), bloki: [nowyBlok("naglowek", { nazwaSklepu: "Kawa <z> Gór" })] });
    // nazwa z konta jest escapowana jak każdy tekst w mailu
    expect(zNazwa.html).toContain("Kawa &lt;z&gt; Gór");
    expect(zNazwa.html).not.toContain("<z>");
  });

  it("lista kontrolna mówi językiem klienta: bez http(s), CAN-SPAM i Mailpita; adres prowadzi do ustawień konta", () => {
    const punkty = ocenGotowosc({ temat: "", docelowo: 0, kandydaci: 0, html: "<p>x</p>", maStopkeZWypisem: true, domena: { rodzaj: "deweloperski", domena: null, adres: "a@b.pl" }, uwagiTresci: [], adresPocztowy: null });
    const tekst = punkty.map((p) => `${p.etykieta} ${p.opis}`).join(" ");
    expect(tekst).not.toMatch(/http\(s\)|CAN-SPAM|Mailpit|SPF|DKIM|DMARC/);
    expect(punkty.find((p) => p.klucz === "adres")?.akcja).toBe("Uzupełnij adres firmy");
    expect(punkty.find((p) => p.klucz === "link")?.akcja).toBe("Dodaj link");
  });
});

describe("skróty klawiszowe: klik zaznacza, Enter edytuje, Esc wychodzi (P1-6)", () => {
  const baza: KontekstKlawisza = { wPolu: false, wTekscie: false, naPrzycisku: false, wOknie: false, naPlotnie: true, zaznaczony: true, edycjaMozliwa: true };

  it("w trakcie pisania Delete, Backspace i Ctrl+D NIGDY nie ruszają bloku", () => {
    const pisanie = { ...baza, wTekscie: true };
    for (const k of [{ key: "Backspace" }, { key: "Delete" }, { key: "d", ctrlKey: true }, { key: "D", metaKey: true }, { key: "Enter" }, { key: "ArrowUp", altKey: true }]) {
      expect(akcjaKlawisza(k, pisanie)).toBeNull();
    }
    expect(akcjaKlawisza({ key: "Escape" }, pisanie)).toBe("wyjdzZTekstu");
  });

  it("w polach panelu (link, alt, kolor) skróty bloku też nie działają; Ctrl+Z zostaje natywny", () => {
    const pole = { ...baza, wPolu: true };
    expect(akcjaKlawisza({ key: "Backspace" }, pole)).toBeNull();
    expect(akcjaKlawisza({ key: "z", ctrlKey: true }, pole)).toBeNull();
    expect(akcjaKlawisza({ key: "s", ctrlKey: true }, pole)).toBe("zapisz");
  });

  it("na zaznaczonym bloku (poza tekstem): Delete/Backspace usuwa, Ctrl+D duplikuje, Enter wchodzi w tekst", () => {
    expect(akcjaKlawisza({ key: "Delete" }, baza)).toBe("usun");
    expect(akcjaKlawisza({ key: "Backspace" }, baza)).toBe("usun");
    expect(akcjaKlawisza({ key: "d", ctrlKey: true }, baza)).toBe("duplikuj");
    expect(akcjaKlawisza({ key: "Enter" }, baza)).toBe("wejdzWTekst");
    expect(akcjaKlawisza({ key: "Escape" }, baza)).toBe("odznacz");
    expect(akcjaKlawisza({ key: "ArrowDown" }, baza)).toBe("nastepny");
    expect(akcjaKlawisza({ key: "ArrowUp", altKey: true }, baza)).toBe("przesunWyzej");
    expect(akcjaKlawisza({ key: "z", ctrlKey: true, shiftKey: true }, baza)).toBe("ponow");
  });

  it("bez zaznaczenia, w otwartym oknie, w podglądzie i po wysyłce nic nie jest usuwane", () => {
    expect(akcjaKlawisza({ key: "Delete" }, { ...baza, zaznaczony: false })).toBeNull();
    expect(akcjaKlawisza({ key: "Delete" }, { ...baza, wOknie: true })).toBeNull();
    expect(akcjaKlawisza({ key: "Delete" }, { ...baza, edycjaMozliwa: false })).toBeNull();
    expect(akcjaKlawisza({ key: "d", ctrlKey: true }, { ...baza, edycjaMozliwa: false })).toBeNull();
    // Enter na przycisku klika przycisk (np. „Duplikuj”), nie wchodzi w tekst
    expect(akcjaKlawisza({ key: "Enter" }, { ...baza, naPrzycisku: true })).toBeNull();
    // fokus na przycisku w panelu bocznym albo w pasku górnym: Backspace nie kasuje bloku
    expect(akcjaKlawisza({ key: "Backspace" }, { ...baza, naPlotnie: false, naPrzycisku: true })).toBeNull();
    expect(akcjaKlawisza({ key: "d", ctrlKey: true }, { ...baza, naPlotnie: false })).toBeNull();
    expect(akcjaKlawisza({ key: "z", ctrlKey: true }, { ...baza, naPlotnie: false })).toBe("cofnij");
  });
});

describe("upuszczony plik: typ i rozmiar sprawdzane przed wysłaniem", () => {
  it("przyjmuje PNG/JPEG/GIF/WebP do 5 MB, odrzuca resztę z czytelnym powodem", () => {
    expect(ocenPlikObrazu({ name: "a.png", size: 1000, type: "image/png" })).toBeNull();
    expect(ocenPlikObrazu({ name: "a.webp", size: MAKS_BAJTOW_OBRAZU, type: "image/webp" })).toBeNull();
    expect(ocenPlikObrazu({ name: "logo.svg", size: 1000, type: "image/svg+xml" })).toMatch(/PNG, JPEG, GIF albo WebP/);
    expect(ocenPlikObrazu({ name: "x.html", size: 10, type: "text/html" })).toMatch(/nie jest obraz/);
    expect(ocenPlikObrazu({ name: "duzy.jpg", size: MAKS_BAJTOW_OBRAZU + 1, type: "image/jpeg" })).toMatch(/Limit to 5 MB/);
    expect(ocenPlikObrazu({ name: "pusty.png", size: 0, type: "image/png" })).toMatch(/pusty/);
    // pusty MIME: decyduje rozszerzenie (serwer i tak sprawdza bajty)
    expect(ocenPlikObrazu({ name: "zdjecie.JPG", size: 1000, type: "" })).toBeNull();
    expect(ocenPlikObrazu({ name: "skrypt.html", size: 1000, type: "" })).toMatch(/nie jest obraz/);
  });
});

describe("przykładowe dane w samym HTML-u (kampanie bez bloków, encje)", () => {
  it("wykrywa adres i firmę także zapisane encjami", () => {
    expect(przykladyWHtml("<p>Tw&oacute;j sklep sp. z o.o.<br>ul. Przyk&#322;adowa 1, 00-001&nbsp;Warszawa</p>")).toHaveLength(3);
    expect(przykladyWHtml("<p>Sklep Ani sp. z o.o., ul. Długa 5, 31-001 Kraków</p>")).toEqual([]);
    // tekst niewidoczny dla odbiorcy (style, komentarze, head) nie blokuje wysyłki
    expect(przykladyWHtml("<head><title>ul. Przykładowa 1</title></head><style>/* 00-001 Warszawa */</style><!-- Twój sklep sp. z o.o. --><p>Cześć</p>")).toEqual([]);
    expect(przykladyWHtml("<p>Cześć</p><style>.x{} /* ul. Przykładowa 1")).toEqual([]);
    expect(przykladyWHtml("<p>Cześć</p><!-- 00-001 Warszawa")).toEqual([]);
  });
});
