<?php
// Tworzy klucze REST WooCommerce dokładnie tak, jak zrobiłby to merchant w panelu.
// Uwaga: WooCommerce trzyma consumer_key jako hash, dlatego jawną wartość widać tylko tutaj.
global $wpdb;
$user_id = 1;
$consumer_key    = 'ck_' . wc_rand_hash();
$consumer_secret = 'cs_' . wc_rand_hash();

$wpdb->insert(
    $wpdb->prefix . 'woocommerce_api_keys',
    [
        'user_id'         => $user_id,
        'description'     => 'midrev-esp sandbox',
        'permissions'     => 'read_write',
        'consumer_key'    => wc_api_hash( $consumer_key ),
        'consumer_secret' => $consumer_secret,
        'truncated_key'   => substr( $consumer_key, -7 ),
    ],
    [ '%d', '%s', '%s', '%s', '%s', '%s' ]
);

echo "WOO_URL=http://localhost:8091\n";
echo "WOO_CONSUMER_KEY={$consumer_key}\n";
echo "WOO_CONSUMER_SECRET={$consumer_secret}\n";
