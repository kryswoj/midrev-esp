<?php
/**
 * TYLKO SANDBOX (E2E wtyczki MidRev ESP for WooCommerce).
 *
 * ESP do testów stoi w kontenerze `mrv-esp-woo-e2e` w sieci dockera sandboxa (port 3101):
 * kontener Woo nie dosięga portów hosta (ufw), a kontener w tej samej sieci tak.
 *  - adres API wtyczki: stała MIDREV_ESP_API_URL (wtyczka NIE bierze adresu z URL ani formularza),
 *  - dostawa webhooków Woo (wp_safe_remote_request) na ten host i port.
 */
if ( ! defined( 'MIDREV_ESP_API_URL' ) ) {
	define( 'MIDREV_ESP_API_URL', 'http://mrv-esp-woo-e2e:3101' );
}
add_filter( 'http_request_host_is_external', static function ( $external, $host ) {
	return 'mrv-esp-woo-e2e' === $host ? true : $external;
}, 10, 2 );
add_filter( 'http_allowed_safe_ports', static function ( $ports ) {
	$ports[] = 3101;
	return $ports;
} );
