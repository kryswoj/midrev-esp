#!/usr/bin/env bash
# midrev-esp: odtworzenie backupu (plik .tar.age z backup.sh).
#
# DOMYŚLNIE odtwarza do NOWEJ, osobnej bazy `midrev_esp_restore_test` w kontenerze
# produkcyjnym i rozpakowuje obrazy do osobnego katalogu. Produkcji nie dotyka.
# To jest też comiesięczny test odtworzenia (README, sekcja 6.3).
#
# Użycie:
#   restore.sh --klucz <plik-klucza-age> (--plik <x.tar.age> | --zdalny <remote:ścieżka> | --najnowszy)
#              [--baza <nazwa>] [--obrazy-do <katalog>] [--na-produkcje]
#
#   --klucz        plik z kluczem PRYWATNYM age (AGE-SECRET-KEY-...). Klucz nie mieszka na
#                  serwerze: wgraj go na czas odtworzenia do /dev/shm (RAM) i usuń po.
#   --plik         lokalny plik backupu
#   --zdalny       ścieżka rclone, np. b2-midrev:midrev-esp-backup/daily/midrev-esp-prod-....tar.age
#   --najnowszy    najnowszy plik z $RCLONE_REMOTE/daily/ (backup.env)
#   --baza         baza docelowa (domyślnie midrev_esp_restore_test). Baza produkcyjna
#                  wyłącznie z --na-produkcje. Istniejąca baza inna niż domyślna testowa = odmowa.
#   --obrazy-do    dokąd rozpakować obrazy (domyślnie /var/backups/midrev-esp/restore-<czas>/var)
#   --klucz-podpisu plik z kluczem HMAC backupu (64 hex; domyślnie HMAC_KEY_FILE z backup.env).
#                  Podpis <plik>.sig jest sprawdzany ZAWSZE, gdy klucz jest dostępny; przy
#                  --na-produkcje brak klucza albo zły podpis = odmowa.
#   --na-produkcje NADPISANIE PRODUKCJI. Wymaga: zatrzymanego panelu i workera, wpisania
#                  z klawiatury nazwy bazy i słowa NADPISUJE, świeżego zrzutu bezpieczeństwa
#                  obecnego stanu (robi go skrypt). WYMAGA ZGODY KRYSTIANA.
#
# Skrypt NIGDY nie uruchamia panelu ani workera po odtworzeniu produkcji: najpierw trzeba
# wprowadzić wypisy z luki (README 6.4), potem start ręcznie.

set -euo pipefail
umask 077

SKRYPT_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=lib/wspolne.sh
. "$SKRYPT_DIR/../lib/wspolne.sh"

BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-$ESP_ROOT/shared/env/backup.env}
DOMYSLNA_BAZA=midrev_esp_restore_test
KLUCZ_PODPISU="" KLUCZ="" PLIK="" ZDALNY="" NAJNOWSZY=0 CEL="" OBRAZY_DO="" NA_PRODUKCJE=0
while (($#)); do
	case $1 in
		--klucz) KLUCZ=${2:?}; shift 2 ;;
		--klucz-podpisu) KLUCZ_PODPISU=${2:?}; shift 2 ;;
		--plik) PLIK=${2:?}; shift 2 ;;
		--zdalny) ZDALNY=${2:?}; shift 2 ;;
		--najnowszy) NAJNOWSZY=1; shift ;;
		--baza) CEL=${2:?}; shift 2 ;;
		--obrazy-do) OBRAZY_DO=${2:?}; shift 2 ;;
		--na-produkcje) NA_PRODUKCJE=1; shift ;;
		-h | --help) sed -n '2,27p' "$0"; exit 0 ;;
		*) zgin "nieznana opcja: $1 (--help)" ;;
	esac
done

cfg() { czytaj_zmienna "$BACKUP_ENV_FILE" "$1"; }
AGE_BIN=$(cfg AGE_BIN)
: "${AGE_BIN:=age}"
RCLONE_CONFIG_FILE=$(cfg RCLONE_CONFIG)
: "${RCLONE_CONFIG_FILE:=$ESP_ROOT/shared/env/rclone.conf}"
KATALOG_BACKUPU=$(cfg KATALOG_BACKUPU)
: "${KATALOG_BACKUPU:=/var/backups/midrev-esp}"
if [[ -z $KLUCZ_PODPISU ]]; then
	KLUCZ_PODPISU=$(cfg HMAC_KEY_FILE)
	: "${KLUCZ_PODPISU:=$ESP_ROOT/shared/env/backup-hmac.key}"
	[[ -r $KLUCZ_PODPISU ]] || KLUCZ_PODPISU=""
fi

[[ -n $KLUCZ && -r $KLUCZ ]] || zgin "podaj --klucz <plik z AGE-SECRET-KEY>"
wymagaj_uprawnien_600 "$KLUCZ"
[[ -z $KLUCZ_PODPISU ]] || wymagaj_uprawnien_600 "$KLUCZ_PODPISU"
grep -q '^AGE-SECRET-KEY-' "$KLUCZ" || zgin "$KLUCZ nie zawiera klucza prywatnego age"
(( (${#PLIK} > 0) + (${#ZDALNY} > 0) + NAJNOWSZY == 1 )) || zgin "podaj dokładnie jedno: --plik, --zdalny albo --najnowszy"
command -v "$AGE_BIN" >/dev/null || zgin "brak age"

PROD=$(db_nazwa)
# na produkcji (i przy odtwarzaniu na nowym serwerze po sekcji 3 README) env aplikacji musi
# wskazywać tę samą bazę co db.env; bez production.env (np. test na innej maszynie) pomijamy
if [[ -f $ESP_ENV_FILE ]]; then
	sprawdz_zgodnosc_bazy
elif [[ $NA_PRODUKCJE == 1 ]]; then
	zgin "brak $ESP_ENV_FILE: nie nadpisuję produkcji bez sprawdzenia, której bazy używa aplikacja"
fi
: "${CEL:=$DOMYSLNA_BAZA}"
[[ $CEL =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || zgin "niepoprawna nazwa bazy: $CEL"
[[ $CEL != postgres && $CEL != template0 && $CEL != template1 ]] || zgin "baza systemowa $CEL: odmowa"

if [[ $CEL == "$PROD" && $NA_PRODUKCJE != 1 ]]; then
	zgin "$CEL to baza PRODUKCYJNA. Nadpisanie tylko z --na-produkcje (i zgodą Krystiana)."
fi
if [[ $NA_PRODUKCJE == 1 && $CEL != "$PROD" ]]; then
	zgin "--na-produkcje podane, ale --baza $CEL to nie produkcja ($PROD). Podaj --baza $PROD albo usuń flagę."
fi

# Warunki nadpisania produkcji sprawdzamy ZANIM cokolwiek pobierzemy i odszyfrujemy.
if [[ $NA_PRODUKCJE == 1 ]]; then
	[[ $(id -u) == 0 ]] || zgin "--na-produkcje tylko jako root"
	[[ -t 0 ]] || zgin "--na-produkcje wymaga interaktywnego terminala (potwierdzenie z klawiatury)"
	for u in midrev-esp-web.service midrev-esp-worker.service; do
		if systemctl is-active --quiet "$u"; then
			zgin "$u działa. Zatrzymaj panel i workera: systemctl stop midrev-esp-worker midrev-esp-web"
		fi
	done
fi

zablokuj_baze 0
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ROBOCZY=$KATALOG_BACKUPU/restore-$STAMP
install -d -m 700 "$ROBOCZY"
ZAKONCZONE=0
po_wyjsciu() {
	local kod=$1
	trap - EXIT
	set +e
	# produkcja: niedokończona baza robocza (przed zamianą nazw) nie może zostać
	if [[ -n ${BAZA_ROBOCZA:-} ]]; then
		db_psql postgres "drop database if exists \"$BAZA_ROBOCZA\" with (force)" >/dev/null
	fi
	[[ -n ${OBRAZY_NOWE:-} && -d $OBRAZY_NOWE ]] && rm -rf "$OBRAZY_NOWE"
	# jawne (odszyfrowane) pliki nie mogą zostać na dysku
	rm -f "$ROBOCZY/baza.dump" "$ROBOCZY/obrazy.tgz" "$ROBOCZY/backup.tar.age" "$ROBOCZY/backup.tar.age.sig"
	if [[ $kod != 0 || $ZAKONCZONE != 1 ]]; then
		blad "odtworzenie NIEUDANE (kod $kod). Katalog roboczy: $ROBOCZY"
		[[ $kod != 0 ]] || kod=1
	fi
	exit "$kod"
}
trap 'po_wyjsciu $?' EXIT

# ---------------------------------------------------------------------------
# 1. plik backupu
if [[ -n $PLIK ]]; then
	[[ -f $PLIK ]] || zgin "brak pliku $PLIK"
	ZRODLO=$PLIK
else
	command -v rclone >/dev/null || zgin "brak rclone"
	wymagaj_uprawnien_600 "$RCLONE_CONFIG_FILE"
	if [[ $NAJNOWSZY == 1 ]]; then
		REMOTE=$(cfg RCLONE_REMOTE)
		[[ -n $REMOTE ]] || zgin "RCLONE_REMOTE nie ustawiony w $BACKUP_ENV_FILE"
		PRZYROSTEK=$(cfg NAZWA_PRZYROSTEK)
		: "${PRZYROSTEK:=prod}"
		LISTA=$(rclone --config "$RCLONE_CONFIG_FILE" lsf --files-only "$REMOTE/daily/")
		# tylko pliki tej instancji (ten sam wzorzec nazwy co backup.sh), nie „cokolwiek .tar.age"
		# najnowszy KOMPLET (plik + podpis), gdy mamy czym sprawdzić podpis
		OSTATNI=""
		while read -r f; do
			[[ -n $f ]] || continue
			if [[ -z $KLUCZ_PODPISU ]] || grep -qxF "$f.sig" <<<"$LISTA"; then OSTATNI=$f; fi
		done < <(grep -E "^midrev-esp-$PRZYROSTEK-[0-9]{8}T[0-9]{6}Z\.tar\.age$" <<<"$LISTA" | sort || true)
		[[ -n $OSTATNI ]] || zgin "brak plików w $REMOTE/daily/"
		ZDALNY=$REMOTE/daily/$OSTATNI
	fi
	log "pobieram $ZDALNY"
	rclone --config "$RCLONE_CONFIG_FILE" --stats 0 copyto "$ZDALNY" "$ROBOCZY/backup.tar.age"
	# podpis może nie istnieć (backupy sprzed podpisów): o tym decyduje weryfikacja niżej
	rclone --config "$RCLONE_CONFIG_FILE" --stats 0 copyto "$ZDALNY.sig" "$ROBOCZY/backup.tar.age.sig" 2>/dev/null ||
		ostrzezenie "brak pliku podpisu $ZDALNY.sig"
	ZRODLO=$ROBOCZY/backup.tar.age
fi
log "źródło: $ZRODLO"

# 1b. pochodzenie: HMAC pliku kluczem, którego nie ma w buckecie
PODPIS_OK=0
if [[ -n $KLUCZ_PODPISU ]]; then
	[[ -s $ZRODLO.sig ]] || zgin "brak podpisu $ZRODLO.sig, a klucz podpisu jest dostępny: odmowa"
	[[ $(podpis_hmac "$ZRODLO" "$KLUCZ_PODPISU") == "$(tr -d ' \n' <"$ZRODLO.sig")" ]] ||
		zgin "podpis HMAC backupu NIEPOPRAWNY: plik nie pochodzi z naszego backupu albo został zmieniony"
	PODPIS_OK=1
	log "podpis HMAC poprawny"
elif [[ $NA_PRODUKCJE == 1 ]]; then
	zgin "--na-produkcje wymaga weryfikacji podpisu: podaj --klucz-podpisu (klucz HMAC z menedżera haseł)"
else
	ostrzezenie "brak klucza podpisu: pochodzenie backupu NIE zostało sprawdzone (dopuszczalne tylko przy teście)"
fi

# 2. odszyfrowanie i rozpakowanie (manifest, zrzut, obrazy)
"$AGE_BIN" --decrypt -i "$KLUCZ" "$ZRODLO" | tar -x -C "$ROBOCZY" manifest.json baza.dump obrazy.tgz
for f in manifest.json baza.dump obrazy.tgz; do [[ -s $ROBOCZY/$f ]] || zgin "w backupie brak $f"; done
jq -e '.format == 1' "$ROBOCZY/manifest.json" >/dev/null || zgin "nieznany format manifestu"
[[ $(sha256sum "$ROBOCZY/baza.dump" | cut -d' ' -f1) == "$(jq -r '.pliki["baza.dump"].sha256' "$ROBOCZY/manifest.json")" ]] || zgin "suma SHA-256 zrzutu nie zgadza się z manifestem"
[[ $(sha256sum "$ROBOCZY/obrazy.tgz" | cut -d' ' -f1) == "$(jq -r '.pliki["obrazy.tgz"].sha256' "$ROBOCZY/manifest.json")" ]] || zgin "suma SHA-256 obrazów nie zgadza się z manifestem"
log "manifest: $(jq -c '{stamp, baza, rewizja_kodu, wersja_postgres}' "$ROBOCZY/manifest.json")"
if [[ $NA_PRODUKCJE == 1 && $(jq -r '.baza' "$ROBOCZY/manifest.json") != "$PROD" ]]; then
	zgin "backup dotyczy bazy '$(jq -r '.baza' "$ROBOCZY/manifest.json")', a produkcja to '$PROD': to nie jest backup tej instancji"
fi
docker exec -i "$ESP_DB_CONTAINER" pg_restore --list <"$ROBOCZY/baza.dump" | grep 'TABLE DATA public schema_migrations' >/dev/null ||
	zgin "zrzut nie przechodzi pg_restore --list"

# ---------------------------------------------------------------------------
# 3. baza docelowa
# Produkcja: odtwarzamy do NOWEJ bazy obok, weryfikujemy, dopiero potem zamiana nazw.
# Błąd pg_restore, brak miejsca albo przerwanie w połowie zostawia produkcję nietkniętą.
ISTNIEJE=$(db_psql postgres "select count(*) from pg_database where datname = '$CEL'")
STAMP_MALY=${STAMP,,}
ZABEZP=brak
if [[ $NA_PRODUKCJE == 1 ]]; then
	RESTORE_DO=${CEL}_nowa_$STAMP_MALY
	STARA=${CEL}_przed_restore_$STAMP_MALY
	((${#STARA} <= 63)) || zgin "nazwa $STARA dłuższa niż 63 znaki"
	echo
	echo "!!! NADPISANIE PRODUKCJI: baza $CEL zostanie zastąpiona backupem z $(jq -r '.stamp' "$ROBOCZY/manifest.json")."
	echo "!!! Wszystko po tej chwili (wypisy, zgody, wysyłki) zniknie z bazy produkcyjnej."
	echo "!!! Obecna baza zostanie przemianowana na $STARA (nie jest usuwana)."
	read -r -p "Wpisz nazwę bazy ($CEL): " odp1
	[[ $odp1 == "$CEL" ]] || zgin "nazwa się nie zgadza, przerwane"
	read -r -p "Wpisz NADPISUJE: " odp2
	[[ $odp2 == NADPISUJE ]] || zgin "przerwane"
	if [[ $ISTNIEJE == 1 ]]; then
		TABEL_W_PROD=$(db_psql "$CEL" "select count(*) from pg_tables where schemaname = 'public'")
		ZABEZP=$KATALOG_BACKUPU/przed-restore-$STAMP.dump
		log "zrzut bezpieczeństwa obecnej produkcji ($TABEL_W_PROD tabel): $ZABEZP"
		docker exec "$ESP_DB_CONTAINER" pg_dump -U "$(db_uzytkownik)" -d "$CEL" -Fc >"$ZABEZP"
		docker exec -i "$ESP_DB_CONTAINER" pg_restore --list <"$ZABEZP" >"$ROBOCZY/lista-zabezp.txt"
		# baza z danymi: zrzut musi mieć schemat aplikacji; pusta baza (nowy serwer) nie ma czego chronić
		if ((TABEL_W_PROD > 0)); then
			grep 'TABLE DATA public schema_migrations' "$ROBOCZY/lista-zabezp.txt" >/dev/null ||
				zgin "zrzut bezpieczeństwa niekompletny: NIE nadpisuję"
		fi
	else
		log "baza $CEL nie istnieje (nowy serwer?): powstanie z backupu"
	fi
else
	RESTORE_DO=$CEL
	if [[ $ISTNIEJE == 1 ]]; then
		if [[ $CEL == "$DOMYSLNA_BAZA" ]]; then
			log "usuwam poprzednią bazę testową $CEL"
			db_psql postgres "drop database \"$CEL\" with (force)" >/dev/null
		else
			zgin "baza $CEL już istnieje. Odtwarzam tylko do NOWEJ bazy (albo domyślnej $DOMYSLNA_BAZA)."
		fi
	fi
fi
[[ $(db_psql postgres "select count(*) from pg_database where datname = '$RESTORE_DO'") == 0 ]] ||
	zgin "baza robocza $RESTORE_DO już istnieje"
db_psql postgres "create database \"$RESTORE_DO\"" >/dev/null
if [[ $NA_PRODUKCJE == 1 ]]; then BAZA_ROBOCZA=$RESTORE_DO; fi
log "pg_restore -> $RESTORE_DO"
docker exec -i "$ESP_DB_CONTAINER" pg_restore -U "$(db_uzytkownik)" -d "$RESTORE_DO" \
	--no-owner --exit-on-error --single-transaction <"$ROBOCZY/baza.dump"

# 4. weryfikacja liczby wierszy. Manifest ma liczby z PRÓBNEGO odtworzenia (dokładny stan
#    zrzutu) -> wymagamy równości. Bez próbnego odtworzenia są tylko liczby z produkcji
#    tuż po zrzucie (mogły urosnąć) -> wymagamy odtworzone <= produkcja i obecności tabel.
LICZBY=$(liczby_wierszy "$RESTORE_DO")
if [[ $(jq -r '.liczby_wierszy_probne_odtworzenie == null' "$ROBOCZY/manifest.json") == false ]]; then
	WZOR=$(jq -c '.liczby_wierszy_probne_odtworzenie' "$ROBOCZY/manifest.json") DOKLADNIE=true
else
	WZOR=$(jq -c '.liczby_wierszy_produkcja' "$ROBOCZY/manifest.json") DOKLADNIE=false
fi
ROZJAZD=$(jq -rn --argjson m "$WZOR" --argjson r "$LICZBY" --argjson dokl "$DOKLADNIE" '
	[$m | to_entries[] | select(.value != null)
	 | select(($r[.key] == null) or (if $dokl then $r[.key] != .value else $r[.key] > .value end))
	 | "\(.key): backup=\(.value) odtworzone=\($r[.key])"] | join(", ")')
[[ -z $ROZJAZD ]] || zgin "liczby wierszy po odtworzeniu nie zgadzają się: $ROZJAZD"
log "baza $RESTORE_DO odtworzona, liczby wierszy zgodne z backupem: $LICZBY"

# 4a. obrazy: walidacja archiwum i rozpakowanie do NOWEGO katalogu, jeszcze przed zamianą bazy
sprawdz_archiwum_obrazow "$ROBOCZY/obrazy.tgz"
if [[ $NA_PRODUKCJE == 1 ]]; then
	VAR=$ESP_ROOT/shared/var
	OBRAZY_NOWE=$VAR/.obrazy-nowe-$STAMP
	install -d -m 700 "$OBRAZY_NOWE"
	tar -xzf "$ROBOCZY/obrazy.tgz" -C "$OBRAZY_NOWE" --no-same-owner --no-same-permissions
	install -d -m 700 "$OBRAZY_NOWE/obrazy"
	chown -R midrev-esp:midrev-esp "$OBRAZY_NOWE"
else
	: "${OBRAZY_DO:=$ROBOCZY/var}"
	install -d -m 700 "$OBRAZY_DO"
	tar -xzf "$ROBOCZY/obrazy.tgz" -C "$OBRAZY_DO" --no-same-owner --no-same-permissions
fi

# 4b. produkcja: zamiana nazw (stara zostaje jako $STARA)
if [[ $NA_PRODUKCJE == 1 ]]; then
	for u in midrev-esp-web.service midrev-esp-worker.service; do
		! systemctl is-active --quiet "$u" || zgin "$u wystartował w międzyczasie: przerwane (produkcja nietknięta)"
	done
	if [[ $ISTNIEJE == 1 ]]; then
		db_psql postgres "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$CEL' and pid <> pg_backend_pid()" >/dev/null
		db_psql postgres "alter database \"$CEL\" rename to \"$STARA\"" >/dev/null
		log "dotychczasowa produkcja: $CEL -> $STARA"
	fi
	if ! db_psql postgres "alter database \"$RESTORE_DO\" rename to \"$CEL\"" >/dev/null; then
		# przywróć nazwę starej produkcji, zanim wyjdziemy
		[[ $ISTNIEJE == 1 ]] && db_psql postgres "alter database \"$STARA\" rename to \"$CEL\"" >/dev/null
		zgin "zamiana nazw nie powiodła się; produkcja przywrócona pod nazwą $CEL"
	fi
	BAZA_ROBOCZA=""
	log "backup jest teraz bazą $CEL"
fi

# 5. obrazy produkcji: dwie zmiany nazw w obrębie tego samego systemu plików
if [[ $NA_PRODUKCJE == 1 ]]; then
	if [[ -d $VAR/obrazy ]]; then
		mv "$VAR/obrazy" "$VAR/obrazy.przed-restore-$STAMP"
		log "dotychczasowe obrazy przeniesione do $VAR/obrazy.przed-restore-$STAMP"
	fi
	if ! mv "$OBRAZY_NOWE/obrazy" "$VAR/obrazy"; then
		# baza jest już podmieniona: cofamy WSZYSTKO, żeby produkcja nie została w pół drogi
		blad "podmiana katalogu obrazów nie powiodła się: cofam obrazy i bazę"
		[[ -d $VAR/obrazy.przed-restore-$STAMP && ! -e $VAR/obrazy ]] && mv "$VAR/obrazy.przed-restore-$STAMP" "$VAR/obrazy"
		db_psql postgres "alter database \"$CEL\" rename to \"$RESTORE_DO\"" >/dev/null
		[[ $ISTNIEJE == 1 ]] && db_psql postgres "alter database \"$STARA\" rename to \"$CEL\"" >/dev/null
		BAZA_ROBOCZA=$RESTORE_DO
		zgin "restore cofnięty: produkcja wróciła do stanu sprzed restore (baza i obrazy)"
	fi
	rmdir "$OBRAZY_NOWE" || ostrzezenie "nie usunięto pustego $OBRAZY_NOWE"
	OBRAZY_DO=$VAR/obrazy
fi
log "obrazy: $OBRAZY_DO ($(find "$OBRAZY_DO" -type f | wc -l) plików), podpis: $([[ $PODPIS_OK == 1 ]] && echo sprawdzony || echo NIESPRAWDZONY)"

ZAKONCZONE=1
echo
log "ODTWORZENIE OK: baza $CEL, backup z $(jq -r '.stamp' "$ROBOCZY/manifest.json")"
if [[ $NA_PRODUKCJE == 1 ]]; then
	cat <<EOF

DALEJ (ręcznie, w tej kolejności; README 6.4):
  1. Wypisy z luki: z logu Caddy link.midrev.pl (/u, od $(jq -r '.stamp' "$ROBOCZY/manifest.json") do teraz)
     wprowadzić wypisy PRZED startem workera.
  2. deploy.sh --lista: czy aktywne wydanie ma migracje zgodne z backupem (rewizja w manifeście:
     $(jq -r '.rewizja_kodu' "$ROBOCZY/manifest.json")).
  3. systemctl start midrev-esp-web  (sprawdzić panel), potem systemctl start midrev-esp-worker.
  Zrzut sprzed odtworzenia: $ZABEZP
  Dotychczasowa baza (do usunięcia ręcznie po kilku dniach): ${STARA:-brak}
EOF
else
	echo "Baza testowa $CEL zostaje do wglądu. Usunięcie: docker exec $ESP_DB_CONTAINER dropdb -U $(db_uzytkownik) $CEL"
fi
