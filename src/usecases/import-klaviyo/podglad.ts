import { getPool } from "../../adapters/db/pool";
import { wykluczoneGlobalnie } from "../../adapters/db/wykluczenia";
import { dopasuj } from "./analiza";
import { czytajCsv } from "./csv";
import { otworzPlik, plikIstnieje, sciezkaPliku } from "./pliki";
import type { PoleProfilu, PoleSupresji } from "./mapowanie";
import { normalizujWiersz, normalizujWierszSupresji, POWOD_SUPRESJI, type RodzajSupresji, type WierszProfilu } from "./wiersz";
import type { PrzebiegImportu } from "./zadania";

/**
 * Podglad przed wykonaniem (NFR6: efekty uboczne policzone PRZED uruchomieniem). Czyta
 * pliki ta sama normalizacja, ktora potem wykonuje import, i sprawdza w bazie, co juz
 * istnieje. Niczego nie zapisuje.
 */

export interface PlanSupresji {
  wierszy: number;
  bledy: number;
  unikalne: number;
  duplikaty: number;
  /** wg rodzaju, po deduplikacji */
  wgRodzaju: Record<RodzajSupresji, number>;
  bezDaty: number;
  /** ile z nich juz jest wykluczonych (odpowiednio globalnie / w sklepie) */
  juzWykluczone: number;
}

export interface PlanImportu {
  wierszy: number;
  bledy: number;
  duplikaty: number;
  unikalne: number;
  istniejace: number;
  nowe: number;
  /** ile dostanie zgode 'granted' po WSZYSTKICH wykluczeniach */
  zeZgoda: number;
  /** status SUBSCRIBED bez czytelnej daty: profil bez zgody */
  zgodaBezDaty: number;
  /** UNSUBSCRIBED w pliku profili: trafia do wykluczen sklepu */
  wypisani: number;
  /** kolumna supresji Klaviyo niepusta */
  supresjaKlaviyo: number;
  /** osoby z pliku profili, ktore trafia do wykluczen sklepu (UNSUBSCRIBED lub supresja; bez podwojnego liczenia) */
  doWypisow: number;
  /** kandydaci do zgody, ktorych blokuje globalna lista (skargi/odbicia) - supresja wygrywa */
  naSupresjiGlobalnej: number;
  /** kandydaci do zgody wypisani wczesniej z tego sklepu (rejestr) */
  wykluczeniWSklepie: number;
  /** kandydaci do zgody obecni w pliku supresji tego importu */
  wPlikuSupresji: number;
  bezZgody: number;
  doListy: number;
  listaId: string | null;
  listaNazwa: string | null;
  supresje: PlanSupresji | null;
  supresjePominiete: boolean;
  probka: ProbkaWiersza[];
  policzonoAt: string;
}

export interface ProbkaWiersza {
  linia: number;
  email: string;
  imie: string | null;
  nazwisko: string | null;
  zgoda: "granted" | "unsubscribed" | "none";
  zgodaData: string | null;
  uwagi: string[];
  blad: string | null;
}

const PARTIA = 5000;

async function istniejaceKlucze(tenantId: string, klucze: string[]): Promise<Set<string>> {
  const wynik = new Set<string>();
  for (let i = 0; i < klucze.length; i += PARTIA) {
    const { rows } = await getPool().query<{ klucz: string }>(
      `select lower(btrim(email)) as klucz from profiles
        where tenant_id = $1 and lower(btrim(email)) = any($2::text[])`,
      [tenantId, klucze.slice(i, i + PARTIA)],
    );
    for (const r of rows) wynik.add(r.klucz);
  }
  return wynik;
}

/**
 * Globalna lista wykluczen przez WSPOLNA funkcje (adapters/db/wykluczenia.ts): trafienie
 * po adresie ALBO po kluczowanym haszu (0022), dokladnie jak w bramce wysylki. Osoba
 * zanonimizowana (wiersz bez adresu, z samym haszem) nie wroci do bazy jawnie przez
 * import. Partiami, bo plik moze miec setki tysiecy adresow.
 */
export async function globalnieWykluczone(klucze: string[]): Promise<Set<string>> {
  const wynik = new Set<string>();
  for (let i = 0; i < klucze.length; i += PARTIA) {
    for (const k of await wykluczoneGlobalnie(klucze.slice(i, i + PARTIA))) wynik.add(k);
  }
  return wynik;
}

export async function wykluczoneWSklepie(tenantId: string, klucze: string[]): Promise<Set<string>> {
  const wynik = new Set<string>();
  for (let i = 0; i < klucze.length; i += PARTIA) {
    const { rows } = await getPool().query<{ klucz: string }>(
      `select klucz from (
         select distinct on (lower(btrim(email))) lower(btrim(email)) as klucz, action
           from tenant_suppressions
          where tenant_id = $1 and lower(btrim(email)) = any($2::text[])
          order by lower(btrim(email)), occurred_at desc, id desc
       ) s where action = 'suppressed'`,
      [tenantId, klucze.slice(i, i + PARTIA)],
    );
    for (const r of rows) wynik.add(r.klucz);
  }
  return wynik;
}

/**
 * Przejscie po pliku supresji: zbior kluczy per rodzaj. Zwraca tez liczby do planu.
 * Deduplikacja: przy dwoch wpisach tego samego adresu wygrywa mocniejszy (globalny).
 */
export async function przeczytajSupresje(
  sciezka: string,
  mapowanie: PoleSupresji[],
): Promise<{ rodzaje: Map<string, RodzajSupresji>; daty: Map<string, Date | null>; wierszy: number; bledy: number; duplikaty: number; bezDaty: number }> {
  const rodzaje = new Map<string, RodzajSupresji>();
  const daty = new Map<string, Date | null>();
  let wierszy = 0;
  let bledy = 0;
  let duplikaty = 0;
  let bezDaty = 0;
  let pierwszy = true;
  for await (const rekord of czytajCsv(otworzPlik(sciezka))) {
    if (pierwszy) {
      pierwszy = false;
      continue;
    }
    wierszy += 1;
    if (rekord.blad) {
      bledy += 1;
      continue;
    }
    const w = normalizujWierszSupresji(rekord.linia, dopasuj(rekord.pola, mapowanie.length), mapowanie);
    if (!w.ok) {
      bledy += 1;
      continue;
    }
    const byl = rodzaje.get(w.wiersz.klucz);
    if (byl) {
      duplikaty += 1;
      if (!POWOD_SUPRESJI[byl].globalna && POWOD_SUPRESJI[w.wiersz.rodzaj].globalna) rodzaje.set(w.wiersz.klucz, w.wiersz.rodzaj);
      continue;
    }
    rodzaje.set(w.wiersz.klucz, w.wiersz.rodzaj);
    daty.set(w.wiersz.klucz, w.wiersz.data);
    if (!w.wiersz.data) bezDaty += 1;
  }
  return { rodzaje, daty, wierszy, bledy, duplikaty, bezDaty };
}

export async function policzPlan(tenantId: string, job: PrzebiegImportu): Promise<PlanImportu> {
  const mapowanie = job.mapping as PoleProfilu[];
  const naglowki = job.headers;
  const sciezka = sciezkaPliku(tenantId, job.id, "profiles");
  if (!(await plikIstnieje(sciezka))) throw new Error("Plik profili zniknął z dysku. Wgraj go ponownie.");

  // krok 1: plik supresji (jesli jest), bo rozstrzyga, kto NIE dostanie zgody
  let supresje: PlanSupresji | null = null;
  let kluczeSupresji = new Map<string, RodzajSupresji>();
  if (job.suppression_file_name && job.suppression_mapping) {
    const sciezkaS = sciezkaPliku(tenantId, job.id, "suppressions");
    if (!(await plikIstnieje(sciezkaS))) throw new Error("Plik supresji zniknął z dysku. Wgraj go ponownie.");
    const s = await przeczytajSupresje(sciezkaS, job.suppression_mapping);
    kluczeSupresji = s.rodzaje;
    const wgRodzaju: Record<RodzajSupresji, number> = { wypis: 0, skarga: 0, odbicie: 0, nieprawidlowy: 0, reczne: 0 };
    for (const r of s.rodzaje.values()) wgRodzaju[r] += 1;
    const globalneKlucze = [...s.rodzaje].filter(([, r]) => POWOD_SUPRESJI[r].globalna).map(([k]) => k);
    const lokalneKlucze = [...s.rodzaje].filter(([, r]) => !POWOD_SUPRESJI[r].globalna).map(([k]) => k);
    const [juzGlobalne, juzLokalne] = await Promise.all([globalnieWykluczone(globalneKlucze), wykluczoneWSklepie(tenantId, lokalneKlucze)]);
    supresje = {
      wierszy: s.wierszy,
      bledy: s.bledy,
      unikalne: s.rodzaje.size,
      duplikaty: s.duplikaty,
      wgRodzaju,
      bezDaty: s.bezDaty,
      juzWykluczone: juzGlobalne.size + juzLokalne.size,
    };
  }

  // krok 2: plik profili
  let wierszy = 0;
  let bledy = 0;
  let duplikaty = 0;
  let zgodaBezDaty = 0;
  let wypisani = 0;
  let supresjaKlaviyo = 0;
  const widziane = new Map<string, WierszProfilu>();
  const probka: ProbkaWiersza[] = [];
  let pierwszy = true;
  for await (const rekord of czytajCsv(otworzPlik(sciezka))) {
    if (pierwszy) {
      pierwszy = false;
      continue;
    }
    wierszy += 1;
    if (rekord.blad) {
      bledy += 1;
      if (probka.length < 20) probka.push({ linia: rekord.linia, email: "", imie: null, nazwisko: null, zgoda: "none", zgodaData: null, uwagi: [], blad: rekord.blad });
      continue;
    }
    const w = normalizujWiersz(rekord.linia, dopasuj(rekord.pola, naglowki.length), mapowanie, naglowki);
    if (!w.ok) {
      bledy += 1;
      if (probka.length < 20) probka.push({ linia: w.linia, email: w.email ?? "", imie: null, nazwisko: null, zgoda: "none", zgodaData: null, uwagi: [], blad: w.powod });
      continue;
    }
    const wiersz = w.wiersz;
    if (widziane.has(wiersz.klucz)) {
      duplikaty += 1;
      // duplikat pokazujemy w probce jawnie: operator ma wiedziec, ze pierwszy wiersz wygrywa
      if (probka.length < 20) probka.push({ linia: wiersz.linia, email: wiersz.email, imie: wiersz.imie, nazwisko: wiersz.nazwisko, zgoda: "none", zgodaData: null, uwagi: ["powtórzony adres, pominięty (liczy się pierwsze wystąpienie)"], blad: null });
      continue;
    }
    widziane.set(wiersz.klucz, wiersz);
    if (wiersz.uwagi.some((u) => u.startsWith("zgoda bez daty"))) zgodaBezDaty += 1;
    if (wiersz.zgoda === "unsubscribed") wypisani += 1;
    if (wiersz.supresja) supresjaKlaviyo += 1;
    if (probka.length < 20) {
      probka.push({
        linia: wiersz.linia,
        email: wiersz.email,
        imie: wiersz.imie,
        nazwisko: wiersz.nazwisko,
        zgoda: wiersz.zgoda,
        zgodaData: wiersz.zgodaData ? wiersz.zgodaData.toISOString() : null,
        uwagi: wiersz.uwagi,
        blad: null,
      });
    }
  }

  const klucze = [...widziane.keys()];
  const kandydaciZgody = klucze.filter((k) => widziane.get(k)!.zgoda === "granted");
  const [istniejace, globalne, lokalne] = await Promise.all([
    istniejaceKlucze(tenantId, klucze),
    globalnieWykluczone(kandydaciZgody),
    wykluczoneWSklepie(tenantId, kandydaciZgody),
  ]);

  let naSupresjiGlobalnej = 0;
  let wykluczeniWSklepie = 0;
  let wPlikuSupresji = 0;
  let zeZgoda = 0;
  for (const k of kandydaciZgody) {
    const zPliku = kluczeSupresji.get(k);
    // skarga/odbicie z pliku supresji trafi na liste globalna PRZED profilami, wiec
    // w wykonaniu zablokuje ja lista globalna - plan liczy to tak samo
    if (globalne.has(k) || (zPliku && POWOD_SUPRESJI[zPliku].globalna)) naSupresjiGlobalnej += 1;
    else if (lokalne.has(k)) wykluczeniWSklepie += 1;
    else if (zPliku) wPlikuSupresji += 1;
    else zeZgoda += 1;
  }
  let doWypisow = 0;
  for (const w of widziane.values()) if (w.zgoda === "unsubscribed" || w.supresja) doWypisow += 1;

  let listaNazwa: string | null = null;
  const listaId = job.options.listId ?? null;
  if (listaId) {
    const { rows } = await getPool().query("select name from lists where tenant_id = $1 and id = $2", [tenantId, listaId]);
    listaNazwa = rows[0]?.name ?? null;
    if (!listaNazwa) throw new Error("Wybrana lista nie istnieje. Wróć do mapowania i wybierz inną.");
  }

  return {
    wierszy,
    bledy,
    duplikaty,
    unikalne: klucze.length,
    istniejace: istniejace.size,
    nowe: klucze.length - istniejace.size,
    zeZgoda,
    zgodaBezDaty,
    wypisani,
    supresjaKlaviyo,
    doWypisow,
    naSupresjiGlobalnej,
    wykluczeniWSklepie,
    wPlikuSupresji,
    bezZgody: klucze.length - zeZgoda,
    doListy: listaId ? klucze.length : 0,
    listaId,
    listaNazwa,
    supresje,
    supresjePominiete: Boolean(job.options.supresjePominiete),
    probka,
    policzonoAt: new Date().toISOString(),
  };
}
