# shellcheck shell=bash
# Wspólne funkcje skryptów operacyjnych midrev-esp (backup, restore, deploy, healthcheck).
# Plik jest dołączany przez `source`, nie uruchamiany.
#
# Zasady, których te funkcje pilnują:
# - wartości sekretów nigdy nie trafiają na stdout ani do logu,
# - plik env czytamy bez `eval` i bez `source` (to nie jest skrypt powłoki, tylko
#   format systemd EnvironmentFile=: KLUCZ=wartość, bez rozwijania zmiennych),
# - alert, który nie doszedł, jest błędem, a nie cichym `|| true`.

# --- Ścieżki (każdą da się nadpisać zmienną środowiskową; test na sucho z tego korzysta) ---
: "${ESP_ROOT:=/srv/midrev-esp}"
: "${ESP_ENV_FILE:=$ESP_ROOT/shared/env/production.env}"
: "${ESP_DB_ENV_FILE:=$ESP_ROOT/shared/env/db.env}"
: "${ESP_DB_CONTAINER:=midrev-esp-prod-db}"
: "${ESP_STATE_DIR:=/var/lib/midrev-esp}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
ostrzezenie() { log "UWAGA: $*" >&2; }
blad() { log "BŁĄD: $*" >&2; }
# zgin: ostatni powód zostaje w OSTATNI_BLAD, żeby pułapka EXIT mogła go dać do alertu
# shellcheck disable=SC2034 # czytają skrypty dołączające ten plik (pułapki EXIT)
OSTATNI_BLAD=""
zgin() {
	# shellcheck disable=SC2034
	OSTATNI_BLAD=$*
	blad "$*"
	exit 1
}

# czytaj_zmienna PLIK NAZWA -> wypisuje wartość (ostatnie wystąpienie) albo nic.
# Obsługuje wartości w cudzysłowach "..." i '...'. Nie rozwija zmiennych, nie wykonuje kodu.
czytaj_zmienna() {
	local plik=$1 nazwa=$2 linia wartosc
	[[ -r $plik ]] || return 0
	linia=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${nazwa}=" "$plik" | tail -n 1 || true)
	[[ -n $linia ]] || return 0
	wartosc=${linia#*=}
	# obetnij białe znaki na końcu (CR z plików edytowanych w Windows też)
	wartosc=${wartosc%%[[:space:]]}
	wartosc=${wartosc%$'\r'}
	if [[ $wartosc == \"*\" && ${#wartosc} -ge 2 ]]; then
		wartosc=${wartosc:1:${#wartosc}-2}
	elif [[ $wartosc == \'*\' && ${#wartosc} -ge 2 ]]; then
		wartosc=${wartosc:1:${#wartosc}-2}
	fi
	printf '%s' "$wartosc"
}

# wymagaj_uprawnien_600 PLIK: plik z sekretami ma być 600 (albo 400) i należeć do roota
# albo do bieżącego użytkownika. Inaczej odmawiamy, zamiast po cichu czytać.
wymagaj_uprawnien_600() {
	local plik=$1 tryb wlasciciel
	[[ -f $plik ]] || zgin "brak pliku $plik"
	tryb=$(stat -c '%a' "$plik")
	wlasciciel=$(stat -c '%u' "$plik")
	case $tryb in
		600 | 400) ;;
		*) zgin "plik $plik ma prawa $tryb, wymagane 600 (chmod 600 $plik)" ;;
	esac
	if [[ $wlasciciel != 0 && $wlasciciel != "$(id -u)" ]]; then
		zgin "plik $plik należy do UID $wlasciciel, wymagany root"
	fi
}

# json_tekst TEKST -> literał JSON (z cudzysłowami). jq jest w provision.sh.
json_tekst() { jq -Rn --arg t "$1" '$t'; }

# wyslij_alert POZIOM TREŚĆ
# POZIOM: info | uwaga | krytyczny. Format zgodny z alertami aplikacji
# (src/jobs/alerty.ts): pola content (Discord) i text (Slack/Mattermost).
# Zwraca kod != 0, gdy alertu nie dało się dostarczyć (brak adresu też jest błędem).
wyslij_alert() {
	local poziom=$1 tresc=$2 url host cialo kod
	url=${ALERT_WEBHOOK_URL:-}
	if [[ -z $url ]]; then
		url=$(czytaj_zmienna "$ESP_ENV_FILE" ALERT_WEBHOOK_URL)
	fi
	host=$(hostname -f 2>/dev/null || hostname)
	# Discord tnie powyżej 2000 znaków
	tresc="[midrev-esp][$poziom][$host] $tresc"
	tresc=${tresc:0:1900}
	log "ALERT($poziom): $tresc" >&2
	if [[ -z $url ]]; then
		blad "ALERT_WEBHOOK_URL nie jest ustawiony: alert został tylko w logu (to jest błąd konfiguracji)"
		return 2
	fi
	cialo=$(jq -n --arg p "$poziom" --arg t "$tresc" --arg k "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		'{poziom: $p, tenant: null, tresc: $t, kiedy: $k, content: $t, text: $t}')
	# adres webhooka zawiera token: nie wypisujemy go, curl dostaje go przez stdin konfiguracji
	kod=$(curl -sS -o /dev/null -w '%{http_code}' -m 15 --retry 2 --retry-delay 3 \
		-H 'Content-Type: application/json' --data-binary "$cialo" \
		--config <(printf 'url = "%s"\n' "$url") 2>/dev/null) || kod=000
	if [[ $kod != 2?? ]]; then
		blad "alert nie doszedł (HTTP $kod)"
		return 1
	fi
	return 0
}

# db_exec ARGS...: polecenie wewnątrz kontenera Postgresa jako superuser bazy.
# Użytkownik bazy z db.env (POSTGRES_USER), połączenie przez gniazdo lokalne kontenera.
db_uzytkownik() {
	local u
	u=$(czytaj_zmienna "$ESP_DB_ENV_FILE" POSTGRES_USER)
	printf '%s' "${u:-midrev_esp}"
}
db_nazwa() {
	local d
	d=$(czytaj_zmienna "$ESP_DB_ENV_FILE" POSTGRES_DB)
	printf '%s' "${d:-midrev_esp_prod}"
}
db_psql() {
	# db_psql BAZA SQL -> wynik w trybie -At (bez nagłówków)
	local baza=$1 sql=$2
	docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$ESP_DB_CONTAINER" \
		psql -X -q -v ON_ERROR_STOP=1 -U "$(db_uzytkownik)" -d "$baza" -At -c "$sql"
}
db_gotowa() {
	docker exec "$ESP_DB_CONTAINER" pg_isready -q -U "$(db_uzytkownik)" -d "$(db_nazwa)" >/dev/null 2>&1
}

# Tabele, których liczba wierszy trafia do manifestu backupu i jest porównywana po
# odtworzeniu. To rejestr zgód, wykluczeń i nagrobków RODO: ich utrata oznacza wysyłkę
# do ludzi, którzy się wypisali.
TABELE_KONTROLNE=(schema_migrations tenants users consents suppressions tenant_suppressions rodo_nagrobki profiles messages images)

# liczby_wierszy BAZA -> JSON {"tabela": liczba, ...}; tabela nieistniejąca = null
liczby_wierszy() {
	local baza=$1 sql="select json_build_object(" t pierwszy=1
	for t in "${TABELE_KONTROLNE[@]}"; do
		[[ $pierwszy == 1 ]] || sql+=", "
		pierwszy=0
		sql+="'$t', (select case when to_regclass('public.$t') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.$t', false, true, '')))[1]::text::bigint end)"
	done
	sql+=")"
	db_psql "$baza" "$sql"
}

# sprawdz_zgodnosc_bazy: DATABASE_URL z production.env (tego używa aplikacja) ma wskazywać
# DOKŁADNIE tę bazę, którą skrypty backupu/deployu biorą z db.env i z kontenera. Inaczej
# backup może po cichu zrzucać pustą albo inną bazę. Hasła nie wypisujemy nigdy.
sprawdz_zgodnosc_bazy() {
	local url uzytk haslo hostport host port baza port_kontenera
	url=$(czytaj_zmienna "$ESP_ENV_FILE" DATABASE_URL)
	[[ -n $url ]] || zgin "brak DATABASE_URL w $ESP_ENV_FILE"
	[[ $url =~ ^postgres(ql)?://([^:@/]+):([^@/]*)@([^/]+)/([^?]+)(\?.*)?$ ]] ||
		zgin "DATABASE_URL w $ESP_ENV_FILE nie ma postaci postgresql://użytkownik:hasło@host:port/baza"
	uzytk=${BASH_REMATCH[2]}
	haslo=${BASH_REMATCH[3]}
	hostport=${BASH_REMATCH[4]}
	baza=${BASH_REMATCH[5]}
	host=${hostport%:*}
	port=${hostport##*:}
	[[ $hostport == *:* ]] || port=5432
	[[ $host == 127.0.0.1 || $host == localhost ]] || zgin "DATABASE_URL wskazuje host $host; baza produkcyjna słucha tylko na 127.0.0.1"
	[[ $uzytk == "$(db_uzytkownik)" ]] || zgin "użytkownik w DATABASE_URL ($uzytk) != POSTGRES_USER w db.env ($(db_uzytkownik))"
	[[ $baza == "$(db_nazwa)" ]] || zgin "baza w DATABASE_URL ($baza) != POSTGRES_DB w db.env ($(db_nazwa))"
	[[ $haslo == "$(czytaj_zmienna "$ESP_DB_ENV_FILE" POSTGRES_PASSWORD)" ]] ||
		zgin "hasło w DATABASE_URL różni się od POSTGRES_PASSWORD w db.env (wartości nie wypisuję)"
	# WSZYSTKIE mapowania portu: każde musi być dokładnie 127.0.0.1:<port> (dodatkowe
	# 0.0.0.0/:: albo publiczne IP = baza w internecie mimo ufw)
	port_kontenera=$(docker port "$ESP_DB_CONTAINER" 5432/tcp 2>/dev/null) ||
		zgin "kontener $ESP_DB_CONTAINER nie publikuje portu 5432 (docker port)"
	[[ -n $port_kontenera ]] || zgin "kontener $ESP_DB_CONTAINER nie publikuje portu 5432"
	local linia
	while read -r linia; do
		[[ -z $linia || $linia == "127.0.0.1:$port" ]] ||
			zgin "kontener $ESP_DB_CONTAINER publikuje 5432 jako '$linia' (dozwolone wyłącznie 127.0.0.1:$port)"
	done <<<"$port_kontenera"
}

# Blokada operacji na bazie wspólna dla backup.sh i restore.sh (i ręcznych procedur):
# restore nie zderzy się z nocnym backupem, dwa restore nie przepiszą sobie bazy testowej.
: "${ESP_BLOKADA_BAZY:=/run/lock/midrev-esp-baza.lock}"
zablokuj_baze() {
	local czekaj=${1:-0}
	exec 8>"$ESP_BLOKADA_BAZY"
	if ((czekaj > 0)); then
		flock -w "$czekaj" 8 || zgin "blokada $ESP_BLOKADA_BAZY zajęta dłużej niż ${czekaj}s (backup/restore w toku?)"
	else
		flock -n 8 || zgin "inna operacja na bazie trwa (blokada $ESP_BLOKADA_BAZY: backup albo restore)"
	fi
}

# Podpis HMAC-SHA256 pliku backupu. age zapewnia poufność, ale nie pochodzenie: każdy
# z prawem zapisu do bucketu może zaszyfrować własny „backup" naszym kluczem publicznym.
# Klucz HMAC (64 hex) leży na serwerze (backup go potrzebuje) i w menedżerze haseł;
# ktoś, kto ma tylko dostęp do bucketu, podpisu nie podrobi. Klucz nie trafia do argv.
podpis_hmac() {
	local plik=$1 klucz_plik=$2
	KLUCZ_PLIK=$klucz_plik PLIK_DANYCH=$plik python3 - <<'PY'
import hashlib, hmac, os, re, sys
k = open(os.environ["KLUCZ_PLIK"]).read().strip()
if not re.fullmatch(r"[0-9a-fA-F]{64}", k):
    sys.exit("klucz HMAC musi mieć 64 znaki hex (openssl rand -hex 32)")
h = hmac.new(bytes.fromhex(k), digestmod=hashlib.sha256)
with open(os.environ["PLIK_DANYCH"], "rb") as f:
    for blok in iter(lambda: f.read(1 << 20), b""):
        h.update(blok)
print(h.hexdigest())
PY
}

# sprawdz_archiwum_obrazow TGZ: tylko zwykłe pliki i katalogi pod obrazy/, bez ścieżek
# absolutnych, bez `..`, bez linków i plików specjalnych (archiwum z bucketu to dane
# z zewnątrz, a restore działa jako root).
sprawdz_archiwum_obrazow() {
	local tgz=$1 typy nazwy
	typy=$(tar -tvzf "$tgz" | cut -c1 | sort -u | tr -d '\n')
	[[ -z ${typy//[-d]/} ]] || zgin "archiwum obrazów zawiera wpisy typu '${typy//[-d]/}' (linki/urządzenia): odrzucone"
	nazwy=$(tar -tzf "$tgz")
	if grep -vE '^obrazy(/[A-Za-z0-9._-]+)*/?$' <<<"$nazwy" | grep -v '^$' >/dev/null; then
		zgin "archiwum obrazów zawiera ścieżki spoza obrazy/: odrzucone"
	fi
	if grep -E '(^|/)\.\.?(/|$)' <<<"$nazwy" >/dev/null; then
		zgin "archiwum obrazów zawiera '.' lub '..' w ścieżce: odrzucone"
	fi
}
