import { wyslijAlert } from "../jobs/alerty";
import {
  sklepyZeStanemWebhookow,
  zapiszStanWebhookow,
  type SklepZeStanem,
} from "../adapters/store/stan-webhookow";
import { wszystkieAktywne, type StanWebhookow } from "../adapters/store/webhooki";

/**
 * Wykrywanie CISZY sklepu (B3, NFR38).
 *
 * Sklep, który przestał dosyłać zdarzenia, wygląda dokładnie jak sklep bez sprzedaży:
 * panel nie pokazuje żadnego błędu, import kiedyś się udał, a liczby po prostu stoją.
 * To jest awaria bez sygnału, więc musi mieć własny sygnał: widok na ekranie sklepów
 * i alert do człowieka, nie wpis w logu workera.
 *
 * Dwa różne powody, celowo nierozdzielone w alercie - dla odbiorcy skutek jest ten sam:
 * 1. webhooki nie są aktywne (rejestracja padła albo sklep je wyłączył) - pewna awaria,
 * 2. webhooki aktywne, ale przez PROG_CISZY_GODZIN nie przyszło nic - podejrzenie,
 *    bo sklep bez ruchu też milczy. Najczęstsze prawdziwe przyczyny: sklep nie odpala
 *    wp-crona (Woo dostarcza webhooki właśnie z niego), zablokowana dostawa na adres
 *    prywatny albo na port spoza 80/443/8080 po stronie WordPressa.
 */

export const PROG_CISZY_GODZIN = 24;
/** Ten sam sklep nie alarmuje częściej niż raz na tyle godzin. */
export const ODSTEP_ALERTU_GODZIN = 12;

export interface OcenaSklepu {
  storeId: string;
  baseUrl: string;
  /** Ostatnie zdarzenie przysłane PRZEZ sklep. Null = nigdy nic nie przyszło. */
  ostatnieZdarzenieAt: Date | null;
  /** Od kiedy liczymy ciszę: ostatnie zdarzenie albo podłączenie sklepu. */
  odniesienieAt: Date;
  godzinBezZdarzen: number;
  zdarzen24h: number;
  webhookiAktywne: boolean;
  milczy: boolean;
  /** Co dokładnie jest nie tak. Null, gdy sklep dosyła dane. */
  powod: string | null;
}

export async function ocenSklepy(
  tenantId: string,
  opcje: { teraz?: Date; progGodzin?: number } = {},
): Promise<OcenaSklepu[]> {
  const sklepy = await sklepyZeStanemWebhookow(tenantId);
  return sklepy.filter((s) => s.status === "connected").map((s) => ocenSklep(s, opcje));
}

/** Ocena jednego sklepu. Eksportowana, bo ekran sklepów pokazuje dokładnie to samo,
 *  co widzi job alertujący - jedna definicja ciszy, nie dwie. */
export function ocenSklep(
  sklep: SklepZeStanem,
  opcje: { teraz?: Date; progGodzin?: number } = {},
): OcenaSklepu {
  const teraz = opcje.teraz ?? new Date();
  const prog = opcje.progGodzin ?? PROG_CISZY_GODZIN;
  const ostatnie = sklep.ostatnie_zdarzenie_at ? new Date(sklep.ostatnie_zdarzenie_at) : null;
  // sklep podłączony przed chwilą nie "milczy" - punktem odniesienia jest moment
  // podłączenia, dopóki nie przyszło pierwsze zdarzenie
  const odniesienie = ostatnie ?? new Date(sklep.created_at);
  const godzin = Math.max(0, (teraz.getTime() - odniesienie.getTime()) / 3_600_000);
  const aktywne = wszystkieAktywne(sklep.stan);

  let powod: string | null = null;
  if (!aktywne) {
    // rozstrzyga LICZBA wpisów, nie istnienie rekordu: znacznik alertu potrafi
    // założyć pusty stan i sklep bez webhooków zaczynał wtedy kłamać, że "nie są aktywne"
    powod = sklep.stan && sklep.stan.wpisy.length > 0
      ? "webhooki w sklepie nie są aktywne"
      : "webhooki w sklepie nigdy nie zostały założone";
  } else if (godzin >= prog) {
    powod = ostatnie
      ? `brak zdarzeń od ${Math.floor(godzin)} h`
      : `od podłączenia (${Math.floor(godzin)} h) nie przyszło żadne zdarzenie`;
  }

  return {
    storeId: sklep.id,
    baseUrl: sklep.base_url,
    ostatnieZdarzenieAt: ostatnie,
    odniesienieAt: odniesienie,
    godzinBezZdarzen: godzin,
    zdarzen24h: sklep.zdarzen_24h,
    webhookiAktywne: aktywne,
    milczy: powod !== null,
    powod,
  };
}

/**
 * Przebieg kontrolny dla jednego tenanta: ocenia sklepy i wysyła alert o tych, które
 * milczą. Funkcja jest bezpieczna do wielokrotnego wywołania - znacznik ostatniego
 * alertu siedzi w stanie webhooków sklepu, więc job co godzinę nie zasypie kanału.
 *
 * Job cykliczny: `cisza_sklepow` co godzinę per tenant, planowany przez
 * `src/jobs/handlery-cykliczne.ts` (audyt #19).
 */
export async function sprawdzCiszeSklepow(
  tenantId: string,
  opcje: { teraz?: Date; progGodzin?: number; odstepAlertuGodzin?: number } = {},
): Promise<{ ocenione: OcenaSklepu[]; zgloszone: OcenaSklepu[] }> {
  const teraz = opcje.teraz ?? new Date();
  const odstep = opcje.odstepAlertuGodzin ?? ODSTEP_ALERTU_GODZIN;
  const sklepy = await sklepyZeStanemWebhookow(tenantId);
  const ocenione: OcenaSklepu[] = [];
  const zgloszone: OcenaSklepu[] = [];

  for (const sklep of sklepy) {
    if (sklep.status !== "connected") continue;
    const ocena = ocenSklep(sklep, { teraz, progGodzin: opcje.progGodzin });
    ocenione.push(ocena);
    if (!ocena.milczy) continue;

    const ostatniAlert = sklep.stan?.ostatniAlertCiszyAt ? new Date(sklep.stan.ostatniAlertCiszyAt) : null;
    if (ostatniAlert && teraz.getTime() - ostatniAlert.getTime() < odstep * 3_600_000) continue;

    await wyslijAlert(
      `sklep ${ocena.baseUrl} NIE DOSYŁA DANYCH: ${ocena.powod}. ` +
        `Ostatnie zdarzenie: ${ocena.ostatnieZdarzenieAt?.toISOString() ?? "nigdy"}. ` +
        "Zamówienia nie wpadają, atrybucja i automatyzacje liczą na starych danych.",
      { poziom: "krytyczny", tenantId },
    );
    // znacznik zapisujemy PO wysłaniu: gdy alert padnie, następny przebieg spróbuje znowu
    await zapiszStanWebhookow(tenantId, sklep.id, {
      ...(sklep.stan ?? pustyStan()),
      ostatniAlertCiszyAt: teraz.toISOString(),
    });
    zgloszone.push(ocena);
  }

  return { ocenione, zgloszone };
}

/** Sklep sprzed B3 nie ma zapisanego stanu; alert i tak musi mieć gdzie odłożyć znacznik. */
function pustyStan(): StanWebhookow {
  return { adresDostawy: "", sprawdzonyAt: new Date().toISOString(), wpisy: [], blad: null };
}
