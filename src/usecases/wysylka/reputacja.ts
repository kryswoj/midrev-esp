import { getPool } from "../../adapters/db/pool";
import { wyslijAlert } from "../../jobs/alerty";
import { wskaznikiReputacji, type WskaznikiReputacji } from "./zaangazowanie";

/**
 * B5 z PLAN-DOWIEZIENIA-2026-09-22: progi odbić i skarg z automatycznym wstrzymaniem
 * tenanta. Do tej pory jedyną bramką był płaski limit dobowy 500 — czyli ochrona przed
 * wysłaniem ZA DUŻO, a żadna przed wysyłaniem ŹLE.
 *
 * Dlaczego to jest stan tenanta, a nie kampanii: pula IP jest wspólna (SES-BYOD-SPEC
 * sekcja 9), więc jeden nadawca ze skargami psuje dostarczalność wszystkim pozostałym.
 * Wstrzymanie musi zatrzymać wszystko, co ten tenant wysyła, a nie jedną kampanię,
 * która akurat zwróciła uwagę.
 */

/**
 * PROGI. Punkt odniesienia to progi AWS z SES-BYOD-SPEC sekcja 8, podane dosłownie:
 *
 *   odbicia:  5 procent   -> automatyczne review konta,  10 procent  -> możliwe wstrzymanie
 *   skargi:   0,1 procenta-> automatyczne review konta,  0,5 procenta-> możliwe wstrzymanie
 *
 * Zasada doboru NASZYCH progów: nasze WSTRZYMANIE ma leżeć poniżej progu REVIEW Amazona,
 * nie poniżej jego progu wstrzymania. Powód jest praktyczny, nie estetyczny — review AWS
 * jest zdarzeniem, które chcemy ominąć w całości, bo:
 *   1. konto pod review dostaje `Under review` na całą pulę, czyli na wszystkich tenantów,
 *      a nie tylko na tego, który narozrabiał;
 *   2. AWS wprost pisze, że konto, które było już pod review za to samo, może następnym
 *      razem zostać wstrzymane BEZ review, a powtarzalne problemy kończą się trwałym
 *      zawieszeniem. Pierwszy wpis w tej historii jest więc drogi sam w sobie;
 *   3. okno, na którym AWS liczy swoje wskaźniki, jest nieznane ("reprezentatywny wolumen",
 *      bez definicji liczbowej) — nie da się go odtworzyć u siebie, więc równanie do progu
 *      AWS co do przecinka jest zgadywaniem. Zapas musi pokryć ten błąd pomiaru.
 *
 * Stąd:
 *   odbicia twarde  2,0 procent = przegląd (to jest zarazem cel "poniżej 2 procent" z FAQ AWS),
 *                   4,0 procent = wstrzymanie — PONIŻEJ progu review AWS (5 procent).
 *   skargi          0,05 procenta = przegląd,
 *                   0,08 procenta = wstrzymanie — PONIŻEJ progu review AWS (0,1 procenta).
 *
 * Liczymy WŁASNE zdarzenia, nie metryki AWS: te ostatnie dojdą dopiero w Bloku D razem
 * z kontem, a wskaźnik liczony u siebie działa też na Mailpicie i na każdym następnym
 * dostawcy. Mianownik i definicje są te same co w `wskaznikiReputacji` (tylko odbicia
 * TWARDE z `counts_to_rate`, bo miękkie mówią o skrzynce odbiorcy, nie o naszej reputacji).
 */
export const PROGI = {
  odbiciaPrzeglad: 0.02,
  odbiciaWstrzymanie: 0.04,
  skargiPrzeglad: 0.0005,
  skargiWstrzymanie: 0.0008,
  /**
   * Minimalne mianowniki. Bez nich pierwsze odbicie w partii testowej na dziesięć adresów
   * daje 10 procent i wstrzymuje tenanta, który nie zrobił nic złego — a wstrzymanie
   * z fałszywego alarmu uczy operatora ignorować wstrzymania.
   *
   * 1000 dostarczonych przy skargach to nie okrągła liczba z sufitu: przy progu 0,08
   * procenta pojedyncza skarga zaczyna w ogóle mieścić się w skali dopiero przy tysiącu
   * (1/1000 = 0,1 procenta). Poniżej tego wskaźnik mówi wyłącznie o tym, że próbka jest
   * mała. Przy odbiciach próg 4 procent oznacza przy dwustu wiadomościach osiem twardych
   * odbić — to już wzorzec, nie przypadek.
   */
  minMianownikOdbic: 200,
  minDostarczoneDlaSkarg: 1000,
  /** Okno kroczące. AWS też liczy na kroczącym, nie na dobie kalendarzowej. */
  oknoGodzin: 24,
  /** Najczęstszy możliwy alert o przekroczeniu progu przeglądu. */
  odstepAlertuMin: 60,
} as const;

export type DecyzjaReputacji = "ok" | "przeglad" | "wstrzymanie";

export interface WynikProgow {
  wskazniki: WskaznikiReputacji;
  decyzja: DecyzjaReputacji;
  /** Zdanie dla człowieka: co przekroczyło próg i o ile. `null` przy decyzji "ok". */
  powod: string | null;
  /** true WYŁĄCZNIE, gdy to ten przebieg postawił wstrzymanie (a nie zastał je gotowe). */
  wstrzymanyTeraz: boolean;
  /** true, gdy tenant jest wstrzymany — niezależnie od tego, kto i kiedy go wstrzymał. */
  wstrzymany: boolean;
}

function procent(x: number): string {
  return `${(x * 100).toFixed(2).replace(".", ",")} procent`;
}

/** Stan wstrzymania tenanta. Czytany z bazy przy każdej partii, nie z pamięci procesu. */
export async function stanWysylkiTenanta(
  tenantId: string,
): Promise<{ wstrzymany: boolean; od: Date | null; powod: string | null }> {
  const { rows } = await getPool().query(
    "select sending_paused_at, sending_pause_reason from tenants where id = $1",
    [tenantId],
  );
  const w = rows[0];
  return {
    wstrzymany: Boolean(w?.sending_paused_at),
    od: w?.sending_paused_at ?? null,
    powod: w?.sending_pause_reason ?? null,
  };
}

/**
 * Sprawdzenie progów i — po przekroczeniu — wstrzymanie tenanta. Wołane:
 *   1. MIĘDZY PARTIAMI w pętli wysyłki, żeby kampania, która sypie odbiciami, stanęła
 *      po dwudziestu pięciu wiadomościach, a nie po dziesięciu tysiącach;
 *   2. cyklicznie per tenant z workera, bo skargi i odbicia przychodzą webhookami DŁUGO
 *      po tym, jak wysyłka się skończyła — wtedy żadna pętla już nie chodzi.
 *
 * Wyścig dwóch workerów: samo wstrzymanie to jeden atomowy UPDATE z warunkiem
 * `sending_paused_at is null`. Wiersz dostaje tylko jeden proces, więc alert idzie
 * dokładnie raz, a nie tyle razy, ilu workerów akurat liczyło wskaźniki.
 */
export async function sprawdzProgiReputacji(tenantId: string): Promise<WynikProgow> {
  const wskazniki = await wskaznikiReputacji(tenantId, PROGI.oknoGodzin);
  // mianowniki z wskaźników, nie liczone tu drugi raz: przy własnym SMTP (bez „delivered")
  // podstawą jest liczba przekazanych, patrz WskaznikiReputacji.podstawa
  const mianownikOdbic = wskazniki.mianownikOdbic;
  const mianownikSkarg = wskazniki.mianownikSkarg;
  const opisPodstawy = wskazniki.podstawa === "delivered" ? "dostarczonych" : "przekazanych serwerowi";

  const odbiciaLiczalne = mianownikOdbic >= PROGI.minMianownikOdbic;
  const skargiLiczalne = mianownikSkarg >= PROGI.minDostarczoneDlaSkarg;

  const powody: string[] = [];
  let decyzja: DecyzjaReputacji = "ok";

  if (odbiciaLiczalne && wskazniki.wskaznikOdbicTwardych >= PROGI.odbiciaWstrzymanie) {
    decyzja = "wstrzymanie";
    powody.push(
      `odbicia twarde ${procent(wskazniki.wskaznikOdbicTwardych)} (${wskazniki.odbiciaTwarde} z ${mianownikOdbic} ${opisPodstawy}), próg wstrzymania ${procent(PROGI.odbiciaWstrzymanie)}`,
    );
  } else if (odbiciaLiczalne && wskazniki.wskaznikOdbicTwardych >= PROGI.odbiciaPrzeglad) {
    decyzja = "przeglad";
    powody.push(
      `odbicia twarde ${procent(wskazniki.wskaznikOdbicTwardych)} (${wskazniki.odbiciaTwarde} z ${mianownikOdbic} ${opisPodstawy}), próg przeglądu ${procent(PROGI.odbiciaPrzeglad)}`,
    );
  }

  if (skargiLiczalne && wskazniki.wskaznikSkarg >= PROGI.skargiWstrzymanie) {
    decyzja = "wstrzymanie";
    powody.push(
      `skargi ${procent(wskazniki.wskaznikSkarg)} (${wskazniki.skargi} z ${mianownikSkarg} ${opisPodstawy}), próg wstrzymania ${procent(PROGI.skargiWstrzymanie)}`,
    );
  } else if (skargiLiczalne && wskazniki.wskaznikSkarg >= PROGI.skargiPrzeglad && decyzja !== "wstrzymanie") {
    decyzja = "przeglad";
    powody.push(
      `skargi ${procent(wskazniki.wskaznikSkarg)} (${wskazniki.skargi} z ${mianownikSkarg} ${opisPodstawy}), próg przeglądu ${procent(PROGI.skargiPrzeglad)}`,
    );
  }

  const powod = powody.length ? powody.join("; ") : null;
  const pool = getPool();

  if (decyzja === "wstrzymanie" && powod) {
    const tresc = `${powod} — okno ${PROGI.oknoGodzin} h`;
    const { rowCount } = await pool.query(
      `update tenants set sending_paused_at = now(), sending_pause_reason = $2
        where id = $1 and sending_paused_at is null`,
      [tenantId, tresc],
    );
    if (rowCount) {
      await wyslijAlert(
        `WYSYŁKA TENANTA ${tenantId} WSTRZYMANA automatycznie: ${tresc}. ` +
          `Nasze progi leżą poniżej progu review AWS (odbicia 5 procent, skargi 0,1 procenta), ` +
          `więc jest zapas na wyjaśnienie sprawy, zanim zobaczy ją Amazon. ` +
          `Wznowienie wyłącznie ręczne, z panelu kampanii.`,
      );
      return { wskazniki, decyzja, powod, wstrzymanyTeraz: true, wstrzymany: true };
    }
    return { wskazniki, decyzja, powod, wstrzymanyTeraz: false, wstrzymany: true };
  }

  if (decyzja === "przeglad" && powod) {
    // Dławik alertu tą samą metodą co wstrzymanie: atomowy UPDATE rozstrzyga też, który
    // z równoległych workerów ma prawo wysłać alert w tym oknie.
    const { rowCount } = await pool.query(
      `update tenants set reputation_alert_at = now()
        where id = $1
          and (reputation_alert_at is null
               or reputation_alert_at < now() - make_interval(mins => $2::int))`,
      [tenantId, PROGI.odstepAlertuMin],
    );
    if (rowCount) {
      await wyslijAlert(
        `reputacja tenanta ${tenantId} przekroczyła próg PRZEGLĄDU (wysyłka idzie dalej): ${powod} — ` +
          `okno ${PROGI.oknoGodzin} h. Przy progu wstrzymania wysyłka stanie sama.`,
      );
    }
  }

  const stan = await stanWysylkiTenanta(tenantId);
  return { wskazniki, decyzja, powod, wstrzymanyTeraz: false, wstrzymany: stan.wstrzymany };
}

/**
 * Ręczne zdjęcie wstrzymania. Świadomie BEZ automatycznego wznowienia po spadku wskaźnika:
 * wskaźnik spada sam z upływem okna 24 h, więc automat wznawiałby wysyłkę dokładnie wtedy,
 * gdy problem przestał być widoczny — a nie wtedy, gdy ktoś go naprawił.
 *
 * Zwraca kampanie, które w chwili wznowienia stały w 'sending' — job wysyłki domknął się
 * po napotkaniu wstrzymania, więc bez ponownego wepchnięcia do kolejki zostałyby w tym
 * stanie na zawsze.
 */
export async function wznowWysylkeTenanta(
  tenantId: string,
): Promise<{ wznowiony: boolean; doWznowienia: string[] }> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `update tenants set sending_paused_at = null, sending_pause_reason = null
      where id = $1 and sending_paused_at is not null`,
    [tenantId],
  );
  if (!rowCount) return { wznowiony: false, doWznowienia: [] };

  const { rows } = await pool.query(
    `select distinct c.id from campaigns c
       join messages m on m.tenant_id = c.tenant_id and m.source_type = 'campaign'
                      and m.source_id = c.id and m.current_state = 'queued'
      where c.tenant_id = $1 and c.status = 'sending'`,
    [tenantId],
  );
  return { wznowiony: true, doWznowienia: rows.map((r) => r.id as string) };
}
