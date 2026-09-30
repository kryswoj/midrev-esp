# Kontrakt n8n → API zgodne z Klaviyo (zanonimizowane)

Żądania `POST https://a.klaviyo.com/api/events/` z workflowów n8n Sports-med
(`my-marketingskills/clients/mysomicare/n8n-workflows/`), odtworzone 1:1 co do KSZTAŁTU,
nagłówków i ścieżki (z ukośnikiem na końcu). Dane osobowe i identyfikatory zamienione na
fikcyjne; klucza API w plikach nie ma (test wstawia własny klucz tenanta testowego).

| plik | workflow | węzeł |
|---|---|---|
| `quiz-v6-zdarzenie-ukonczony.json` | `quiz-v6-zapis-karty-wznowienie.v3.json` | „Klaviyo: zdarzenie” (complete = true) |
| `quiz-v6-zdarzenie-zapisana.json` | `quiz-v6-zapis-karty-wznowienie.v3.json` | „Klaviyo: zdarzenie” (complete = false) |
| `quiz-lead-v3-zdarzenie.json` | `quiz-lead.v3.json` | „Klaviyo: Track Subscribed Via Quiz” (event_body z „Przygotuj lead”) |
| `quiz-lead-v3-zdarzenie-bez-run.json` | `quiz-lead.v3.json` | to samo, stary front bez `quiz_run` (unique_id z dnia i skrótu adresu) |

Nagłówki we wszystkich węzłach: `revision: 2025-01-15`, `Content-Type: application/json`,
`Accept: application/json`, klucz w `Authorization: Klaviyo-API-Key …` (credential n8n
albo nagłówek w węźle). Odpowiedź czytana przez n8n: `statusCode` (< 300 = sukces) oraz
przy błędzie `body.errors[0].code` i `body.errors[0].source.pointer` (węzły „Alert: ocena”).
