<?php
/**
 * Added to Cart i Started Checkout liczone po stronie serwera sklepu.
 *
 * @package MidrevEsp
 */

defined( 'ABSPATH' ) || exit;

/**
 * Zdarzenia koszyka z hooków WooCommerce, nie z DOM-u: działają tak samo na klasycznym
 * i blokowym checkoucie, przy adblocku i ITP.
 *
 *  - Added to Cart: `woocommerce_add_to_cart` (woła go i klasyczny formularz, i Store API).
 *    Zdarzenie wychodzi raz na żądanie, na `shutdown`, z pełnym koszykiem po zmianie.
 *  - Started Checkout: e-mail z kasy. Klasyczna: `woocommerce_checkout_update_order_review`
 *    (AJAX po wpisaniu danych). Blokowa: Store API `woocommerce_store_api_cart_update_customer_from_request`
 *    (PUT /cart/update-customer po wpisaniu e-maila) i `woocommerce_store_api_checkout_update_order_from_request`
 *    (aktualizacja szkicu zamówienia). Zalogowany klient na stronie kasy: od razu.
 *    Raz na token koszyka i zawartość (ten sam koszyk = jedno zdarzenie).
 *  - Zakup: token koszyka trafia do meta zamówienia `_mrv_cart_token` (ESP zamyka nim koszyk),
 *    a sesja dostaje nowy token.
 *
 * Kogo dotyczy zdarzenie: e-mail (zalogowany, wpisany w kasie) albo identyfikator przeglądarki
 * z ciasteczka `__mx_id` (midrev.js zakłada je WYŁĄCZNIE po zgodzie na cookies). Nieznany gość:
 * nic nie wysyłamy. Przy WP Consent API zdarzenia wychodzą tylko ze zgodą „marketing”.
 */
class Midrev_Esp_Tracker {

	const SESSION_EMAIL = 'midrev_esp_email';
	const SESSION_SC    = 'midrev_esp_sc_hash';

	/**
	 * Koszyk zmienił się w tym żądaniu.
	 *
	 * @var bool
	 */
	private static $dirty = false;

	/**
	 * Pozycja dodana w tym żądaniu (ostatnia).
	 *
	 * @var array|null
	 */
	private static $added = null;

	/** Podpięcie akcji. */
	public static function init(): void {
		add_action( 'woocommerce_add_to_cart', array( __CLASS__, 'on_add_to_cart' ), 20, 6 );
		add_action( 'woocommerce_cart_item_removed', array( __CLASS__, 'mark_dirty' ) );
		add_action( 'woocommerce_after_cart_item_quantity_update', array( __CLASS__, 'mark_dirty' ) );
		add_action( 'woocommerce_applied_coupon', array( __CLASS__, 'mark_dirty' ) );
		add_action( 'woocommerce_removed_coupon', array( __CLASS__, 'mark_dirty' ) );
		add_action( 'shutdown', array( __CLASS__, 'on_shutdown' ), 5 );

		add_action( 'woocommerce_checkout_update_order_review', array( __CLASS__, 'on_classic_review' ) );
		add_action( 'woocommerce_store_api_cart_update_customer_from_request', array( __CLASS__, 'on_store_api_customer' ), 20, 2 );
		add_action( 'woocommerce_store_api_checkout_update_order_from_request', array( __CLASS__, 'on_store_api_order' ), 20, 2 );
		add_action( 'template_redirect', array( __CLASS__, 'on_checkout_page' ), 20 );

		add_action( 'woocommerce_checkout_create_order', array( __CLASS__, 'tag_order' ), 10, 1 );
		add_action( 'woocommerce_store_api_checkout_update_order_meta', array( __CLASS__, 'tag_order' ), 10, 1 );
		add_action( 'woocommerce_checkout_order_processed', array( __CLASS__, 'after_order' ), 50, 0 );
		add_action( 'woocommerce_store_api_checkout_order_processed', array( __CLASS__, 'after_order' ), 50, 0 );
	}

	/** Czy wolno wysyłać zdarzenia zachowań (WP Consent API, kategoria „marketing”). */
	public static function can_track(): bool {
		if ( function_exists( 'wp_has_consent' ) ) {
			return (bool) wp_has_consent( 'marketing' );
		}
		return (bool) apply_filters( 'midrev_esp_can_track', true );
	}

	/** Identyfikator przeglądarki z ciasteczka midrev.js (`__mx_id` = {"a":"…","t":…}). */
	public static function anonymous_id(): ?string {
		if ( empty( $_COOKIE['__mx_id'] ) ) {
			return null;
		}
		$surowe = json_decode( rawurldecode( sanitize_text_field( wp_unslash( $_COOKIE['__mx_id'] ) ) ), true );
		if ( ! is_array( $surowe ) || empty( $surowe['a'] ) || ! is_string( $surowe['a'] ) ) {
			return null;
		}
		return preg_match( '/^[A-Za-z0-9_-]{8,64}$/', $surowe['a'] ) ? $surowe['a'] : null;
	}

	/** E-mail osoby w tej sesji: wpisany w kasie, z konta albo z danych klienta Woo. */
	public static function email(): ?string {
		$kandydaci = array();
		if ( function_exists( 'WC' ) && WC()->session ) {
			$kandydaci[] = (string) WC()->session->get( self::SESSION_EMAIL );
		}
		if ( is_user_logged_in() ) {
			$kandydaci[] = (string) wp_get_current_user()->user_email;
		}
		if ( function_exists( 'WC' ) && WC()->customer ) {
			$kandydaci[] = (string) WC()->customer->get_billing_email();
		}
		foreach ( $kandydaci as $e ) {
			$e = sanitize_email( $e );
			if ( $e && is_email( $e ) ) {
				return strtolower( $e );
			}
		}
		return null;
	}

	/** Zapamiętanie e-maila z kasy w sesji Woo. */
	private static function remember_email( string $email ): ?string {
		$email = sanitize_email( $email );
		if ( ! $email || ! is_email( $email ) ) {
			return null;
		}
		if ( function_exists( 'WC' ) && WC()->session ) {
			WC()->session->set( self::SESSION_EMAIL, strtolower( $email ) );
		}
		return strtolower( $email );
	}

	/** Zmiana koszyka bez dodania produktu. */
	public static function mark_dirty(): void {
		if ( ! Midrev_Esp_Carts::$restoring ) {
			self::$dirty = true;
		}
	}

	/**
	 * Dodanie do koszyka (klasyczne i Store API).
	 *
	 * @param string $key          Klucz pozycji.
	 * @param int    $product_id   Produkt.
	 * @param int    $quantity     Ilość dodana.
	 * @param int    $variation_id Wariant.
	 * @param array  $variation    Atrybuty.
	 */
	public static function on_add_to_cart( $key, $product_id, $quantity, $variation_id, $variation = array() ): void {
		if ( Midrev_Esp_Carts::$restoring ) {
			return;
		}
		self::$dirty = true;
		$produkt     = wc_get_product( $variation_id ? $variation_id : $product_id );
		self::$added = Midrev_Esp_Carts::item_from_product( $produkt ? $produkt : null, (int) $product_id, (int) $variation_id, (int) $quantity, is_array( $variation ) ? $variation : array() );
	}

	/** Koniec żądania: kopia koszyka do odtworzenia i (gdy był add) zdarzenie Added to Cart. */
	public static function on_shutdown(): void {
		if ( ! self::$dirty || ! Midrev_Esp_Api::is_connected() ) {
			return;
		}
		self::$dirty = false;
		$token       = Midrev_Esp_Carts::save_snapshot();
		if ( ! $token || null === self::$added ) {
			return;
		}
		$dodany      = self::$added;
		self::$added = null;
		$email       = self::email();
		$anon        = self::anonymous_id();
		if ( ( ! $email && ! $anon ) || ! self::can_track() ) {
			return;
		}
		Midrev_Esp_Queue::push(
			array(
				'typ'          => 'added_to_cart',
				'email'        => $email,
				'anonymous_id' => $anon,
				'koszyk'       => self::cart_payload( $token ),
				'dodany'       => $dodany,
			)
		);
	}

	/**
	 * Koszyk w kształcie zdarzenia ESP.
	 *
	 * @param string $token Token koszyka.
	 */
	private static function cart_payload( string $token ): array {
		return array(
			'token'   => $token,
			'pozycje' => Midrev_Esp_Carts::items(),
			'wartosc' => WC()->cart ? wc_format_decimal( WC()->cart->get_total( 'edit' ), wc_get_price_decimals() ) : null,
			'waluta'  => get_woocommerce_currency(),
			'link'    => Midrev_Esp_Carts::recovery_url( $token ),
		);
	}

	/**
	 * Klasyczna kasa: AJAX update_order_review niesie pola formularza w `post_data`.
	 *
	 * @param string $post_data Pola kasy (query string).
	 */
	public static function on_classic_review( $post_data ): void {
		$pola = array();
		parse_str( is_string( $post_data ) ? $post_data : '', $pola );
		if ( ! empty( $pola['billing_email'] ) && is_string( $pola['billing_email'] ) ) {
			$email = self::remember_email( wp_unslash( $pola['billing_email'] ) );
			if ( $email ) {
				self::started_checkout( $email );
			}
		}
	}

	/**
	 * Kasa blokowa: Store API aktualizuje klienta koszyka (e-mail wpisany w polu kontaktu).
	 *
	 * @param WC_Customer     $customer Klient.
	 * @param WP_REST_Request $request  Żądanie.
	 */
	public static function on_store_api_customer( $customer, $request = null ): void {
		if ( $customer instanceof WC_Customer ) {
			$email = self::remember_email( (string) $customer->get_billing_email() );
			if ( $email ) {
				self::started_checkout( $email );
			}
		}
	}

	/**
	 * Kasa blokowa: aktualizacja szkicu zamówienia z żądania.
	 *
	 * @param WC_Order        $order   Szkic zamówienia.
	 * @param WP_REST_Request $request Żądanie.
	 */
	public static function on_store_api_order( $order, $request = null ): void {
		if ( $order instanceof WC_Order ) {
			$email = self::remember_email( (string) $order->get_billing_email() );
			if ( $email ) {
				self::started_checkout( $email );
			}
		}
	}

	/** Strona kasy z znanym e-mailem (zalogowany klient, e-mail z wcześniejszej wizyty). */
	public static function on_checkout_page(): void {
		if ( ! function_exists( 'is_checkout' ) || ! is_checkout() || is_order_received_page() || ( function_exists( 'is_wc_endpoint_url' ) && is_wc_endpoint_url() ) ) {
			return;
		}
		$email = self::email();
		if ( $email ) {
			self::started_checkout( $email );
		}
	}

	/**
	 * Started Checkout raz na token i zawartość koszyka.
	 *
	 * @param string $email E-mail z kasy.
	 */
	public static function started_checkout( string $email ): void {
		if ( ! Midrev_Esp_Api::is_connected() || ! function_exists( 'WC' ) || ! WC()->cart || WC()->cart->is_empty() || ! self::can_track() ) {
			return;
		}
		$token = Midrev_Esp_Carts::save_snapshot();
		if ( ! $token ) {
			return;
		}
		$pozycje = Midrev_Esp_Carts::items();
		$hash    = md5( $token . '|' . $email . '|' . wp_json_encode( wp_list_pluck( $pozycje, 'qty', 'product_id' ) ) . '|' . count( $pozycje ) );
		if ( WC()->session->get( self::SESSION_SC ) === $hash ) {
			return;
		}
		WC()->session->set( self::SESSION_SC, $hash );
		$imie     = WC()->customer ? (string) WC()->customer->get_billing_first_name() : '';
		$nazwisko = WC()->customer ? (string) WC()->customer->get_billing_last_name() : '';
		Midrev_Esp_Queue::push(
			array(
				'typ'          => 'started_checkout',
				'email'        => $email,
				'imie'         => $imie ? $imie : null,
				'nazwisko'     => $nazwisko ? $nazwisko : null,
				'anonymous_id' => self::anonymous_id(),
				'koszyk'       => self::cart_payload( $token ),
			)
		);
	}

	/**
	 * Token koszyka w meta zamówienia (przed zapisem zamówienia; HPOS-zgodnie przez WC_Order).
	 *
	 * @param WC_Order $order Zamówienie.
	 */
	public static function tag_order( $order ): void {
		if ( ! ( $order instanceof WC_Order ) ) {
			return;
		}
		$token = Midrev_Esp_Carts::token( false );
		if ( $token ) {
			$order->update_meta_data( '_mrv_cart_token', $token );
		}
	}

	/** Po złożeniu zamówienia: nowy koszyk = nowy token. */
	public static function after_order(): void {
		Midrev_Esp_Carts::rotate();
		if ( function_exists( 'WC' ) && WC()->session ) {
			WC()->session->set( self::SESSION_SC, null );
		}
	}
}
