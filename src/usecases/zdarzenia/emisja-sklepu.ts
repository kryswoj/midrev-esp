import type { PoolClient } from "pg";
import { METRYKI_WBUDOWANE, type DefinicjaMetrykiWbudowanej } from "../../domain/zdarzenia/kontrakt";
import type { KlientSklepu, ZamowienieSklepu } from "../../domain/store/contract";
import { wykladnikWaluty } from "../../domain/zdarzenia/limity";
import { zapiszZdarzenie } from "./zapisz-zdarzenie";

/**
 * Metryki wbudowane ze sklepu (plan 1.3, MVP: Woo), emitowane w transakcji zapisu
 * zamówienia/profilu, wyłącznie przez `zapiszZdarzenie` (AD-36).
 *
 * „Placed Order” raz na zamówienie (przy PIERWSZYM pojawieniu się, jak dotychczasowe
 * `order.created`) + „Ordered Product” na KAŻDĄ pozycję: flow Sports-med „Emaile z kodem
 * po kupnie pakietu” filtruje `ProductID` właśnie na tej metryce. Import historii = źródło
 * `import` (backfill, nie wyzwala flow), webhook = `webhook`.
 */

/** Para metryk zamówienia platformy: „Placed Order” + „Ordered Product”. */
export interface MetrykiZamowienia {
  zamowienie: DefinicjaMetrykiWbudowanej;
  produkt: DefinicjaMetrykiWbudowanej;
}

export const METRYKI_ZAMOWIENIA_WOO: MetrykiZamowienia = {
  zamowienie: METRYKI_WBUDOWANE.zlozoneZamowienie,
  produkt: METRYKI_WBUDOWANE.zamowionyProdukt,
};

function naGlowne(minor: number, waluta: string): number {
  const exp = wykladnikWaluty(waluta);
  return Number((minor / 10 ** exp).toFixed(exp));
}

export async function emitujZamowienie(
  klient: PoolClient,
  tenantId: string,
  dane: {
    orderId: string;
    profileId: string | null;
    zamowienie: ZamowienieSklepu;
    kanal: "webhook" | "import";
    /** metryki platformy (domyślnie Woo); Shopify podaje `shopify/Placed Order` i `shopify/Ordered Product` */
    metryki?: MetrykiZamowienia;
  },
): Promise<{ placedOrderId: string; produkty: number }> {
  const metryki = dane.metryki ?? METRYKI_ZAMOWIENIA_WOO;
  const { zamowienie: z, orderId } = dane;
  const waluta = z.waluta ?? "PLN";
  const source = dane.kanal === "import" ? "import" : "webhook";
  const pozycje = z.pozycje ?? [];
  const items = pozycje.map((p, i) => ({
    ProductID: p.productId ?? null,
    SKU: p.sku,
    ProductName: p.nazwa,
    Quantity: p.ilosc,
    ItemPrice: naGlowne(p.cenaMinor, waluta),
    RowTotal: p.sumaMinor !== null && p.sumaMinor !== undefined ? naGlowne(p.sumaMinor, waluta) : null,
    LineId: p.lineId ?? String(i + 1),
  }));

  const placed = await zapiszZdarzenie(
    klient,
    {
      tenantId,
      metryka: metryki.zamowienie,
      profileId: dane.profileId,
      occurredAt: z.occurredAt,
      uniqueId: orderId,
      valueMinor: z.sumaMinor,
      valueCurrency: waluta,
      properties: {
        OrderId: z.externalId,
        OrderNumber: z.numer,
        Status: z.status,
        $value: naGlowne(z.sumaMinor, waluta),
        ItemNames: pozycje.map((p) => p.nazwa),
        ProductNames: pozycje.map((p) => p.nazwa),
        ProductIDs: pozycje.map((p) => p.productId).filter((x): x is string => Boolean(x)),
        SKUs: pozycje.map((p) => p.sku).filter((x): x is string => Boolean(x)),
        ItemCount: pozycje.reduce((s, p) => s + (Number.isFinite(p.ilosc) ? p.ilosc : 0), 0),
        $extra: { Items: items },
      },
      source,
    },
    {
      // lustro dla obecnego silnika automatyzacji (payload w starym kształcie)
      lustro: { eventType: "order.created", payload: { orderId, totalMinor: z.sumaMinor, kanal: dane.kanal } },
    },
  );

  let produkty = 0;
  for (const [i, p] of pozycje.entries()) {
    const linia = p.lineId ?? String(i + 1);
    const wynik = await zapiszZdarzenie(klient, {
      tenantId,
      metryka: metryki.produkt,
      profileId: dane.profileId,
      occurredAt: z.occurredAt,
      uniqueId: `${orderId}:${linia}`,
      valueMinor: p.sumaMinor ?? p.cenaMinor * (Number.isFinite(p.ilosc) ? p.ilosc : 1),
      valueCurrency: waluta,
      properties: {
        OrderId: z.externalId,
        ProductID: p.productId ?? null,
        SKU: p.sku,
        ProductName: p.nazwa,
        Quantity: p.ilosc,
        ItemPrice: naGlowne(p.cenaMinor, waluta),
        $value: naGlowne(p.sumaMinor ?? p.cenaMinor * (Number.isFinite(p.ilosc) ? p.ilosc : 1), waluta),
      },
      source,
    });
    if (!wynik.duplikat) produkty++;
  }
  return { placedOrderId: placed.id, produkty };
}

/** `customer.created` / `customer.updated`: techniczne, ukryte, nie wyzwalają (kontrakt §3). */
export async function emitujKlienta(
  klient: PoolClient,
  tenantId: string,
  dane: {
    profileId: string;
    typ: "customer.created" | "customer.updated";
    kiedy: Date;
    storeId: string | null;
    klientSklepu: Pick<KlientSklepu, "externalId">;
    kanal: "webhook" | "import";
  },
): Promise<void> {
  const payload: Record<string, unknown> = { storeId: dane.storeId, externalId: dane.klientSklepu.externalId };
  if (dane.kanal === "import") payload.kanal = "import";
  await zapiszZdarzenie(
    klient,
    {
      tenantId,
      metryka: dane.typ === "customer.created" ? METRYKI_WBUDOWANE.klientUtworzony : METRYKI_WBUDOWANE.klientZaktualizowany,
      profileId: dane.profileId,
      occurredAt: dane.kiedy,
      // zmiana konta ze sklepu ma własną wersję (data modyfikacji): ta sama wersja
      // przysłana drugi raz jest duplikatem, nowa wersja - nowym zdarzeniem
      uniqueId: `customer:${dane.storeId ?? "-"}:${dane.klientSklepu.externalId}:${dane.typ}:${Math.floor(dane.kiedy.getTime() / 1000)}`,
      properties: payload,
      source: dane.kanal === "import" ? "import" : "webhook",
    },
    { lustro: { eventType: dane.typ, payload } },
  );
}
