/**
 * Strefa czasu planu wysyłki (audyt 24.09, #6).
 *
 * Pole `<input type="datetime-local">` nie zna strefy: przysyła „2026-11-27T08:00", a
 * etykieta w panelu obiecuje „czas polski". Serwer stoi w UTC, więc `new Date(surowa)`
 * dawało 08:00 UTC = 09:00/10:00 w Polsce i kampania na Black Friday o ósmej rano
 * wychodziła w południe. Tu obie strony (parsowanie i renderowanie wartości pola)
 * są liczone JAWNIE w `Europe/Warsaw`, bez zależności: `Intl.DateTimeFormat` podaje
 * części daty w zadanej strefie, a przesunięcie wyprowadzamy z różnicy między nimi
 * a chwilą UTC. Działa dla CET (zima, +1) i CEST (lato, +2), także w dniu zmiany czasu.
 */

export const STREFA_PANELU = "Europe/Warsaw";

interface Czesci {
  rok: number;
  miesiac: number;
  dzien: number;
  godzina: number;
  minuta: number;
  sekunda: number;
}

function czesciWStrefie(d: Date, strefa: string): Czesci {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: strefa,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const c of f.formatToParts(d)) {
    if (c.type !== "literal") p[c.type] = Number(c.value);
  }
  return { rok: p.year, miesiac: p.month, dzien: p.day, godzina: p.hour % 24, minuta: p.minute, sekunda: p.second };
}

/** Przesunięcie strefy względem UTC (w minutach) w chwili `d`. Warszawa: 60 zimą, 120 latem. */
export function przesuniecieMinut(d: Date, strefa = STREFA_PANELU): number {
  const c = czesciWStrefie(d, strefa);
  const jakUtc = Date.UTC(c.rok, c.miesiac - 1, c.dzien, c.godzina, c.minuta, c.sekunda);
  // Date.UTC milisekundy vs d z obciętymi milisekundami (formatToParts ich nie podaje)
  return Math.round((jakUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

const WZORZEC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * „YYYY-MM-DDTHH:mm" (wartość datetime-local) odczytana jako czas polski → chwila UTC.
 * `null` przy niepoprawnym formacie albo nieistniejącej dacie (31.02, 25:00).
 *
 * Godzina z luki przy zmianie czasu (np. 2:30 w ostatnią niedzielę marca nie istnieje)
 * ląduje o godzinę później, tak jak robią to systemy operacyjne; godzina powtórzona
 * w październiku bierze wcześniejsze wystąpienie (jeszcze CEST).
 */
export function parsujCzasPolski(surowa: string, strefa = STREFA_PANELU): Date | null {
  const m = WZORZEC.exec(surowa.trim());
  if (!m) return null;
  const [rok, miesiac, dzien, godzina, minuta, sekunda] = m.slice(1).map((x) => Number(x ?? 0));
  if (miesiac < 1 || miesiac > 12 || dzien < 1 || dzien > 31 || godzina > 23 || minuta > 59 || sekunda > 59) return null;
  // „jakby UTC", potem korekta o przesunięcie strefy policzone dla tej chwili;
  // druga iteracja domyka przypadek, w którym pierwsze przybliżenie leży po drugiej
  // stronie zmiany czasu niż wynik
  const naiwna = Date.UTC(rok, miesiac - 1, dzien, godzina, minuta, sekunda);
  let wynik = new Date(naiwna - przesuniecieMinut(new Date(naiwna), strefa) * 60_000);
  wynik = new Date(naiwna - przesuniecieMinut(wynik, strefa) * 60_000);
  // data nieistniejąca (31.02) przesuwa się w Date.UTC na marzec: odrzucamy
  const kontrola = czesciWStrefie(wynik, strefa);
  if (kontrola.miesiac !== miesiac || kontrola.dzien !== dzien) {
    // dopuszczalna jest wyłącznie różnica z luki przy zmianie czasu (ta sama doba)
    return null;
  }
  return wynik;
}

/** Chwila UTC → wartość dla pola datetime-local w czasie polskim („YYYY-MM-DDTHH:mm"). */
export function naPoleCzasuPolskiego(d: Date | string | null | undefined, strefa = STREFA_PANELU): string {
  if (!d) return "";
  const data = new Date(d);
  if (Number.isNaN(data.getTime())) return "";
  const c = czesciWStrefie(data, strefa);
  const dwa = (n: number) => String(n).padStart(2, "0");
  return `${c.rok}-${dwa(c.miesiac)}-${dwa(c.dzien)}T${dwa(c.godzina)}:${dwa(c.minuta)}`;
}
