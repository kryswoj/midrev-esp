import { randomBytes } from "node:crypto";
import type { PoswiadczeniaWoo } from "../adapters/store/woo/adapter";
import { zaszyfruj } from "../adapters/crypto";
import { zapiszSklep } from "../adapters/db/repozytoria";
import { getPool } from "../adapters/db/pool";
import { adapterSklepu, BladSklepu, odszyfrujPoswiadczenia } from "../adapters/store/fabryka";
import { definicjaPlatformy, type DefinicjaPlatformy } from "../adapters/store/rejestr";
import {
  odczytajStanWebhookow,
  sklepDoRejestracji,
  zapiszPoswiadczenia,
  znajdzSklepPoAdresie,
  zapiszStanWebhookow,
} from "../adapters/store/stan-webhookow";
import {
  adresDostawySklepu,
  normalizujStatus,
  wszystkieAktywne,
  type StanWebhookow,
  type WebhookSklepu,
  type WpisWebhooka,
} from "../adapters/store/webhooki";
import { config } from "../config";
import type { PlatformaSklepu, PortWebhookow, WynikWeryfikacji } from "../domain/store/contract";
import { ustawRoleSklepu } from "./integracja/role-metryk";

export type WynikPodlaczenia =
  | {
      ok: true;
      storeId: string;
      mozliwosci: Record<string, boolean>;
      webhooki: StanWebhookow;
      /** Sklep zapisany, ale dane NIE będą dochodzić. Wołający ma to pokazać, nie połknąć. */
      ostrzezenie?: string;
    }
  | { ok: false; blad: string; szczegoly?: string };

/** Jak sklep został połączony (`stores.connection_method`, 0046). */
export type MetodaPolaczenia = "klucze" | "wtyczka" | "wc_auth" | "oauth";

/**
 * Podłączenie sklepu WooCommerce kluczami REST (FR8, FR9, B3). Cienkie opakowanie
 * portu „Sklep”: ta sama droga co wtyczka i `/wc-auth`, inne są tylko źródła kluczy.
 */
export async function podlaczSklepWoo(
  tenantId: string,
  poswiadczenia: PoswiadczeniaWoo,
  opcje: { metoda?: MetodaPolaczenia; dodatkowe?: Record<string, unknown> } = {},
): Promise<WynikPodlaczenia> {
  return podlaczSklep(tenantId, {
    platforma: "woocommerce",
    baseUrl: poswiadczenia.baseUrl,
    poswiadczenia: { ck: poswiadczenia.consumerKey, cs: poswiadczenia.consumerSecret, ...(opcje.dodatkowe ?? {}) },
    metoda: opcje.metoda ?? "klucze",
  });
}

/**
 * Podłączenie sklepu dowolnej platformy (port „Sklep”, plan E.1). Poświadczenia są
 * sprawdzane ZAKRES PO ZAKRESIE zanim cokolwiek zapiszemy, bo klucze bez uprawnienia do
 * zamówień przechodzą zwykły test połączenia, a potem import kończy się pustym wynikiem
 * wyglądającym jak sklep bez historii.
 *
 * Po zapisie sklepu rejestrujemy webhooki PO STRONIE SKLEPU (jeśli platforma je ma). Bez tego
 * kroku sklep po imporcie historii cicho staje w miejscu. Na końcu role metryk zamówień
 * (placed_order itd.) wskazują metryki tej platformy: szablony flow wskazują rolę.
 */
export async function podlaczSklep(
  tenantId: string,
  dane: {
    platforma: Exclude<PlatformaSklepu, "custom">;
    baseUrl: string;
    /** poświadczenia w kształcie platformy (Woo: `{ck, cs}`); szyfrowane w całości (AD-13) */
    poswiadczenia: Record<string, unknown>;
    metoda: MetodaPolaczenia;
  },
): Promise<WynikPodlaczenia> {
  const definicja = definicjaPlatformy(dane.platforma);
  if (!definicja) return { ok: false, blad: `Platforma ${dane.platforma} nie ma jeszcze adaptera` };
  const adapter = definicja.utworzAdapter(tenantId, dane.baseUrl, dane.poswiadczenia);
  const weryfikacja: WynikWeryfikacji = await adapter.weryfikujPoswiadczenia();

  if (!weryfikacja.ok) {
    if (weryfikacja.powod === "brak-uprawnien") {
      return {
        ok: false,
        blad: `Klucze nie mają uprawnienia do: ${weryfikacja.brakujaceUprawnienia.join(", ")}`,
        szczegoly: "Merchant musi wygenerować klucze z prawem odczytu tych zasobów.",
      };
    }
    if (weryfikacja.powod === "bledne-poswiadczenia") {
      return { ok: false, blad: "Sklep odrzucił klucze", szczegoly: weryfikacja.szczegoly };
    }
    return { ok: false, blad: "Sklep nie odpowiada", szczegoly: weryfikacja.szczegoly };
  }

  // Ponowne podłączenie tego samego sklepu ODZYSKUJE sekret webhooka (i inne sekrety, np.
  // wtyczki). Nowy sekret przy webhookach, które już istnieją w sklepie, oznaczałby, że sklep
  // podpisuje po staremu, a endpoint odrzuca każdą dostawę jako zły podpis - cisza zamiast błędu.
  const zastany = await znajdzSklepPoAdresie(tenantId, dane.platforma, dane.baseUrl);
  const zastanePoswiadczenia = odzyskajPoswiadczenia(zastany?.credentials_encrypted);
  const webhookSecret =
    (typeof zastanePoswiadczenia?.webhookSecret === "string" && zastanePoswiadczenia.webhookSecret) ||
    randomBytes(32).toString("hex");
  // stan czytamy PRZED zapisem: upsert nadpisuje całe `capabilities` świeżymi
  // możliwościami adaptera, więc po nim poprzedniego stanu już nie ma
  const poprzedni = zastany ? await odczytajStanWebhookow(tenantId, zastany.id) : null;

  const sklep = await zapiszSklep(tenantId, {
    platform: dane.platforma,
    baseUrl: dane.baseUrl,
    // szyfrogram, nie tekst (AD-13). Sekret webhooka leży razem z kluczami REST,
    // bo endpoint ingestu czyta go stąd przy weryfikacji podpisu HMAC.
    credentialsEncrypted: zaszyfruj(JSON.stringify({ ...(zastanePoswiadczenia ?? {}), ...dane.poswiadczenia, webhookSecret })),
    capabilities: adapter.mozliwosci() as unknown as Record<string, boolean>,
    status: "connected",
    connectionMethod: dane.metoda,
  });

  const stan = definicja.webhooki && adapter.listujWebhooki
    ? await zarejestrujWebhoki(adapter as PortWebhookow, definicja, sklep.id, webhookSecret, poprzedni)
    : pustyStan(definicja, sklep.id, "Platforma nie obsługuje webhooków");
  await zapiszStanWebhookow(tenantId, sklep.id, stan);
  await ustawRoleSklepu(getPool(), tenantId, dane.platforma);

  return {
    ok: true,
    storeId: sklep.id,
    mozliwosci: sklep.capabilities,
    webhooki: stan,
    ostrzezenie: wszystkieAktywne(stan, definicja.webhooki?.tematy) ? undefined : opisBraku(stan),
  };
}

/**
 * Ponowna rejestracja i sprawdzenie webhooków istniejącego sklepu (przycisk na ekranie
 * sklepów). Ta sama droga co przy podłączaniu - jedna implementacja, więc naprawa nie
 * może rozjechać się z pierwszym podłączeniem.
 */
export async function odswiezWebhokiSklepu(
  tenantId: string,
  storeId: string,
): Promise<{ ok: true; stan: StanWebhookow } | { ok: false; blad: string }> {
  const sklep = await sklepDoRejestracji(tenantId, storeId);
  if (!sklep) return { ok: false, blad: "Nie znaleziono takiego sklepu" };
  const definicja = definicjaPlatformy(sklep.platform);
  if (!definicja?.webhooki) {
    return { ok: false, blad: "Ta platforma nie ma webhooków do rejestracji" };
  }

  let poswiadczenia: Record<string, unknown>;
  let sekret: string;
  try {
    poswiadczenia = odszyfrujPoswiadczenia(sklep.credentials_encrypted);
    sekret = (typeof poswiadczenia.webhookSecret === "string" && poswiadczenia.webhookSecret) || randomBytes(32).toString("hex");
    if (!poswiadczenia.webhookSecret) {
      // sklep podłączony przed B3 nie ma sekretu webhooka: dopisujemy go teraz,
      // a rejestracja niżej wgra ten sam sekret do webhooków w sklepie
      poswiadczenia = { ...poswiadczenia, webhookSecret: sekret };
      await zapiszPoswiadczenia(tenantId, storeId, zaszyfruj(JSON.stringify(poswiadczenia)));
    }
  } catch {
    return { ok: false, blad: "Nie udało się odczytać poświadczeń sklepu" };
  }

  const adapter = definicja.utworzAdapter(tenantId, sklep.base_url, poswiadczenia);
  if (!adapter.listujWebhooki) return { ok: false, blad: "Ta platforma nie ma webhooków do rejestracji" };
  const poprzedni = await odczytajStanWebhookow(tenantId, storeId);
  const stan = await zarejestrujWebhoki(adapter as PortWebhookow, definicja, storeId, sekret, poprzedni);
  await zapiszStanWebhookow(tenantId, storeId, stan);
  return { ok: true, stan };
}

/** Adapter sklepu z bazy (dla wołających spoza tego modułu); błąd = komunikat bez sekretów. */
export async function adapterIstniejacegoSklepu(tenantId: string, storeId: string) {
  try {
    return await adapterSklepu(tenantId, storeId);
  } catch (b) {
    throw b instanceof BladSklepu ? b : new BladSklepu("Nie udało się odczytać poświadczeń sklepu");
  }
}

function pustyStan(definicja: DefinicjaPlatformy, storeId: string, blad: string | null): StanWebhookow {
  return {
    adresDostawy: definicja.webhooki ? adresDostawySklepu(config().APP_URL, definicja.webhooki.sciezkaDostawy(storeId)) : "",
    sprawdzonyAt: new Date().toISOString(),
    wpisy: [],
    blad,
    usunieteDuplikaty: 0,
  };
}

/**
 * Rejestracja tematów w sklepie + POTWIERDZENIE ODCZYTEM ZWROTNYM.
 *
 * Kod odpowiedzi POST-a nie jest dowodem: Woo potrafi oddać 201, a webhooka zostawić
 * w stanie paused, albo wyłączyć go później po serii nieudanych dostaw. Dlatego
 * "aktywny" wpisujemy wyłącznie na podstawie osobnego GET-a po utworzeniu.
 *
 * Dedup po (adres dostawy, temat): adres niesie identyfikator sklepu w ESP, więc
 * wszystko, co pod niego celuje, jest nasze. Ponowne podłączenie aktualizuje to,
 * co zastało, zamiast dokładać drugi webhook obok.
 */
async function zarejestrujWebhoki(
  adapter: PortWebhookow,
  definicja: DefinicjaPlatformy,
  storeId: string,
  sekret: string,
  poprzedni: StanWebhookow | null,
): Promise<StanWebhookow> {
  const tematy = definicja.webhooki?.tematy ?? [];
  const adres = adresDostawySklepu(config().APP_URL, definicja.webhooki!.sciezkaDostawy(storeId));
  const stan: StanWebhookow = {
    adresDostawy: adres,
    sprawdzonyAt: new Date().toISOString(),
    wpisy: [],
    blad: null,
    usunieteDuplikaty: 0,
    // dedup alertów o ciszy przeżywa ponowną rejestrację - inaczej każdy klik
    // "Sprawdź webhooki" odblokowywałby kolejny alert o tym samym
    ostatniAlertCiszyAt: poprzedni?.ostatniAlertCiszyAt ?? null,
  };

  let zastane: WebhookSklepu[];
  try {
    zastane = await adapter.listujWebhooki();
  } catch (blad) {
    stan.blad = opisBledu(blad);
    stan.wpisy = tematy.map((temat) => ({
      temat,
      webhookId: null,
      stan: "blad" as const,
      statusZrodla: null,
      potwierdzonyAt: null,
      blad: stan.blad,
    }));
    return stan;
  }

  for (const temat of tematy) {
    stan.wpisy.push(await zadbajOTemat(adapter, zastane, adres, temat, sekret, stan));
  }
  return stan;
}

async function zadbajOTemat(
  adapter: PortWebhookow,
  zastane: WebhookSklepu[],
  adres: string,
  temat: string,
  sekret: string,
  stan: StanWebhookow,
): Promise<WpisWebhooka> {
  const pusty: WpisWebhooka = {
    temat,
    webhookId: null,
    stan: "brak",
    statusZrodla: null,
    potwierdzonyAt: null,
    blad: null,
  };
  // "nasze" = celujące dokładnie w nasz adres dostawy (z identyfikatorem sklepu w ESP).
  // Aktywny ma pierwszeństwo na zachowanie, reszta to duplikaty do skasowania.
  const nasze = zastane
    .filter((w) => w.adresDostawy === adres && w.temat === temat)
    .sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
    );

  try {
    let id: number | string;
    if (nasze.length === 0) {
      const utworzony = await adapter.utworzWebhook({
        nazwa: `MidRev ESP ${temat}`,
        temat,
        adresDostawy: adres,
        sekret,
      });
      id = utworzony.id;
    } else {
      id = nasze[0].id;
      // sekret nadpisywany ZAWSZE: API nie pozwala go odczytać, więc jedyny sposób,
      // żeby mieć pewność, że sklep podpisuje tym, co zna endpoint, to go ustawić
      await adapter.zaktualizujWebhook(id, { sekret, status: "active" });
      for (const nadmiarowy of nasze.slice(1)) {
        await adapter.usunWebhook(nadmiarowy.id);
        stan.usunieteDuplikaty = (stan.usunieteDuplikaty ?? 0) + 1;
      }
    }

    // ODCZYT ZWROTNY ZE ŹRÓDŁA - jedyny dowód, że webhook faktycznie jest aktywny
    const potwierdzony = await adapter.pobierzWebhook(id);
    if (!potwierdzony) {
      return { ...pusty, webhookId: id, stan: "blad", blad: "Sklep nie widzi webhooka po utworzeniu" };
    }
    if (potwierdzony.adresDostawy !== adres || potwierdzony.temat !== temat) {
      return {
        ...pusty,
        webhookId: id,
        stan: "blad",
        statusZrodla: potwierdzony.status,
        blad: "Sklep zapisał webhooka z innym adresem albo tematem",
      };
    }
    return {
      temat,
      webhookId: id,
      stan: normalizujStatus(potwierdzony.status),
      statusZrodla: potwierdzony.status,
      potwierdzonyAt: new Date().toISOString(),
      blad: null,
    };
  } catch (blad) {
    return { ...pusty, stan: "blad", blad: opisBledu(blad) };
  }
}

function odzyskajPoswiadczenia(szyfrogram: Buffer | undefined): Record<string, unknown> | null {
  if (!szyfrogram) return null;
  try {
    return odszyfrujPoswiadczenia(szyfrogram);
  } catch {
    return null;
  }
}

/** Komunikat błędu bez treści sekretu - w wyjątku z fetcha potrafi siedzieć URL z kluczami. */
function opisBledu(blad: unknown): string {
  const tresc = blad instanceof Error ? blad.message : String(blad);
  return tresc.replace(/(ck|cs)_[a-z0-9]+/gi, "$1_…");
}

/** Jedno zdanie dla operatora: co dokładnie nie działa i co to znaczy. */
export function opisBraku(stan: StanWebhookow): string {
  if (stan.blad) {
    return `Sklep jest podłączony, ale webhooków nie udało się założyć (${stan.blad}). Dopóki tego nie naprawisz, nowe zamówienia nie będą dochodzić.`;
  }
  const chore = stan.wpisy.filter((w) => w.stan !== "aktywny");
  if (chore.length === 0) return "";
  const tematy = chore.map((w) => w.temat).join(", ");
  return `Sklep jest podłączony, ale ${chore.length === 1 ? "temat" : "tematy"} ${tematy} ${chore.length === 1 ? "nie jest" : "nie są"} aktywne - zdarzenia z tego zakresu nie będą dochodzić.`;
}
