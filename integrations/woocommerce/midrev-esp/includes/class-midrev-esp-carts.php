<?php
/**
 * Token koszyka i link odtwarzający koszyk `?mrv_cart=`.
 *
 * @package MidrevEsp
 */

defined( 'ABSPATH' ) || exit;

/**
 * Koszyk Woo żyje w sesji przeglądarki, więc mail „wróć do koszyka” otwarty na telefonie
 * zobaczyłby pusty koszyk. Wtyczka trzyma kopię pozycji pod losowym tokenem (sesja Woo, bez
 * własnego ciasteczka) i buduje PODPISANY link z datą ważności:
 *
 *   https://sklep.pl/?mrv_cart={token}.{wygasa}.{podpis}
 *
 * podpis = HMAC-SHA256(sekret wtyczki, "koszyk|{token}.{wygasa}") (32 znaki hex). Link odtwarza
 * pozycje (warianty, ilości, kupony) w NOWEJ sesji i przekierowuje do kasy. Nie loguje, nie
 * wypełnia danych osoby (link przekazany dalej nie zdradza, kto kupował).
 */
class Midrev_Esp_Carts {

	const SESSION_TOKEN = 'midrev_esp_cart_token';

	/**
	 * Trwa odtwarzanie koszyka z linku: dodania produktów NIE są nowymi „Added to Cart”.
	 *
	 * @var bool
	 */
	public static $restoring = false;
	const TTL                = 2592000; // 30 dni
	const MAX_ITEMS          = 100;

	/** Podpięcie akcji. */
	public static function init(): void {
		add_action( 'wp_loaded', array( __CLASS__, 'maybe_restore' ), 25 );
		add_action( 'midrev_esp_cleanup_carts', array( __CLASS__, 'cleanup' ) );
		add_action( 'init', array( __CLASS__, 'schedule_cleanup' ) );
	}

	/** Sprzątanie wygasłych koszyków raz na dobę. */
	public static function schedule_cleanup(): void {
		if ( function_exists( 'as_has_scheduled_action' ) && Midrev_Esp_Api::is_connected() && ! as_has_scheduled_action( 'midrev_esp_cleanup_carts', array(), Midrev_Esp_Install::GROUP ) ) {
			as_schedule_recurring_action( time() + 3600, DAY_IN_SECONDS, 'midrev_esp_cleanup_carts', array(), Midrev_Esp_Install::GROUP );
		}
	}

	/** Usunięcie wygasłych koszyków. */
	public static function cleanup(): void {
		global $wpdb;
		$tabela = Midrev_Esp_Install::carts_table();
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$tabela} WHERE expires_at < %s", current_time( 'mysql', true ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	/** Token koszyka z sesji Woo (tworzony, gdy koszyk ma pozycje). */
	public static function token( bool $utworz = true ): ?string {
		if ( ! function_exists( 'WC' ) || ! WC()->session ) {
			return null;
		}
		$t = WC()->session->get( self::SESSION_TOKEN );
		if ( is_string( $t ) && preg_match( '/^[A-Za-z0-9]{32}$/', $t ) ) {
			return $t;
		}
		if ( ! $utworz ) {
			return null;
		}
		$t = wp_generate_password( 32, false, false );
		WC()->session->set( self::SESSION_TOKEN, $t );
		return $t;
	}

	/** Nowy token po złożeniu zamówienia (kolejny koszyk tej osoby to inny koszyk). */
	public static function rotate(): void {
		if ( function_exists( 'WC' ) && WC()->session ) {
			WC()->session->set( self::SESSION_TOKEN, null );
		}
	}

	/**
	 * Pozycje koszyka w kształcie zdarzeń ESP.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public static function items(): array {
		$wynik = array();
		if ( ! function_exists( 'WC' ) || ! WC()->cart ) {
			return $wynik;
		}
		foreach ( WC()->cart->get_cart() as $pozycja ) {
			$wynik[] = self::item_from_cart( $pozycja );
			if ( count( $wynik ) >= self::MAX_ITEMS ) {
				break;
			}
		}
		return $wynik;
	}

	/**
	 * Jedna pozycja koszyka.
	 *
	 * @param array $pozycja Pozycja z WC()->cart->get_cart().
	 */
	public static function item_from_cart( array $pozycja ): array {
		$produkt = isset( $pozycja['data'] ) && $pozycja['data'] instanceof WC_Product ? $pozycja['data'] : null;
		return self::item_from_product(
			$produkt,
			(int) ( $pozycja['product_id'] ?? 0 ),
			(int) ( $pozycja['variation_id'] ?? 0 ),
			(int) ( $pozycja['quantity'] ?? 1 ),
			isset( $pozycja['variation'] ) && is_array( $pozycja['variation'] ) ? $pozycja['variation'] : array()
		);
	}

	/**
	 * Pozycja z produktu.
	 *
	 * @param WC_Product|null $produkt    Produkt (wariant albo prosty).
	 * @param int             $product_id Id produktu nadrzędnego.
	 * @param int             $variation  Id wariantu (0 = brak).
	 * @param int             $qty        Ilość.
	 * @param array           $atrybuty   Atrybuty wariantu.
	 */
	public static function item_from_product( $produkt, int $product_id, int $variation, int $qty, array $atrybuty = array() ): array {
		$obraz = '';
		$url   = '';
		$cena  = null;
		$nazwa = '';
		$sku   = '';
		$kat   = array();
		if ( $produkt instanceof WC_Product ) {
			$nazwa = $produkt->get_name();
			$sku   = (string) $produkt->get_sku();
			$cena  = wc_format_decimal( wc_get_price_including_tax( $produkt ), wc_get_price_decimals() );
			$url   = (string) $produkt->get_permalink();
			$img   = $produkt->get_image_id() ? wp_get_attachment_image_url( $produkt->get_image_id(), 'woocommerce_thumbnail' ) : '';
			$obraz = $img ? (string) $img : '';
			$kat   = wp_list_pluck( wc_get_product_terms( $product_id, 'product_cat', array( 'fields' => 'all' ) ), 'name' );
		}
		return array(
			'product_id'   => (string) $product_id,
			'variation_id' => $variation > 0 ? (string) $variation : null,
			'name'         => wp_strip_all_tags( $nazwa ) ? wp_strip_all_tags( $nazwa ) : '#' . $product_id,
			'sku'          => $sku,
			'qty'          => max( 1, min( 9999, $qty ) ),
			'price'        => $cena,
			'image'        => $obraz,
			'url'          => $url,
			'categories'   => array_slice( array_map( 'strval', $kat ), 0, 20 ),
			'attributes'   => array_map( 'strval', $atrybuty ),
		);
	}

	/** Zapis kopii koszyka pod tokenem (do odtworzenia z linku). Zwraca token albo null. */
	public static function save_snapshot(): ?string {
		if ( ! function_exists( 'WC' ) || ! WC()->cart || WC()->cart->is_empty() ) {
			return null;
		}
		$token = self::token();
		if ( ! $token ) {
			return null;
		}
		$pozycje = array();
		foreach ( WC()->cart->get_cart() as $p ) {
			$pozycje[] = array(
				'product_id'   => (int) ( $p['product_id'] ?? 0 ),
				'variation_id' => (int) ( $p['variation_id'] ?? 0 ),
				'quantity'     => (int) ( $p['quantity'] ?? 1 ),
				'variation'    => isset( $p['variation'] ) && is_array( $p['variation'] ) ? array_map( 'strval', $p['variation'] ) : array(),
			);
			if ( count( $pozycje ) >= self::MAX_ITEMS ) {
				break;
			}
		}
		global $wpdb;
		$teraz = time();
		$wpdb->replace( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			Midrev_Esp_Install::carts_table(),
			array(
				'token'      => $token,
				'items'      => wp_json_encode( $pozycje ),
				'coupons'    => wp_json_encode( array_values( WC()->cart->get_applied_coupons() ) ),
				'updated_at' => gmdate( 'Y-m-d H:i:s', $teraz ),
				'expires_at' => gmdate( 'Y-m-d H:i:s', $teraz + self::TTL ),
			),
			array( '%s', '%s', '%s', '%s', '%s' )
		);
		return $token;
	}

	/** Podpisany link odtwarzający koszyk (ważny 30 dni od ostatniej zmiany). */
	public static function recovery_url( string $token ): string {
		$wygasa = time() + self::TTL;
		$podpis = substr( Midrev_Esp_Api::hmac( $token . '.' . $wygasa ), 0, 32 );
		return add_query_arg( 'mrv_cart', $token . '.' . $wygasa . '.' . $podpis, home_url( '/' ) );
	}

	/**
	 * Weryfikacja wartości `mrv_cart`. Zwraca token albo null (zły format, podpis, wygasły).
	 *
	 * @param string $wartosc Wartość parametru.
	 */
	public static function verify( string $wartosc ): ?string {
		if ( ! Midrev_Esp_Api::is_connected() ) {
			return null;
		}
		if ( ! preg_match( '/^([A-Za-z0-9]{32})\.(\d{9,11})\.([a-f0-9]{32})$/', $wartosc, $m ) ) {
			return null;
		}
		if ( (int) $m[2] < time() ) {
			return null;
		}
		$oczekiwany = substr( Midrev_Esp_Api::hmac( $m[1] . '.' . $m[2] ), 0, 32 );
		return hash_equals( $oczekiwany, $m[3] ) ? $m[1] : null;
	}

	/** Obsługa linku `?mrv_cart=` na froncie sklepu. */
	public static function maybe_restore(): void {
		if ( empty( $_GET['mrv_cart'] ) || is_admin() || wp_doing_ajax() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			return;
		}
		if ( ! function_exists( 'WC' ) || ! WC()->cart || ! WC()->session ) {
			return;
		}
		$wartosc = sanitize_text_field( wp_unslash( $_GET['mrv_cart'] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- link z maila: autoryzacją jest podpis HMAC, nie nonce
		$token   = self::verify( $wartosc );
		// porażka: koszyk sklepu (tam motyw pokazuje komunikaty), bez parametru w adresie
		$cel = wc_get_cart_url();
		if ( ! $token ) {
			wc_add_notice( __( 'This cart link has expired. Your cart could not be restored.', 'midrev-esp' ), 'notice' );
			wp_safe_redirect( $cel );
			exit;
		}
		global $wpdb;
		$tabela = Midrev_Esp_Install::carts_table();
		$wiersz = $wpdb->get_row( $wpdb->prepare( "SELECT items, coupons FROM {$tabela} WHERE token = %s AND expires_at >= %s", $token, current_time( 'mysql', true ) ), ARRAY_A ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		if ( ! $wiersz ) {
			wc_add_notice( __( 'This cart link has expired. Your cart could not be restored.', 'midrev-esp' ), 'notice' );
			wp_safe_redirect( $cel );
			exit;
		}
		$pozycje = json_decode( (string) $wiersz['items'], true );
		$kupony  = json_decode( (string) $wiersz['coupons'], true );
		WC()->session->set_customer_session_cookie( true );
		WC()->cart->empty_cart();
		$pominiete       = 0;
		self::$restoring = true;
		foreach ( is_array( $pozycje ) ? $pozycje : array() as $p ) {
			$produkt = absint( $p['product_id'] ?? 0 );
			$wariant = absint( $p['variation_id'] ?? 0 );
			$ilosc   = max( 1, min( 9999, absint( $p['quantity'] ?? 1 ) ) );
			$atr     = isset( $p['variation'] ) && is_array( $p['variation'] ) ? array_map( 'sanitize_text_field', $p['variation'] ) : array();
			if ( ! $produkt || false === WC()->cart->add_to_cart( $produkt, $ilosc, $wariant, $atr ) ) {
				++$pominiete;
			}
		}
		foreach ( is_array( $kupony ) ? $kupony : array() as $kupon ) {
			$kupon = wc_format_coupon_code( (string) $kupon );
			if ( $kupon && ! WC()->cart->has_discount( $kupon ) ) {
				WC()->cart->apply_coupon( $kupon );
			}
		}
		self::$restoring = false;
		// NOWY token dla tej sesji (review PHP r1): link przekazany dalej nie współdzieli koszyka
		// z nadawcą; stary koszyk w ESP zamknie zakup tej osoby (dopasowanie po osobie i czasie)
		WC()->session->set( self::SESSION_TOKEN, null );
		self::save_snapshot();
		if ( $pominiete > 0 ) {
			wc_add_notice( __( 'Some products from your cart are no longer available.', 'midrev-esp' ), 'notice' );
		}
		wp_safe_redirect( WC()->cart->is_empty() ? wc_get_cart_url() : wc_get_checkout_url() );
		exit;
	}
}
