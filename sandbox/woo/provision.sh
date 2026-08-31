#!/usr/bin/env bash
# Stawia sklep testowy: WooCommerce + dane + klucze REST.
# Wynik: .woo-credentials (gitignorowane) z ck_/cs_ do testów adaptera.
set -euo pipefail
cd "$(dirname "$0")"
DC="docker compose -f docker-compose.woo.yml"
CLI="$DC exec -T --user 33:33 woo-cli wp --path=/var/www/html"
SITE_URL="http://localhost:8091"

echo "== czekam na WordPressa =="
for _ in $(seq 1 90); do curl -sf -o /dev/null "$SITE_URL" && break || sleep 2; done

echo "== instalacja WordPressa =="
$CLI core install --url="$SITE_URL" --title="Sklep Testowy MidRev" \
  --admin_user=admin --admin_password=admin --admin_email=dev@midrev.test --skip-email || true

echo "== WooCommerce =="
$CLI plugin install woocommerce --activate
$CLI option update woocommerce_store_address "Testowa 1"
$CLI option update woocommerce_store_city "Warszawa"
$CLI option update woocommerce_default_country "PL:MZ"
$CLI option update woocommerce_currency "PLN"
$CLI rewrite structure '/%postname%/' --hard

echo "== kopiuje skrypty do kontenera =="
$DC cp seed-woo.php woo:/var/www/html/seed-woo.php
$DC cp make-keys.php woo:/var/www/html/make-keys.php

echo "== shim SSL dla REST (sandbox) =="
$DC exec -T --user 33:33 woo-cli mkdir -p /var/www/html/wp-content/mu-plugins
$DC cp mu-sandbox-ssl.php woo:/var/www/html/wp-content/mu-plugins/sandbox-ssl.php

echo "== dane testowe =="
$CLI eval-file /var/www/html/seed-woo.php

echo "== klucze REST =="
$CLI eval-file /var/www/html/make-keys.php | tee .woo-credentials
echo
echo "Gotowe. Panel: $SITE_URL/wp-admin (admin/admin). Klucze w .woo-credentials"
