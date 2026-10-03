/**
 * Czyste mapowanie zdarzeń Web Pixels Shopify → żądania Client API MidRev (`/client/events`,
 * `/client/profiles`, zgodne z Klaviyo). Zero zależności i zero efektów ubocznych: ten sam plik
 * bundluje Shopify CLI do piksela i importuje test w repo (tests/shopify-piksel.test.ts).
 *
 * Zasady:
 *   - bramka zgody: nic nie wychodzi bez zgody na analitykę i marketing (Customer Privacy API;
 *     poza regionami, gdzie zgoda jest wymagana, Shopify zwraca true). Dodatkowo
 *     `[customer_privacy]` w shopify.extension.toml każe Shopify nie uruchamiać piksela bez niej,
 *   - Placed Order NIGDY z piksela (tylko serwer, plan E.7): `checkout_completed` = wyłącznie
 *     identyfikacja osoby (łączy przeglądarkę z profilem),
 *   - Started Checkout też nie: liczy go webhook `checkouts/*` z linkiem powrotu; piksel na
 *     `checkout_started` / `checkout_contact_info_submitted` tylko identyfikuje po e-mailu,
 *   - tożsamość: identyfikator przeglądarki i dane osoby z `midrev.js` (ciasteczko `__mx_id`,
 *     localStorage `__mx_p`), żeby piksel i popup widziały tę samą osobę; e-mail nigdy w URL.
 */

export const WERSJA_PIKSELA = "1.0.0";

/** Zgoda z `init.customerPrivacy` / zdarzenia `visitorConsentCollected`. */
export function zgodaPozwala(prywatnosc) {
  if (!prywatnosc || typeof prywatnosc !== "object") return false;
  return prywatnosc.analyticsProcessingAllowed === true && prywatnosc.marketingAllowed === true;
}

function str(v, n) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t.slice(0, n || 500) : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** id z GID Shopify (`gid://shopify/Product/123`) albo liczby → "123". */
export function idZGid(v) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string" || !v) return null;
  const m = /\/(\d+)(?:\?.*)?$/.exec(v);
  return m ? m[1] : /^\d+$/.test(v) ? v : null;
}

/** Token koszyka z `init.data.cart.id` (`gid://shopify/Cart/<token>?key=…`). */
export function tokenKoszyka(id) {
  if (typeof id !== "string") return null;
  const m = /\/Cart\/([^?/]+)/.exec(id);
  return m ? m[1].slice(0, 200) : null;
}

/**
 * Atrybuty profilu: `anonymous_id` z ciasteczka midrev.js (fallback: id klienta Shopify
 * z prefiksem), plus e-mail, token `_kx` i external_id z localStorage midrev.js, plus e-mail
 * zalogowanego klienta albo podany w checkoucie (`email` ma pierwszeństwo nad zapamiętanym).
 */
export function tozsamosc({ ciastko, osoba, clientId, email }) {
  const at = {};
  let anon = null;
  try {
    const o = ciastko ? JSON.parse(decodeURIComponent(ciastko)) : null;
    anon = o && typeof o === "object" ? str(o.a, 64) : null;
  } catch (e) {
    anon = null;
  }
  if (!anon && clientId) anon = "shopify:" + String(clientId).slice(0, 100);
  if (anon) at.anonymous_id = anon;
  let os = {};
  try {
    os = osoba ? JSON.parse(osoba) || {} : {};
  } catch (e) {
    os = {};
  }
  const e = str(email, 320) || str(os.e, 320);
  if (e && EMAIL.test(e)) at.email = e;
  if (str(os.x, 255)) at.external_id = str(os.x, 255);
  if (str(os.k, 200)) at._kx = str(os.k, 200);
  return at;
}

function wariant(v, origin) {
  if (!v || typeof v !== "object") return null;
  const produkt = v.product || {};
  const id = idZGid(produkt.id);
  const nazwa = str(produkt.title, 500) || str(v.title, 500);
  if (!id || !nazwa) return null;
  const url = str(produkt.url, 2000);
  return {
    id,
    wariant: idZGid(v.id),
    nazwa,
    sku: str(v.sku, 255),
    cena: v.price && typeof v.price.amount === "number" ? v.price.amount : null,
    waluta: v.price && str(v.price.currencyCode, 3),
    url: url ? (/^https?:\/\//.test(url) ? url : origin ? origin + url : null) : null,
    obraz: v.image && str(v.image.src, 2000),
    marka: str(produkt.vendor, 255),
    typ: str(produkt.type, 120),
  };
}

function zdarzenie(nazwa, at, properties, extra) {
  const a = { properties, metric: { data: { type: "metric", attributes: { name: nazwa } } }, profile: { data: { type: "profile", attributes: at } } };
  if (extra.unique_id) a.unique_id = extra.unique_id;
  if (typeof extra.value === "number" && Number.isFinite(extra.value)) a.value = extra.value;
  if (extra.value_currency) a.value_currency = extra.value_currency;
  return { sciezka: "/client/events", cialo: { data: { type: "event", attributes: a } } };
}

function profil(at) {
  return { sciezka: "/client/profiles", cialo: { data: { type: "profile", attributes: at } } };
}

/**
 * Zdarzenie piksela → lista żądań (pusta = nic nie wysyłamy).
 * `k`: { prywatnosc, ciastko, osoba, klientEmail (zalogowany z init), origin, teraz }.
 */
export function mapujZdarzenie(ev, k) {
  if (!zgodaPozwala(k.prywatnosc)) return [];
  if (!ev || typeof ev.name !== "string") return [];
  const dane = ev.data || {};
  const checkout = dane.checkout || null;
  const emailCheckoutu = checkout ? str(checkout.email, 320) : null;
  const at = tozsamosc({ ciastko: k.ciastko, osoba: k.osoba, clientId: ev.clientId, email: emailCheckoutu || k.klientEmail });
  const origin = k.origin || null;

  switch (ev.name) {
    case "product_viewed": {
      const w = wariant(dane.productVariant, origin);
      if (!w) return [];
      const okno = Math.floor((k.teraz || Date.now()) / 1800000);
      return [
        zdarzenie(
          "Viewed Product",
          at,
          {
            ProductID: w.id,
            VariantID: w.wariant,
            ProductName: w.nazwa,
            SKU: w.sku,
            Price: w.cena,
            URL: w.url,
            ImageURL: w.obraz,
            Brand: w.marka,
            Categories: w.typ ? [w.typ] : [],
            $source: "shopify-pixel",
          },
          { unique_id: "vp:" + (at.anonymous_id || "?") + ":" + w.id + ":" + okno, value: w.cena, value_currency: w.waluta },
        ),
      ];
    }
    case "product_added_to_cart": {
      const linia = dane.cartLine || {};
      const w = wariant(linia.merchandise, origin);
      if (!w) return [];
      const ilosc = typeof linia.quantity === "number" && linia.quantity > 0 ? linia.quantity : 1;
      const suma = linia.cost && linia.cost.totalAmount && typeof linia.cost.totalAmount.amount === "number" ? linia.cost.totalAmount.amount : null;
      return [
        zdarzenie(
          "Added to Cart",
          at,
          {
            AddedItemProductID: w.id,
            AddedItemVariantID: w.wariant,
            AddedItemProductName: w.nazwa,
            AddedItemSKU: w.sku,
            AddedItemPrice: w.cena,
            AddedItemQuantity: ilosc,
            AddedItemURL: w.url,
            AddedItemImageURL: w.obraz,
            CartToken: k.tokenKoszyka || null,
            $value: suma,
            $source: "shopify-pixel",
          },
          { unique_id: ev.id ? "atc:" + String(ev.id).slice(0, 200) : null, value: suma, value_currency: w.waluta },
        ),
      ];
    }
    case "checkout_started":
    case "checkout_contact_info_submitted":
    case "checkout_completed":
      // identyfikacja gościa po e-mailu z checkoutu; zdarzenia zakupowe liczy serwer
      return at.email || at._kx || at.external_id ? [profil(at)] : [];
    default:
      return [];
  }
}

/** URL żądania: e-mail nigdy w adresie, tylko klucz publiczny strony. */
export function adresZadania(apiUrl, siteKey, sciezka) {
  return String(apiUrl).replace(/\/+$/, "") + sciezka + "?company_id=" + encodeURIComponent(siteKey);
}
