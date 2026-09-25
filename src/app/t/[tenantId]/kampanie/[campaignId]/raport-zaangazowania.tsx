import { metrykiZaangazowania } from "../../../../../usecases/wysylka/zaangazowanie";
import { zGroszy } from "../../../../../domain/kwoty";
import { odmien } from "../../../../../domain/liczebniki";

/**
 * Otwarcia i kliknięcia kampanii — z ROZDZIELONYM ruchem ludzkim i maszynowym.
 *
 * To jest cała teza tego ekranu i jedyny powód, dla którego wygląda inaczej niż raport
 * Klaviyo. Klaviyo pokazuje `opens` jako jedną liczbę, mimo że ma na zdarzeniu flagę
 * `machine_open` (KLAVIYO-MODULY 3.2). Od czasu Apple Mail Privacy Protection znaczna
 * część tej liczby to skaner Apple, który pobiera obrazek za użytkownika, zanim ten
 * cokolwiek zobaczy. Efekt: open rate rośnie, nikt nie przeczytał maila, a przy Klaviyo
 * takie otwarcie potrafi jeszcze wygrać atrybucję przychodu.
 *
 * Dlatego tutaj:
 *   - LICZBĄ GŁÓWNĄ są otwarcia ludzkie (unikalne, czyli ilu ludzi, nie ile pobrań),
 *   - maszynowe stoją obok, opisane wprost, i nigdy nie są dodawane do głównej liczby,
 *   - kliknięcia liczone są tak samo: do pieniędzy z 0007 wchodzą wyłącznie ludzkie.
 *
 * `automat is null` („nie wiemy") jest po stronie ludzkiej — tak liczy
 * `metrykiZaangazowania` i tak ma być: zdarzenie bez przesłanek nie znika z raportu.
 *
 * KOLEJNOŚĆ BLOKÓW: przychód stoi PRZED wskaźnikiem otwarć (PANELE-ESP 2.5 i 3.5).
 * Klaviyo daje open rate na samej górze, ale edrone i Omnisend stawiają pieniądze
 * pierwsze i dla sklepu to jest właściwsza hierarchia — tym bardziej że po Apple MPP
 * otwarcie jest metryką kaleką, a przychód nie.
 *
 * Komponent czyta metryki zaangażowania sam; przychód dostaje w propsach ze strony
 * kampanii, bo liczy go osobny przebieg atrybucji i nie ma sensu pytać o niego dwa razy.
 */

function procent(licznik: number, mianownik: number): string {
  if (mianownik <= 0) return "—";
  return `${((licznik / mianownik) * 100).toFixed(1).replace(".", ",")}%`;
}

export async function RaportZaangazowania({
  tenantId,
  campaignId,
  /** liczba wysłanych wiadomości; bez niej wskaźniki procentowe nie mają mianownika */
  wyslane,
  /** przychód z ostatniego przebiegu atrybucji, w groszach */
  przychodMinor,
  /** liczba zamówień z tego samego przebiegu */
  zamowien,
}: {
  tenantId: string;
  campaignId: string;
  wyslane?: number;
  przychodMinor?: number;
  zamowien?: number;
}) {
  const m = await metrykiZaangazowania(tenantId, "campaign", campaignId);
  const otwarciaMaszynowe = m.otwarcia - m.otwarciaLudzkie;
  const kliknieciaMaszynowe = m.klikniecia - m.kliknieciaLudzkie;
  const podstawa = wyslane ?? 0;
  const przychod = Number(przychodMinor ?? 0);
  const zamowienia = Number(zamowien ?? 0);
  // przychód na wiadomość liczony z tych samych dwóch liczb, które stoją obok —
  // operator ma móc go sprawdzić w pamięci, a nie zaufać kaflowi na słowo
  const naWiadomosc = podstawa > 0 ? Math.round(przychod / podstawa) : null;

  return (
    <section className="karta p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2>Wyniki kampanii</h2>
        <span className="text-[13px] text-[var(--color-tekst-3)]">
          własny pixel i redirect, bez śledzenia dostawcy
        </span>
      </div>

      {/* Blok pierwszy: pieniądze. Dopiero pod nim zaangażowanie. */}
      <div className="grid gap-px overflow-hidden rounded-[10px] border border-[var(--color-linia)] bg-[var(--color-linia)] sm:grid-cols-2">
        <div className="bg-[var(--color-powierzchnia)] px-4 py-4">
          <div className="etykieta">Przychód</div>
          <div className="wielkosc-hero mt-1.5">{zGroszy(przychod)}</div>
          <div className="mt-2 text-[13px] text-[var(--color-tekst-3)]">
            {odmien(zamowienia, "zamówienie", "zamówienia", "zamówień")} z ostatniego
            przebiegu atrybucji
          </div>
        </div>

        <div className="bg-[var(--color-powierzchnia)] px-4 py-4">
          <div className="etykieta">Przychód na wiadomość</div>
          <div className="wielkosc-hero mt-1.5">
            {naWiadomosc === null ? "—" : zGroszy(naWiadomosc)}
          </div>
          <div className="mt-2 text-[13px] text-[var(--color-tekst-3)]">
            {podstawa > 0
              ? `${odmien(podstawa, "wysłana wiadomość", "wysłane wiadomości", "wysłanych wiadomości")} w mianowniku`
              : "brak wysłanych wiadomości, do czego liczyć"}
          </div>
        </div>
      </div>

      <h3 className="mt-6 mb-3">Zaangażowanie</h3>

      <div className="grid gap-px overflow-hidden rounded-[10px] border border-[var(--color-linia)] bg-[var(--color-linia)] sm:grid-cols-2">
        <div className="bg-[var(--color-powierzchnia)] px-4 py-4">
          <div className="etykieta">Otwarcia ludzkie</div>
          <div className="wielkosc-hero mt-1.5">{m.otwarciaUnikalne}</div>
          <div className="mt-2 text-[13px] text-[var(--color-tekst-3)]">
            {podstawa > 0
              ? `${procent(m.otwarciaUnikalne, podstawa)} wysłanych, ${m.otwarciaLudzkie} pobrań łącznie`
              : `${m.otwarciaLudzkie} pobrań łącznie`}
          </div>
        </div>

        <div className="bg-[var(--color-powierzchnia)] px-4 py-4">
          <div className="etykieta">Kliknięcia ludzkie</div>
          <div className="wielkosc-hero mt-1.5">{m.kliknieciaUnikalne}</div>
          <div className="mt-2 text-[13px] text-[var(--color-tekst-3)]">
            {podstawa > 0
              ? `${procent(m.kliknieciaUnikalne, podstawa)} wysłanych, `
              : ""}
            {m.otwarciaUnikalne > 0
              ? `${procent(m.kliknieciaUnikalne, m.otwarciaUnikalne)} otwierających`
              : "brak otwarć, do czego liczyć"}
          </div>
        </div>
      </div>

      {/* Maszynowe OSOBNO i z nazwy: to nie jest przypis drobnym drukiem, tylko druga
          połowa prawdy o tej kampanii. Plakietka „uwaga", nie „błąd" — ruch maszynowy
          nie jest awarią, jest stanem rynku. */}
      <div className="mt-4 grid gap-px overflow-hidden rounded-[10px] border border-[var(--color-linia)] bg-[var(--color-linia)] sm:grid-cols-2">
        <div className="bg-[var(--color-powierzchnia-2)] px-4 py-4">
          <div className="flex items-center justify-between gap-2">
            <span className="plakietka plakietka-uwaga">Otwarcia maszynowe</span>
            <span className="wielkosc">{otwarciaMaszynowe}</span>
          </div>
          <div className="mt-2 text-[13px] text-[var(--color-tekst-3)]">
            Apple MPP, proxy obrazków, skanery poczty. Nie są liczone do otwarć ludzkich
            {m.otwarcia > 0 ? ` (${procent(otwarciaMaszynowe, m.otwarcia)} wszystkich pobrań)` : ""}.
          </div>
        </div>

        <div className="bg-[var(--color-powierzchnia-2)] px-4 py-4">
          <div className="flex items-center justify-between gap-2">
            <span className="plakietka plakietka-uwaga">Kliknięcia maszynowe</span>
            <span className="wielkosc">{kliknieciaMaszynowe}</span>
          </div>
          <div className="mt-2 text-[13px] text-[var(--color-tekst-3)]">
            Skanery bezpieczeństwa klikają każdy link, zanim mail zobaczy człowiek. Do
            atrybucji przychodu nie wchodzą w ogóle.
          </div>
        </div>
      </div>

      {m.opoznienia > 0 ? (
        <div className="mt-4 text-[13px] text-[var(--color-tekst-2)]">
          <span className="liczba text-[var(--color-tekst-2)]">{m.opoznienia}</span>{" "}
          {m.opoznienia === 1 ? "opóźnienie dostarczenia" : "opóźnień dostarczenia"} zgłoszone
          przez dostawcę — to stan transportu, nie zachowanie odbiorcy.
        </div>
      ) : null}

      <p className="mt-4 max-w-[74ch] text-[13px] leading-[20px] text-[var(--color-tekst-3)]">
        Otwarcia ludzkie liczymy po odbiorcach, nie po pobraniach obrazka. Zdarzenie,
        którego nie umiemy rozstrzygnąć, jest po stronie ludzkiej — wolimy wskaźnik
        ostrożnie zawyżony o nieznane niż po cichu wycięty.
      </p>
    </section>
  );
}
