<?php
/**
 * Kolejka zdarzeń do MidRev ESP z ponawianiem.
 *
 * @package MidrevEsp
 */

defined( 'ABSPATH' ) || exit;

/**
 * Zdarzenie najpierw trafia do tabeli (w tym samym żądaniu, w którym klient dodał produkt),
 * a wysyłka idzie w tle przez Action Scheduler (WooCommerce go dostarcza), z zapasem WP-Cron.
 * Dzięki temu wolny albo leżący ESP nigdy nie spowalnia koszyka ani checkoutu.
 *
 * Bez duplikatów: każde zdarzenie ma `event_id` (UUID) nadany przy zapisie; ESP traktuje go
 * jako klucz idempotencji, więc ponowienie po zgubionej odpowiedzi nie tworzy drugiego
 * zdarzenia. Wiersz znika dopiero po odpowiedzi 2xx. Błąd sieci / 5xx / 429 = ponowienie
 * z rosnącym odstępem (1, 2, 4… min, maks. 6 h), 400/413/415/422 = paczka odrzucona
 * (ponawianie niczego nie zmieni), po 48 h albo 25 próbach = porzucone.
 */
class Midrev_Esp_Queue {

	const HOOK_FLUSH  = 'midrev_esp_flush_queue';
	const HOOK_CRON   = 'midrev_esp_cron_flush';
	const BATCH       = 50;
	const MAX_TRIES   = 25;
	const MAX_AGE_SEC = 172800;
	const LOCK        = 'midrev_esp_flush_lock';

	/** Podpięcie akcji. */
	public static function init(): void {
		add_action( self::HOOK_FLUSH, array( __CLASS__, 'flush' ) );
		add_action( self::HOOK_CRON, array( __CLASS__, 'flush' ) );
		add_action( 'init', array( __CLASS__, 'ensure_schedule' ) );
	}

	/** Cykliczne ponawianie co 5 minut (Action Scheduler; zapasowo WP-Cron). */
	public static function ensure_schedule(): void {
		if ( ! Midrev_Esp_Api::is_connected() ) {
			return;
		}
		if ( function_exists( 'as_has_scheduled_action' ) && function_exists( 'as_schedule_recurring_action' ) ) {
			if ( ! as_has_scheduled_action( self::HOOK_CRON, array(), Midrev_Esp_Install::GROUP ) ) {
				as_schedule_recurring_action( time() + 300, 300, self::HOOK_CRON, array(), Midrev_Esp_Install::GROUP );
			}
			return;
		}
		if ( ! wp_next_scheduled( self::HOOK_CRON ) ) {
			wp_schedule_event( time() + 300, 'hourly', self::HOOK_CRON );
		}
	}

	/** UUID v4 zdarzenia. */
	private static function uuid(): string {
		return wp_generate_uuid4();
	}

	/**
	 * Dodanie zdarzenia do kolejki i zlecenie wysyłki w tle.
	 *
	 * @param array $zdarzenie Zdarzenie bez `id` i `czas` (uzupełniane tutaj).
	 */
	public static function push( array $zdarzenie ): void {
		if ( ! Midrev_Esp_Api::is_connected() ) {
			return;
		}
		global $wpdb;
		$zdarzenie['id']   = self::uuid();
		$zdarzenie['czas'] = gmdate( 'c' );
		$teraz             = current_time( 'mysql', true );
		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			Midrev_Esp_Install::queue_table(),
			array(
				'event_id'        => $zdarzenie['id'],
				'payload'         => wp_json_encode( $zdarzenie ),
				'attempts'        => 0,
				'next_attempt_at' => $teraz,
				'created_at'      => $teraz,
			),
			array( '%s', '%s', '%d', '%s', '%s' )
		);
		self::schedule_now();
	}

	/** Wysyłka w tle tak szybko, jak się da (jedno zadanie naraz). */
	private static function schedule_now(): void {
		if ( function_exists( 'as_enqueue_async_action' ) && function_exists( 'as_has_scheduled_action' ) ) {
			if ( ! as_has_scheduled_action( self::HOOK_FLUSH, array(), Midrev_Esp_Install::GROUP ) ) {
				as_enqueue_async_action( self::HOOK_FLUSH, array(), Midrev_Esp_Install::GROUP );
			}
			return;
		}
		if ( ! wp_next_scheduled( self::HOOK_FLUSH ) ) {
			wp_schedule_single_event( time(), self::HOOK_FLUSH );
		}
	}

	/** Liczba zdarzeń czekających w kolejce (strona ustawień). */
	public static function count(): int {
		global $wpdb;
		$tabela = Midrev_Esp_Install::queue_table();
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$tabela}" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	/** Wyczyszczenie kolejki (odłączenie). */
	public static function clear(): void {
		global $wpdb;
		$tabela = Midrev_Esp_Install::queue_table();
		$wpdb->query( "DELETE FROM {$tabela}" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	/**
	 * Wysyłka zaległych zdarzeń paczkami. Blokada (transient) ogranicza równoległe przebiegi;
	 * gdyby jednak dwa wysłały to samo, ESP odrzuci duplikat po `event_id`.
	 */
	public static function flush(): void {
		if ( ! Midrev_Esp_Api::is_connected() ) {
			return;
		}
		if ( get_transient( self::LOCK ) ) {
			return;
		}
		set_transient( self::LOCK, 1, 60 );
		global $wpdb;
		$tabela = Midrev_Esp_Install::queue_table();
		try {
			for ( $runda = 0; $runda < 10; $runda++ ) {
				$wiersze = $wpdb->get_results( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
					$wpdb->prepare(
						"SELECT id, event_id, payload, attempts, created_at FROM {$tabela} WHERE next_attempt_at <= %s ORDER BY id ASC LIMIT %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
						current_time( 'mysql', true ),
						self::BATCH
					),
					ARRAY_A
				);
				if ( empty( $wiersze ) ) {
					break;
				}
				$zdarzenia = array();
				$ids       = array();
				foreach ( $wiersze as $w ) {
					$ids[] = (int) $w['id'];
					$z     = json_decode( $w['payload'], true );
					if ( is_array( $z ) ) {
						$zdarzenia[] = $z;
					}
				}
				$r   = Midrev_Esp_Api::signed_request(
					'zdarzenia',
					array(
						'zdarzenia' => $zdarzenia,
						'wtyczka'   => array( 'wersja' => MIDREV_ESP_VERSION ),
					)
				);
				$kod = is_wp_error( $r ) ? 0 : (int) $r['code'];
				if ( $kod >= 200 && $kod < 300 ) {
					self::delete_ids( $ids );
					if ( is_array( $r['data'] ) && isset( $r['data']['konfiguracja'] ) ) {
						Midrev_Esp_Api::save_config( $r['data']['konfiguracja'] );
					}
					$ostatnie = end( $zdarzenia );
					Midrev_Esp_Api::update_status(
						array(
							'last_event_at'   => time(),
							'last_event_type' => is_array( $ostatnie ) && isset( $ostatnie['typ'] ) ? sanitize_key( $ostatnie['typ'] ) : '',
							'last_error'      => '',
						)
					);
					continue;
				}
				if ( in_array( $kod, array( 400, 413, 415, 422 ), true ) ) {
					// paczka odrzucona jako niepoprawna: ponawianie nic nie da (ESP waliduje każde
					// zdarzenie osobno, więc 400 oznacza zepsutą całą paczkę); 401/408/429 itd. = ponowienie
					self::delete_ids( $ids );
					/* translators: %d: HTTP status code */
					Midrev_Esp_Api::update_status( array( 'last_error' => sprintf( __( 'MidRev ESP rejected events (HTTP %d).', 'midrev-esp' ), $kod ) ) );
					continue;
				}
				$blad = is_wp_error( $r ) ? $r->get_error_message() : sprintf( 'HTTP %d', $kod );
				self::retry_later( $wiersze, $blad );
				Midrev_Esp_Api::update_status( array( 'last_error' => $blad ) );
				break;
			}
		} finally {
			delete_transient( self::LOCK );
		}
	}

	/** Usunięcie wysłanych wierszy. */
	private static function delete_ids( array $ids ): void {
		global $wpdb;
		if ( empty( $ids ) ) {
			return;
		}
		$tabela  = Midrev_Esp_Install::queue_table();
		$ids     = array_map( 'absint', $ids );
		$miejsca = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$tabela} WHERE id IN ({$miejsca})", $ids ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare
	}

	/** Ponowienie z rosnącym odstępem; zbyt stare albo wyczerpane = porzucone. */
	private static function retry_later( array $wiersze, string $blad ): void {
		global $wpdb;
		$tabela = Midrev_Esp_Install::queue_table();
		$teraz  = time();
		foreach ( $wiersze as $w ) {
			$proby = (int) $w['attempts'] + 1;
			$wiek  = $teraz - (int) strtotime( $w['created_at'] . ' UTC' );
			if ( $proby >= self::MAX_TRIES || $wiek > self::MAX_AGE_SEC ) {
				$wpdb->delete( $tabela, array( 'id' => (int) $w['id'] ), array( '%d' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
				continue;
			}
			$odstep = min( 21600, 60 * ( 2 ** min( $proby - 1, 9 ) ) );
			$wpdb->update( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
				$tabela,
				array(
					'attempts'        => $proby,
					'next_attempt_at' => gmdate( 'Y-m-d H:i:s', $teraz + $odstep ),
					'last_error'      => substr( sanitize_text_field( $blad ), 0, 255 ),
				),
				array( 'id' => (int) $w['id'] ),
				array( '%d', '%s', '%s' ),
				array( '%d' )
			);
		}
	}
}
