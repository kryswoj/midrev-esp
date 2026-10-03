# Atrapa Shopify: payloady webhooków i odpowiedzi GraphQL

Kształt pól według przykładów z dokumentacji shopify.dev (Webhooks reference, wersja
2026-07; Admin GraphQL: `bulkOperationRunQuery`, `node(id) ... on BulkOperation`,
`webhookSubscriptionCreate`, `webPixelCreate`, `metafieldsSet`, `ordersCount`). Dane fikcyjne,
domena `.example`/`.test`. Żaden test nie łączy się z prawdziwym Shopify: atrapa `fetch`
w `tests/shopify.test.ts` odrzuca każdy host spoza `*.myshopify.com` i storage bulk.

Uwagi z dokumentacji, które te pliki odwzorowują:
- `carts/create|update`: bez `email` i `customer` (tylko token, pozycje, daty),
- `checkouts/create|update`: `token`, `cart_token`, `email`, `abandoned_checkout_url`,
  `buyer_accepts_marketing`, `customer`, `line_items`, daty,
- `customers_email_marketing_consent/update`: `customer_id`, `email_address`,
  `email_marketing_consent{state, opt_in_level, consent_updated_at}` (temat
  `customers_marketing_consent/update` dotyczy SMS),
- RODO: `customers/redact` z `customer{id,email,phone}` i `orders_to_redact`,
  `customers/data_request` z `orders_requested` i `data_request{id}`, `shop/redact` z `shop_id`.
