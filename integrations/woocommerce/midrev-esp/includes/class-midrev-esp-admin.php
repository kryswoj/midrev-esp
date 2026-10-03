<?php
/**
 * Strona ustawień wtyczki w panelu WordPressa (WooCommerce > MidRev ESP).
 *
 * @package MidrevEsp
 */

defined( 'ABSPATH' ) || exit;

/**
 * Status połączenia, ostatnie zdarzenie, kolejka, parowanie kodem i „Odłącz”.
 * Każda akcja: admin-post.php + nonce + capability `manage_woocommerce`; wszystko, co
 * wychodzi do HTML, jest escapowane; sekret wtyczki nigdy nie jest renderowany.
 */
class Midrev_Esp_Admin {

	const PAGE = 'midrev-esp';
	const CAP  = 'manage_woocommerce';

	/** Podpięcie akcji. */
	public static function init(): void {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 60 );
		add_action( 'admin_post_midrev_esp_connect', array( __CLASS__, 'handle_connect' ) );
		add_action( 'admin_post_midrev_esp_confirm', array( __CLASS__, 'handle_confirm' ) );
		add_action( 'admin_post_midrev_esp_cancel', array( __CLASS__, 'handle_cancel' ) );
		add_action( 'admin_post_midrev_esp_disconnect', array( __CLASS__, 'handle_disconnect' ) );
		add_action( 'admin_post_midrev_esp_ping', array( __CLASS__, 'handle_ping' ) );
		add_action( 'admin_post_midrev_esp_flush', array( __CLASS__, 'handle_flush' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( MIDREV_ESP_FILE ), array( __CLASS__, 'action_links' ) );
		add_action( 'admin_notices', array( __CLASS__, 'notice_not_connected' ) );
	}

	/** Pozycja w menu WooCommerce. */
	public static function menu(): void {
		add_submenu_page( 'woocommerce', __( 'MidRev ESP', 'midrev-esp' ), __( 'MidRev ESP', 'midrev-esp' ), self::CAP, self::PAGE, array( __CLASS__, 'render' ) );
	}

	/**
	 * Link „Ustawienia” na liście wtyczek.
	 *
	 * @param array $links Linki.
	 */
	public static function action_links( $links ): array {
		$url = admin_url( 'admin.php?page=' . self::PAGE );
		array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'midrev-esp' ) . '</a>' );
		return $links;
	}

	/** Przypomnienie o parowaniu (poza stroną wtyczki). */
	public static function notice_not_connected(): void {
		if ( Midrev_Esp_Api::is_connected() || ! current_user_can( self::CAP ) ) {
			return;
		}
		$ekran = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( $ekran && false !== strpos( (string) $ekran->id, self::PAGE ) ) {
			return;
		}
		echo '<div class="notice notice-info"><p>' . esc_html__( 'MidRev ESP is installed but not connected yet.', 'midrev-esp' ) . ' <a href="' . esc_url( admin_url( 'admin.php?page=' . self::PAGE ) ) . '">' . esc_html__( 'Connect the store', 'midrev-esp' ) . '</a></p></div>';
	}

	/** Wspólna kontrola akcji: uprawnienia + nonce. */
	private static function guard( string $akcja ): void {
		if ( ! current_user_can( self::CAP ) ) {
			wp_die( esc_html__( 'You are not allowed to do this.', 'midrev-esp' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $akcja );
	}

	/**
	 * Powrót na stronę wtyczki z komunikatem (komunikat w transient użytkownika, nie w URL).
	 *
	 * @param string $typ   success|error.
	 * @param string $tresc Treść.
	 */
	private static function back( string $typ, string $tresc ): void {
		set_transient(
			'midrev_esp_notice_' . get_current_user_id(),
			array(
				'typ'   => $typ,
				'tresc' => $tresc,
			),
			120
		);
		wp_safe_redirect( admin_url( 'admin.php?page=' . self::PAGE ) );
		exit;
	}

	/** Klucz transientu z kodem czekającym na potwierdzenie (per administrator). */
	private static function pending_key(): string {
		return 'midrev_esp_confirm_' . get_current_user_id();
	}

	/**
	 * Parowanie, krok 1: sprawdzenie kodu w ESP BEZ zakładania klucza REST. Administrator widzi,
	 * z jakim kontem MidRev połączy sklep, i dopiero „Potwierdź” zakłada klucz (krok 2).
	 */
	public static function handle_connect(): void {
		self::guard( 'midrev_esp_connect' );
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- nonce sprawdza guard() (check_admin_referer).
		$kod   = isset( $_POST['midrev_esp_code'] ) ? sanitize_text_field( wp_unslash( $_POST['midrev_esp_code'] ) ) : '';
		$wynik = Midrev_Esp_Api::check_code( $kod );
		if ( is_wp_error( $wynik ) ) {
			self::back( 'error', $wynik->get_error_message() );
		}
		set_transient(
			self::pending_key(),
			array(
				'kod'   => Midrev_Esp_Api::normalize_code( $kod ),
				'konto' => $wynik['konto'],
			),
			10 * MINUTE_IN_SECONDS
		);
		wp_safe_redirect( admin_url( 'admin.php?page=' . self::PAGE ) );
		exit;
	}

	/** Parowanie, krok 2: po potwierdzeniu konta klucz REST i połączenie. */
	public static function handle_confirm(): void {
		self::guard( 'midrev_esp_confirm' );
		$oczekujace = get_transient( self::pending_key() );
		if ( ! is_array( $oczekujace ) || empty( $oczekujace['kod'] ) ) {
			self::back( 'error', __( 'The confirmation expired. Paste the pairing code again.', 'midrev-esp' ) );
		}
		// jedno parowanie naraz (review PHP r2): dwa równoległe „Potwierdź” nie tworzą dwóch kluczy
		if ( ! add_option( 'midrev_esp_pair_lock', time(), '', false ) ) {
			$od = (int) get_option( 'midrev_esp_pair_lock' );
			if ( $od > time() - 120 ) {
				self::back( 'error', __( 'Pairing is already in progress. Wait a moment and refresh the page.', 'midrev-esp' ) );
			}
			update_option( 'midrev_esp_pair_lock', time(), false );
		}
		$wynik = Midrev_Esp_Api::pair( (string) $oczekujace['kod'] );
		delete_option( 'midrev_esp_pair_lock' );
		if ( is_wp_error( $wynik ) ) {
			self::back( 'error', $wynik->get_error_message() );
		}
		delete_transient( self::pending_key() );
		Midrev_Esp_Queue::ensure_schedule();
		self::back( 'success', __( 'Connected. Orders, products and cart events now flow to MidRev ESP.', 'midrev-esp' ) );
	}

	/** Rezygnacja z potwierdzenia. */
	public static function handle_cancel(): void {
		self::guard( 'midrev_esp_cancel' );
		delete_transient( self::pending_key() );
		// klucz REST z nieudanej próby nie zostaje w sklepie po rezygnacji (review PHP r2)
		Midrev_Esp_Api::discard_pending();
		wp_safe_redirect( admin_url( 'admin.php?page=' . self::PAGE ) );
		exit;
	}

	/** Odłączenie. */
	public static function handle_disconnect(): void {
		self::guard( 'midrev_esp_disconnect' );
		Midrev_Esp_Api::disconnect();
		self::back( 'success', __( 'Disconnected. The REST API key created by the plugin was deleted.', 'midrev-esp' ) );
	}

	/** Sprawdzenie połączenia. */
	public static function handle_ping(): void {
		self::guard( 'midrev_esp_ping' );
		$wynik = Midrev_Esp_Api::ping();
		if ( is_wp_error( $wynik ) ) {
			self::back( 'error', $wynik->get_error_message() );
		}
		self::back( 'success', __( 'Connection works. Settings refreshed from MidRev ESP.', 'midrev-esp' ) );
	}

	/** Ręczna wysyłka kolejki. */
	public static function handle_flush(): void {
		self::guard( 'midrev_esp_flush' );
		delete_transient( Midrev_Esp_Queue::LOCK );
		Midrev_Esp_Queue::flush();
		/* translators: %d: number of events */
		self::back( 'success', sprintf( __( 'Queue processed. Events still waiting: %d.', 'midrev-esp' ), Midrev_Esp_Queue::count() ) );
	}

	/**
	 * Data względna po polsku/angielsku z i18n.
	 *
	 * @param int $ts Znacznik czasu.
	 */
	private static function ago( int $ts ): string {
		if ( $ts <= 0 ) {
			return __( 'never', 'midrev-esp' );
		}
		/* translators: %s: human readable time difference */
		return sprintf( __( '%s ago', 'midrev-esp' ), human_time_diff( $ts, time() ) );
	}

	/**
	 * Przycisk-formularz akcji.
	 *
	 * @param string $akcja   Akcja admin-post.
	 * @param string $etykieta Etykieta.
	 * @param string $klasa   Klasa przycisku.
	 * @param string $confirm Pytanie potwierdzające (opcjonalne).
	 */
	private static function action_button( string $akcja, string $etykieta, string $klasa = 'button', string $confirm = '' ): void {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:inline-block;margin-right:8px"' . ( $confirm ? ' onsubmit="return confirm(' . esc_attr( wp_json_encode( $confirm ) ) . ');"' : '' ) . '>';
		echo '<input type="hidden" name="action" value="' . esc_attr( $akcja ) . '" />';
		wp_nonce_field( $akcja );
		echo '<button type="submit" class="' . esc_attr( $klasa ) . '">' . esc_html( $etykieta ) . '</button>';
		echo '</form>';
	}

	/** Strona ustawień. */
	public static function render(): void {
		if ( ! current_user_can( self::CAP ) ) {
			return;
		}
		$notice = get_transient( 'midrev_esp_notice_' . get_current_user_id() );
		if ( $notice ) {
			delete_transient( 'midrev_esp_notice_' . get_current_user_id() );
		}
		echo '<div class="wrap midrev-esp">';
		echo '<h1>' . esc_html__( 'MidRev ESP', 'midrev-esp' ) . '</h1>';
		if ( is_array( $notice ) ) {
			$klasa = 'error' === $notice['typ'] ? 'notice-error' : 'notice-success';
			echo '<div class="notice ' . esc_attr( $klasa ) . '"><p>' . esc_html( (string) $notice['tresc'] ) . '</p></div>';
		}
		if ( Midrev_Esp_Api::is_connected() ) {
			self::render_connected();
		} else {
			self::render_pairing();
		}
		echo '</div>';
	}

	/** Widok bez połączenia: kod parowania albo potwierdzenie konta. */
	private static function render_pairing(): void {
		$oczekujace = get_transient( self::pending_key() );
		if ( is_array( $oczekujace ) && ! empty( $oczekujace['konto'] ) ) {
			echo '<div class="card" style="max-width:640px">';
			echo '<h2>' . esc_html__( 'Confirm the connection', 'midrev-esp' ) . '</h2>';
			/* translators: 1: store address, 2: MidRev account name */
			echo '<p>' . esc_html( sprintf( __( 'The store %1$s will be connected to the MidRev account: %2$s.', 'midrev-esp' ), wp_parse_url( home_url(), PHP_URL_HOST ), (string) $oczekujace['konto'] ) ) . '</p>';
			/* translators: %s: MidRev ESP host */
			echo '<p>' . esc_html( sprintf( __( 'Data goes to: %s (orders, customers, products, carts and newsletter consents).', 'midrev-esp' ), (string) wp_parse_url( Midrev_Esp_Api::api_url(), PHP_URL_HOST ) ) ) . '</p>';
			echo '<p class="description">' . esc_html__( 'The plugin will create a WooCommerce REST API key (read/write) for MidRev ESP. Confirm only if you recognise this account.', 'midrev-esp' ) . '</p>';
			echo '<p>';
			self::action_button( 'midrev_esp_confirm', __( 'Confirm and connect', 'midrev-esp' ), 'button button-primary' );
			self::action_button( 'midrev_esp_cancel', __( 'Cancel', 'midrev-esp' ) );
			echo '</p></div>';
			return;
		}
		// Kod z linku w panelu MidRev wypełnia pole, ale NIE paruje sam: potrzebne kliknięcie (nonce).
		$kod = isset( $_GET['mrv_kod'] ) ? sanitize_text_field( wp_unslash( $_GET['mrv_kod'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$kod = preg_replace( '/[^A-Za-z0-9-]/', '', $kod );
		echo '<div class="card" style="max-width:640px">';
		echo '<h2>' . esc_html__( 'Connect your store', 'midrev-esp' ) . '</h2>';
		echo '<p>' . esc_html__( 'Paste the pairing code from the MidRev panel (Settings → Store → WooCommerce). The plugin creates the REST API key and webhooks for you; you do not copy any keys.', 'midrev-esp' ) . '</p>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		echo '<input type="hidden" name="action" value="midrev_esp_connect" />';
		wp_nonce_field( 'midrev_esp_connect' );
		echo '<p><label for="midrev_esp_code"><strong>' . esc_html__( 'Pairing code', 'midrev-esp' ) . '</strong></label><br />';
		echo '<input type="text" class="regular-text code" id="midrev_esp_code" name="midrev_esp_code" value="' . esc_attr( $kod ) . '" placeholder="MRV-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" autocomplete="off" required /></p>';
		echo '<p><button type="submit" class="button button-primary">' . esc_html__( 'Connect with MidRev', 'midrev-esp' ) . '</button></p>';
		echo '</form>';
		/* translators: %s: API host */
		echo '<p class="description">' . esc_html( sprintf( __( 'Data is sent only to %s over HTTPS.', 'midrev-esp' ), wp_parse_url( Midrev_Esp_Api::api_url(), PHP_URL_HOST ) ) ) . '</p>';
		echo '</div>';
	}

	/** Widok po połączeniu: zdrowie integracji. */
	private static function render_connected(): void {
		$c      = Midrev_Esp_Api::connection();
		$s      = Midrev_Esp_Api::status();
		$config = Midrev_Esp_Api::config();
		$kolej  = Midrev_Esp_Queue::count();
		$blad   = isset( $s['last_error'] ) ? (string) $s['last_error'] : '';
		$zdrowy = '' === $blad && $kolej < 50;

		echo '<div class="card" style="max-width:720px">';
		echo '<h2 style="display:flex;align-items:center;gap:8px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' . esc_attr( $zdrowy ? '#1a7f37' : '#bf8700' ) . '"></span>';
		echo esc_html( $zdrowy ? __( 'Connected to MidRev ESP', 'midrev-esp' ) : __( 'Connected, needs attention', 'midrev-esp' ) ) . '</h2>';
		echo '<table class="widefat striped" style="margin:12px 0"><tbody>';
		$wiersze = array(
			__( 'Connected', 'midrev-esp' )           => self::ago( (int) ( $c['connected_at'] ?? 0 ) ),
			__( 'Last event sent', 'midrev-esp' )     => self::ago( (int) ( $s['last_event_at'] ?? 0 ) ) . ( ! empty( $s['last_event_type'] ) ? ' (' . self::event_label( (string) $s['last_event_type'] ) . ')' : '' ),
			__( 'Last check', 'midrev-esp' )          => self::ago( (int) ( $s['last_ping'] ?? 0 ) ),
			__( 'Events waiting', 'midrev-esp' )      => (string) $kolej,
			__( 'Tracking script', 'midrev-esp' )     => ! empty( $config['site_key'] ) ? __( 'on', 'midrev-esp' ) : __( 'off', 'midrev-esp' ),
			__( 'Newsletter checkbox', 'midrev-esp' ) => ! empty( $config['checkbox'] ) ? sprintf( /* translators: %d: clause version */ __( 'on (clause version %d)', 'midrev-esp' ), (int) ( $config['zgoda']['wersja'] ?? 0 ) ) : __( 'off', 'midrev-esp' ),
			__( 'Plugin version', 'midrev-esp' )      => MIDREV_ESP_VERSION,
		);
		foreach ( $wiersze as $etykieta => $wartosc ) {
			echo '<tr><th style="width:220px">' . esc_html( $etykieta ) . '</th><td>' . esc_html( $wartosc ) . '</td></tr>';
		}
		if ( '' !== $blad ) {
			echo '<tr><th>' . esc_html__( 'Last error', 'midrev-esp' ) . '</th><td style="color:#b32d2e">' . esc_html( $blad ) . '</td></tr>';
		}
		echo '</tbody></table>';
		if ( ! empty( $config['zgoda']['tresc'] ) ) {
			echo '<p class="description">' . esc_html__( 'Checkbox text (set in the MidRev panel):', 'midrev-esp' ) . ' “' . esc_html( (string) $config['zgoda']['tresc'] ) . '”</p>';
		}
		echo '<p>';
		self::action_button( 'midrev_esp_ping', __( 'Check connection', 'midrev-esp' ), 'button button-primary' );
		if ( $kolej > 0 ) {
			self::action_button( 'midrev_esp_flush', __( 'Send waiting events now', 'midrev-esp' ) );
		}
		echo '</p>';
		echo '<hr style="margin:16px 0" /><p class="description">';
		self::action_button( 'midrev_esp_disconnect', __( 'Disconnect', 'midrev-esp' ), 'button button-link-delete', __( 'Disconnect the store from MidRev ESP? Orders and cart events will stop flowing.', 'midrev-esp' ) );
		echo '</p></div>';
	}

	/**
	 * Etykieta typu zdarzenia.
	 *
	 * @param string $typ Typ.
	 */
	private static function event_label( string $typ ): string {
		$mapa = array(
			'added_to_cart'    => __( 'added to cart', 'midrev-esp' ),
			'started_checkout' => __( 'started checkout', 'midrev-esp' ),
			'identify'         => __( 'customer identified', 'midrev-esp' ),
			'consent'          => __( 'newsletter consent', 'midrev-esp' ),
		);
		return isset( $mapa[ $typ ] ) ? $mapa[ $typ ] : $typ;
	}
}
