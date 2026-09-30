<?php
/**
 * TYLKO SANDBOX. WooCommerce dopuszcza Basic auth wyłącznie po HTTPS, a po HTTP
 * wymaga podpisu OAuth 1.0a. Prawdziwe sklepy klientów stoją na HTTPS, więc adapter
 * ma używać Basic auth bez wyjątków dla testów. Zamiast brudzić kod, sandbox udaje
 * HTTPS wyłącznie dla ścieżek REST, żeby panel WP dalej działał po HTTP.
 */
if ( isset( $_SERVER['REQUEST_URI'] ) && str_starts_with( $_SERVER['REQUEST_URI'], '/wp-json/' ) ) {
    $_SERVER['HTTPS'] = 'on';
}

/**
 * TYLKO SANDBOX. Woo dostarcza webhooki przez wp_safe_remote_request(), a WordPress
 * blokuje "safe" żądania do adresów prywatnych — ESP w sandboksie stoi właśnie na
 * bramce dockera (adres prywatny), więc bez tego filtra dostawa webhooka cicho pada.
 * Prawdziwe sklepy klientów wysyłają na publiczny adres ESP i filtra nie potrzebują.
 */
add_filter( 'http_request_host_is_external', static function ( $external, $host ) {
    return $host === '172.22.0.1' ? true : $external;
}, 10, 2 );

// ...i to samo dotyczy portu: wp_http_validate_url dopuszcza tylko 80/443/8080,
// a ESP w sandboksie nasluchuje na 3005 (serwer dev, baza midrev_esp), a testowy
// odbiornik webhookow na 3015 (tests/odbiornik-webhookow.ts, baza midrev_esp_test).
add_filter( 'http_allowed_safe_ports', static function ( $ports ) {
    $ports[] = 3005;
    $ports[] = 3015;
    return $ports;
} );
