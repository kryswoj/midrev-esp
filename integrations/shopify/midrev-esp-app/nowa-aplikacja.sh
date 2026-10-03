#!/usr/bin/env bash
# Generuje konfigurację aplikacji MidRev dla jednego sklepu klienta (custom distribution).
#
#   ./nowa-aplikacja.sh <slug-klienta> "<Nazwa klienta>" <client_id> [APP_URL]
#
# Tworzy shopify.app.<slug>.toml z szablonu. Niczego nie wysyła do Shopify: deploy robi
# człowiek (`shopify app deploy --config <slug>`), patrz raport 04-shopify.md.
set -euo pipefail
cd "$(dirname "$0")"
slug="${1:?podaj slug klienta, np. bcw}"
nazwa="${2:?podaj nazwę klienta}"
client_id="${3:?podaj client_id z Dev Dashboard}"
app_url="${4:-https://app.midrev.pl}"
[[ "$slug" =~ ^[a-z0-9-]{2,40}$ ]] || { echo "slug: małe litery, cyfry, myślniki" >&2; exit 1; }
[[ "$client_id" =~ ^[A-Za-z0-9_-]{16,128}$ ]] || { echo "client_id wygląda na niepełny" >&2; exit 1; }
[[ "$app_url" =~ ^https://[a-z0-9.-]+$ ]] || { echo "APP_URL: https://host bez ścieżki" >&2; exit 1; }
# nazwa trafia do TOML w cudzysłowie i do sed: bez znaków, które trzeba by escapować
[[ "$nazwa" =~ ^[[:alnum:][:space:].,()_-]{2,60}$ ]] || { echo "nazwa: litery, cyfry, spacje i . , ( ) _ - (2-60 znaków)" >&2; exit 1; }
nazwa_esc="$nazwa"
cel="shopify.app.${slug}.toml"
[[ -e "$cel" ]] && { echo "$cel już istnieje" >&2; exit 1; }
sed -e "s|{{CLIENT_ID}}|${client_id}|g" -e "s|{{NAZWA_KLIENTA}}|${nazwa_esc}|g" \
    -e "s|{{SLUG}}|${slug}|g" -e "s|{{APP_URL}}|${app_url}|g" shopify.app.toml.szablon > "$cel"
echo "Utworzono $cel. Dalej: shopify app deploy --config ${slug}"
