import { register } from "@shopify/web-pixels-extension";
import { adresZadania, mapujZdarzenie, tokenKoszyka, zgodaPozwala } from "./mapowanie";

/**
 * Piksel MidRev (Web Pixel extension, `runtime_context = "strict"`: web worker bez DOM).
 * Ustawienia (`settings.siteKey`, `settings.apiUrl`) zapisuje backend MidRev przy instalacji
 * (`webPixelCreate`), klient niczego nie wkleja. Mapowanie i bramka zgody: ./mapowanie.js.
 */
register(({ analytics, browser, init, settings, customerPrivacy }) => {
  const siteKey = settings && settings.siteKey;
  const apiUrl = settings && settings.apiUrl;
  if (!siteKey || !apiUrl || !/^https:\/\//.test(apiUrl)) return;

  let prywatnosc = (init && init.customerPrivacy) || null;
  // zgoda zmieniona w trakcie wizyty (baner cookies): od tej chwili obowiązuje nowa
  try {
    customerPrivacy.subscribe("visitorConsentCollected", (e) => {
      prywatnosc = e && e.customerPrivacy ? e.customerPrivacy : prywatnosc;
    });
  } catch (e) {
    /* starsze wersje API bez subskrypcji: zostaje stan z init */
  }
  const klientEmail = init && init.data && init.data.customer ? init.data.customer.email || null : null;
  let koszyk = init && init.data && init.data.cart ? tokenKoszyka(init.data.cart.id) : null;
  const origin = init && init.context && init.context.document && init.context.document.location ? init.context.document.location.origin : null;

  async function wyslij(ev) {
    if (!zgodaPozwala(prywatnosc)) return;
    let ciastko = null;
    let osoba = null;
    try {
      ciastko = await browser.cookie.get("__mx_id");
      osoba = await browser.localStorage.getItem("__mx_p");
    } catch (e) {
      /* brak dostępu = tylko id klienta Shopify */
    }
    if (ev.name === "product_added_to_cart" && ev.data && ev.data.cartLine && !koszyk && init && init.data && init.data.cart) koszyk = tokenKoszyka(init.data.cart.id);
    const zadania = mapujZdarzenie(ev, { prywatnosc, ciastko, osoba, klientEmail, origin, teraz: Date.now(), tokenKoszyka: koszyk });
    for (const z of zadania) {
      try {
        await fetch(adresZadania(apiUrl, siteKey, z.sciezka), {
          method: "POST",
          // text/plain: bez preflight CORS (jak midrev.js); credentials: omit, bez ciasteczek
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: JSON.stringify(z.cialo),
          keepalive: true,
          credentials: "omit",
        });
      } catch (e) {
        /* piksel nigdy nie psuje sklepu */
      }
    }
  }

  for (const nazwa of ["product_viewed", "product_added_to_cart", "checkout_started", "checkout_contact_info_submitted", "checkout_completed"]) {
    analytics.subscribe(nazwa, (ev) => {
      wyslij(ev);
    });
  }
});
