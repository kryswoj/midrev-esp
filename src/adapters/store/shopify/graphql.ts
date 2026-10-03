import { WERSJA_API_SHOPIFY } from "./oauth";

/**
 * Klient GraphQL Admin API z dławikiem opartym na KOSZCIE zapytań (nie liczbie żądań).
 *
 * Shopify liczy kubełek punktów (np. 1000 pkt, odpływ 50 pkt/s; wartości czytamy z odpowiedzi,
 * nie zaszywamy). Każda odpowiedź niesie `extensions.cost.throttleStatus`
 * {maximumAvailable, currentlyAvailable, restoreRate}. Przed kolejnym zapytaniem czekamy, aż
 * kubełek odrośnie do kosztu poprzedniego (szacunek), a odpowiedź `THROTTLED` (albo HTTP 429)
 * ponawiamy z wyliczonym opóźnieniem i wykładniczym zapasem. 5xx: ponowienie z backoffem.
 *
 * Token idzie wyłącznie w nagłówku `X-Shopify-Access-Token`; nie ma go w żadnym komunikacie
 * błędu ani logu. Odpowiedź 401/403 = `BladDostepuShopify` (token cofnięty, aplikacja
 * odinstalowana albo brak zakresu), bez ponawiania.
 */

export interface StanKubelka {
  maks: number;
  dostepne: number;
  odplywNaSek: number;
  /** kiedy odczytano (ms) */
  kiedy: number;
}

export class BladShopify extends Error {
  constructor(
    message: string,
    readonly kod: string | null = null,
  ) {
    super(message);
  }
}
export class BladDostepuShopify extends BladShopify {}

export interface OpcjeKlienta {
  domena: string;
  token: string;
  wersja?: string;
  fetchImpl?: typeof fetch;
  /** wstrzykiwane w testach; domyślnie prawdziwe czekanie */
  czekaj?: (ms: number) => Promise<void>;
  teraz?: () => number;
  maksProb?: number;
}

const czekajDomyslnie = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class KlientShopify {
  readonly domena: string;
  #token: string;
  readonly #wersja: string;
  readonly #fetch: typeof fetch;
  readonly #czekaj: (ms: number) => Promise<void>;
  readonly #teraz: () => number;
  readonly #maksProb: number;
  kubelek: StanKubelka | null = null;
  /** ile razy dławik kazał czekać (diagnostyka i testy) */
  oczekiwania: number[] = [];

  constructor(o: OpcjeKlienta) {
    this.domena = o.domena;
    this.#token = o.token;
    this.#wersja = o.wersja ?? WERSJA_API_SHOPIFY;
    this.#fetch = o.fetchImpl ?? fetch;
    this.#czekaj = o.czekaj ?? czekajDomyslnie;
    this.#teraz = o.teraz ?? Date.now;
    this.#maksProb = o.maksProb ?? 6;
  }

  toJSON() {
    return { domena: this.domena, token: "[sekret]" };
  }

  /** Ile ms poczekać, zanim kubełek pomieści zapytanie o koszcie `koszt`. */
  ileCzekac(koszt: number): number {
    const k = this.kubelek;
    if (!k || k.odplywNaSek <= 0) return 0;
    const uplynelo = (this.#teraz() - k.kiedy) / 1000;
    const teraz = Math.min(k.maks, k.dostepne + uplynelo * k.odplywNaSek);
    if (teraz >= koszt) return 0;
    return Math.ceil(((koszt - teraz) / k.odplywNaSek) * 1000);
  }

  async zapytanie<T = Record<string, unknown>>(query: string, zmienne: Record<string, unknown> = {}, szacowanyKoszt = 50): Promise<T> {
    let proba = 0;
    for (;;) {
      proba++;
      const pauza = this.ileCzekac(szacowanyKoszt);
      if (pauza > 0) {
        this.oczekiwania.push(pauza);
        await this.#czekaj(pauza);
      }
      let odp: Response;
      try {
        odp = await this.#fetch(`https://${this.domena}/admin/api/${this.#wersja}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": this.#token },
          body: JSON.stringify({ query, variables: zmienne }),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        if (proba >= this.#maksProb) throw new BladShopify("Shopify nie odpowiada", "siec");
        await this.#odczekaj(proba);
        continue;
      }
      if (odp.status === 401 || odp.status === 403) {
        throw new BladDostepuShopify(`Shopify odmówił dostępu (HTTP ${odp.status}): token cofnięty albo brak zakresu`, `http_${odp.status}`);
      }
      if (odp.status === 429 || odp.status >= 500) {
        if (proba >= this.#maksProb) throw new BladShopify(`Shopify HTTP ${odp.status} po ${proba} próbach`, `http_${odp.status}`);
        const ra = Number(odp.headers.get("retry-after"));
        await this.#odczekaj(proba, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
        continue;
      }
      if (!odp.ok) throw new BladShopify(`Shopify HTTP ${odp.status}`, `http_${odp.status}`);
      let dane: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[]; extensions?: { cost?: { requestedQueryCost?: number; actualQueryCost?: number; throttleStatus?: { maximumAvailable?: number; currentlyAvailable?: number; restoreRate?: number } } } };
      try {
        dane = await odp.json();
      } catch {
        throw new BladShopify("nieczytelna odpowiedź GraphQL");
      }
      const ts = dane.extensions?.cost?.throttleStatus;
      if (ts && typeof ts.currentlyAvailable === "number") {
        this.kubelek = {
          maks: ts.maximumAvailable ?? 1000,
          dostepne: ts.currentlyAvailable,
          odplywNaSek: ts.restoreRate ?? 50,
          kiedy: this.#teraz(),
        };
      }
      const koszt = dane.extensions?.cost?.requestedQueryCost;
      if (typeof koszt === "number" && koszt > 0) szacowanyKoszt = koszt;
      const bledy = dane.errors ?? [];
      if (bledy.some((b) => b.extensions?.code === "THROTTLED")) {
        if (proba >= this.#maksProb) throw new BladShopify("Shopify dławi zapytania (THROTTLED)", "THROTTLED");
        const potrzeba = this.ileCzekac(szacowanyKoszt);
        await this.#odczekaj(proba, potrzeba > 0 ? potrzeba : undefined);
        continue;
      }
      if (bledy.some((b) => b.extensions?.code === "ACCESS_DENIED")) {
        throw new BladDostepuShopify("Shopify: brak uprawnienia do zasobu (ACCESS_DENIED)", "ACCESS_DENIED");
      }
      if (bledy.length) {
        throw new BladShopify(`GraphQL: ${bledy.map((b) => String(b.message ?? "błąd").slice(0, 200)).join("; ")}`, bledy[0].extensions?.code ?? null);
      }
      if (!dane.data) throw new BladShopify("odpowiedź GraphQL bez danych");
      return dane.data;
    }
  }

  async #odczekaj(proba: number, minimum?: number) {
    const wykladniczo = Math.min(30_000, 500 * 2 ** (proba - 1));
    const ms = Math.max(minimum ?? 0, wykladniczo);
    this.oczekiwania.push(ms);
    await this.#czekaj(ms);
  }
}

/** userErrors z mutacji → jeden czytelny komunikat albo null. */
export function bledyUzytkownika(e: unknown): string | null {
  if (!Array.isArray(e) || e.length === 0) return null;
  return e
    .map((x) => (x && typeof x === "object" && "message" in x ? String((x as { message: unknown }).message).slice(0, 200) : "błąd"))
    .join("; ");
}
