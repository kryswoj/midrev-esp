/*
 * Most Shopify Customer Privacy API → midrev.js (wersja 1.0.0).
 * Zgoda MARKETINGOWA i ANALITYCZNA z banera Shopify (albo „nie wymagana” w regionie) = 
 * `_learnq.push(["consent", true])`; sprzeciw = `["consent", false]` (midrev.js usuwa wtedy
 * ciasteczko). Zalogowany klient: identify po e-mailu, kolejkowany w midrev.js do zgody.
 * Nigdy nie psuje strony: wszystko w try/catch.
 */
(function (w, d) {
  "use strict";
  if (w.__midrevShopifyMost) return;
  w.__midrevShopifyMost = 1;
  var q = (w._learnq = w._learnq || []);
  function ustaw(zgoda) {
    try { q.push(["consent", zgoda === true]); } catch (e) {}
  }
  function zPrywatnosci() {
    try {
      var cp = w.Shopify && w.Shopify.customerPrivacy;
      if (!cp) return;
      ustaw(cp.marketingAllowed() === true && cp.analyticsProcessingAllowed() === true);
    } catch (e) {}
  }
  try {
    if (w.Shopify && typeof w.Shopify.loadFeatures === "function") {
      w.Shopify.loadFeatures([{ name: "consent-tracking-api", version: "0.1" }], function (blad) {
        if (!blad) zPrywatnosci();
      });
    }
    d.addEventListener("visitorConsentCollected", function (e) {
      try {
        var x = e && e.detail;
        if (x) ustaw(x.marketingAllowed === true && x.analyticsAllowed === true);
        else zPrywatnosci();
      } catch (b) {}
    });
  } catch (e) {}
  try {
    var k = w.__midrevShopify;
    if (k && typeof k.zalogowany === "string" && k.zalogowany) q.push(["identify", { email: k.zalogowany }]);
  } catch (e) {}
})(window, document);
