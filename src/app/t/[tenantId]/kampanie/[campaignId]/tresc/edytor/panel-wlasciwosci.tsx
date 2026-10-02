"use client";

import { Plus, Trash2 } from "lucide-react";
import {
  KROJE,
  ROZMIARY_PRZYCISKU,
  SIECI,
  WARIANTY_TEKSTU,
  type Blok,
  type BlokTypu,
  type Kolumna,
  type Kroj,
  type Siec,
  type StyleMaila,
} from "../../../../../../../domain/email/bloki";
import { PoleKoloru, PoleTekstu, PoleUrl, Przelacznik, Sekcja, Segmenty, Suwak, Wybor, Wyrownanie } from "./kontrolki";
import { NAZWY_BLOKOW } from "./biblioteka";
import { PoleObrazu } from "./pole-obrazu";

type Zmiana = (zmiany: Partial<Blok>, klucz?: string) => void;

function Oprawa({ blok, zmien, styl }: { blok: Blok; zmien: Zmiana; styl: StyleMaila }) {
  return (
    <Sekcja tytul="Marginesy i tło">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
        <Suwak etykieta="Nad blokiem" wartosc={blok.gora} min={0} maks={120} onZmiana={(gora) => zmien({ gora }, "gora")} />
        <Suwak etykieta="Pod blokiem" wartosc={blok.dol} min={0} maks={120} onZmiana={(dol) => zmien({ dol }, "dol")} />
      </div>
      <Suwak etykieta="Wcięcie z boków" wartosc={blok.boki} min={0} maks={80} onZmiana={(boki) => zmien({ boki }, "boki")} />
      <PoleKoloru etykieta="Tło bloku" wartosc={blok.tlo} pusty="Brak (tło treści)" zastepczy={styl.tloTresci} onZmiana={(tlo) => zmien({ tlo }, "tlo")} />
    </Sekcja>
  );
}

function PolaKolumny({ nazwa, kol, zmien }: { nazwa: string; kol: Kolumna; zmien: (k: Partial<Kolumna>, klucz: string) => void }) {
  return (
    <Sekcja tytul={`Kolumna ${nazwa}`} opis="Tekst edytujesz na płótnie. Obraz i przycisk są opcjonalne.">
      <PoleObrazu etykieta="Obraz" wartosc={kol.obrazUrl} onZmiana={(obrazUrl) => zmien({ obrazUrl }, `${nazwa}-img`)} />
      <PoleTekstu etykieta="Tekst alternatywny obrazu" wartosc={kol.obrazAlt} onZmiana={(obrazAlt) => zmien({ obrazAlt }, `${nazwa}-alt`)} maks={300} />
      <PoleTekstu etykieta="Napis na przycisku" wartosc={kol.przyciskTekst} onZmiana={(przyciskTekst) => zmien({ przyciskTekst }, `${nazwa}-btn`)} placeholder="puste = bez przycisku" maks={300} />
      <PoleUrl etykieta="Link przycisku i obrazu" wartosc={kol.przyciskLink} onZmiana={(przyciskLink) => zmien({ przyciskLink }, `${nazwa}-link`)} />
    </Sekcja>
  );
}

export function WlasciwosciBloku({ blok, zmien, uwagi, styl }: { blok: Blok; zmien: Zmiana; uwagi: string[]; styl: StyleMaila }) {
  const tresc = (() => {
    switch (blok.typ) {
      case "naglowek":
        return (
          <Sekcja tytul="Logo" opis="Bez logo w nagłówku stoi nazwa sklepu (edytujesz ją na płótnie, dwukrotnym kliknięciem).">
            <PoleObrazu etykieta="Logo" wartosc={blok.logoUrl} onZmiana={(logoUrl) => zmien({ logoUrl }, "logoUrl")} podpowiedz="PNG albo JPG. SVG nie działa w Gmailu i Outlooku." />
            <PoleTekstu etykieta="Tekst alternatywny" wartosc={blok.logoAlt} onZmiana={(logoAlt) => zmien({ logoAlt }, "logoAlt")} placeholder={blok.nazwa} maks={300} />
            <Suwak etykieta="Szerokość logo" wartosc={blok.logoSzerokosc} min={40} maks={400} onZmiana={(logoSzerokosc) => zmien({ logoSzerokosc }, "logoSzerokosc")} />
            <PoleUrl etykieta="Link (strona sklepu)" wartosc={blok.link} onZmiana={(link) => zmien({ link }, "link")} />
            <Wyrownanie wartosc={blok.wyrownanie} onZmiana={(wyrownanie) => zmien({ wyrownanie })} />
          </Sekcja>
        );
      case "tekst":
        return (
          <Sekcja tytul="Tekst" opis="Kliknij tekst na płótnie drugi raz (albo Enter), żeby pisać. Pasek u góry: pogrubienie, link (Ctrl+K), styl i wyrównanie. Esc kończy pisanie.">
            <PoleKoloru etykieta="Kolor tekstu" wartosc={blok.kolor} pusty="Ze stylów maila" zastepczy={styl.kolorTekstu} onZmiana={(kolor) => zmien({ kolor }, "kolor")} />
          </Sekcja>
        );
      case "obraz":
        return (
          <Sekcja tytul="Obraz">
            <PoleObrazu etykieta="Adres obrazu" wartosc={blok.src} onZmiana={(src) => zmien({ src }, "src")} podpowiedz="Wklej adres obrazu ze sklepu albo wgraj plik do biblioteki poniżej." />
            <PoleTekstu etykieta="Tekst alternatywny (alt)" wartosc={blok.alt} onZmiana={(alt) => zmien({ alt }, "alt")} placeholder="co jest na obrazie" podpowiedz="Wyświetla się, gdy skrzynka blokuje obrazy, i czyta go czytnik ekranu." maks={300} />
            <PoleUrl etykieta="Link po kliknięciu" wartosc={blok.link} onZmiana={(link) => zmien({ link }, "link")} />
            <Suwak etykieta="Szerokość" wartosc={blok.szerokosc} min={10} maks={100} jednostka="%" onZmiana={(szerokosc) => zmien({ szerokosc }, "szerokosc")} />
            <Suwak etykieta="Zaokrąglenie rogów" wartosc={blok.zaokraglenie} min={0} maks={40} onZmiana={(zaokraglenie) => zmien({ zaokraglenie }, "zaokraglenie")} />
            <Wyrownanie wartosc={blok.wyrownanie} onZmiana={(wyrownanie) => zmien({ wyrownanie })} />
          </Sekcja>
        );
      case "przycisk":
        return (
          <Sekcja tytul="Przycisk" opis="Napis zmieniasz na płótnie (kliknij dwa razy). Przycisk wygląda tak samo także w Outlooku.">
            <PoleUrl etykieta="Link" wartosc={blok.link} onZmiana={(link) => zmien({ link }, "link")} mail />
            <PoleKoloru etykieta="Kolor tła" wartosc={blok.kolorTla} pusty="Kolor marki" zastepczy={styl.kolorMarki} onZmiana={(kolorTla) => zmien({ kolorTla }, "kolorTla")} />
            <PoleKoloru etykieta="Kolor napisu" wartosc={blok.kolorTekstu} onZmiana={(kolorTekstu) => zmien({ kolorTekstu }, "kolorTekstu")} />
            <Segmenty etykieta="Rozmiar" wartosc={blok.rozmiar} onZmiana={(rozmiar) => zmien({ rozmiar })} opcje={(Object.keys(ROZMIARY_PRZYCISKU) as (keyof typeof ROZMIARY_PRZYCISKU)[]).map((k) => ({ wartosc: k, etykieta: ROZMIARY_PRZYCISKU[k].etykieta, opis: `${ROZMIARY_PRZYCISKU[k].etykieta} przycisk` }))} />
            <Suwak etykieta="Zaokrąglenie rogów" wartosc={blok.zaokraglenie} min={0} maks={40} onZmiana={(zaokraglenie) => zmien({ zaokraglenie }, "zaokraglenie")} />
            <Przelacznik etykieta="Na całą szerokość" wartosc={blok.pelnaSzerokosc} onZmiana={(pelnaSzerokosc) => zmien({ pelnaSzerokosc })} />
            {!blok.pelnaSzerokosc ? <Wyrownanie wartosc={blok.wyrownanie} onZmiana={(wyrownanie) => zmien({ wyrownanie })} /> : null}
          </Sekcja>
        );
      case "separator":
        return (
          <Sekcja tytul="Separator">
            <PoleKoloru etykieta="Kolor linii" wartosc={blok.kolor} onZmiana={(kolor) => zmien({ kolor }, "kolor")} />
            <Suwak etykieta="Grubość" wartosc={blok.grubosc} min={1} maks={8} onZmiana={(grubosc) => zmien({ grubosc }, "grubosc")} />
            <Suwak etykieta="Szerokość" wartosc={blok.szerokosc} min={10} maks={100} jednostka="%" onZmiana={(szerokosc) => zmien({ szerokosc }, "szerokosc")} />
            <Segmenty etykieta="Styl linii" wartosc={blok.styl} onZmiana={(styl) => zmien({ styl })} opcje={[{ wartosc: "solid", etykieta: "ciągła", opis: "Linia ciągła" }, { wartosc: "dashed", etykieta: "kreski", opis: "Linia przerywana" }, { wartosc: "dotted", etykieta: "kropki", opis: "Linia kropkowana" }]} />
          </Sekcja>
        );
      case "odstep":
        return (
          <Sekcja tytul="Odstęp">
            <Suwak etykieta="Wysokość" wartosc={blok.wysokosc} min={4} maks={160} onZmiana={(wysokosc) => zmien({ wysokosc }, "wysokosc")} />
          </Sekcja>
        );
      case "kolumny":
        return (
          <>
            <Sekcja tytul="Układ" opis="Na telefonie kolumny ustawiają się jedna pod drugą.">
              <Segmenty etykieta="Proporcje" wartosc={blok.proporcja} onZmiana={(proporcja) => zmien({ proporcja })} opcje={[{ wartosc: "50-50", etykieta: "½ · ½", opis: "Równe kolumny" }, { wartosc: "33-67", etykieta: "⅓ · ⅔", opis: "Węższa lewa" }, { wartosc: "67-33", etykieta: "⅔ · ⅓", opis: "Węższa prawa" }]} />
              <Suwak etykieta="Odstęp między kolumnami" wartosc={blok.odstepKolumn} min={0} maks={48} onZmiana={(odstepKolumn) => zmien({ odstepKolumn }, "odstepKolumn")} />
              <Wyrownanie wartosc={blok.wyrownanie} onZmiana={(wyrownanie) => zmien({ wyrownanie })} />
            </Sekcja>
            <PolaKolumny nazwa="lewa" kol={blok.lewa} zmien={(z, k) => zmien({ lewa: { ...blok.lewa, ...z } } as Partial<Blok>, k)} />
            <PolaKolumny nazwa="prawa" kol={blok.prawa} zmien={(z, k) => zmien({ prawa: { ...blok.prawa, ...z } } as Partial<Blok>, k)} />
          </>
        );
      case "produkt":
        return (
          <Sekcja tytul="Produkt" opis="Nazwę, opis i cenę edytujesz też wprost na płótnie.">
            <PoleObrazu etykieta="Zdjęcie produktu" wartosc={blok.obrazUrl} onZmiana={(obrazUrl) => zmien({ obrazUrl }, "obrazUrl")} />
            <PoleTekstu etykieta="Tekst alternatywny zdjęcia" wartosc={blok.obrazAlt} onZmiana={(obrazAlt) => zmien({ obrazAlt }, "obrazAlt")} placeholder={blok.nazwa} maks={300} />
            <PoleUrl etykieta="Link do produktu" wartosc={blok.link} onZmiana={(link) => zmien({ link }, "link")} podpowiedz="Prowadzi tam zdjęcie i przycisk." />
            <div className="grid grid-cols-2 gap-3">
              <PoleTekstu etykieta="Cena" wartosc={blok.cena} onZmiana={(cena) => zmien({ cena }, "cena")} maks={60} />
              <PoleTekstu etykieta="Cena przed (przekreślona)" wartosc={blok.cenaPrzed} onZmiana={(cenaPrzed) => zmien({ cenaPrzed }, "cenaPrzed")} placeholder="opcjonalnie" maks={60} />
            </div>
            <PoleTekstu etykieta="Napis na przycisku" wartosc={blok.przyciskTekst} onZmiana={(przyciskTekst) => zmien({ przyciskTekst }, "przyciskTekst")} placeholder="puste = bez przycisku" maks={300} />
            <Wyrownanie wartosc={blok.wyrownanie} onZmiana={(wyrownanie) => zmien({ wyrownanie })} />
          </Sekcja>
        );
      case "kod":
        return (
          <Sekcja tytul="Kod rabatowy" opis="Kod musi istnieć w sklepie — edytor go nie tworzy.">
            <PoleTekstu etykieta="Kod" wartosc={blok.kod} onZmiana={(kod) => zmien({ kod }, "kod")} maks={80} />
            <PoleKoloru etykieta="Kolor ramki i kodu" wartosc={blok.kolorRamki} onZmiana={(kolorRamki) => zmien({ kolorRamki }, "kolorRamki")} />
            <PoleKoloru etykieta="Tło" wartosc={blok.tloKodu} onZmiana={(tloKodu) => zmien({ tloKodu }, "tloKodu")} />
          </Sekcja>
        );
      case "social":
        return (
          <Sekcja tytul="Profile społecznościowe" opis="Profil bez linku nie trafi do maila.">
            <Segmenty etykieta="Styl" wartosc={blok.styl} onZmiana={(styl) => zmien({ styl })} opcje={[{ wartosc: "kolor", etykieta: "kolorowe", opis: "Kolory serwisów" }, { wartosc: "ciemny", etykieta: "ciemne", opis: "Ciemne" }, { wartosc: "jasny", etykieta: "jasne", opis: "Jasne z obrysem" }]} />
            <Wyrownanie wartosc={blok.wyrownanie} onZmiana={(wyrownanie) => zmien({ wyrownanie })} />
            <div className="space-y-2.5">
              {blok.linki.map((l, i) => (
                <div key={i} className="flex items-end gap-2">
                  <div className="w-[118px] shrink-0">
                    <Wybor etykieta={i === 0 ? "Serwis" : ""} wartosc={l.siec} onZmiana={(siec: Siec) => zmien({ linki: blok.linki.map((x, j) => (j === i ? { ...x, siec } : x)) })} opcje={(Object.keys(SIECI) as Siec[]).map((k) => ({ wartosc: k, etykieta: SIECI[k].etykieta }))} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <PoleUrl etykieta={i === 0 ? "Adres profilu" : ""} wartosc={l.url} onZmiana={(url) => zmien({ linki: blok.linki.map((x, j) => (j === i ? { ...x, url } : x)) }, `social-${i}`)} />
                  </div>
                  <button type="button" aria-label={`Usuń ${SIECI[l.siec].etykieta}`} onClick={() => zmien({ linki: blok.linki.filter((_, j) => j !== i) })} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--color-tekst-3)] hover:bg-[var(--color-blad-tlo)] hover:text-[var(--color-blad)]">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            {blok.linki.length < 8 ? (
              <button
                type="button"
                className="przycisk przycisk-wtorny przycisk-maly"
                onClick={() => {
                  const wolna = (Object.keys(SIECI) as Siec[]).find((s) => !blok.linki.some((l) => l.siec === s)) ?? "www";
                  zmien({ linki: [...blok.linki, { siec: wolna, url: "" }] });
                }}
              >
                <Plus size={14} /> Dodaj profil
              </button>
            ) : null}
          </Sekcja>
        );
      case "stopka":
        return (
          <Sekcja tytul="Stopka" opis="Nazwę, adres i NIP firmy oraz link do wypisania się dodajemy pod każdym mailem sami, z ustawień konta. Tu wpisz to, co chcesz dodać od siebie, np. kontakt.">
            <PoleKoloru etykieta="Kolor tekstu" wartosc={blok.kolor} pusty="Szary domyślny" zastepczy="#868d97" onZmiana={(kolor) => zmien({ kolor }, "kolor")} />
            <Wyrownanie wartosc={blok.wyrownanie} onZmiana={(wyrownanie) => zmien({ wyrownanie })} />
          </Sekcja>
        );
      case "html":
        return (
          <Sekcja tytul="Własny HTML" opis="Wstawiany do maila bez zmian. Kliknięcia w linki do stron policzymy, stopkę z wypisem dodajemy sami.">
            <PoleTekstu etykieta="Kod HTML" wartosc={blok.html} onZmiana={(html) => zmien({ html }, "html")} wielolinijkowe={14} mono placeholder={'<p>Treść…</p>\n<p><a href="https://sklep.pl">Link</a></p>'} maks={200000} />
          </Sekcja>
        );
    }
  })();

  return (
    <>
      <div className="flex h-12 items-center gap-2 border-b border-[var(--color-linia)] px-4">
        <h2 className="text-[14px]">{NAZWY_BLOKOW[blok.typ]}</h2>
        <span className="text-[12px] text-[var(--color-tekst-3)]">właściwości bloku</span>
      </div>
      {uwagi.length ? (
        <div className="border-b border-[var(--color-czeka-ramka)] bg-[var(--color-czeka-tlo)] px-4 py-3 text-[12px] leading-[17px] text-[var(--color-czeka)]">
          <ul className="space-y-1">
            {uwagi.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {tresc}
      <Oprawa blok={blok} zmien={zmien} styl={styl} />
    </>
  );
}

export function StyleGlobalne({ styl, zmien }: { styl: StyleMaila; zmien: (z: Partial<StyleMaila>, klucz?: string) => void }) {
  return (
    <>
      <div className="flex h-12 items-center gap-2 border-b border-[var(--color-linia)] px-4">
        <h2 className="text-[14px]">Style maila</h2>
        <span className="text-[12px] text-[var(--color-tekst-3)]">nic nie zaznaczono</span>
      </div>
      <Sekcja tytul="Kolory" opis="Kliknij blok na płótnie, żeby zmienić tylko jego wygląd.">
        <PoleKoloru etykieta="Kolor marki (przyciski, linki, ceny)" wartosc={styl.kolorMarki} onZmiana={(kolorMarki) => zmien({ kolorMarki }, "kolorMarki")} />
        <PoleKoloru etykieta="Kolor tekstu" wartosc={styl.kolorTekstu} onZmiana={(kolorTekstu) => zmien({ kolorTekstu }, "kolorTekstu")} />
        <PoleKoloru etykieta="Tło treści" wartosc={styl.tloTresci} onZmiana={(tloTresci) => zmien({ tloTresci }, "tloTresci")} />
      </Sekcja>
      <Sekcja tytul="Typografia">
        <Wybor etykieta="Krój pisma" wartosc={styl.kroj} onZmiana={(kroj: Kroj) => zmien({ kroj })} opcje={(Object.keys(KROJE) as Kroj[]).map((k) => ({ wartosc: k, etykieta: KROJE[k].etykieta }))} />
        <p className="text-[12px] leading-[17px] text-[var(--color-tekst-3)]">
          Tylko kroje bezpieczne dla poczty — każdy klient pocztowy ma je u siebie, więc mail wygląda wszędzie tak samo.
        </p>
      </Sekcja>
    </>
  );
}

export type { BlokTypu };
