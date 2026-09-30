#!/usr/bin/env bash
# midrev-esp: healthcheck uruchamiany co 5 minut przez midrev-esp-healthcheck.timer
# (użytkownik midrev-esp, ALERT_WEBHOOK_URL z EnvironmentFile=).
#
# Sprawdza:
#   A. (krytyczne) GET /api/zdrowie == 200 oraz aktywne unity web i worker.
#      /api/zdrowie w aplikacji sprawdza bazę i heartbeat workera, więc stojąca kolejka
#      też daje 503. Alert po 2 kolejnych porażkach (10 min), przypomnienie co godzinę,
#      komunikat „wróciło" po naprawie.
#   B. (ostrzeżenia, najwyżej raz na 6 h każde) wiek ostatniego udanego backupu > 26 h,
#      zajętość dysku > 85%.
#
# Stan (licznik porażek, czasy ostatnich alertów) w $STATE_DIRECTORY (systemd StateDirectory=).

set -euo pipefail

SKRYPT_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=lib/wspolne.sh
. "$SKRYPT_DIR/../lib/wspolne.sh"

HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3100/api/zdrowie}
STAN=${STATE_DIRECTORY:-/var/lib/midrev-esp-healthcheck}
ZNACZNIK_BACKUPU=${ZNACZNIK_BACKUPU:-/var/lib/midrev-esp-backup/ostatni-ok}
PROG_PORAZEK=${PROG_PORAZEK:-2}
PRZYPOMNIENIE_S=${PRZYPOMNIENIE_S:-3600}
OSTRZEZENIE_CO_S=${OSTRZEZENIE_CO_S:-21600}
BACKUP_MAX_WIEK_S=${BACKUP_MAX_WIEK_S:-93600}
DYSK_PROG_PROC=${DYSK_PROG_PROC:-85}
UNITY=${UNITY:-midrev-esp-web.service midrev-esp-worker.service}
TERAZ=$(date +%s)

[[ -d $STAN && -w $STAN ]] || zgin "katalog stanu $STAN niedostępny do zapisu"

czytaj_stan() { cat "$STAN/$1" 2>/dev/null || echo "${2:-0}"; }
zapisz_stan() { printf '%s\n' "$2" >"$STAN/$1.tmp" && mv "$STAN/$1.tmp" "$STAN/$1"; }

# --- A. zdrowie aplikacji ---
POWOD=""
for u in $UNITY; do
	systemctl is-active --quiet "$u" || POWOD+="$u nieaktywny ($(systemctl is-active "$u" 2>/dev/null || true)); "
done
KOD=$(curl -s -o "$STAN/odpowiedz" -w '%{http_code}' -m 10 "$HEALTH_URL") || KOD=000
if [[ $KOD != 200 ]]; then
	# pierwsze 300 znaków odpowiedzi (trasa zdrowia nie zwraca danych osobowych)
	POWOD+="$HEALTH_URL -> HTTP $KOD $(head -c 300 "$STAN/odpowiedz" 2>/dev/null | tr -d '\n' || true)"
fi

PORAZKI=$(czytaj_stan porazki)
ALERT_OSTATNI=$(czytaj_stan alert_ostatni)
ALARM=$(czytaj_stan alarm)
if [[ -z $POWOD ]]; then
	# stan „alarm" kasujemy dopiero, gdy „wróciło" doszło (inaczej spróbujemy za 5 min)
	if [[ $ALARM != 1 ]] || wyslij_alert info "Wróciło: /api/zdrowie 200, web i worker aktywne (po $PORAZKI nieudanych sprawdzeniach)."; then
		zapisz_stan alarm 0
	fi
	zapisz_stan porazki 0
	log "OK"
else
	PORAZKI=$((PORAZKI + 1))
	zapisz_stan porazki "$PORAZKI"
	log "porażka $PORAZKI: $POWOD"
	if ((PORAZKI >= PROG_PORAZEK)); then
		if [[ $ALARM != 1 ]] || ((TERAZ - ALERT_OSTATNI >= PRZYPOMNIENIE_S)); then
			# alarm ustawiony zawsze; czas ostatniego alertu tylko gdy doszedł (inaczej ponowienie za 5 min)
			zapisz_stan alarm 1
			if wyslij_alert krytyczny "Healthcheck: $PORAZKI porażki z rzędu. $POWOD. journalctl -u midrev-esp-web -u midrev-esp-worker"; then
				zapisz_stan alert_ostatni "$TERAZ"
			fi
		fi
	fi
fi

# --- B. ostrzeżenia ---
ostrzez_rzadko() {
	local klucz=$1 tresc=$2 ostatni
	ostatni=$(czytaj_stan "ostrz_$klucz")
	if ((TERAZ - ostatni >= OSTRZEZENIE_CO_S)); then
		if wyslij_alert uwaga "$tresc"; then
			zapisz_stan "ostrz_$klucz" "$TERAZ"
		fi
	fi
}

if [[ -r $ZNACZNIK_BACKUPU ]]; then
	WIEK=$((TERAZ - $(stat -c %Y "$ZNACZNIK_BACKUPU")))
	if ((WIEK > BACKUP_MAX_WIEK_S)); then
		ostrzez_rzadko backup "Ostatni udany backup $((WIEK / 3600)) h temu ($(cat "$ZNACZNIK_BACKUPU")). systemctl status midrev-esp-backup.timer"
	fi
else
	ostrzez_rzadko backup "Brak znacznika udanego backupu ($ZNACZNIK_BACKUPU): backup nigdy się nie udał albo timer nie działa."
fi

for punkt in / /var/lib/docker; do
	[[ -d $punkt ]] || continue
	PROC=$(df -P "$punkt" 2>/dev/null | awk 'NR==2 {gsub("%", "", $5); print $5}')
	if [[ -n $PROC ]] && ((PROC > DYSK_PROG_PROC)); then
		ostrzez_rzadko "dysk_${punkt//\//_}" "Dysk $punkt zajęty w $PROC% (próg $DYSK_PROG_PROC%)."
	fi
done

# kod wyjścia != 0 przy porażce: widać to w `systemctl --failed` i journalu
[[ -z $POWOD ]]
