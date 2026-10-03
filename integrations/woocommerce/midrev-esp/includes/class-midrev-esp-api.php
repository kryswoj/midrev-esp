<?php
/**
 * Połączenie z MidRev ESP: parowanie, podpisane żądania, konfiguracja.
 *
 * @package MidrevEsp
 */

defined( 'ABSPATH' ) || exit;

/**
 * Klient API MidRev ESP.
 *
 * Sekret wtyczki (HMAC) leży w osobnej opcji bez autoload i nigdy nie trafia do HTML-a,
 * do logów ani do odpowiedzi AJAX. Każde żądanie do ESP jest podpisane:
 * base64( HMAC-SHA256( "{timestamp}.{body}", sekret ) ) w nagłówku X-MRV-Signature.
 */
class Midrev_Esp_Api {

	const OPT_CONNECTION = 'midrev_esp_connection';
	const OPT_SECRET     = 'midrev_esp_secret';
	const OPT_CONFIG     = 'midrev_esp_config';
	const OPT_STATUS     = 'midrev_esp_status';
	const OPT_PENDING    = 'midrev_esp_pending_key';

	/** Adres API (stała, nie dane od użytkownika). */
	public static function api_url(): string {
		return untrailingslashit( (string) MIDREV_ESP_API_URL );
	}

	/** Dane połączenia (bez sekretu) albo null. */
	public static function connection(): ?array {
		$c = get_option( self::OPT_CONNECTION );
		return is_array( $c ) && ! empty( $c['store_id'] ) ? $c : null;
	}

	/** Czy wtyczka jest sparowana. */
	public static function is_connected(): bool {
		return null !== self::connection() && '' !== (string) get_option( self::OPT_SECRET, '' );
	}

	/** Konfiguracja z ESP (klauzula zgody, klucz strony). */
	public static function config(): array {
		$c = get_option( self::OPT_CONFIG );
		return is_array( $c ) ? $c : array();
	}

	/** Status (ostatnie zdarzenie, ostatni błąd) do strony ustawień. */
	public static function status(): array {
		$s = get_option( self::OPT_STATUS );
		return is_array( $s ) ? $s : array();
	}

	/** Zapis fragmentu statusu. */
	public static function update_status( array $zmiany ): void {
		update_option( self::OPT_STATUS, array_merge( self::status(), $zmiany ), false );
	}

	/** Zapis konfiguracji otrzymanej z ESP (tylko znane pola, odkażone). */
	public static function save_config( $k ): void {
		if ( ! is_array( $k ) ) {
			return;
		}
		$zgoda = null;
		if ( isset( $k['zgoda'] ) && is_array( $k['zgoda'] ) && isset( $k['zgoda']['wersja'], $k['zgoda']['tresc'] ) ) {
			$zgoda = array(
				'wersja'   => absint( $k['zgoda']['wersja'] ),
				'tresc'    => sanitize_textarea_field( (string) $k['zgoda']['tresc'] ),
				'polityka' => isset( $k['zgoda']['polityka'] ) ? esc_url_raw( (string) $k['zgoda']['polityka'] ) : '',
			);
		}
		$config = array(
			'site_key'   => isset( $k['site_key'] ) ? preg_replace( '/[^A-Za-z0-9]/', '', (string) $k['site_key'] ) : '',
			'script_url' => isset( $k['script_url'] ) ? esc_url_raw( (string) $k['script_url'] ) : '',
			'checkbox'   => ! empty( $k['checkbox'] ) && null !== $zgoda,
			'zgoda'      => $zgoda,
			'updated_at' => time(),
		);
		update_option( self::OPT_CONFIG, $config, true );
	}

	/**
	 * Klucz REST WooCommerce (read_write) dla bieżącego administratora, jak robi to /wc-auth
	 * (WC_Auth::create_keys): w bazie hash klucza i sekret, klucz w jawnej postaci tylko tu.
	 *
	 * @return array{key_id:int,consumer_key:string,consumer_secret:string}
	 * @throws RuntimeException Gdy klucza nie da się zapisać.
	 */
	private static function create_api_key(): array {
		global $wpdb;
		$consumer_key    = 'ck_' . wc_rand_hash();
		$consumer_secret = 'cs_' . wc_rand_hash();
		$ok              = $wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			$wpdb->prefix . 'woocommerce_api_keys',
			array(
				'user_id'         => get_current_user_id(),
				'description'     => 'MidRev ESP',
				'permissions'     => 'read_write',
				'consumer_key'    => wc_api_hash( $consumer_key ),
				'consumer_secret' => $consumer_secret,
				'truncated_key'   => substr( $consumer_key, -7 ),
			),
			array( '%d', '%s', '%s', '%s', '%s', '%s' )
		);
		if ( ! $ok ) {
			throw new RuntimeException( esc_html__( 'Could not create a WooCommerce REST API key.', 'midrev-esp' ) );
		}
		return array(
			'key_id'          => (int) $wpdb->insert_id,
			'consumer_key'    => $consumer_key,
			'consumer_secret' => $consumer_secret,
		);
	}

	/** Porzucenie klucza z nieudanej próby parowania (anulowanie, inny kod): klucz i opcja znikają. */
	public static function discard_pending(): void {
		$oczekujacy = get_option( self::OPT_PENDING );
		if ( is_array( $oczekujacy ) && ! empty( $oczekujacy['key_id'] ) ) {
			$polaczenie = self::connection();
			// klucz aktywnego połączenia zostaje (ponowienie zakończone sukcesem mogło go przejąć)
			if ( ! $polaczenie || (int) ( $polaczenie['key_id'] ?? 0 ) !== (int) $oczekujacy['key_id'] ) {
				self::delete_api_key( (int) $oczekujacy['key_id'] );
			}
		}
		delete_option( self::OPT_PENDING );
	}

	/** Usunięcie klucza REST założonego przez wtyczkę. */
	public static function delete_api_key( int $key_id ): void {
		global $wpdb;
		if ( $key_id > 0 ) {
			$wpdb->delete( $wpdb->prefix . 'woocommerce_api_keys', array( 'key_id' => $key_id ), array( '%d' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
		}
	}

	/** Kod w postaci kanonicznej albo null. */
	public static function normalize_code( string $kod ): ?string {
		$kod = strtoupper( preg_replace( '/[^A-Za-z0-9-]/', '', $kod ) );
		return preg_match( '/^MRV-?(?:[A-Z2-9]{5}-?){5}$/', $kod ) ? $kod : null;
	}

	/**
	 * Krok 1 parowania BEZ kluczy: z jakim kontem MidRev połączy się sklep. Kod dla innego
	 * sklepu odpada tutaj, zanim powstanie klucz REST (ochrona przed „wklej ten kod” od obcych).
	 *
	 * @param string $kod Kod parowania.
	 * @return array{konto:string,sklep:?string}|WP_Error
	 */
	public static function check_code( string $kod ) {
		$kod = self::normalize_code( $kod );
		if ( ! $kod ) {
			return new WP_Error( 'midrev_code', __( 'This does not look like a MidRev pairing code (MRV-XXXXX-…).', 'midrev-esp' ) );
		}
		$response = wp_remote_post(
			self::api_url() . '/api/integracje/woocommerce/paruj/sprawdz',
			array(
				'timeout' => 20,
				'headers' => array( 'Content-Type' => 'application/json' ),
				'body'    => wp_json_encode(
					array(
						'kod'      => $kod,
						'home_url' => home_url(),
					)
				),
			)
		);
		if ( is_wp_error( $response ) ) {
			/* translators: %s: error message */
			return new WP_Error( 'midrev_http', sprintf( __( 'MidRev ESP did not respond: %s', 'midrev-esp' ), $response->get_error_message() ) );
		}
		$data = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		if ( 200 !== (int) wp_remote_retrieve_response_code( $response ) || ! is_array( $data ) || empty( $data['konto'] ) ) {
			$msg = is_array( $data ) && ! empty( $data['komunikat'] ) ? sanitize_text_field( (string) $data['komunikat'] ) : sprintf( 'HTTP %d', (int) wp_remote_retrieve_response_code( $response ) );
			/* translators: %s: error message from MidRev ESP */
			return new WP_Error( 'midrev_pair', sprintf( __( 'Pairing failed: %s', 'midrev-esp' ), $msg ) );
		}
		return array(
			'konto' => sanitize_text_field( (string) $data['konto'] ),
			'sklep' => isset( $data['sklep'] ) ? esc_url_raw( (string) $data['sklep'] ) : null,
		);
	}

	/**
	 * Parowanie kodem z panelu MidRev.
	 *
	 * @param string $kod Kod parowania.
	 * @return true|WP_Error
	 */
	public static function pair( string $kod ) {
		$kod = self::normalize_code( $kod );
		if ( ! $kod ) {
			return new WP_Error( 'midrev_code', __( 'This does not look like a MidRev pairing code (MRV-XXXXX-…).', 'midrev-esp' ) );
		}
		// Klucz z poprzedniej próby, której wynik jest NIEZNANY (timeout, 5xx): ESP mógł go już
		// zapisać, więc nie kasujemy go, tylko ponawiamy z nim (ESP przyjmie ponowienie tym samym
		// kodem dla tego samego sklepu). Nowy klucz tylko, gdy poprzedniego nie ma.
		// Klucz z nieudanej próby jest przypięty do KODU (review PHP r2): inny kod = stary klucz
		// usuwany, nowy tworzony; nigdy nie wysyłamy klucza z próby dla innego konta.
		$oczekujacy = get_option( self::OPT_PENDING );
		if ( is_array( $oczekujacy ) && ( empty( $oczekujacy['kod'] ) || ! hash_equals( (string) $oczekujacy['kod'], $kod ) ) ) {
			self::discard_pending();
			$oczekujacy = null;
		}
		if ( is_array( $oczekujacy ) && ! empty( $oczekujacy['key_id'] ) && ! empty( $oczekujacy['consumer_key'] ) ) {
			$klucz = array(
				'key_id'          => (int) $oczekujacy['key_id'],
				'consumer_key'    => (string) $oczekujacy['consumer_key'],
				'consumer_secret' => (string) $oczekujacy['consumer_secret'],
			);
		} else {
			try {
				$klucz = self::create_api_key();
			} catch ( RuntimeException $e ) {
				return new WP_Error( 'midrev_key', $e->getMessage() );
			}
		}
		$body     = array(
			'kod'             => $kod,
			'home_url'        => home_url(),
			'site_url'        => site_url(),
			'consumer_key'    => $klucz['consumer_key'],
			'consumer_secret' => $klucz['consumer_secret'],
			'plugin_version'  => MIDREV_ESP_VERSION,
			'wc_version'      => defined( 'WC_VERSION' ) ? WC_VERSION : '',
		);
		$response = wp_remote_post(
			self::api_url() . '/api/integracje/woocommerce/paruj',
			array(
				'timeout' => 60,
				'headers' => array( 'Content-Type' => 'application/json' ),
				'body'    => wp_json_encode( $body ),
			)
		);
		// Klucz w jawnej postaci nie jest nam już potrzebny (ESP ma go w szyfrogramie).
		unset( $body['consumer_key'], $body['consumer_secret'] );

		$code = is_wp_error( $response ) ? 0 : (int) wp_remote_retrieve_response_code( $response );
		if ( is_wp_error( $response ) || $code >= 500 || 0 === $code ) {
			// wynik nieznany: klucz zostaje do ponowienia (sekret poza autoload, usuwany po sukcesie)
			update_option( self::OPT_PENDING, array_merge( $klucz, array( 'kod' => $kod ) ), false );
			$msg = is_wp_error( $response ) ? $response->get_error_message() : sprintf( 'HTTP %d', $code );
			/* translators: %s: error message */
			return new WP_Error( 'midrev_http', sprintf( __( 'MidRev ESP did not respond: %s', 'midrev-esp' ), $msg ) . ' ' . __( 'Try again with the same code.', 'midrev-esp' ) );
		}
		$data = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		if ( 200 !== $code || ! is_array( $data ) || empty( $data['store_id'] ) || empty( $data['plugin_secret'] ) ) {
			// odmowa (4xx) jest ostateczna: klucz nie jest nikomu potrzebny
			self::delete_api_key( $klucz['key_id'] );
			delete_option( self::OPT_PENDING );
			$msg = is_array( $data ) && ! empty( $data['komunikat'] ) ? sanitize_text_field( (string) $data['komunikat'] ) : sprintf( 'HTTP %d', $code );
			/* translators: %s: error message from MidRev ESP */
			return new WP_Error( 'midrev_pair', sprintf( __( 'Pairing failed: %s', 'midrev-esp' ), $msg ) );
		}

		// Ponowne parowanie: stary klucz REST wtyczki przestaje być potrzebny.
		$stare = self::connection();
		if ( $stare && ! empty( $stare['key_id'] ) && (int) $stare['key_id'] !== $klucz['key_id'] ) {
			self::delete_api_key( (int) $stare['key_id'] );
		}
		update_option(
			self::OPT_CONNECTION,
			array(
				'store_id'     => sanitize_text_field( (string) $data['store_id'] ),
				'key_id'       => $klucz['key_id'],
				'connected_at' => time(),
				'api_url'      => self::api_url(),
			),
			true
		);
		update_option( self::OPT_SECRET, preg_replace( '/[^a-f0-9]/', '', (string) $data['plugin_secret'] ), false );
		delete_option( self::OPT_PENDING );
		self::save_config( isset( $data['konfiguracja'] ) ? $data['konfiguracja'] : array() );
		self::update_status(
			array(
				'last_error' => '',
				'last_ping'  => time(),
			)
		);
		return true;
	}

	/**
	 * Podpisane żądanie do ESP.
	 *
	 * @param string $sciezka Ścieżka pod /api/integracje/woocommerce/{store_id}/.
	 * @param array  $body    Ciało JSON.
	 * @param int    $timeout Limit czasu w sekundach.
	 * @return array{code:int,data:mixed}|WP_Error
	 */
	public static function signed_request( string $sciezka, array $body, int $timeout = 15 ) {
		$c      = self::connection();
		$secret = (string) get_option( self::OPT_SECRET, '' );
		if ( ! $c || '' === $secret ) {
			return new WP_Error( 'midrev_not_connected', __( 'The store is not connected to MidRev ESP.', 'midrev-esp' ) );
		}
		$json     = (string) wp_json_encode( $body );
		$ts       = (string) time();
		$sig      = base64_encode( hash_hmac( 'sha256', $ts . '.' . $json, $secret, true ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		$response = wp_remote_post(
			self::api_url() . '/api/integracje/woocommerce/' . rawurlencode( $c['store_id'] ) . '/' . $sciezka,
			array(
				'timeout' => $timeout,
				'headers' => array(
					'Content-Type'    => 'application/json',
					'X-MRV-Timestamp' => $ts,
					'X-MRV-Signature' => $sig,
				),
				'body'    => $json,
			)
		);
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		return array(
			'code' => (int) wp_remote_retrieve_response_code( $response ),
			'data' => json_decode( (string) wp_remote_retrieve_body( $response ), true ),
		);
	}

	/** Ping: sprawdzenie połączenia i odświeżenie konfiguracji. */
	public static function ping() {
		$r = self::signed_request( 'ping', array( 'wersja' => MIDREV_ESP_VERSION ) );
		if ( is_wp_error( $r ) ) {
			self::update_status( array( 'last_error' => $r->get_error_message() ) );
			return $r;
		}
		if ( 200 !== $r['code'] ) {
			/* translators: %d: HTTP status code */
			$msg = 401 === $r['code'] ? __( 'MidRev ESP rejected the signature. Pair the store again.', 'midrev-esp' ) : sprintf( __( 'MidRev ESP returned HTTP %d.', 'midrev-esp' ), $r['code'] );
			self::update_status( array( 'last_error' => $msg ) );
			return new WP_Error( 'midrev_ping', $msg );
		}
		if ( is_array( $r['data'] ) && isset( $r['data']['konfiguracja'] ) ) {
			self::save_config( $r['data']['konfiguracja'] );
		}
		self::update_status(
			array(
				'last_error' => '',
				'last_ping'  => time(),
			)
		);
		return true;
	}

	/**
	 * Odłączenie: ESP usuwa swoje webhooki (póki klucz REST działa), potem kasujemy klucz,
	 * sekret i konfigurację. Kolejka zdarzeń jest czyszczona (nie ma już dokąd jej wysłać).
	 */
	public static function disconnect(): void {
		$c = self::connection();
		if ( $c ) {
			self::signed_request( 'rozlacz', array(), 30 );
			if ( ! empty( $c['key_id'] ) ) {
				self::delete_api_key( (int) $c['key_id'] );
			}
		}
		delete_option( self::OPT_CONNECTION );
		delete_option( self::OPT_SECRET );
		delete_option( self::OPT_CONFIG );
		self::update_status(
			array(
				'last_error'      => '',
				'disconnected_at' => time(),
			)
		);
		Midrev_Esp_Queue::clear();
	}

	/** HMAC do podpisu linku koszyka (ten sam sekret co żądania, inny kontekst). */
	public static function hmac( string $dane ): string {
		$secret = (string) get_option( self::OPT_SECRET, '' );
		return hash_hmac( 'sha256', 'koszyk|' . $dane, $secret );
	}
}
