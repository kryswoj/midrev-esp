<?php
/**
 * Plugin Name:       MidRev ESP for WooCommerce
 * Plugin URI:        https://midrev.pl
 * Description:       Connects WooCommerce with MidRev ESP: orders and products sync, abandoned cart and checkout events sent from the server, cart recovery links, newsletter consent at checkout.
 * Version:           1.0.0
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Author:            MidRev
 * Author URI:        https://midrev.pl
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       midrev-esp
 * Domain Path:       /languages
 * WC requires at least: 8.0
 * WC tested up to:   11.1
 * Requires Plugins:  woocommerce
 *
 * @package MidrevEsp
 */

defined( 'ABSPATH' ) || exit;

define( 'MIDREV_ESP_VERSION', '1.0.0' );
define( 'MIDREV_ESP_FILE', __FILE__ );
define( 'MIDREV_ESP_DIR', plugin_dir_path( __FILE__ ) );

// Adres API MidRev ESP. Domyślnie produkcja; sandbox/testy ustawiają stałą w wp-config.php
// (celowo NIE z parametru URL ani z formularza: podmieniony adres wysłałby klucze REST obcemu serwerowi).
if ( ! defined( 'MIDREV_ESP_API_URL' ) ) {
	define( 'MIDREV_ESP_API_URL', 'https://esp.midrev.pl' );
}

require_once MIDREV_ESP_DIR . 'includes/class-midrev-esp-install.php';
require_once MIDREV_ESP_DIR . 'includes/class-midrev-esp-api.php';
require_once MIDREV_ESP_DIR . 'includes/class-midrev-esp-queue.php';
require_once MIDREV_ESP_DIR . 'includes/class-midrev-esp-carts.php';
require_once MIDREV_ESP_DIR . 'includes/class-midrev-esp-tracker.php';
require_once MIDREV_ESP_DIR . 'includes/class-midrev-esp-consent.php';
require_once MIDREV_ESP_DIR . 'includes/class-midrev-esp-frontend.php';
require_once MIDREV_ESP_DIR . 'includes/class-midrev-esp-admin.php';

register_activation_hook( __FILE__, array( 'Midrev_Esp_Install', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'Midrev_Esp_Install', 'deactivate' ) );

// HPOS i blokowy checkout: deklaracje zgodności (odczyt zamówień wyłącznie przez wc_get_order()).
add_action(
	'before_woocommerce_init',
	static function () {
		if ( class_exists( '\Automattic\WooCommerce\Utilities\FeaturesUtil' ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', __FILE__, true );
		}
	}
);

add_action(
	'plugins_loaded',
	static function () {
		load_plugin_textdomain( 'midrev-esp', false, dirname( plugin_basename( __FILE__ ) ) . '/languages' );
		if ( ! class_exists( 'WooCommerce' ) ) {
			add_action(
				'admin_notices',
				static function () {
					echo '<div class="notice notice-error"><p>' . esc_html__( 'MidRev ESP for WooCommerce requires WooCommerce to be active.', 'midrev-esp' ) . '</p></div>';
				}
			);
			return;
		}
		Midrev_Esp_Install::maybe_upgrade();
		Midrev_Esp_Queue::init();
		Midrev_Esp_Carts::init();
		Midrev_Esp_Tracker::init();
		Midrev_Esp_Consent::init();
		Midrev_Esp_Frontend::init();
		if ( is_admin() ) {
			Midrev_Esp_Admin::init();
		}
	}
);

// WP Consent API: wtyczka deklaruje, że respektuje zgody (bez tego WP Consent API pokazuje ostrzeżenie).
add_filter( 'wp_consent_api_registered_' . plugin_basename( __FILE__ ), '__return_true' );
