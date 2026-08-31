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
