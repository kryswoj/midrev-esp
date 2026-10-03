"use client";

import { Copy, Info, Plus, Trash2, X } from "lucide-react";
import { KROJE, type Kroj } from "../../../../../domain/email/bloki/schemat";
import {
  NAZWY_AKCJI,
  NAZWY_BLOKOW,
  NAZWY_TYPOW,
  type AkcjaPrzycisku,
  type Blok,
  type DefinicjaFormularza,
  type KrojFormularza,
  type Krok,
  type StylFormularza,
  type TypFormularza,
} from "../../../../../domain/formularze/model";
import { PoleKoloru, PoleTekstu, PoleUrl, Przelacznik, Pole, Sekcja, Segmenty, Suwak, Wybor } from "../../kampanie/[campaignId]/tresc/edytor/kontrolki";
import { PoleObrazu } from "../../kampanie/[campaignId]/tresc/edytor/pole-obrazu";

/**
 * Prawy panel buildera: właściwości zaznaczonego bloku albo (bez zaznaczenia) krok,
 * ustawienia formularza, wygląd i teaser. Kontrolki z edytora maili, żeby panel wyglądał
 * i działał tak samo w całym produkcie.
 */

export function Notka({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 rounded-lg bg-[var(--color-powierzchnia-2)] px-3 py-2 text-[12px] leading-[17px] text-[var(--color-tekst-2)]">
      <Info size={14} className="mt-px shrink-0 text-[var(--color-tekst-3)]" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function PoleWieloliniowe({ etykieta, wartosc, onZmiana, wiersze = 3, maks, autoFocus, podpowiedz }: { etykieta: string; wartosc: string; onZmiana: (w: string) => void; wiersze?: number; maks: number; autoFocus?: boolean; podpowiedz?: React.ReactNode }) {
  return (
    <Pole etykieta={etykieta} podpowiedz={podpowiedz}>
      {(id) => <textarea id={id} rows={wiersze} value={wartosc} maxLength={maks} autoFocus={autoFocus} onChange={(e) => onZmiana(e.target.value)} className="pole" />}
    </Pole>
  );
}

function PoleJednoliniowe({ etykieta, wartosc, onZmiana, maks, autoFocus, podpowiedz, placeholder }: { etykieta: string; wartosc: string; onZmiana: (w: string) => void; maks: number; autoFocus?: boolean; podpowiedz?: React.ReactNode; placeholder?: string }) {
  return (
    <Pole etykieta={etykieta} podpowiedz={podpowiedz}>
      {(id) => <input id={id} value={wartosc} maxLength={maks} autoFocus={autoFocus} placeholder={placeholder} onChange={(e) => onZmiana(e.target.value)} className="pole" />}
    </Pole>
  );
}

export function WlasciwosciBloku({
  blok,
  zmien,
  onUsun,
  onDuplikuj,
  onZamknij,
  wersjaKlauzuli,
  sukces,
}: {
  blok: Blok;
  zmien: (z: Partial<Blok>) => void;
  onUsun: () => void;
  onDuplikuj: () => void;
  onZamknij: () => void;
  wersjaKlauzuli: number | null;
  sukces: boolean;
}) {
  const jedyny = blok.typ === "email" || blok.typ === "zgoda";
  return (
    <div>
      <div className="flex h-12 items-center justify-between border-b border-[var(--color-linia)] pl-4 pr-2">
        <h2 className="text-[14px]">{NAZWY_BLOKOW[blok.typ]}</h2>
        <button type="button" onClick={onZamknij} aria-label="Zamknij właściwości (Esc)" title="Esc" className="grid h-8 w-8 place-items-center rounded-lg text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)]">
          <X size={16} />
        </button>
      </div>
      <Sekcja tytul="Treść">
        <Tresc blok={blok} zmien={zmien} wersjaKlauzuli={wersjaKlauzuli} sukces={sukces} />
      </Sekcja>
      <div className="flex gap-2 px-4 py-4">
        {!jedyny ? (
          <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={onDuplikuj}>
            <Copy size={14} /> Duplikuj
          </button>
        ) : null}
        <button type="button" className="przycisk przycisk-wtorny przycisk-maly text-[var(--color-blad)]" onClick={onUsun}>
          <Trash2 size={14} /> Usuń blok
        </button>
      </div>
    </div>
  );
}

function Tresc({ blok, zmien, wersjaKlauzuli, sukces }: { blok: Blok; zmien: (z: Partial<Blok>) => void; wersjaKlauzuli: number | null; sukces: boolean }) {
  switch (blok.typ) {
    case "naglowek":
      return (
        <>
          <PoleWieloliniowe etykieta="Tekst nagłówka" wartosc={blok.tekst} onZmiana={(tekst) => zmien({ tekst })} wiersze={2} maks={200} autoFocus />
          <Suwak etykieta="Wielkość" wartosc={blok.rozmiar} onZmiana={(rozmiar) => zmien({ rozmiar })} min={16} maks={48} />
        </>
      );
    case "tekst":
      return <PoleWieloliniowe etykieta="Tekst" wartosc={blok.tekst} onZmiana={(tekst) => zmien({ tekst })} wiersze={5} maks={1000} autoFocus podpowiedz="Nowa linia w polu = nowa linia w formularzu." />;
    case "obraz":
      return (
        <>
          <PoleObrazu etykieta="Obraz" wartosc={blok.url} onZmiana={(url) => zmien({ url })} />
          <PoleJednoliniowe etykieta="Opis obrazu (dla czytników ekranu)" wartosc={blok.alt} onZmiana={(alt) => zmien({ alt })} maks={200} />
          <Suwak etykieta="Szerokość" wartosc={blok.szerokosc} onZmiana={(szerokosc) => zmien({ szerokosc })} min={20} maks={100} jednostka="%" />
        </>
      );
    case "email":
      return (
        <>
          <PoleJednoliniowe etykieta="Tekst w pustym polu" wartosc={blok.placeholder} onZmiana={(placeholder) => zmien({ placeholder })} maks={120} autoFocus />
          <PoleJednoliniowe etykieta="Etykieta dla czytników ekranu" wartosc={blok.etykieta} onZmiana={(etykieta) => zmien({ etykieta })} maks={120} />
          <Notka>Pole e-mail jest zawsze wymagane. Po wysłaniu tego kroku zapisujemy profil, zgodę i wpis na listę, nawet jeśli osoba nie dokończy kolejnych kroków.</Notka>
        </>
      );
    case "imie":
    case "telefon":
      return (
        <>
          <PoleJednoliniowe etykieta="Tekst w pustym polu" wartosc={blok.placeholder} onZmiana={(placeholder) => zmien({ placeholder })} maks={120} autoFocus />
          <PoleJednoliniowe etykieta="Etykieta dla czytników ekranu" wartosc={blok.etykieta} onZmiana={(etykieta) => zmien({ etykieta })} maks={120} />
          <Przelacznik etykieta="Pole wymagane" wartosc={blok.wymagane} onZmiana={(wymagane) => zmien({ wymagane })} />
          <Notka>
            {blok.typ === "telefon"
              ? "Numer trafia do profilu, jeśli profil jeszcze go nie ma. Wysyłki SMS nie ma, więc formularz nie zbiera zgody na SMS."
              : "Imię trafia do profilu, jeśli profil jeszcze go nie ma. Formularz nie nadpisuje danych z zamówień."}
          </Notka>
        </>
      );
    case "pytanie":
      return (
        <>
          <PoleJednoliniowe etykieta="Pytanie" wartosc={blok.pytanie} onZmiana={(pytanie) => zmien({ pytanie })} maks={200} autoFocus />
          <div>
            <span className="etykieta mb-1.5 block">Odpowiedzi</span>
            <ul className="space-y-1.5">
              {blok.opcje.map((o, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <input
                    value={o}
                    maxLength={80}
                    aria-label={`Odpowiedź ${i + 1}`}
                    onChange={(e) => zmien({ opcje: blok.opcje.map((x, j) => (j === i ? e.target.value : x)) })}
                    className="pole"
                  />
                  <button type="button" aria-label={`Usuń odpowiedź ${i + 1}`} onClick={() => zmien({ opcje: blok.opcje.filter((_, j) => j !== i) })} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--color-tekst-3)] hover:bg-[var(--color-powierzchnia-2)]">
                    <X size={15} />
                  </button>
                </li>
              ))}
            </ul>
            {blok.opcje.length < 12 ? (
              <button type="button" className="przycisk przycisk-wtorny przycisk-maly mt-2" onClick={() => zmien({ opcje: [...blok.opcje, `Odpowiedź ${blok.opcje.length + 1}`] })}>
                <Plus size={14} /> Dodaj odpowiedź
              </button>
            ) : null}
          </div>
          <Przelacznik etykieta="Można wybrać kilka" wartosc={blok.wielokrotny} onZmiana={(wielokrotny) => zmien({ wielokrotny })} />
          <Przelacznik etykieta="Odpowiedź wymagana" wartosc={blok.wymagane} onZmiana={(wymagane) => zmien({ wymagane })} />
          <PoleJednoliniowe
            etykieta="Zapisz w profilu jako"
            wartosc={blok.wlasciwosc}
            onZmiana={(wlasciwosc) => zmien({ wlasciwosc: wlasciwosc.replace(/[^A-Za-z0-9_]/g, "") })}
            maks={64}
            placeholder="np. Zainteresowania"
            podpowiedz="Nazwa właściwości profilu. Po niej zbudujesz segment, np. „Zainteresowania zawiera Promocje”."
          />
        </>
      );
    case "przycisk":
      return (
        <>
          <PoleJednoliniowe etykieta="Tekst przycisku" wartosc={blok.tekst} onZmiana={(tekst) => zmien({ tekst })} maks={80} autoFocus />
          <Wybor<AkcjaPrzycisku>
            etykieta="Po kliknięciu"
            wartosc={blok.akcja}
            onZmiana={(akcja) => zmien({ akcja })}
            opcje={(sukces ? (["zamknij", "url"] as AkcjaPrzycisku[]) : (["wyslij", "dalej", "zamknij", "url"] as AkcjaPrzycisku[])).map((a) => ({ wartosc: a, etykieta: NAZWY_AKCJI[a] }))}
          />
          {blok.akcja === "url" ? <PoleUrl etykieta="Adres strony" wartosc={blok.url} onZmiana={(url) => zmien({ url })} /> : null}
          <Notka>
            {blok.akcja === "wyslij"
              ? "Sprawdza pola tego kroku. W kroku z e-mailem zapisuje osobę, w kolejnych uzupełnia jej profil. Potem przechodzi dalej (po ostatnim kroku: sukces)."
              : blok.akcja === "dalej"
                ? "Przechodzi do następnego kroku bez zapisywania pól. Dobre na „Pomiń”."
                : blok.akcja === "zamknij"
                  ? "Zamyka formularz. Po zamknięciu pokaże się teaser, jeśli jest włączony."
                  : "Otwiera podany adres w tej samej karcie."}
          </Notka>
        </>
      );
    case "zgoda":
      return (
        <>
          <PoleWieloliniowe etykieta="Treść zgody" wartosc={blok.tekst} onZmiana={(tekst) => zmien({ tekst })} wiersze={6} maks={2000} autoFocus />
          <PoleUrl etykieta="Adres polityki prywatności" wartosc={blok.adresPolityki} onZmiana={(adresPolityki) => zmien({ adresPolityki })} placeholder="https://twojsklep.pl/polityka-prywatnosci" />
          <Notka>
            Pole wyboru jest zawsze niezaznaczone i bez niego zapis nie przejdzie. Ten tekst zapisujemy w rejestrze zgód jako dowód.
            {wersjaKlauzuli ? ` Na stronie obowiązuje wersja ${wersjaKlauzuli}. Zmiana tekstu albo linku utworzy nową wersję przy publikacji.` : ""}
          </Notka>
        </>
      );
    case "kod":
      return (
        <>
          <PoleJednoliniowe etykieta="Kod rabatowy" wartosc={blok.kod} onZmiana={(kod) => zmien({ kod: kod.replace(/\s+/g, "").toUpperCase() })} maks={60} autoFocus />
          <PoleJednoliniowe etykieta="Opis nad kodem" wartosc={blok.opis} onZmiana={(opis) => zmien({ opis })} maks={120} />
          <Notka>Kod pokazujemy dopiero po zapisie: nie ma go w skrypcie na stronie, więc nikt nie wyciągnie go bez podania adresu. Utwórz ten sam kod w sklepie.</Notka>
        </>
      );
    case "nie_dziekuje":
      return <PoleJednoliniowe etykieta="Tekst linku" wartosc={blok.tekst} onZmiana={(tekst) => zmien({ tekst })} maks={80} autoFocus podpowiedz="Zamyka formularz, tak jak krzyżyk." />;
  }
}

const KROJE_OPCJE: { wartosc: KrojFormularza; etykieta: string }[] = [
  { wartosc: "strona", etykieta: "Jak na stronie sklepu" },
  ...(Object.keys(KROJE) as Kroj[]).filter((k) => k !== "systemowy").map((k) => ({ wartosc: k as KrojFormularza, etykieta: KROJE[k].etykieta })),
  { wartosc: "systemowy", etykieta: KROJE.systemowy.etykieta },
];

export function UstawieniaFormularza({
  def,
  krok,
  zmienDef,
  zmienStyl,
  zmienNazweKroku,
  listy,
  onDuplikujKrok,
  onUsunKrok,
  mozeUsunac,
  sukces,
}: {
  def: DefinicjaFormularza;
  krok: Krok;
  zmienDef: (f: (d: DefinicjaFormularza) => DefinicjaFormularza) => void;
  zmienStyl: (z: Partial<StylFormularza>) => void;
  zmienNazweKroku: (n: string) => void;
  listy: { id: string; name: string }[];
  onDuplikujKrok: () => void;
  onUsunKrok: () => void;
  mozeUsunac: boolean;
  sukces: boolean;
}) {
  const s = def.styl;
  return (
    <div>
      <Sekcja tytul={sukces ? "Ten krok: sukces" : "Ten krok"} opis={sukces ? "Pokazuje się po zapisie. Tu stoi kod rabatowy." : "Treść kroku edytujesz na podglądzie: kliknij blok."}>
        <PoleJednoliniowe etykieta="Nazwa kroku" wartosc={krok.nazwa} onZmiana={zmienNazweKroku} maks={60} />
        {!sukces ? (
          <div className="flex gap-2">
            <button type="button" className="przycisk przycisk-wtorny przycisk-maly" onClick={onDuplikujKrok}>
              <Copy size={14} /> Duplikuj krok
            </button>
            {mozeUsunac ? (
              <button type="button" className="przycisk przycisk-wtorny przycisk-maly text-[var(--color-blad)]" onClick={onUsunKrok}>
                <Trash2 size={14} /> Usuń krok
              </button>
            ) : null}
          </div>
        ) : null}
      </Sekcja>
      <Sekcja tytul="Cały formularz" opis="Te ustawienia dotyczą wszystkich kroków.">
        <Segmenty<TypFormularza>
          etykieta="Typ"
          wartosc={def.typ}
          onZmiana={(typ) => zmienDef((d) => ({ ...d, typ, teaser: typ === "embed" ? { ...d.teaser, wlaczony: false } : d.teaser }))}
          opcje={(["popup", "flyout", "embed"] as TypFormularza[]).map((t) => ({ wartosc: t, etykieta: t === "popup" ? "Popup" : t === "flyout" ? "W rogu" : "Osadzony", opis: NAZWY_TYPOW[t].opis }))}
        />
        <Pole etykieta="Zapisz na listę" podpowiedz="Osoba trafia na listę po zapisie. To uruchamia automatyzacje z wyzwalaczem „dołączenie do listy”.">
          {(id) => (
            <select id={id} className="pole" value={def.listaId ?? ""} onChange={(e) => zmienDef((d) => ({ ...d, listaId: e.target.value || null }))}>
              <option value="">Nie zapisuj na żadną listę</option>
              {listy.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </Pole>
      </Sekcja>
      <Sekcja tytul="Wygląd całego formularza">
        <Suwak etykieta="Szerokość maksymalna" wartosc={s.szerokosc} onZmiana={(szerokosc) => zmienStyl({ szerokosc })} min={280} maks={760} />
        <p className="-mt-2 text-[12px] leading-[17px] text-[var(--color-tekst-3)]">Na telefonie formularz zajmuje szerokość ekranu z marginesem 16 px.</p>
        <div className="grid grid-cols-2 gap-3">
          <PoleKoloru etykieta="Tło" wartosc={s.tlo} onZmiana={(tlo) => zmienStyl({ tlo })} />
          <PoleKoloru etykieta="Tekst" wartosc={s.kolorTekstu} onZmiana={(kolorTekstu) => zmienStyl({ kolorTekstu })} />
          <PoleKoloru etykieta="Przycisk" wartosc={s.kolorPrzycisku} onZmiana={(kolorPrzycisku) => zmienStyl({ kolorPrzycisku })} />
          <PoleKoloru etykieta="Tekst przycisku" wartosc={s.kolorTekstuPrzycisku} onZmiana={(kolorTekstuPrzycisku) => zmienStyl({ kolorTekstuPrzycisku })} />
        </div>
        <Wybor<KrojFormularza> etykieta="Krój pisma" wartosc={s.kroj} onZmiana={(kroj) => zmienStyl({ kroj })} opcje={KROJE_OPCJE} />
        {s.kroj === "strona" ? <p className="-mt-2 text-[12px] leading-[17px] text-[var(--color-tekst-3)]">W podglądzie widzisz krój panelu. W sklepie formularz przejmie krój strony, więc wiersze mogą się łamać trochę inaczej.</p> : null}
        <Suwak etykieta="Zaokrąglenie rogów" wartosc={s.zaokraglenie} onZmiana={(zaokraglenie) => zmienStyl({ zaokraglenie })} min={0} maks={32} />
        <Segmenty etykieta="Wyrównanie" wartosc={s.wyrownanie} onZmiana={(wyrownanie) => zmienStyl({ wyrownanie })} opcje={[{ wartosc: "lewo", etykieta: "Do lewej", opis: "Tekst do lewej" }, { wartosc: "srodek", etykieta: "Do środka", opis: "Tekst wyśrodkowany" }]} />
        {def.typ === "popup" ? <Suwak etykieta="Przyciemnienie strony pod popupem" wartosc={s.nakladka} onZmiana={(nakladka) => zmienStyl({ nakladka })} min={0} maks={90} jednostka="%" /> : null}
        {def.typ !== "popup" ? <Segmenty etykieta="Róg ekranu" wartosc={s.rog} onZmiana={(rog) => zmienStyl({ rog })} opcje={[{ wartosc: "lewo", etykieta: "Lewy dół", opis: "Lewy dolny róg" }, { wartosc: "prawo", etykieta: "Prawy dół", opis: "Prawy dolny róg" }]} /> : null}
      </Sekcja>
      <Sekcja tytul="Obraz formularza" opis="Zdjęcie obok treści albo w tle. Na telefonie boczne zdjęcie przechodzi nad treść.">
        <Wybor
          etykieta="Położenie"
          wartosc={s.obrazPozycja}
          onZmiana={(obrazPozycja) => zmienStyl({ obrazPozycja })}
          opcje={[
            { wartosc: "brak", etykieta: "Bez obrazu" },
            { wartosc: "lewo", etykieta: "Z lewej" },
            { wartosc: "prawo", etykieta: "Z prawej" },
            { wartosc: "gora", etykieta: "Nad treścią" },
            { wartosc: "tlo", etykieta: "W tle" },
          ]}
        />
        {s.obrazPozycja !== "brak" ? <PoleObrazu etykieta="Plik obrazu" wartosc={s.obraz} onZmiana={(obraz) => zmienStyl({ obraz })} /> : null}
      </Sekcja>
      {def.typ !== "embed" ? (
        <Sekcja tytul="Teaser" opis="Mała zakładka w rogu po zamknięciu formularza. Kliknięcie otwiera go znowu.">
          <Przelacznik etykieta="Pokazuj teaser po zamknięciu" wartosc={def.teaser.wlaczony} onZmiana={(wlaczony) => zmienDef((d) => ({ ...d, teaser: { ...d.teaser, wlaczony, tekst: d.teaser.tekst || "Odbierz rabat" } }))} />
          {def.teaser.wlaczony ? <PoleTekstu etykieta="Tekst zakładki" wartosc={def.teaser.tekst} onZmiana={(tekst) => zmienDef((d) => ({ ...d, teaser: { ...d.teaser, tekst } }))} maks={60} /> : null}
        </Sekcja>
      ) : null}
    </div>
  );
}

/** Prawy panel, gdy zaznaczony jest teaser: tylko to, co go dotyczy. */
export function UstawieniaTeasera({ def, zmienDef, zmienStyl }: { def: DefinicjaFormularza; zmienDef: (f: (d: DefinicjaFormularza) => DefinicjaFormularza) => void; zmienStyl: (z: Partial<StylFormularza>) => void }) {
  return (
    <div>
      <Sekcja tytul="Teaser" opis="Mała zakładka w rogu ekranu. Pokazuje się po zamknięciu formularza bez zapisu i wraca na kolejnych stronach, dopóki osoba jej nie ukryje. Kliknięcie otwiera formularz od pierwszego kroku.">
        <Przelacznik etykieta="Pokazuj teaser po zamknięciu" wartosc={def.teaser.wlaczony} onZmiana={(wlaczony) => zmienDef((d) => ({ ...d, teaser: { ...d.teaser, wlaczony, tekst: d.teaser.tekst || "Odbierz rabat" } }))} />
        <PoleTekstu etykieta="Tekst zakładki" wartosc={def.teaser.tekst} onZmiana={(tekst) => zmienDef((d) => ({ ...d, teaser: { ...d.teaser, tekst } }))} maks={60} />
        <Segmenty etykieta="Róg ekranu" wartosc={def.styl.rog} onZmiana={(rog) => zmienStyl({ rog })} opcje={[{ wartosc: "lewo", etykieta: "Lewy dół", opis: "Lewy dolny róg" }, { wartosc: "prawo", etykieta: "Prawy dół", opis: "Prawy dolny róg" }]} />
        <Notka>Kolory teasera to kolory przycisku formularza (zmienisz je w ustawieniach kroku).</Notka>
      </Sekcja>
    </div>
  );
}
