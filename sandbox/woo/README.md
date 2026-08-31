# Sandbox WooCommerce

Atrapa sklepu klienta do testów adaptera `StorePlatform` (AD-8) i testów integracyjnych (AD-20).
To nie jest część produktu i nigdy nie trafia na żaden serwer.

```bash
cd sandbox/woo
docker compose -f docker-compose.woo.yml up -d
./provision.sh          # instaluje WordPressa, WooCommerce, dane i klucze REST
```

Po wykonaniu: panel na http://localhost:8091/wp-admin (admin/admin), klucze w `.woo-credentials`
(plik jest gitignorowany, bo to poświadczenia, choćby i testowe).

**Dane testowe są celowo nierówne.** 40 zamówień rozłożonych od 400 dni wstecz do wczoraj, w tym
anulowane i zwrócone, 6 klientów, 8 produktów w trzech kategoriach. Daty historyczne są sednem:
adapter musi zapisać `occurred_at` ze źródła, a nie datę importu (AD-10). Test, który tego nie
sprawdza, przepuści błąd fałszujący raporty przychodu po cichu.

**Dlaczego jest tu shim SSL.** WooCommerce dopuszcza Basic auth wyłącznie po HTTPS, a po HTTP
wymaga podpisu OAuth 1.0a. Sklepy klientów stoją na HTTPS, więc adapter ma używać Basic auth bez
wyjątków dla testów. `mu-sandbox-ssl.php` udaje HTTPS wyłącznie dla ścieżek `/wp-json/`, żeby
panel WordPressa dalej działał po HTTP. Cały hack jest po stronie sandboxu, zero śladu w kodzie.
