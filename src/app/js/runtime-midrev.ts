/**
 * `midrev.js`: skrypt strony (plan 6, plan integracji D.1/E.2). Odpowiednik klaviyo.js.
 *
 * Ten plik trzyma kod PRZEGLĄDARKI jako tekst (String.raw: bez interpolacji, backslashe
 * zostają). Trasa `/js/v1/{klucz}.js` skleja go z konfiguracją klucza strony. Testy
 * uruchamiają TEN SAM tekst w `node:vm` z atrapą window/document, więc testowany jest kod,
 * który naprawdę trafia do przeglądarek.
 *
 * Zasady (każda wynika z historii błędów):
 *   - nic nie śledzi przed zgodą na cookies (RODO/ePrivacy): bez zgody nie ma odczytu ani
 *     zapisu ciasteczka, nie ma zdarzeń; `_mx` z adresu jest usuwany zawsze (żeby nie trafił
 *     do GA4), ale używany dopiero po zgodzie,
 *   - nigdy nie psuje strony: każdy punkt wejścia w try/catch, metody zwracają Promise,
 *     który się nie odrzuca,
 *   - API zgodne z Klaviyo (`_learnq.push`, `klaviyo.identify/track/trackViewedItem`), żeby
 *     wdrożenie Klaviyo przeszło podmianą jednego tagu; własny alias `window.midrev`,
 *   - zero danych w adresie: e-mail idzie w ciele żądania, nigdy w URL.
 */

export const WERSJA_MIDREV_JS = "1.0.0";

/** Budżet rozmiaru skryptu po gzip (test pilnuje). */
export const BUDZET_MIDREV_JS_GZ_B = 15_000;

export const RUNTIME_MIDREV = String.raw`(function (w, d, K) {
  "use strict";
  if (w.__midrevJs) return;
  w.__midrevJs = K.v;
  var DEBUG = false;
  try { DEBUG = /[?&]mrv_debug=1\b/.test(w.location.search); } catch (e) {}
  function log() { if (DEBUG && w.console) { try { w.console.log.apply(w.console, ["[midrev]"].concat([].slice.call(arguments))); } catch (e) {} } }
  function cicho(f) { return function () { try { return f.apply(this, arguments); } catch (e) { log("blad", e && e.message); } }; }
  function P(v) { try { return Promise.resolve(v); } catch (e) { return { then: function () {} }; } }
  function teraz() { return new Date().getTime(); }
  function str(v, n) { if (v === null || v === undefined) return null; v = String(v).replace(/^\s+|\s+$/g, ""); return v ? v.slice(0, n || 500) : null; }
  function num(v) { var n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : v; return typeof n === "number" && isFinite(n) ? n : null; }
  function los() { var s = ""; try { var a = new Uint8Array(16); w.crypto.getRandomValues(a); for (var i = 0; i < 16; i++) s += (a[i] + 256).toString(16).slice(1); return s; } catch (e) { return (Math.random().toString(16) + Math.random().toString(16)).replace(/0\./g, "").slice(0, 32); } }
  function hasz(t) { var h = 5381; t = String(t); for (var i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

  // ── stan: zgoda, tożsamość ──────────────────────────────────────────────
  var zgoda = !K.zgoda;
  var stan = { a: null, e: null, p: null, x: null, k: null, t: 0 };
  var tokenZLinku = null;
  var kolejkaPrzedZgoda = [];
  var wyslane = {};
  var C = "__mx_id";

  function domenaCiasteczka() {
    var h = w.location.hostname, cz = h.split(".");
    if (cz.length < 2 || /^[0-9.]+$/.test(h)) return null;
    for (var i = cz.length - 2; i >= 0; i--) {
      var dom = cz.slice(i).join(".");
      d.cookie = "__mx_t=1; path=/; domain=." + dom + "; SameSite=Lax";
      if (d.cookie.indexOf("__mx_t=1") >= 0) { d.cookie = "__mx_t=; path=/; domain=." + dom + "; max-age=0"; return dom; }
    }
    return null;
  }
  var domena;
  function czytajCiasteczko() {
    var m = d.cookie.match(/(?:^|;\s*)__mx_id=([^;]*)/);
    if (!m) return null;
    try { var o = JSON.parse(decodeURIComponent(m[1])); return o && typeof o === "object" ? o : null; } catch (e) { return null; }
  }
  // ciasteczko niesie TYLKO losowy identyfikator przeglądarki i znacznik czasu (leci do serwera
  // sklepu z każdym żądaniem); e-mail, telefon, external_id i token z linku zostają w localStorage
  function czytajOsobe() { try { var o = JSON.parse(w.localStorage.getItem("__mx_p") || "null"); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; } }
  function zapiszOsobe() {
    try {
      var o = {};
      if (stan.e) o.e = stan.e; if (stan.p) o.p = stan.p; if (stan.x) o.x = stan.x; if (stan.k) o.k = stan.k;
      w.localStorage.setItem("__mx_p", JSON.stringify(o));
    } catch (e) {}
  }
  function zapiszCiasteczko() {
    if (!zgoda) return;
    if (domena === undefined) domena = domenaCiasteczka();
    var o = { a: stan.a, t: stan.t };
    zapiszOsobe();
    d.cookie = C + "=" + encodeURIComponent(JSON.stringify(o)) + "; path=/; max-age=63072000; SameSite=Lax" +
      (domena ? "; domain=." + domena : "") + (w.location.protocol === "https:" ? "; Secure" : "");
  }
  function usunCiasteczko() {
    if (domena === undefined) domena = domenaCiasteczka();
    d.cookie = C + "=; path=/; max-age=0" + (domena ? "; domain=." + domena : "");
    d.cookie = C + "=; path=/; max-age=0";
    try { w.localStorage.removeItem("__mx_p"); } catch (e) {}
  }
  function wczytajStan() {
    var o = czytajCiasteczko() || {}, os = czytajOsobe();
    stan.a = str(o.a, 64) || los();
    // starszy format (dane osoby w ciasteczku) czytany raz i przenoszony do localStorage
    stan.e = str(os.e || o.e, 320); stan.p = str(os.p || o.p, 40); stan.x = str(os.x || o.x, 255); stan.k = str(os.k || o.k, 200);
    stan.t = num(o.t) || 0;
    if (tokenZLinku) stan.k = tokenZLinku;
    zapiszCiasteczko();
  }
  function rozpoznany() { return !!(stan.e || stan.p || stan.x || stan.k); }

  function profil(dodatkowe) {
    var at = { anonymous_id: stan.a };
    if (stan.e) at.email = stan.e;
    if (stan.p) at.phone_number = stan.p;
    if (stan.x) at.external_id = stan.x;
    if (stan.k) at._kx = stan.k;
    if (dodatkowe) for (var k in dodatkowe) if (Object.prototype.hasOwnProperty.call(dodatkowe, k)) at[k] = dodatkowe[k];
    return { data: { type: "profile", attributes: at } };
  }

  // ── transport: tekst/plain (bez preflight CORS), keepalive, sendBeacon jako zapas ──
  function wyslij(sciezka, cialo) {
    var url = K.api + sciezka + "?company_id=" + encodeURIComponent(K.id);
    var tresc = JSON.stringify(cialo);
    try {
      if (w.fetch) {
        return w.fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: tresc, keepalive: tresc.length < 60000, credentials: "omit", mode: "cors" })
          .then(function (o) { log(sciezka, o.status); return o.status >= 200 && o.status < 300; }, function () { return false; });
      }
      if (w.navigator && w.navigator.sendBeacon) return P(w.navigator.sendBeacon(url, new Blob([tresc], { type: "text/plain" })));
    } catch (e) { log("wyslij", e && e.message); }
    return P(false);
  }

  // ── zgoda na cookies: ręczna, Google Consent Mode v2, popularne CMP ─────────
  function zgodaCmp() {
    try {
      var ics = w.google_tag_data && w.google_tag_data.ics && w.google_tag_data.ics.entries;
      if (ics && ics.analytics_storage) {
        var s = ics.analytics_storage;
        var v = s.update !== undefined ? s.update : s["default"];
        if (v === true || v === "granted") return true;
        if (v === false || v === "denied") return false;
      }
      if (gcm !== null) return gcm;
      if (w.Cookiebot && w.Cookiebot.consent && w.Cookiebot.hasResponse) return !!w.Cookiebot.consent.statistics;
      if (typeof w.getCkyConsent === "function") { var c = w.getCkyConsent(); if (c && c.isUserActionCompleted) return !!(c.categories && c.categories.analytics); }
      if (typeof w.OnetrustActiveGroups === "string" && w.OneTrust && typeof w.OneTrust.IsAlertBoxClosed === "function" && w.OneTrust.IsAlertBoxClosed()) return w.OnetrustActiveGroups.indexOf(",C0002,") >= 0;
      if (typeof w.cmplz_has_consent === "function" && typeof w.cmplz_get_cookie === "function" && w.cmplz_get_cookie("banner-status") === "dismissed") return !!w.cmplz_has_consent("statistics");
      if (typeof w.wp_has_consent === "function" && w.consent_api_set_by) return !!w.wp_has_consent("statistics");
      var cp = w.customerPrivacy || (w.Shopify && w.Shopify.customerPrivacy);
      if (cp) {
        if (typeof cp.analyticsProcessingAllowed === "function") return !!cp.analyticsProcessingAllowed();
        if (typeof cp.isAnalyticsAllowed === "function") return !!cp.isAnalyticsAllowed();
      }
    } catch (e) {}
    return null;
  }
  var gcm = null;
  function zgodaZDataLayer(a) {
    // gtag('consent', 'default'|'update', {analytics_storage: 'granted'|'denied'})
    if (a && a[0] === "consent" && a[2] && typeof a[2] === "object" && a[2].analytics_storage) {
      gcm = a[2].analytics_storage === "granted";
      return true;
    }
    return false;
  }
  var trybRecznej = false;
  function ustawZgode(v, zrodlo) {
    v = !!v;
    if (v === zgoda) return;
    zgoda = v;
    log("zgoda", v, zrodlo);
    if (v) {
      wczytajStan();
      stronaPoZgodzie();
      var q = kolejkaPrzedZgoda; kolejkaPrzedZgoda = [];
      for (var i = 0; i < q.length; i++) wykonaj(q[i]);
    } else {
      usunCiasteczko();
      stan = { a: null, e: null, p: null, x: null, k: null, t: 0 };
      kolejkaPrzedZgoda = [];
    }
  }
  function sprawdzZgode() { if (!K.zgoda || trybRecznej) return; var v = zgodaCmp(); if (v !== null) ustawZgode(v, "cmp"); }

  // ── identify / track ──────────────────────────────────────────────────────
  var POLA = { first_name: 1, last_name: 1, organization: 1, title: 1, locale: 1 };
  var LOK = { city: 1, region: 1, country: 1, zip: 1, address1: 1, address2: 1, timezone: 1 };
  function identify(o) {
    if (!o || typeof o !== "object") return P(false);
    if (!zgoda) { if (kolejkaPrzedZgoda.length < 30) kolejkaPrzedZgoda.push(["identify", o]); return P(false); }
    var at = {}, wl = {}, lok = {}, jest = false;
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      var v = o[k], kk = k.replace(/^\$/, "");
      if (kk === "email") { var e = str(v, 320); if (e && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) { stan.e = e; jest = true; } }
      else if (kk === "phone_number") { var p = str(v, 40); if (p) { stan.p = p; jest = true; } }
      else if (kk === "id" || kk === "external_id") { var x = str(v, 255); if (x) { stan.x = x; jest = true; } }
      else if (POLA[kk]) at[kk] = str(v, 255);
      else if (LOK[kk]) lok[kk] = str(v, 255);
      else if (kk !== "exchange_id" && kk !== "kx" && kk !== "anonymous_id") wl[k] = v;
    }
    if (!jest && !rozpoznany()) { log("identify bez identyfikatora"); return P(false); }
    for (var z in lok) { at.location = lok; break; }
    for (var y in wl) { at.properties = wl; break; }
    zapiszCiasteczko();
    var r = wyslij("/client/profiles", profil(at));
    aktywnyNaStronie();
    return r;
  }

  var STANDARD = { "Viewed Product": "vp", "Added to Cart": "atc", "Started Checkout": "sc", "Active on Site": "aos" };
  function okno(ms) { return Math.floor(teraz() / ms); }
  function idZdarzenia(nazwa, p) {
    if (p && p.$event_id) return str(p.$event_id, 255);
    var s = STANDARD[nazwa];
    if (s === "vp") return "vp:" + stan.a + ":" + hasz(p.ProductID || p.ProductName || "") + ":" + okno(1800000);
    if (s === "atc") return "atc:" + stan.a + ":" + hasz((p.AddedItemProductID || "") + "|" + (p.AddedItemQuantity || 1)) + ":" + okno(60000);
    if (s === "sc") return "sc:" + stan.a + ":" + hasz((p.ItemNames || []).join("|") + "|" + p.$value) + ":" + okno(1800000);
    if (s === "aos") return "aos:" + stan.a + ":" + okno(1800000);
    return null;
  }
  function track(nazwa, props, opcje) {
    nazwa = str(nazwa, 127);
    if (!nazwa) return P(false);
    props = props && typeof props === "object" ? props : {};
    if (!zgoda) { if (kolejkaPrzedZgoda.length < 30) kolejkaPrzedZgoda.push(["track", nazwa, props]); return P(false); }
    if (nazwa === "Active on Site" && !rozpoznany()) return P(false);
    var uid = idZdarzenia(nazwa, props);
    if (uid && wyslane[nazwa + "|" + uid]) { log("duplikat", nazwa); return P(true); }
    if (uid) wyslane[nazwa + "|" + uid] = 1;
    var p = {};
    for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k) && k !== "$event_id") p[k] = props[k];
    var at = { properties: p, metric: { data: { type: "metric", attributes: { name: nazwa } } }, profile: profil() };
    if (uid) at.unique_id = uid;
    var wartosc = num(p.$value);
    if (wartosc !== null) at.value = wartosc;
    if (opcje && opcje.waluta) at.value_currency = opcje.waluta;
    return wyslij("/client/events", { data: { type: "event", attributes: at } });
  }
  function aktywnyNaStronie() {
    if (!zgoda || !rozpoznany()) return;
    if (teraz() - stan.t < 1800000) return;
    stan.t = teraz();
    zapiszCiasteczko();
    track("Active on Site", { page: adresStrony() });
  }

  // trackViewedItem: lista „ostatnio oglądane” w przeglądarce (semantyka Klaviyo), bez zdarzenia
  function trackViewedItem(o) {
    if (!zgoda || !o || typeof o !== "object") return P(false);
    try {
      var lista = JSON.parse(w.localStorage.getItem("__mx_viewed") || "[]");
      var id = str(o.ItemId || o.ProductID, 255);
      lista = lista.filter(function (x) { return x && x.ItemId !== id; });
      lista.unshift({ Title: str(o.Title || o.ProductName, 255), ItemId: id, Url: str(o.Url || o.URL, 2000), ImageUrl: str(o.ImageUrl || o.ImageURL, 2000), Categories: o.Categories, Metadata: o.Metadata, at: teraz() });
      w.localStorage.setItem("__mx_viewed", JSON.stringify(lista.slice(0, 10)));
    } catch (e) {}
    return P(true);
  }

  function subscribe(o) {
    if (!o || !o.email || !o.consentText) return P(false);
    var at = { consent_text: String(o.consentText), profile: { data: { type: "profile", attributes: { email: String(o.email) } } } };
    if (o.source) at.custom_source = String(o.source).slice(0, 120);
    var cialo = { data: { type: "subscription", attributes: at } };
    if (o.listId) cialo.data.relationships = { list: { data: { type: "list", id: String(o.listId) } } };
    var r = wyslij("/client/subscriptions", cialo);
    if (zgoda) identify({ email: o.email });
    return r;
  }

  // ── adres strony bez danych: canonical albo origin+ścieżka (query bywa nośnikiem e-maila) ──
  function adresStrony() {
    try {
      var c = d.querySelector && d.querySelector('link[rel="canonical"]');
      var h = c && c.getAttribute("href");
      if (h && /^https?:\/\//i.test(h)) return h.slice(0, 2000);
    } catch (e) {}
    return (w.location.origin + w.location.pathname).slice(0, 2000);
  }
  function obrazStrony() {
    try { var m = d.querySelector('meta[property="og:image"]'); var v = m && m.getAttribute("content"); if (v && /^https?:\/\//i.test(v)) return v; } catch (e) {}
    return null;
  }

  // ── GA4 dataLayer → metryki Klaviyo ───────────────────────────────────────
  function kategorie(it) {
    var k = [];
    var pola = ["item_category", "item_category2", "item_category3", "item_category4", "item_category5", "category"];
    for (var i = 0; i < pola.length; i++) { var v = str(it[pola[i]], 120); if (v && k.indexOf(v) < 0) k.push(v); }
    return k;
  }
  function pozycja(it, href, img) {
    var cena = num(it.price), ilosc = num(it.quantity) || 1;
    var o = {
      ProductID: str(it.item_id || it.id, 255), SKU: str(it.item_variant_id || it.sku || it.item_id || it.id, 255),
      ProductName: str(it.item_name || it.name, 500), Quantity: ilosc, ItemPrice: cena,
      RowTotal: cena === null ? null : Math.round(cena * ilosc * 100) / 100,
      ProductURL: str(it.item_url || it.url, 2000) || href, ImageURL: str(it.image_url || it.item_image || it.image, 2000) || img,
      ProductCategories: kategorie(it), Brand: str(it.item_brand || it.brand, 255)
    };
    if (it.item_variant) o.Variant = str(it.item_variant, 255);
    return o;
  }
  function mapujGa4(nazwa, ec, href, img) {
    if (!ec || typeof ec !== "object") return null;
    var items = ec.items && ec.items.length ? ec.items : [];
    var poz = [];
    for (var i = 0; i < items.length && i < 50; i++) if (items[i] && typeof items[i] === "object") poz.push(pozycja(items[i], i === 0 && nazwa === "view_item" ? href : null, i === 0 ? img : null));
    var waluta = str(ec.currency, 3);
    var suma = 0, nazwy = [], kat = [];
    for (var j = 0; j < poz.length; j++) {
      suma += poz[j].RowTotal || 0;
      if (poz[j].ProductName) nazwy.push(poz[j].ProductName);
      for (var q = 0; q < poz[j].ProductCategories.length; q++) if (kat.indexOf(poz[j].ProductCategories[q]) < 0) kat.push(poz[j].ProductCategories[q]);
    }
    var wartosc = num(ec.value);
    if (wartosc === null) wartosc = Math.round(suma * 100) / 100;
    var p;
    if (nazwa === "view_item") {
      var x = poz[0];
      if (!x || !x.ProductID && !x.ProductName) return null;
      p = { ProductName: x.ProductName, ProductID: x.ProductID, SKU: x.SKU, Categories: x.ProductCategories, ImageURL: x.ImageURL, URL: x.ProductURL || href, Brand: x.Brand, Price: x.ItemPrice, $value: x.ItemPrice };
      return ["Viewed Product", p, waluta];
    }
    if (nazwa === "add_to_cart") {
      var a = poz[0];
      if (!a) return null;
      p = { $value: wartosc, AddedItemProductName: a.ProductName, AddedItemProductID: a.ProductID, AddedItemSKU: a.SKU, AddedItemCategories: a.ProductCategories, AddedItemImageURL: a.ImageURL, AddedItemURL: a.ProductURL, AddedItemPrice: a.ItemPrice, AddedItemQuantity: a.Quantity, ItemNames: nazwy, Items: poz };
      return ["Added to Cart", p, waluta];
    }
    if (nazwa === "begin_checkout") {
      if (!poz.length) return null;
      p = { $value: wartosc, ItemNames: nazwy, CheckoutURL: href, Categories: kat, Items: poz };
      return ["Started Checkout", p, waluta];
    }
    return null;
  }
  function emailZZakupu(ev) {
    var u = ev && (ev.user_data || ev.enhanced_conversion_data || (ev.ecommerce && ev.ecommerce.user_data));
    var e = u && (u.email || u.email_address);
    e = str(e, 320);
    return e && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
  }
  var widzianyViewItem = false;
  function zdarzenieDataLayer(ev) {
    if (!ev || typeof ev !== "object") return;
    var nazwa, ec;
    if (typeof ev.length === "number" && ev[0] === "event") { nazwa = ev[1]; ec = ev[2]; }
    else if (zgodaZDataLayer(ev)) { sprawdzZgode(); return; }
    else { nazwa = ev.event; ec = ev.ecommerce; }
    if (nazwa === "gtm.dom" || nazwa === "gtm.load") return;
    if (!K.ga4) return;
    if (nazwa === "purchase") { var e = emailZZakupu(ev.length ? ev[2] : ev); if (e) identify({ email: e }); return; }
    var m = mapujGa4(nazwa, ec, adresStrony(), obrazStrony());
    if (!m) return;
    if (m[0] === "Viewed Product") widzianyViewItem = true;
    track(m[0], m[1], { waluta: m[2] });
  }
  function podepnijDataLayer() {
    var dl = w.dataLayer = w.dataLayer || [];
    if (dl.__midrev) return;
    for (var i = 0; i < dl.length; i++) cicho(zdarzenieDataLayer)(dl[i]);
    var oryginal = dl.push;
    dl.push = function () {
      var r = oryginal.apply(dl, arguments);
      for (var j = 0; j < arguments.length; j++) cicho(zdarzenieDataLayer)(arguments[j]);
      return r;
    };
    dl.__midrev = 1;
  }

  // JSON-LD Product (zapas, gdy strona nie ma GA4 view_item)
  function produktZJsonLd() {
    var s = d.querySelectorAll ? d.querySelectorAll('script[type="application/ld+json"]') : [];
    for (var i = 0; i < s.length; i++) {
      var o; try { o = JSON.parse(s[i].textContent || ""); } catch (e) { continue; }
      var lista = [].concat(o && o["@graph"] ? o["@graph"] : o);
      for (var j = 0; j < lista.length; j++) {
        var x = lista[j];
        if (!x || (x["@type"] !== "Product" && !(x["@type"] && x["@type"].indexOf && x["@type"].indexOf("Product") >= 0 && typeof x["@type"] !== "string"))) continue;
        var of = [].concat(x.offers || [])[0] || {};
        var img = [].concat(x.image || [])[0];
        if (img && typeof img === "object") img = img.url;
        var cena = num(of.price !== undefined ? of.price : of.lowPrice);
        return ["Viewed Product", { ProductName: str(x.name, 500), ProductID: str(x.sku || x.productID || x["@id"], 255) || adresStrony(), SKU: str(x.sku, 255), ImageURL: str(img, 2000) || obrazStrony(), URL: adresStrony(), Brand: str(x.brand && (x.brand.name || x.brand), 255), Price: cena, $value: cena, Categories: x.category ? [str(x.category, 120)] : [] }, str(of.priceCurrency, 3)];
      }
    }
    return null;
  }

  // ── wykonanie komend (_learnq, klaviyo, midrev) ───────────────────────────
  function wykonaj(c) {
    if (!c || typeof c.length !== "number") { if (typeof c === "function") cicho(c)(); return P(false); }
    var nazwa = c[0];
    if (nazwa === "identify") return identify(c[1]);
    if (nazwa === "track") return track(c[1], c[2]);
    if (nazwa === "trackViewedItem") return trackViewedItem(c[1]);
    if (nazwa === "consent") { trybRecznej = true; ustawZgode(c[1] !== false, "push"); return P(true); }
    if (nazwa === "subscribe") return subscribe(c[1]);
    return P(false);
  }
  var bezpieczneWykonaj = function (c) { try { return wykonaj(c); } catch (e) { log("komenda", e && e.message); return P(false); } };
  function kolejka(q) { if (q && typeof q.length === "number" && typeof q !== "string") for (var i = 0; i < q.length; i++) bezpieczneWykonaj(q[i]); }

  var api = {
    v: K.v,
    push: function () { var r; for (var i = 0; i < arguments.length; i++) r = bezpieczneWykonaj(arguments[i]); return r || P(false); },
    identify: function (o) { return bezpieczneWykonaj(["identify", o]); },
    track: function (n, p) { return bezpieczneWykonaj(["track", n, p]); },
    trackViewedItem: function (o) { return bezpieczneWykonaj(["trackViewedItem", o]); },
    isIdentified: function () { return P(zgoda && rozpoznany()); },
    subscribe: function (o) { return bezpieczneWykonaj(["subscribe", o]); },
    consent: function (v) { trybRecznej = true; ustawZgode(v !== false, "api"); return P(zgoda); },
    _mapujGa4: mapujGa4,
    __midrev: true
  };
  api.consent.grant = function () { return api.consent(true); };
  api.consent.revoke = function () { return api.consent(false); };
  api.consent.status = function () { return zgoda; };

  // ── start ─────────────────────────────────────────────────────────────────
  function tokenZAdresu() {
    try {
      var u = new URL(w.location.href);
      var t = u.searchParams.get("_mx");
      if (!t) return;
      u.searchParams["delete"]("_mx");
      if (w.history && w.history.replaceState) w.history.replaceState(w.history.state, "", u.pathname + u.search + u.hash);
      if (/^[A-Za-z0-9_-]{60,200}$/.test(t)) tokenZLinku = t;
    } catch (e) {}
  }
  var stronaZrobiona = false;
  function stronaPoZgodzie() {
    if (stronaZrobiona) return;
    stronaZrobiona = true;
    if (tokenZLinku) wyslij("/client/profiles", profil());
    aktywnyNaStronie();
    if (K.ga4) w.setTimeout(cicho(function () { if (!widzianyViewItem) { var m = produktZJsonLd(); if (m) track(m[0], m[1], { waluta: m[2] }); } }), 2500);
  }
  function znacznikDebug() {
    if (!DEBUG || !d.body) return;
    var b = d.createElement("div");
    b.setAttribute("style", "position:fixed;left:12px;bottom:12px;z-index:2147483646;background:#0f172a;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:8px 10px;border-radius:8px;opacity:.92");
    b.textContent = "MidRev widzi tę stronę · zgoda: " + (zgoda ? "tak" : "nie") + " · osoba: " + (zgoda && rozpoznany() ? "rozpoznana" : "nieznana") + " · v" + K.v;
    d.body.appendChild(b);
  }
  function formularze() {
    if (!K.formy || w.__midrevPopup || w.__midrevFormularze) return;
    var s = d.getElementsByTagName("script");
    for (var i = 0; i < s.length; i++) if ((s[i].getAttribute("src") || "").indexOf(K.formy) === 0) return;
    var el = d.createElement("script");
    el.async = true; el.src = K.formy;
    (d.head || d.documentElement).appendChild(el);
  }

  cicho(function () {
    tokenZAdresu();
    var przed = { m: w.midrev, l: w._learnq, k: w.klaviyo };
    w.midrev = api;
    // shim Klaviyo tylko, gdy prawdziwego klaviyo.js nie ma na stronie (nie psujemy go):
    // klaviyo.js zamienia _learnq/klaviyo z tablicy (kolejki) na własny obiekt
    function tablica(x) { return x && typeof x.length === "number" && typeof x !== "string"; }
    var prawdziweKlaviyo = (przed.k && !przed.k.__midrev && !tablica(przed.k) && typeof przed.k.identify === "function") ||
      (przed.l && !przed.l.__midrev && !tablica(przed.l) && typeof przed.l.push === "function");
    var shim = K.shim && !prawdziweKlaviyo;
    if (shim) {
      w._learnq = { push: api.push, __midrev: true };
      w.klaviyo = api;
    }
    if (zgoda) wczytajStan();
    else sprawdzZgode();
    podepnijDataLayer();
    kolejka(przed.m);
    if (shim) { kolejka(przed.l); kolejka(przed.k); }
    if (zgoda) stronaPoZgodzie();
    // CMP: zdarzenia znanych banerów + odpytanie przez 2 min (baner ładuje się później)
    var ev = ["CookiebotOnAccept", "CookiebotOnDecline", "CookiebotOnConsentReady", "cookieyes_consent_update", "consent.onetrust", "OneTrustGroupsUpdated", "cmplz_status_change", "cmplz_fire_categories", "wp_listen_for_consent_change"];
    for (var i = 0; i < ev.length; i++) { w.addEventListener(ev[i], cicho(sprawdzZgode)); d.addEventListener(ev[i], cicho(sprawdzZgode)); }
    var n = 0, t = w.setInterval(cicho(function () { sprawdzZgode(); if (++n > 80) w.clearInterval(t); }), 1500);
    // formularze (builder) zgłaszają zapis, skrypt identyfikuje osobę po zgodzie
    d.addEventListener("midrev:identify", cicho(function (e) { if (e && e.detail) identify(e.detail); }));
    formularze();
    if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", cicho(znacznikDebug)); else znacznikDebug();
    log("start", K.v, "zgoda:", zgoda);
  })();
})(window, document, __KONFIG__);
`;

/** JSON bezpieczny do wklejenia w <script>: bez "<" i separatorów linii U+2028/29. */
export function bezpiecznyJsonSkryptu(dane: unknown): string {
  return JSON.stringify(dane).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export interface KonfiguracjaMidrevJs {
  id: string;
  api: string;
  /** true = nic nie śledzi przed zgodą na cookies */
  zgoda: boolean;
  ga4: boolean;
  shim: boolean;
  /** adres loadera formularzy (istniejący /s/{tenantId}) albo null */
  formy: string | null;
}

export function zbudujMidrevJs(k: KonfiguracjaMidrevJs): string {
  const konfig = { v: WERSJA_MIDREV_JS, id: k.id, api: k.api, zgoda: k.zgoda, ga4: k.ga4, shim: k.shim, formy: k.formy };
  return `/* midrev.js v${WERSJA_MIDREV_JS} */\n` + RUNTIME_MIDREV.replace("__KONFIG__", () => bezpiecznyJsonSkryptu(konfig));
}
