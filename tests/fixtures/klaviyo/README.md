# Fixtures: eksport z Klaviyo

Struktura kolumn wg help.klaviyo.com (artykuły: „How to export a list or segment to a CSV
file” 115005078687, „How to import subscribers to a list” 115005251128, „How to migrate
existing email subscribers (and unsubscribes)” 115005078487, „How to manage email
suppressions” 24312135764251). Adresy zmyślone (`@example.test`).

- `lista-eksport.csv`: eksport listy z BOM, kolumnami zgody (`Email Marketing Consent`
  = SUBSCRIBED/UNSUBSCRIBED/NEVER_SUBSCRIBED, `Email Marketing Consent Timestamp`),
  `Source`, `Email Suppressions`, właściwościami własnymi (City, Shopify Tags) i
  pułapkami: adres z wielkimi literami i spacją, przecinek i cudzysłów w polu,
  pole wielolinijkowe, zły adres, duplikat, wstrzyknięcie formuły, zgoda bez daty.
- `supresje-eksport.csv`: eksport wykluczeń z kolumną powodu (wartości z API Klaviyo:
  UNSUBSCRIBED, USER_SUPPRESSED, SPAM_COMPLAINT, HARD_BOUNCE, INVALID_EMAIL) i datą.
- `supresje-sam-email.csv`: minimalny plik wykluczeń (sama kolumna Email, CRLF), taki
  jak Klaviyo przyjmuje przy „Upload file” w View suppressed profiles.
