<?php
/**
 * Tabele i harmonogram wtyczki.
 *
 * @package MidrevEsp
 */

defined( 'ABSPATH' ) || exit;

/**
 * Instalacja: dwie własne tabele (kolejka zdarzeń do ESP i koszyki do odtworzenia z linku)
 * oraz cykliczne zadanie Action Scheduler (ponawianie kolejki, ping). Wtyczka nie zapisuje
 * nic w bazie sklepu poza tymi tabelami, opcjami `midrev_esp_*` i meta zamówień `_mrv_*`.
 */
class Midrev_Esp_Install {

	const DB_VERSION = '1';
	const GROUP      = 'midrev-esp';

	/** Nazwa tabeli kolejki. */
	public static function queue_table(): string {
		global $wpdb;
		return $wpdb->prefix . 'midrev_esp_queue';
	}

	/** Nazwa tabeli koszyków. */
	public static function carts_table(): string {
		global $wpdb;
		return $wpdb->prefix . 'midrev_esp_carts';
	}

	/** Aktywacja: tabele i harmonogram. */
	public static function activate(): void {
		self::create_tables();
		update_option( 'midrev_esp_db_version', self::DB_VERSION, false );
	}

	/** Dezaktywacja: zatrzymanie zadań (dane zostają do odinstalowania). */
	public static function deactivate(): void {
		if ( function_exists( 'as_unschedule_all_actions' ) ) {
			as_unschedule_all_actions( '', array(), self::GROUP );
		}
		wp_clear_scheduled_hook( 'midrev_esp_cron_flush' );
	}

	/** Aktualizacja schematu po wgraniu nowej wersji zip (bez ponownej aktywacji). */
	public static function maybe_upgrade(): void {
		if ( get_option( 'midrev_esp_db_version' ) !== self::DB_VERSION ) {
			self::activate();
		}
	}

	/** Tabele (dbDelta jest idempotentne). */
	private static function create_tables(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$queue   = self::queue_table();
		$carts   = self::carts_table();

		// event_id UNIQUE: to samo zdarzenie nie wejdzie do kolejki dwa razy, a ESP i tak
		// deduplikuje po nim ponowienia (klucz idempotencji po stronie serwera).
		dbDelta(
			"CREATE TABLE {$queue} (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			event_id varchar(64) NOT NULL,
			payload longtext NOT NULL,
			attempts smallint(5) unsigned NOT NULL DEFAULT 0,
			next_attempt_at datetime NOT NULL,
			created_at datetime NOT NULL,
			last_error varchar(255) NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY event_id (event_id),
			KEY next_attempt_at (next_attempt_at)
		) {$charset};"
		);

		// Koszyk do odtworzenia z linku `?mrv_cart=` (wygasa po 30 dniach; sprzątanie cykliczne).
		dbDelta(
			"CREATE TABLE {$carts} (
			token varchar(64) NOT NULL,
			items longtext NOT NULL,
			coupons text NULL,
			updated_at datetime NOT NULL,
			expires_at datetime NOT NULL,
			PRIMARY KEY  (token),
			KEY expires_at (expires_at)
		) {$charset};"
		);
	}
}
