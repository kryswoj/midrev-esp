#!/usr/bin/env bash
# midrev-esp: codzienny backup produkcji. Uruchamia go midrev-esp-backup.timer (root).
#
# Co robi, po kolei (każdy krok przerywa całość przy błędzie):
#  1. pg_dump -Fc bazy produkcyjnej przez `docker exec` (spójny zrzut w jednej transakcji),
#  2. weryfikacja zrzutu: rozmiar > próg, pg_restore --list, obecność kluczowych tabel,
#  3. PRÓBNE ODTWORZENIE zrzutu do tymczasowej bazy w tym samym kontenerze i porównanie
#     liczby wierszy tabel kontrolnych (zgody, wykluczenia, nagrobki RODO) z produkcją;
#     baza tymczasowa jest usuwana. Backup, którego nikt nie odtworzył, nie jest backupem,
#  4. tar katalogu shared/var/obrazy (var/importy to pliki przejściowe z danymi osobowymi:
#     nie trafiają do kopii),
#  5. manifest (sumy SHA-256, liczby wierszy, wersja kodu), całość w jeden tar,
#  6. szyfrowanie `age` KLUCZEM PUBLICZNYM (odbiorcy z pliku). Klucz prywatny NIE istnieje
#     na serwerze: kradzież serwera albo bucketu nie daje dostępu do kopii,
#  7. wysyłka rclone poza serwer: daily/ zawsze, weekly/ pierwszy udany backup danego
#     tygodnia ISO (tydzień bez kopii tygodniowej nie zdarzy się przez jeden zły dzień),
#     sprawdzenie rozmiaru po stronie zdalnej,
#  8. retencja PO LICZBIE (14 dziennych, 8 tygodniowych), nie po dacie: gdy backup
#     przestanie działać, stare kopie nie znikną same,
#  9. znacznik ostatniego sukcesu (czyta go healthcheck), alert „ok" raz w tygodniu,
#     alert „krytyczny" przy każdym błędzie. Opcjonalny ping zewnętrzny (dead man's switch).
#
# Konfiguracja: $BACKUP_ENV_FILE (domyślnie /srv/midrev-esp/shared/env/backup.env, 600).
# Test na sucho: wszystkie ścieżki i nazwy da się nadpisać (patrz backup.env.example).

set -euo pipefail
umask 077

SKRYPT_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=lib/wspolne.sh
. "$SKRYPT_DIR/../lib/wspolne.sh"

# Pułapka EXIT ustawiona NAJPIERW: także błąd konfiguracji (złe prawa pliku, brak klucza)
# ma skończyć się alertem, a nie cichym wpisem w journalu.
KROK=konfiguracja
ZAKONCZONE=0
STAGING=""
ZNACZNIK_DIR=/var/lib/midrev-esp-backup
po_wyjsciu() {
	local kod=$1
	trap - EXIT
	set +e
	# baza próbna nie może zostać (miejsce na dysku, dane osobowe w dodatkowej kopii)
	if [[ ${BAZA_PROBNA_UTWORZONA:-0} == 1 ]]; then
		db_psql postgres "drop database if exists \"$BAZA_PROBNA\" with (force)" >/dev/null
	fi
	[[ -n ${STAGING:-} && -d $STAGING ]] && rm -rf "$STAGING"
	if [[ $kod != 0 || $ZAKONCZONE != 1 ]]; then
		blad "backup NIEUDANY w kroku '$KROK' (kod $kod)"
		wyslij_alert krytyczny "Backup NIEUDANY w kroku '$KROK' (kod $kod)${OSTATNI_BLAD:+: $OSTATNI_BLAD}. Ostatni udany: $(cat "$ZNACZNIK_DIR/ostatni-ok" 2>/dev/null || echo nigdy). journalctl -u midrev-esp-backup"
		[[ $kod != 0 ]] || kod=1
	fi
	exit "$kod"
}
trap 'po_wyjsciu $?' EXIT

BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-$ESP_ROOT/shared/env/backup.env}
wymagaj_uprawnien_600 "$BACKUP_ENV_FILE"
# restore w toku = czekamy do godziny, potem błąd z alertem
zablokuj_baze 3600
cfg() { czytaj_zmienna "$BACKUP_ENV_FILE" "$1"; }

RCLONE_REMOTE=$(cfg RCLONE_REMOTE)            # np. b2-midrev:midrev-esp-backup
RCLONE_CONFIG_FILE=$(cfg RCLONE_CONFIG)       # plik konfiguracji rclone (600)
AGE_RECIPIENTS_FILE=$(cfg AGE_RECIPIENTS_FILE)
PRZYROSTEK=$(cfg NAZWA_PRZYROSTEK)            # np. "prod"; część nazwy pliku
MIN_DUMP_BAJTOW=$(cfg MIN_DUMP_BAJTOW)
MIN_TABEL=$(cfg MIN_TABEL)
ZOSTAW_DZIENNYCH=$(cfg ZOSTAW_DZIENNYCH)
ZOSTAW_TYGODNIOWYCH=$(cfg ZOSTAW_TYGODNIOWYCH)
ZOSTAW_LOKALNYCH=$(cfg ZOSTAW_LOKALNYCH)
PROBNE_ODTWORZENIE=$(cfg PROBNE_ODTWORZENIE)
RETENCJA_ZDALNA=$(cfg RETENCJA_ZDALNA)
PING_URL=$(cfg PING_URL)
KATALOG_BACKUPU=$(cfg KATALOG_BACKUPU)
ZNACZNIK_DIR=$(cfg ZNACZNIK_DIR)
AGE_BIN=$(cfg AGE_BIN)
KOD_DIR=$(cfg KOD_DIR)
HMAC_KEY_FILE=$(cfg HMAC_KEY_FILE)

: "${PRZYROSTEK:=prod}" "${MIN_DUMP_BAJTOW:=20000}" "${MIN_TABEL:=40}"
: "${ZOSTAW_DZIENNYCH:=14}" "${ZOSTAW_TYGODNIOWYCH:=8}" "${ZOSTAW_LOKALNYCH:=2}"
: "${PROBNE_ODTWORZENIE:=1}" "${RETENCJA_ZDALNA:=0}" "${KATALOG_BACKUPU:=/var/backups/midrev-esp}"
: "${ZNACZNIK_DIR:=/var/lib/midrev-esp-backup}" "${AGE_BIN:=age}"
: "${RCLONE_CONFIG_FILE:=$ESP_ROOT/shared/env/rclone.conf}"
: "${HMAC_KEY_FILE:=$ESP_ROOT/shared/env/backup-hmac.key}"
: "${KOD_DIR:=$ESP_ROOT/current}"

[[ -n $RCLONE_REMOTE ]] || zgin "RCLONE_REMOTE nie ustawiony w $BACKUP_ENV_FILE"
[[ $RCLONE_REMOTE == *:* ]] || zgin "RCLONE_REMOTE musi mieć postać nazwa:ścieżka"
[[ -n $AGE_RECIPIENTS_FILE && -s $AGE_RECIPIENTS_FILE ]] || zgin "brak pliku odbiorców age ($AGE_RECIPIENTS_FILE)"
grep -q 'AGE-SECRET-KEY' "$AGE_RECIPIENTS_FILE" && zgin "$AGE_RECIPIENTS_FILE zawiera KLUCZ PRYWATNY. Na serwerze ma być tylko publiczny (age1...)"
grep -qE '^age1[0-9a-z]+' "$AGE_RECIPIENTS_FILE" || zgin "$AGE_RECIPIENTS_FILE nie zawiera klucza publicznego age1..."
# Konfiguracja rclone poza /root (unit ma ProtectHome=read-only, a rclone przy
# odświeżaniu tokenu OAuth przepisuje plik).
wymagaj_uprawnien_600 "$RCLONE_CONFIG_FILE"
wymagaj_uprawnien_600 "$HMAC_KEY_FILE"
command -v python3 >/dev/null || zgin "brak python3 (podpis HMAC)"
command -v "$AGE_BIN" >/dev/null || zgin "brak programu age ($AGE_BIN)"
command -v rclone >/dev/null || zgin "brak rclone"
command -v jq >/dev/null || zgin "brak jq"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAZWA=midrev-esp-$PRZYROSTEK-$STAMP.tar.age
STAGING=$KATALOG_BACKUPU/staging/$STAMP
LOKALNE=$KATALOG_BACKUPU/lokalne
BAZA=$(db_nazwa)
BAZA_PROBNA=${BAZA}_backup_check


install -d -m 700 "$STAGING" "$LOKALNE" "$ZNACZNIK_DIR"
chmod 755 "$ZNACZNIK_DIR"

# ---------------------------------------------------------------------------
KROK=pg_dump
db_gotowa || zgin "baza nie odpowiada ($ESP_DB_CONTAINER)"
# backup ma zrzucać bazę, której naprawdę używa aplikacja (DATABASE_URL), nie tylko db.env
if [[ -f $ESP_ENV_FILE ]]; then
	sprawdz_zgodnosc_bazy
else
	zgin "brak $ESP_ENV_FILE: nie mogę sprawdzić, czy zrzucam bazę aplikacji"
fi
log "pg_dump $BAZA"
docker exec "$ESP_DB_CONTAINER" pg_dump -U "$(db_uzytkownik)" -d "$BAZA" -Fc -Z 6 >"$STAGING/baza.dump"
# liczby wierszy możliwie blisko zrzutu (zapisy w międzyczasie = różnica w próbnym odtworzeniu,
# dlatego porównanie dopuszcza tylko wzrost po stronie produkcji, nie spadek)
LICZBY_PROD=$(liczby_wierszy "$BAZA")

KROK=weryfikacja_zrzutu
ROZMIAR=$(stat -c %s "$STAGING/baza.dump")
((ROZMIAR >= MIN_DUMP_BAJTOW)) || zgin "zrzut ma $ROZMIAR B, próg $MIN_DUMP_BAJTOW B"
docker exec -i "$ESP_DB_CONTAINER" pg_restore --list <"$STAGING/baza.dump" >"$STAGING/lista.txt"
TABEL=$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ TABLE ' "$STAGING/lista.txt" || true)
((TABEL >= MIN_TABEL)) || zgin "zrzut ma $TABEL tabel, próg $MIN_TABEL"
for t in schema_migrations consents suppressions tenant_suppressions; do
	grep -qE "TABLE DATA public $t " "$STAGING/lista.txt" || zgin "w zrzucie brak danych tabeli $t"
done
log "zrzut: $ROZMIAR B, $TABEL tabel"

# ---------------------------------------------------------------------------
if [[ $PROBNE_ODTWORZENIE == 1 ]]; then
	KROK=probne_odtworzenie
	[[ $BAZA_PROBNA != "$BAZA" ]] || zgin "nazwa bazy próbnej równa produkcyjnej"
	db_psql postgres "drop database if exists \"$BAZA_PROBNA\" with (force)" >/dev/null
	db_psql postgres "create database \"$BAZA_PROBNA\"" >/dev/null
	BAZA_PROBNA_UTWORZONA=1
	docker exec -i "$ESP_DB_CONTAINER" pg_restore -U "$(db_uzytkownik)" -d "$BAZA_PROBNA" \
		--no-owner --exit-on-error --single-transaction <"$STAGING/baza.dump"
	LICZBY_PROBA=$(liczby_wierszy "$BAZA_PROBNA")
	# każda tabela: odtworzona <= produkcja (produkcja mogła urosnąć po zrzucie) i nie
	# mniej niż 0; tabela obecna w produkcji musi być obecna w odtworzeniu
	ROZJAZD=$(jq -rn --argjson p "$LICZBY_PROD" --argjson r "$LICZBY_PROBA" '
		[$p | to_entries[] | select(.value != null)
		 | select(($r[.key] == null) or ($r[.key] > .value))
		 | "\(.key): prod=\(.value) odtworzone=\($r[.key])"] | join(", ")')
	[[ -z $ROZJAZD ]] || zgin "próbne odtworzenie nie zgadza się z produkcją: $ROZJAZD"
	db_psql postgres "drop database \"$BAZA_PROBNA\" with (force)" >/dev/null
	BAZA_PROBNA_UTWORZONA=0
	log "próbne odtworzenie OK: $LICZBY_PROBA"
else
	LICZBY_PROBA=null
	ostrzezenie "próbne odtworzenie wyłączone (PROBNE_ODTWORZENIE=0)"
fi

# ---------------------------------------------------------------------------
KROK=pliki
VAR_DIR=$ESP_ROOT/shared/var
# katalog zakłada provision.sh; jego brak to zła konfiguracja, a nie „pusta biblioteka"
[[ -d $VAR_DIR/obrazy ]] || zgin "brak $VAR_DIR/obrazy (provision.sh zakłada ten katalog)"
tar -C "$VAR_DIR" -czf "$STAGING/obrazy.tgz" obrazy
# te same reguły co w restore: backup, którego restore odmówi, nie może zostać wysłany jako „OK"
sprawdz_archiwum_obrazow "$STAGING/obrazy.tgz"
tar -tzf "$STAGING/obrazy.tgz" >/dev/null
PLIKOW=$(tar -tzf "$STAGING/obrazy.tgz" | grep -vc '/$' || true)

KROK=manifest
REWIZJA=$(cat "$KOD_DIR/REVISION" 2>/dev/null || echo nieznana)
jq -n \
	--arg stamp "$STAMP" --arg baza "$BAZA" --arg rewizja "$REWIZJA" \
	--arg host "$(hostname -f 2>/dev/null || hostname)" \
	--arg sha_dump "$(sha256sum "$STAGING/baza.dump" | cut -d' ' -f1)" \
	--arg sha_obrazy "$(sha256sum "$STAGING/obrazy.tgz" | cut -d' ' -f1)" \
	--argjson rozmiar "$ROZMIAR" --argjson tabel "$TABEL" --argjson plikow "$PLIKOW" \
	--argjson liczby "$LICZBY_PROD" --argjson odtworzone "$LICZBY_PROBA" \
	--arg pg "$(docker exec "$ESP_DB_CONTAINER" postgres --version)" \
	'{format: 1, stamp: $stamp, host: $host, baza: $baza, wersja_postgres: $pg,
	  rewizja_kodu: $rewizja, pliki: {"baza.dump": {sha256: $sha_dump, bajtow: $rozmiar, tabel: $tabel},
	  "obrazy.tgz": {sha256: $sha_obrazy, plikow: $plikow}},
	  liczby_wierszy_produkcja: $liczby, liczby_wierszy_probne_odtworzenie: $odtworzone}' \
	>"$STAGING/manifest.json"

KROK=szyfrowanie
tar -C "$STAGING" -cf - manifest.json baza.dump obrazy.tgz |
	"$AGE_BIN" --encrypt -R "$AGE_RECIPIENTS_FILE" -o "$STAGING/$NAZWA"
# nagłówek age potwierdza, że plik jest szyfrogramem, a nie np. pustym wyjściem
head -c 64 "$STAGING/$NAZWA" | grep 'age-encryption.org/v1' >/dev/null || zgin "plik wynikowy nie wygląda na szyfrogram age"
ROZMIAR_ZASZ=$(stat -c %s "$STAGING/$NAZWA")
# podpis pochodzenia (restore odmawia produkcji bez poprawnego podpisu)
podpis_hmac "$STAGING/$NAZWA" "$HMAC_KEY_FILE" >"$STAGING/$NAZWA.sig"
[[ $(wc -c <"$STAGING/$NAZWA.sig") == 65 ]] || zgin "podpis HMAC ma zły format"
# jawne kopie usuwamy od razu, zanim cokolwiek pójdzie w sieć
rm -f "$STAGING/baza.dump" "$STAGING/obrazy.tgz" "$STAGING/lista.txt"

# ---------------------------------------------------------------------------
KROK=wysylka
rclone_cmd() { rclone --config "$RCLONE_CONFIG_FILE" --retries 3 --low-level-retries 10 --stats 0 "$@"; }
# najpierw podpis, potem plik: obecność .tar.age w buckecie oznacza, że .sig już tam jest
rclone_cmd copyto "$STAGING/$NAZWA.sig" "$RCLONE_REMOTE/daily/$NAZWA.sig"
rclone_cmd copyto "$STAGING/$NAZWA" "$RCLONE_REMOTE/daily/$NAZWA"
ZDALNY_ROZMIAR=$(rclone_cmd lsjson "$RCLONE_REMOTE/daily/$NAZWA" | jq -r '.[0].Size // -1')
[[ $ZDALNY_ROZMIAR == "$ROZMIAR_ZASZ" ]] || zgin "rozmiar po stronie zdalnej ($ZDALNY_ROZMIAR) != lokalny ($ROZMIAR_ZASZ)"
log "wysłano $RCLONE_REMOTE/daily/$NAZWA ($ROZMIAR_ZASZ B)"

TYDZIEN=$(date -u +%G-W%V)
TYGODNIOWY=0
# katalog weekly/ może jeszcze nie istnieć (pierwszy backup): wtedy lista jest pusta
LISTA_TYG=$(rclone_cmd lsf --files-only "$RCLONE_REMOTE/weekly/" 2>/dev/null) || LISTA_TYG=""
# tydzień „zajęty" tylko przez komplet: plik + podpis
TYG_KOMPLET=0
while read -r f; do
	[[ -n $f ]] || continue
	grep -qxF "$f.sig" <<<"$LISTA_TYG" && TYG_KOMPLET=1
done < <(grep -E "^midrev-esp-$PRZYROSTEK-.*-$TYDZIEN\.tar\.age$" <<<"$LISTA_TYG" || true)
if [[ $TYG_KOMPLET == 0 ]]; then
	TYGODNIOWY=1
	NAZWA_TYG=${NAZWA%.tar.age}-$TYDZIEN.tar.age
	rclone_cmd copyto "$STAGING/$NAZWA.sig" "$RCLONE_REMOTE/weekly/$NAZWA_TYG.sig"
	rclone_cmd copyto "$STAGING/$NAZWA" "$RCLONE_REMOTE/weekly/$NAZWA_TYG"
	ZDALNY_TYG=$(rclone_cmd lsjson "$RCLONE_REMOTE/weekly/$NAZWA_TYG" | jq -r '.[0].Size // -1')
	[[ $ZDALNY_TYG == "$ROZMIAR_ZASZ" ]] || zgin "kopia tygodniowa: rozmiar zdalny $ZDALNY_TYG != $ROZMIAR_ZASZ"
	log "kopia tygodniowa $NAZWA_TYG"
fi

# lokalna kopia (TEN SAM dysk: tylko do szybkiego odtworzenia, NIE jest backupem)
mv "$STAGING/$NAZWA" "$LOKALNE/$NAZWA"
mv "$STAGING/$NAZWA.sig" "$LOKALNE/$NAZWA.sig"

# ---------------------------------------------------------------------------
KROK=retencja
przytnij_zdalne() {
	local kat=$1 zostaw=$2 lista pliki do_usuniecia
	# błąd listowania = błąd backupu (nie „nic do usunięcia")
	lista=$(rclone_cmd lsf --files-only "$RCLONE_REMOTE/$kat/")
	pliki=$(grep -E "^midrev-esp-$PRZYROSTEK-[0-9]{8}T[0-9]{6}Z.*\.tar\.age$" <<<"$lista" | sort) || pliki=""
	do_usuniecia=$(head -n -"$zostaw" <<<"$pliki")
	while read -r p; do
		[[ -n $p ]] || continue
		log "retencja: usuwam $kat/$p"
		rclone_cmd deletefile "$RCLONE_REMOTE/$kat/$p"
		rclone_cmd deletefile "$RCLONE_REMOTE/$kat/$p.sig" 2>/dev/null || ostrzezenie "brak podpisu $kat/$p.sig do usunięcia"
	done <<<"$do_usuniecia"
}
if [[ $RETENCJA_ZDALNA == 1 ]]; then
	przytnij_zdalne daily "$ZOSTAW_DZIENNYCH"
	przytnij_zdalne weekly "$ZOSTAW_TYGODNIOWYCH"
else
	log "retencja zdalna wyłączona (RETENCJA_ZDALNA=0: np. bucket z regułą cyklu życia / bez prawa usuwania)"
fi
find "$LOKALNE" -maxdepth 1 -name "midrev-esp-$PRZYROSTEK-*.tar.age" -printf '%f\n' | sort | head -n -"$ZOSTAW_LOKALNYCH" |
	while read -r p; do rm -f "$LOKALNE/$p" "$LOKALNE/$p.sig"; done

# ---------------------------------------------------------------------------
KROK=raport
ZAKONCZONE=1
printf '%s %s\n' "$STAMP" "$NAZWA" >"$ZNACZNIK_DIR/ostatni-ok.tmp"
mv "$ZNACZNIK_DIR/ostatni-ok.tmp" "$ZNACZNIK_DIR/ostatni-ok"
chmod 644 "$ZNACZNIK_DIR/ostatni-ok"
PODSUMOWANIE="Backup OK: $NAZWA, zrzut $ROZMIAR B / $TABEL tabel, obrazów $PLIKOW, szyfrogram $ROZMIAR_ZASZ B, tygodniowy=$TYGODNIOWY, liczby: $LICZBY_PROD"
log "$PODSUMOWANIE"
if [[ -n $PING_URL ]]; then
	curl -fsS -m 15 --retry 2 -o /dev/null --config <(printf 'url = "%s"\n' "$PING_URL") || ostrzezenie "ping zewnętrzny (PING_URL) nie doszedł"
fi
if [[ $TYGODNIOWY == 1 ]]; then
	# raz w tygodniu „żyję": brak tej wiadomości w poniedziałek = sprawdzić timer
	wyslij_alert info "$PODSUMOWANIE" || ostrzezenie "tygodniowy raport OK nie doszedł"
fi
