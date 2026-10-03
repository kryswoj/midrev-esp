<?php
/**
 * Skrypt midrev.js na stronie sklepu i Viewed Product.
 *
 * @package MidrevEsp
 */

defined( 'ABSPATH' ) || exit;

/**
 * midrev.js (klucz publiczny strony, bez sekretów) robi popupy, identyfikację z linków
 * w mailach i Viewed Product. Bramkę zgody na cookies ma sam skrypt (WP Consent API, Consent
 * Mode v2, popularne CMP): przed zgodą nie zapisuje ciasteczek i nic nie wysyła, a zdarzenia
 * z kolejki `window.midrev` wykonuje dopiero po zgodzie.
 *
 * Added to Cart i Started Checkout liczy serwer (Midrev_Esp_Tracker), więc skrypt w trybie
 * Woo ich nie wysyła (GA4 dataLayer wyłączony przy parowaniu): bez podwójnych zdarzeń.
 */
class Midrev_Esp_Frontend {

	/** Podpięcie akcji. */
	public static function init(): void {
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_action( 'init', array( __CLASS__, 'register_cookie_info' ) );
	}

	/** Opis ciasteczka dla WP Consent API (lista cookies w CMP). */
	public static function register_cookie_info(): void {
		if ( function_exists( 'wp_add_cookie_info' ) ) {
			wp_add_cookie_info( '__mx_id', 'MidRev ESP', 'marketing', __( '2 years', 'midrev-esp' ), __( 'Random browser identifier used to recognise returning visitors and personalise e-mails.', 'midrev-esp' ) );
		}
	}

	/** midrev.js + kolejka zdarzeń strony. */
	public static function enqueue(): void {
		if ( ! Midrev_Esp_Api::is_connected() ) {
			return;
		}
		$c = Midrev_Esp_Api::config();
		if ( empty( $c['script_url'] ) || ! wp_http_validate_url( $c['script_url'] ) ) {
			return;
		}
		wp_register_script( 'midrev-esp', $c['script_url'], array(), null, array( 'strategy' => 'async', 'in_footer' => false ) ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion -- wersję skryptu trzyma ESP (cache 5 min)
		wp_enqueue_script( 'midrev-esp' );

		$kolejka = array();
		if ( is_user_logged_in() ) {
			$email = sanitize_email( wp_get_current_user()->user_email );
			if ( $email ) {
				$kolejka[] = array( 'identify', array( 'email' => $email ) );
			}
		}
		if ( function_exists( 'is_product' ) && is_product() ) {
			$produkt = wc_get_product( get_queried_object_id() );
			if ( $produkt instanceof WC_Product ) {
				$dane      = self::product_data( $produkt );
				$kolejka[] = array( 'track', 'Viewed Product', $dane );
				$kolejka[] = array(
					'trackViewedItem',
					array(
						'Title'      => $dane['ProductName'],
						'ItemId'     => $dane['ProductID'],
						'Url'        => $dane['URL'],
						'ImageUrl'   => $dane['ImageURL'],
						'Categories' => $dane['Categories'],
					),
				);
			}
		}
		$js = 'window.midrev=window.midrev||[];window._learnq=window._learnq||[];';
		foreach ( $kolejka as $wpis ) {
			$js .= 'window.midrev.push(' . wp_json_encode( $wpis, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT ) . ');';
		}
		wp_add_inline_script( 'midrev-esp', $js, 'before' );
	}

	/**
	 * Dane produktu w kształcie Klaviyo (Viewed Product).
	 *
	 * @param WC_Product $produkt Produkt.
	 */
	public static function product_data( WC_Product $produkt ): array {
		$obraz = $produkt->get_image_id() ? wp_get_attachment_image_url( $produkt->get_image_id(), 'woocommerce_single' ) : '';
		$cena  = (float) wc_get_price_to_display( $produkt );
		$przed = $produkt->is_on_sale() ? (float) $produkt->get_regular_price() : null;
		return array(
			'ProductID'      => (string) $produkt->get_id(),
			'ProductName'    => wp_strip_all_tags( $produkt->get_name() ),
			'SKU'            => (string) $produkt->get_sku(),
			'Categories'     => wp_list_pluck( wc_get_product_terms( $produkt->get_id(), 'product_cat', array( 'fields' => 'all' ) ), 'name' ),
			'ImageURL'       => $obraz ? (string) $obraz : '',
			'URL'            => (string) $produkt->get_permalink(),
			'Price'          => $cena,
			'CompareAtPrice' => $przed,
			'$value'         => $cena,
		);
	}
}
