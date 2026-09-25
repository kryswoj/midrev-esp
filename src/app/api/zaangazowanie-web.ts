import { isIP } from "node:net";

/**
 * Wspólne dla DWÓCH tras publicznych, które zapisują zaangażowanie: redirectu kliknięć
 * (`/r/[token]`) i pixela otwarć (`/api/o/[token]`).
 *
 * Obie mają tę samą, nietypową charakterystykę: są osiągalne z sieci BEZ SESJI, bo
 * uruchamia je odbiorca maila (albo maszyna po drodze), a ich zapis NIE MOŻE popsuć
 * doświadczenia odbiorcy. Człowiek ma zobaczyć stronę sklepu i obrazek nawet wtedy, gdy
 * baza akurat mruga. Dlatego zapis jest tu świadomie „najlepszą próbą", a nie warunkiem
 * odpowiedzi — odwrotnie niż wszędzie indziej w tym systemie.
 *
 * To NIE jest miejsce na drugą heurystykę wykrywania automatu ani na drugą bramkę zgody.
 * Jedno i drugie siedzi w `zapiszZaangazowanie` i `ocenAutomat`; tutaj wyłącznie
 * wyciągamy z żądania to, czym tamte funkcje mają czym oceniać.
 */

/**
 * Adres IP żądania z nagłówków proxy. Zwraca `null`, gdy nie da się go odczytać
 * JEDNOZNACZNIE — i to jest celowe zachowanie, a nie brak staranności.
 *
 * Dwie rzeczy, o których trzeba wiedzieć, czytając potem dane z tej kolumny:
 *
 * 1. `x-forwarded-for` jest nagłówkiem od klienta. Dopóki przed aplikacją nie stoi proxy,
 *    które go NADPISUJE, każdy może wpisać tam, co chce. W `ocenAutomat` IP służy
 *    wyłącznie do rozpoznania sieci Apple (MPP), więc podszycie się pod nią może
 *    wyłącznie DODAĆ zdarzeniu etykietę „maszynowe", czyli wypchnąć je z atrybucji
 *    przychodu. Kierunek fałszerstwa jest więc zachowawczy: da się sobie zaszkodzić,
 *    nie da się dopisać sobie przychodu.
 * 2. Kolumna `ip` w `message_engagement` ma typ `inet`. Wartość, której Postgres nie
 *    przyjmie, wywróciłaby całą transakcję zapisu — czyli jeden dziwny nagłówek
 *    kasowałby prawdziwe zdarzenie. Dlatego walidujemy PRZED zapisem wbudowanym
 *    `net.isIP`, zamiast liczyć na to, że baza to jakoś przyjmie.
 */
export function adresIp(naglowki: Headers): string | null {
  // Kolejność jest znacząca: PIERWSZY wpis `x-forwarded-for` to klient, kolejne to proxy
  // po drodze. Gdyby przy śmieciu w pierwszym wpisie sięgnąć po drugi, zapisalibyśmy
  // adres pośrednika jako adres odbiorcy. Dlatego alternatywą jest wyłącznie `x-real-ip`.
  const kandydaci = [naglowki.get("x-forwarded-for")?.split(",")[0], naglowki.get("x-real-ip")];
  for (const surowy of kandydaci) {
    const kandydat = surowy?.trim();
    if (!kandydat) continue;
    // forma "[::1]:443" z niektórych proxy: bierzemy samo IP spomiędzy nawiasów
    const koniec = kandydat.indexOf("]");
    const bezNawiasow =
      kandydat.startsWith("[") && koniec !== -1 ? kandydat.slice(1, koniec) : kandydat;
    if (isIP(bezNawiasow)) return bezNawiasow;
  }
  return null;
}

/** User agent obcięty do rozmiaru, jaki i tak przyjmie kolumna. */
export function agentUzytkownika(naglowki: Headers): string | null {
  const ua = naglowki.get("user-agent")?.trim();
  return ua ? ua.slice(0, 300) : null;
}

/**
 * Czeka na zapis, ale najwyżej `limitMs` — i nigdy nie rzuca.
 *
 * Powód istnienia tej funkcji jest dosłownie taki: odbiorca kliknął link w mailu i ma
 * trafić do sklepu. Zawieszona baza nie może zamienić tego w kręcące się kółko w
 * przeglądarce, a błąd zapisu nie może zamienić tego w białą stronę z błędem. Zgubione
 * kliknięcie w statystyce jest kosztem nieporównywalnie mniejszym niż zgubiony klient.
 *
 * Po przekroczeniu limitu zapis NIE jest anulowany — leci dalej w tle i zwykle się
 * kończy. Rezygnujemy wyłącznie z czekania na niego.
 *
 * Świadomy kompromis: nieudany zapis idzie do logu, a NIE alertem do człowieka. Awaria
 * bazy przy dużej kampanii to tysiące żądań na minutę, czyli tysiące alertów — kanał
 * techniczny zamilkłby pod własnym spamem. Ceną jest to, że długa cisza w otwarciach
 * i kliknięciach wygląda jak słaba kampania, a nie jak awaria. Właściwym miejscem na
 * ten alarm jest osobny czujnik („zero zdarzeń od N minut przy trwającej wysyłce"),
 * i to jest rzecz do dołożenia, a nie coś, co ta funkcja załatwia.
 */
export async function zapiszNieblokujaco<T>(
  praca: Promise<T>,
  opis: string,
  limitMs = 2000,
): Promise<T | null> {
  let minelo: ReturnType<typeof setTimeout> | undefined;
  const bezpieczna = praca.catch((blad: unknown) => {
    console.error(`${opis}: zapis nie powiódł się, odpowiedź dla odbiorcy bez zmian`, blad);
    return null;
  });
  const limit = new Promise<null>((rozwiaz) => {
    minelo = setTimeout(() => {
      console.error(`${opis}: zapis przekroczył ${limitMs} ms, nie czekamy dłużej`);
      rozwiaz(null);
    }, limitMs);
  });
  try {
    return await Promise.race([bezpieczna, limit]);
  } finally {
    if (minelo) clearTimeout(minelo);
  }
}

/**
 * Czy cel przekierowania w ogóle nadaje się do przekierowania. Snapshot linków powstaje
 * z treści kampanii i dziś zawiera wyłącznie http(s), bo tak działa przepisywanie linków.
 * Ale ta trasa jest publiczna, a `links` to jsonb — sprawdzenie schematu kosztuje jedną
 * linijkę i zamyka drogę na `javascript:` czy `data:` w razie, gdyby cokolwiek kiedyś
 * wpisało do snapshotu coś innego.
 */
export function celBezpieczny(url: string): boolean {
  try {
    const schemat = new URL(url).protocol;
    return schemat === "http:" || schemat === "https:";
  } catch {
    return false;
  }
}
