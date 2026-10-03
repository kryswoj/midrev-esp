<?php
/**
 * Test logiki zgody wtyczki Woo (Midrev_Esp_Tracker::can_track) bez WordPressa: minimalne
 * zaślepki funkcji WP. Uruchamia tests/woo-wtyczka-zgoda.test.ts (php:8.2-cli w dockerze).
 * Argument: "bez-api" (sklep bez WP Consent API) albo "api-tak" / "api-nie" (wp_has_consent).
 */
define( 'ABSPATH', __DIR__ );
$GLOBALS['filtry'] = array();
function apply_filters( $tag, $v ) { return isset( $GLOBALS['filtry'][ $tag ] ) ? $GLOBALS['filtry'][ $tag ]( $v ) : $v; }
function sanitize_text_field( $s ) { return trim( (string) $s ); }
function wp_unslash( $s ) { return $s; }
function add_action() {}
$tryb = $argv[1] ?? 'bez-api';
if ( 'bez-api' !== $tryb ) {
	function wp_has_consent( $kat ) { return 'marketing' === $kat && 'api-tak' === $GLOBALS['tryb']; }
}
$GLOBALS['tryb'] = $tryb;
class WC_Order { public $meta = array(); public function update_meta_data( $k, $v ) { $this->meta[ $k ] = $v; } }
class Midrev_Esp_Carts { public static function token( $utworz = true ) { return 'TOKEN-KOSZYKA-1'; } }
require __DIR__ . '/../../integrations/woocommerce/midrev-esp/includes/class-midrev-esp-tracker.php';
function tag( $cookie ) {
	$_COOKIE = $cookie ? array( '__mx_id' => $cookie ) : array();
	$o = new WC_Order();
	Midrev_Esp_Tracker::tag_order( $o );
	return isset( $o->meta['_mrv_cart_token'] );
}

$wyniki = array();
$ciastko = rawurlencode( json_encode( array( 'a' => 'abcDEF123_-xyz', 't' => 1 ) ) );
$wyniki['token_w_zamowieniu_bez_zgody'] = tag( null );
$wyniki['token_w_zamowieniu_ze_zgoda'] = tag( $ciastko );
$_COOKIE = array();
$wyniki['bez_ciastka'] = Midrev_Esp_Tracker::can_track();
$_COOKIE['__mx_id'] = $ciastko;
$wyniki['z_ciastkiem'] = Midrev_Esp_Tracker::can_track();
$_COOKIE['__mx_id'] = 'smiec';
$wyniki['zle_ciastko'] = Midrev_Esp_Tracker::can_track();
unset( $_COOKIE['__mx_id'] );
$GLOBALS['filtry']['midrev_esp_can_track'] = function ( $v ) { return true; };
$wyniki['filtr_true_bez_ciastka'] = Midrev_Esp_Tracker::can_track();
$GLOBALS['filtry']['midrev_esp_can_track'] = function ( $v ) { return false; };
$_COOKIE['__mx_id'] = $ciastko;
$wyniki['filtr_false_z_ciastkiem'] = Midrev_Esp_Tracker::can_track();
echo json_encode( $wyniki );
