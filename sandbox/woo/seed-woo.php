<?php
// Dane testowe: katalog, klienci, zamówienia rozłożone w czasie.
// Daty historyczne są celowe - adapter musi brać occurred_at ze źródła (AD-10),
// a test ma to wychwycić, jeśli ktoś wstawi datę importu.
if ( ! function_exists( 'wc_get_product' ) ) { echo "WooCommerce nieaktywne\n"; return; }

$katalog = [
    [ 'Serum witaminowe',      129.00, 'pielegnacja' ],
    [ 'Krem nawilzajacy',       89.00, 'pielegnacja' ],
    [ 'Szampon wzmacniajacy',   49.00, 'wlosy' ],
    [ 'Odzywka regenerujaca',   55.00, 'wlosy' ],
    [ 'Zestaw podrozny',       199.00, 'zestawy' ],
    [ 'Peeling enzymatyczny',   75.00, 'pielegnacja' ],
    [ 'Olejek do ciala',        65.00, 'cialo' ],
    [ 'Maska nocna',           110.00, 'pielegnacja' ],
];

$produkty = [];
foreach ( $katalog as [$nazwa, $cena, $kategoria] ) {
    $istnieje = get_page_by_title( $nazwa, OBJECT, 'product' );
    if ( $istnieje ) { $produkty[] = wc_get_product( $istnieje->ID ); continue; }
    $p = new WC_Product_Simple();
    $p->set_name( $nazwa );
    $p->set_regular_price( $cena );
    $p->set_manage_stock( false );
    $p->set_catalog_visibility( 'visible' );
    $p->set_status( 'publish' );
    $id = $p->save();
    wp_set_object_terms( $id, $kategoria, 'product_cat' );
    $produkty[] = wc_get_product( $id );
}
echo "produkty: " . count( $produkty ) . "\n";

$klienci = [
    [ 'anna.kowalska@example.test',  'Anna',    'Kowalska' ],
    [ 'piotr.nowak@example.test',    'Piotr',   'Nowak' ],
    [ 'maria.wisniewska@example.test','Maria',  'Wisniewska' ],
    [ 'jan.lewandowski@example.test','Jan',     'Lewandowski' ],
    [ 'ewa.dabrowska@example.test',  'Ewa',     'Dabrowska' ],
    [ 'tomasz.zielinski@example.test','Tomasz', 'Zielinski' ],
];

$ids = [];
foreach ( $klienci as [$mail, $imie, $nazwisko] ) {
    $uid = email_exists( $mail );
    if ( ! $uid ) {
        $uid = wc_create_new_customer( $mail, sanitize_user( strtolower( $imie . $nazwisko ) ), wp_generate_password() );
        update_user_meta( $uid, 'first_name', $imie );
        update_user_meta( $uid, 'last_name', $nazwisko );
        update_user_meta( $uid, 'billing_country', 'PL' );
    }
    $ids[] = $uid;
}
echo "klienci: " . count( $ids ) . "\n";

// Zamówienia od 400 dni wstecz do wczoraj, część opłacona, część anulowana i zwrócona.
$statusy = [ 'completed', 'completed', 'completed', 'processing', 'cancelled', 'refunded' ];
$utworzone = 0;
for ( $i = 0; $i < 40; $i++ ) {
    $dni_wstecz = 400 - ( $i * 10 );
    $data = ( new DateTimeImmutable( 'now', new DateTimeZone( 'UTC' ) ) )->modify( "-{$dni_wstecz} days" );
    $uid  = $ids[ $i % count( $ids ) ];
    $order = wc_create_order( [ 'customer_id' => $uid ] );
    $ile = 1 + ( $i % 3 );
    for ( $j = 0; $j < $ile; $j++ ) {
        $order->add_product( $produkty[ ( $i + $j ) % count( $produkty ) ], 1 + ( $j % 2 ) );
    }
    $order->set_address( [
        'first_name' => get_user_meta( $uid, 'first_name', true ),
        'last_name'  => get_user_meta( $uid, 'last_name', true ),
        'email'      => get_userdata( $uid )->user_email,
        'country'    => 'PL',
        'city'       => 'Warszawa',
    ], 'billing' );
    $order->set_date_created( $data->format( 'Y-m-d H:i:s' ) );
    $order->calculate_totals();
    $order->set_status( $statusy[ $i % count( $statusy ) ] );
    $order->save();
    $utworzone++;
}
echo "zamowienia: {$utworzone}\n";
