=== MidRev ESP for WooCommerce ===
Contributors: midrev
Tags: woocommerce, email marketing, abandoned cart, newsletter
Requires at least: 6.2
Tested up to: 6.8
Requires PHP: 7.4
WC requires at least: 8.0
WC tested up to: 11.1
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Connects WooCommerce with MidRev ESP: orders, products, abandoned cart and checkout, cart recovery links and newsletter consent at checkout.

== Description ==

* One-click connection with a pairing code from the MidRev panel. The plugin creates the WooCommerce REST API key and webhooks itself.
* Added to Cart and Started Checkout are sent from the server (classic and block checkout), with a retry queue.
* Signed cart recovery link `?mrv_cart=` that restores the cart on any device (expires after 30 days).
* Newsletter checkbox at checkout (classic and block checkout), text managed in the MidRev panel, consent proof with clause version.
* Cart and checkout events are sent only with consent: WP Consent API category "marketing" (e.g. Complianz, CookieYes) or, without it, the MidRev tracking cookie set after cookie consent. No consent signal = no events (filter `midrev_esp_can_track`).
* HPOS compatible.

== External service ==

This plugin sends data to MidRev ESP (https://esp.midrev.pl), operated by MidRev, to provide e-mail marketing for the store:
order and product data (through WooCommerce REST API and webhooks), cart contents and the e-mail address entered at checkout,
newsletter consent with the clause version. Data is sent only after the store administrator connects the store.
Terms: https://midrev.pl/regulamin  Privacy policy: https://midrev.pl/polityka-prywatnosci

== Changelog ==

= 1.0.0 =
* First release.
