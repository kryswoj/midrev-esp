import { getPool } from "../adapters/db/pool";
import { odszyfruj } from "../adapters/crypto";
import { poswiadczeniaSklepu, sklep as pobierzSklep } from "../adapters/db/repozytoria";
import { AdapterWoo } from "../adapters/store/woo/adapter";

export interface WynikZgodnosci {
  storeId: string;
  wSklepie: number | null;
  wBazie: number;
  roznica: number | null;
  procent: number | null;
  stan: "zgodne" | "rozjazd" | "nieustalone";
  okresOd: Date;
}

/**
 * Ekran zgodności (FR14, NFR5). Webhooki padają po cichu i nikt tego nie zauważa,
 * dopóki ktoś nie porówna liczb. Stan "nieustalone" jest osobno od "rozjazd", bo
 * niedostępny sklep to nie to samo co brakujące dane.
 *
 * Granica okresu to PEŁNA DOBA GMT (północ), ta sama po obu stronach: Woo filtruje
 * `after` po dacie utworzenia, my po `occurred_at` (= date_created_gmt), więc chwilowe
 * "teraz minus 30 dni" dawało po obu stronach inny zbiór na krawędzi okna (review #6).
 * `roznica > 0` = w sklepie więcej niż w bazie (BRAKUJĄ dane, to jest awaria);
 * `roznica < 0` = w bazie więcej (zamówienia skasowane w sklepie zostają u nas - nie
 * subskrybujemy `order.deleted`), to informacja, nie alarm.
 */
export async function sprawdzZgodnosc(
  tenantId: string,
  storeId: string,
  dniWstecz = 30,
): Promise<WynikZgodnosci> {
  const okresOd = new Date(Date.now() - dniWstecz * 24 * 3600 * 1000);
  okresOd.setUTCHours(0, 0, 0, 0);
  const { rows } = await getPool().query<{ ile: number }>(
    `select count(*)::int as ile from orders
      where tenant_id = $1 and store_id = $2 and occurred_at >= $3`,
    [tenantId, storeId, okresOd],
  );
  const wBazie = rows[0].ile;

  const s = await pobierzSklep(tenantId, storeId);
  const szyfrogram = await poswiadczeniaSklepu(tenantId, storeId);
  if (!s || !szyfrogram) {
    return { storeId, wSklepie: null, wBazie, roznica: null, procent: null, stan: "nieustalone", okresOd };
  }

  try {
    const { ck, cs } = JSON.parse(odszyfruj(szyfrogram));
    const adapter = new AdapterWoo(tenantId, { baseUrl: s.base_url, consumerKey: ck, consumerSecret: cs });
    const wSklepie = await adapter.policzZamowienia(okresOd);
    const roznica = wSklepie - wBazie;
    const procent = wSklepie === 0 ? 0 : Math.abs(roznica) / wSklepie;
    return {
      storeId,
      wSklepie,
      wBazie,
      roznica,
      procent,
      // próg 0,5% z NFR5: powyżej idzie alert do człowieka, nie wpis w logu
      stan: procent > 0.005 ? "rozjazd" : "zgodne",
      okresOd,
    };
  } catch {
    return { storeId, wSklepie: null, wBazie, roznica: null, procent: null, stan: "nieustalone", okresOd };
  }
}
