<?php
/**
 * Checkbox zgody na newsletter w kasie (klasycznej i blokowej).
 *
 * @package MidrevEsp
 */

defined( 'ABSPATH' ) || exit;

/**
 * Treść klauzuli przychodzi z panelu MidRev (wersjonowana). Wtyczka pokazuje ją przy
 * NIEZAZNACZONYM polu wyboru i po złożeniu zamówienia odsyła do ESP wyłącznie NUMER wersji:
 * do rejestru zgód trafia tekst z bazy ESP, więc nikt nie zapisze zgody na tekst, którego
 * klient nie widział.
 *
 *  - kasa klasyczna: `woocommerce_review_order_before_submit` + `woocommerce_checkout_create_order`,
 *  - kasa blokowa: Additional Checkout Fields API (`woocommerce_register_additional_checkout_field`,
 *    lokalizacja `order`, typ `checkbox`), wartość w meta zamówienia `_wc_other/midrev-esp/newsletter`.
 */
class Midrev_Esp_Consent {

	const FIELD_BLOCKS  = 'midrev-esp/newsletter';
	const FIELD_CLASSIC = 'midrev_esp_newsletter';
	const META_YES      = '_mrv_newsletter';
	const META_VERSION  = '_mrv_newsletter_version';

	/** Podpięcie akcji. */
	public static function init(): void {
		add_action( 'woocommerce_init', array( __CLASS__, 'register_block_field' ) );
		add_action( 'woocommerce_review_order_before_submit', array( __CLASS__, 'render_classic' ) );
		add_action( 'woocommerce_checkout_create_order', array( __CLASS__, 'save_classic' ), 20, 2 );
		add_action( 'woocommerce_checkout_order_processed', array( __CLASS__, 'after_classic_order' ), 40, 3 );
		add_action( 'woocommerce_store_api_checkout_order_processed', array( __CLASS__, 'after_block_order' ), 40, 1 );
	}

	/** Bieżąca klauzula albo null (checkbox wyłączony / brak połączenia). */
	public static function clause(): ?array {
		if ( ! Midrev_Esp_Api::is_connected() ) {
			return null;
		}
		$c = Midrev_Esp_Api::config();
		if ( empty( $c['checkbox'] ) || empty( $c['zgoda']['tresc'] ) || empty( $c['zgoda']['wersja'] ) ) {
			return null;
		}
		return $c['zgoda'];
	}

	/** Pole w kasie blokowej (Additional Checkout Fields API, WC 8.9+). */
	public static function register_block_field(): void {
		$klauzula = self::clause();
		if ( ! $klauzula || ! function_exists( 'woocommerce_register_additional_checkout_field' ) ) {
			return;
		}
		$etykieta = (string) $klauzula['tresc'];
		if ( ! empty( $klauzula['polityka'] ) ) {
			/* translators: %s: privacy policy URL */
			$etykieta .= ' ' . sprintf( __( 'Privacy policy: %s', 'midrev-esp' ), $klauzula['polityka'] );
		}
		woocommerce_register_additional_checkout_field(
			array(
				'id'       => self::FIELD_BLOCKS,
				'label'    => $etykieta,
				'location' => 'order',
				'type'     => 'checkbox',
				'required' => false,
			)
		);
	}

	/** Pole w kasie klasycznej (domyślnie NIEzaznaczone). */
	public static function render_classic(): void {
		$klauzula = self::clause();
		if ( ! $klauzula ) {
			return;
		}
		echo '<p class="form-row midrev-esp-newsletter" id="midrev_esp_newsletter_field">';
		echo '<label class="woocommerce-form__label woocommerce-form__label-for-checkbox checkbox">';
		echo '<input type="checkbox" class="woocommerce-form__input woocommerce-form__input-checkbox input-checkbox" name="' . esc_attr( self::FIELD_CLASSIC ) . '" id="' . esc_attr( self::FIELD_CLASSIC ) . '" value="1" /> ';
		echo '<span>' . esc_html( $klauzula['tresc'] ) . '</span>';
		if ( ! empty( $klauzula['polityka'] ) ) {
			echo ' <a href="' . esc_url( $klauzula['polityka'] ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Privacy policy', 'midrev-esp' ) . '</a>';
		}
		echo '</label>';
		echo '<input type="hidden" name="midrev_esp_newsletter_version" value="' . esc_attr( (string) absint( $klauzula['wersja'] ) ) . '" />';
		echo '</p>';
	}

	/**
	 * Zapis zgody z kasy klasycznej w meta zamówienia. Nonce kasy weryfikuje WooCommerce
	 * (WC_Checkout::process_checkout) przed tym hookiem.
	 *
	 * @param WC_Order $order Zamówienie.
	 * @param array    $data  Dane kasy.
	 */
	public static function save_classic( $order, $data = array() ): void {
		if ( ! ( $order instanceof WC_Order ) || ! self::clause() ) {
			return;
		}
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- nonce kasy sprawdza WC_Checkout::process_checkout()
		if ( empty( $_POST[ self::FIELD_CLASSIC ] ) ) {
			return;
		}
		$wersja = isset( $_POST['midrev_esp_newsletter_version'] ) ? absint( wp_unslash( $_POST['midrev_esp_newsletter_version'] ) ) : 0;
		// phpcs:enable WordPress.Security.NonceVerification.Missing
		$order->update_meta_data( self::META_YES, 'yes' );
		$order->update_meta_data( self::META_VERSION, $wersja ? $wersja : absint( self::clause()['wersja'] ) );
	}

	/**
	 * Po zamówieniu z kasy klasycznej.
	 *
	 * @param int      $order_id Id zamówienia.
	 * @param array    $posted   Dane kasy.
	 * @param WC_Order $order    Zamówienie.
	 */
	public static function after_classic_order( $order_id, $posted = array(), $order = null ): void {
		$order = $order instanceof WC_Order ? $order : wc_get_order( $order_id );
		if ( $order && 'yes' === $order->get_meta( self::META_YES ) ) {
			self::send( $order, absint( $order->get_meta( self::META_VERSION ) ) );
		}
	}

	/**
	 * Po zamówieniu z kasy blokowej: wartość pola z Additional Checkout Fields.
	 *
	 * @param WC_Order $order Zamówienie.
	 */
	public static function after_block_order( $order ): void {
		if ( ! ( $order instanceof WC_Order ) || ! self::clause() ) {
			return;
		}
		$zaznaczone = false;
		if ( class_exists( '\Automattic\WooCommerce\Blocks\Package' ) && class_exists( '\Automattic\WooCommerce\Blocks\Domain\Services\CheckoutFields' ) ) {
			$pola       = \Automattic\WooCommerce\Blocks\Package::container()->get( \Automattic\WooCommerce\Blocks\Domain\Services\CheckoutFields::class );
			$zaznaczone = (bool) $pola->get_field_from_object( self::FIELD_BLOCKS, $order, 'other' );
		}
		if ( ! $zaznaczone ) {
			return;
		}
		// etykieta pola pochodzi z bieżącej wersji klauzuli (rejestrowanej przy każdym żądaniu)
		$wersja = absint( self::clause()['wersja'] );
		$order->update_meta_data( self::META_YES, 'yes' );
		$order->update_meta_data( self::META_VERSION, $wersja );
		$order->save();
		self::send( $order, $wersja );
	}

	/**
	 * Zdarzenie zgody do ESP (numer wersji, nie tekst).
	 *
	 * @param WC_Order $order  Zamówienie.
	 * @param int      $wersja Wersja klauzuli.
	 */
	private static function send( WC_Order $order, int $wersja ): void {
		$email = sanitize_email( (string) $order->get_billing_email() );
		if ( ! $email || ! is_email( $email ) || $wersja < 1 ) {
			return;
		}
		Midrev_Esp_Queue::push(
			array(
				'typ'      => 'consent',
				'email'    => strtolower( $email ),
				'imie'     => $order->get_billing_first_name() ? $order->get_billing_first_name() : null,
				'nazwisko' => $order->get_billing_last_name() ? $order->get_billing_last_name() : null,
				'zgoda'    => array(
					'wersja'     => $wersja,
					'zamowienie' => (string) $order->get_order_number(),
				),
			)
		);
	}
}
