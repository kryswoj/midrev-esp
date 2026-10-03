<?php
/**
 * Odinstalowanie: usuwa WSZYSTKIE dane wtyczki (tabele, opcje, klucz REST, zadania).
 * Meta zamówień `_mrv_*` zostają: są częścią historii zamówień sklepu (dowód zgody z kasy).
 *
 * @package MidrevEsp
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

global $wpdb;

$midrev_esp_polaczenie = get_option( 'midrev_esp_connection' );
if ( is_array( $midrev_esp_polaczenie ) && ! empty( $midrev_esp_polaczenie['key_id'] ) ) {
	$wpdb->delete( $wpdb->prefix . 'woocommerce_api_keys', array( 'key_id' => absint( $midrev_esp_polaczenie['key_id'] ) ), array( '%d' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
}

foreach ( array( 'midrev_esp_connection', 'midrev_esp_secret', 'midrev_esp_config', 'midrev_esp_status', 'midrev_esp_db_version' ) as $midrev_esp_opcja ) {
	delete_option( $midrev_esp_opcja );
}

$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}midrev_esp_queue" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.DirectDatabaseQuery.SchemaChange
$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}midrev_esp_carts" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.DirectDatabaseQuery.SchemaChange

if ( function_exists( 'as_unschedule_all_actions' ) ) {
	as_unschedule_all_actions( '', array(), 'midrev-esp' );
}
wp_clear_scheduled_hook( 'midrev_esp_cron_flush' );
wp_clear_scheduled_hook( 'midrev_esp_flush_queue' );
