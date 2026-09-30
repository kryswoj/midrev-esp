# midrev-esp: monitoring produkcji

Są trzy warstwy. Każda łapie coś, czego nie widzą pozostałe:

| Warstwa | Co widzi | Czego nie widzi |
|---|---|---|
| Alerty aplikacji (worker → `ALERT_WEBHOOK_URL`) | wstrzymanie tenanta przez progi reputacji, `held`, wyczerpane próby jobów, cisza sklepu, rozjazd danych | martwy worker (martwy nie wyśle alertu) |
| Healthcheck na serwerze (`midrev-esp-healthcheck.timer`, co 5 min) | panel/worker nie działa, baza nie odpowiada, heartbeat workera stary, backup nie przyszedł, pełny dysk | cały serwer leży, sieć, DNS, TLS z zewnątrz |
| Monitor zewnętrzny (UptimeRobot / Better Stack / healthchecks.io) | serwer niedostępny z internetu, certyfikat, DNS, brak pingu backupu | szczegóły (dlatego jest warstwa 2) |

Wszystkie alerty idą na **jeden kanał techniczny** (Discord), nie do kanału klienta
i nie do `console.error`, którego nikt nie czyta.

## 1. Healthcheck na serwerze

`monitoring/healthcheck.sh` uruchamiany przez `midrev-esp-healthcheck.timer` co 5 minut
(użytkownik `midrev-esp`, stan w `/var/lib/midrev-esp-healthcheck/`).

| Sprawdzenie | Warunek porażki | Alert |
|---|---|---|
| `GET http://127.0.0.1:3100/api/zdrowie` | kod ≠ 200 w 10 s. Trasa daje 503, gdy baza nie odpowiada albo heartbeat workera jest starszy niż 120 s | **krytyczny** po 2 porażkach z rzędu (10 min), przypomnienie co godzinę, „Wróciło” po naprawie |
| `systemctl is-active` web i worker | unit nieaktywny | jw. (ta sama seria) |
| znacznik `/var/lib/midrev-esp-backup/ostatni-ok` | starszy niż 26 h albo brak | **uwaga**, najwyżej raz na 6 h |
| `df` dla `/` i `/var/lib/docker` | zajętość > 85% | **uwaga**, najwyżej raz na 6 h |

Ręcznie:
```bash
systemctl start midrev-esp-healthcheck.service; journalctl -u midrev-esp-healthcheck -n 20
systemctl list-timers 'midrev-esp-*'
curl -s http://127.0.0.1:3100/api/zdrowie
# liczby kolejki/held (gdy ustawiony ZDROWIE_TOKEN w production.env):
curl -s -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:3100/api/zdrowie?szczegoly=1'
```

Porażka healthchecku kończy unit kodem ≠ 0, więc widać ją też w `systemctl --failed`.
Alert, który nie doszedł (webhook nie działa), jest logowany jako błąd, a przy następnym
przebiegu skrypt próbuje ponownie.

Progi da się zmienić zmiennymi w unicie (`Environment=`): `PROG_PORAZEK`,
`PRZYPOMNIENIE_S`, `BACKUP_MAX_WIEK_S`, `DYSK_PROG_PROC`.

## 2. Monitor zewnętrzny (do założenia ręcznie)

Konto u dostawcy monitoringu to nowy podprocesor (widzi tylko adresy URL i kody
odpowiedzi, bez danych osobowych). Założenie konta i wpisanie adresów **WYMAGA ZGODY
KRYSTIANA**. Darmowy plan UptimeRobot albo Better Stack wystarcza.

| Monitor | Typ | Adres | Oczekiwane | Interwał |
|---|---|---|---|---|
| Panel i worker | HTTP(s), słowo kluczowe | `https://esp.midrev.pl/api/zdrowie` | 200 i `"status":"ok"` | 5 min |
| Domena śledzenia (TLS + Caddy) | HTTP(s) | `https://link.midrev.pl/robots.txt` | 200 | 5 min |
| Wypis przez aplikację | HTTP(s) | `https://link.midrev.pl/u/monitoring-nieistniejacy-token` | 404 z treścią strony aplikacji (nie „Nie znaleziono” z Caddy) | 15 min |
| Certyfikaty | SSL expiry | `esp.midrev.pl`, `link.midrev.pl` | > 14 dni | dziennie |
| Backup (dead man's switch) | heartbeat (healthchecks.io albo Better Stack) | adres pingu w `PING_URL` w `backup.env` | ping co 24 h, okres łaski 6 h | — |

Powiadomienia monitora zewnętrznego: ten sam kanał Discord (webhook) plus e-mail/SMS
do Krystiana. Serwer, który leży w całości, nie wyśle alertu sam.

## 3. Zapytania diagnostyczne (tylko odczyt)

```sql
-- docker exec -it midrev-esp-prod-db psql -U midrev_esp -d midrev_esp_prod
-- worker żyje? (heartbeat co kilkanaście sekund)
select worker_id, last_seen_at, stopping_at from worker_heartbeats order by last_seen_at desc limit 5;
-- kolejka stoi?
select count(*) from jobs where status = 'pending' and run_after < now() - interval '10 minutes';
-- joby padnięte w ostatniej dobie
select kind, count(*) from jobs where status = 'failed' and created_at > now() - interval '1 day' group by 1;
-- pułapka partycji (musi być 0)
select count(*) from jobs_default;
-- niewyjaśnione wysyłki
select count(*) from messages where current_state = 'held';
-- wstrzymani nadawcy
select name, sending_paused_at, sending_pause_reason from tenants where sending_paused_at is not null;
```

Tabela `worker_heartbeats` powstaje w migracji `0029_gotowosc_produkcyjna.sql` (28.09).

## 4. Logi

| Źródło | Gdzie | Retencja |
|---|---|---|
| panel, worker, backup, healthcheck | `journalctl -u midrev-esp-<nazwa>` | 30 dni / 1 GB (journald) |
| Caddy, panel | `/var/log/caddy/esp.midrev.pl.access.log` (JSON) | 14 dni |
| Caddy, śledzenie | `/var/log/caddy/link.midrev.pl.access.log` (JSON) | 30 dni (wypisy z luki po restore, README 6.4) |
| Postgres | `docker logs midrev-esp-prod-db` | 5 × 10 MB |
| wdrożenia | `/srv/midrev-esp/wdrozenia.log` | bez limitu (kilka linii na wdrożenie) |

Logi zawierają dane osobowe (IP, tokeny w adresach, w części komunikatów workera adresy
e-mail). Dłuższa retencja wymaga uzasadnienia w rejestrze czynności przetwarzania.
Caddy domyślnie maskuje w logu nagłówki `Cookie` i `Authorization`.
