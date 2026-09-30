#!/usr/bin/env bash
# midrev-esp: wdrożenie nowej wersji na produkcję (osobny VPS). Uruchamiać jako root.
# KAŻDE uruchomienie na produkcji WYMAGA ZGODY KRYSTIANA (README, sekcja 5).
#
# Użycie:
#   deploy.sh --ref <tag|sha|gałąź>        kod z lokalnego klonu $ESP_ROOT/repo.git (git fetch)
#   deploy.sh --archiwum <plik.tar.gz>     kod z archiwum `git archive` (bez klonu na serwerze)
#   deploy.sh --rollback [<release>]       wróć do poprzedniego (albo wskazanego) wydania
#   deploy.sh --lista                      pokaż wydania i które jest aktywne
#
# Opcje:
#   --wymus-w-trakcie-wysylki   pozwól wdrażać, gdy kampania jest w stanie `sending`
#   --bez-dumpa                 pomiń zrzut bazy przed migracjami (NIE zalecane)
#
# Przebieg (każdy krok przerywa całość przy błędzie; błędy nie są wyciszane):
#  1. blokada flock (dwa wdrożenia naraz = odmowa),
#  2. kontrole: env 600, baza zdrowa, dysk, brak wysyłki w toku,
#  3. nowy katalog releases/<UTC>, kod, `npm ci` (PEŁNE, z devDependencies: worker i
#     migracje chodzą przez tsx), `next build` jako użytkownik midrev-esp,
#  4. symlinki var -> shared/var, .next/cache -> shared/cache/next/<release>,
#     kod na własność root (aplikacja nie może zmienić własnego kodu),
#  5. zrzut bazy przed migracjami (przed-wdrozeniem/, 3 ostatnie),
#  6. stop workera (łagodny, SIGTERM), migracje z NOWEGO wydania,
#  7. przełączenie symlinka current (atomowo), start workera, restart panelu,
#  8. healthcheck /api/zdrowie + oba unity aktywne; porażka = automatyczny powrót
#     symlinka do poprzedniego wydania i restart.
#     MIGRACJI NIE COFAMY. Stary kod chodzi wtedy na nowym schemacie; jeśli migracja
#     była niekompatybilna, jedyna droga to odtworzenie zrzutu sprzed wdrożenia
#     (restore.sh, WYMAGA ZGODY),
#  9. sprzątanie: zostaje 5 najnowszych wydań (nigdy aktywne ani poprzednie).

set -euo pipefail

SKRYPT_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=lib/wspolne.sh
. "$SKRYPT_DIR/lib/wspolne.sh"

APP_USER=${APP_USER:-midrev-esp}
APP_HOME=${APP_HOME:-/var/lib/midrev-esp}
RELEASES=$ESP_ROOT/releases
CURRENT=$ESP_ROOT/current
REPO=${ESP_REPO:-$ESP_ROOT/repo.git}
ZOSTAW_WYDAN=5
ZOSTAW_DUMPOW=3
# Katalog z node/npm dla aplikacji (domyślnie systemowy /usr/bin; serwer współdzielony: /opt/node-24/bin)
NODE_DIR=${NODE_DIR:-/usr/bin}
# Skrypt działa jako root, a NODE_DIR trafia na początek PATH i jego node uruchamiamy.
# Dlatego: ścieżka bezwzględna bez ':', po kanonizacji (readlink -e) cała ścieżka od '/'
# oraz pliki node i npm (też po rozwiązaniu symlinków) należą do roota i nie są
# zapisywalne dla grupy/innych. Dopiero potem pierwsze uruchomienie node. Node >= 24.
sprawdz_sciezke_roota() {
	local cel=$1 kat
	[[ $(stat -c '%u' "$cel") == 0 ]] || { echo "$cel nie należy do roota" >&2; exit 1; }
	[[ $(( 8#$(stat -c '%a' "$cel") & 8#022 )) == 0 ]] || { echo "$cel jest zapisywalny dla grupy/innych" >&2; exit 1; }
	kat=$(dirname "$cel")
	while :; do
		[[ $(stat -c '%u' "$kat") == 0 ]] || { echo "$kat (przodek $cel) nie należy do roota" >&2; exit 1; }
		[[ $(( 8#$(stat -c '%a' "$kat") & 8#022 )) == 0 ]] || { echo "$kat (przodek $cel) jest zapisywalny dla grupy/innych" >&2; exit 1; }
		[[ $kat == / ]] && break
		kat=$(dirname "$kat")
	done
}
waliduj_node() {
	[[ $NODE_DIR == /* && $NODE_DIR != *:* ]] || { echo "NODE_DIR musi być ścieżką bezwzględną bez ':' ($NODE_DIR)" >&2; exit 1; }
	NODE_DIR=$(readlink -e "$NODE_DIR") || { echo "NODE_DIR nie istnieje" >&2; exit 1; }
	[[ -d $NODE_DIR && $NODE_DIR != *:* ]] || { echo "NODE_DIR ($NODE_DIR) po kanonizacji nie jest katalogiem albo zawiera ':'" >&2; exit 1; }
	sprawdz_sciezke_roota "$NODE_DIR"
	for plik in node npm; do
		cel=$(readlink -e "$NODE_DIR/$plik") || { echo "brak $NODE_DIR/$plik" >&2; exit 1; }
		[[ -f $cel && -x $cel ]] || { echo "$NODE_DIR/$plik -> $cel nie jest wykonywalnym plikiem" >&2; exit 1; }
		sprawdz_sciezke_roota "$cel"
	done
	WERSJA_NODE=$("$NODE_DIR/node" --version)
	[[ $WERSJA_NODE =~ ^v([0-9]+)\.[0-9]+\.[0-9]+$ && $((10#${BASH_REMATCH[1]})) -ge 24 ]] || { echo "Node w $NODE_DIR to $WERSJA_NODE, wymagany >= 24 (ustaw NODE_DIR, np. /opt/node-24/bin)" >&2; exit 1; }
}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3100/api/zdrowie}
HEALTH_TIMEOUT_S=${HEALTH_TIMEOUT_S:-120}
PANEL_URL=${PANEL_URL:-http://127.0.0.1:3100/logowanie}
DUMP_DIR=${DUMP_DIR:-/var/backups/midrev-esp/przed-wdrozeniem}
LOG_WDROZEN=${LOG_WDROZEN:-$ESP_ROOT/wdrozenia.log}
BLOKADA=${BLOKADA:-/run/lock/midrev-esp-deploy.lock}
MIN_WOLNE_MB=3000

TRYB="" REF="" ARCHIWUM="" CEL_ROLLBACK="" WYMUS=0 BEZ_DUMPA=0
while (($#)); do
	case $1 in
		--ref) TRYB=ref; REF=${2:?--ref wymaga wartości}; shift 2 ;;
		--archiwum) TRYB=archiwum; ARCHIWUM=${2:?--archiwum wymaga ścieżki}; shift 2 ;;
		--rollback) TRYB=rollback; if [[ ${2:-} && ${2:0:2} != -- ]]; then CEL_ROLLBACK=$2; shift; fi; shift ;;
		--lista) TRYB=lista; shift ;;
		--wymus-w-trakcie-wysylki) WYMUS=1; shift ;;
		--bez-dumpa) BEZ_DUMPA=1; shift ;;
		-h | --help) sed -n '2,33p' "$0"; exit 0 ;;
		*) zgin "nieznana opcja: $1 (--help)" ;;
	esac
done
[[ -n $TRYB ]] || zgin "podaj --ref, --archiwum, --rollback albo --lista (--help)"

aktywne_wydanie() {
	if [[ -L $CURRENT ]]; then basename "$(readlink -f "$CURRENT")"; fi
}
wydania() { find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort; }

if [[ $TRYB == lista ]]; then
	akt=$(aktywne_wydanie)
	while read -r w; do
		[[ -n $w ]] || continue
		rev=$(cat "$RELEASES/$w/REVISION" 2>/dev/null || echo '?')
		[[ -f $RELEASES/$w/.wdrozone-ok ]] || rev="$rev  [NIEUDANE/nieprzetestowane]"
		[[ $w == "$akt" ]] && echo "* $w  $rev  (aktywne)" || echo "  $w  $rev"
	done < <(wydania)
	exit 0
fi

[[ $(id -u) == 0 ]] || zgin "uruchom jako root"
exec 9>"$BLOKADA"
flock -n 9 || zgin "inne wdrożenie trwa (blokada $BLOKADA)"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
REL=""
POPRZEDNIE=$(aktywne_wydanie)
FAZA=start

zapisz_wynik() { printf '%s %s %s %s\n' "$STAMP" "${REL:+$(basename "$REL")}" "$1" "$2" >>"$LOG_WDROZEN"; }

# Powrót symlinka do poprzedniego wydania + restart. Migracji NIE cofa.
automatyczny_powrot() {
	local powod=$1
	if [[ -z $POPRZEDNIE || ! -d $RELEASES/$POPRZEDNIE ]]; then
		zapisz_wynik BLAD "$powod; brak wydania do powrotu"
		wyslij_alert krytyczny "Wdrożenie $STAMP: $powod. Brak wydania do powrotu (pierwsze wdrożenie?). journalctl -u midrev-esp-web -u midrev-esp-worker"
		return 1
	fi
	ostrzezenie "AUTOMATYCZNY POWRÓT do $POPRZEDNIE. Migracje z $STAMP ZOSTAJĄ w bazie (nie cofamy ich)."
	przelacz_na "$POPRZEDNIE"
	if restart_uslug && healthcheck; then
		zapisz_wynik ROLLBACK "$powod; wrócono do $POPRZEDNIE"
		wyslij_alert krytyczny "Wdrożenie $STAMP: $powod. Automatyczny powrót do $POPRZEDNIE działa. Migracje nowego wydania zostały w bazie. Zrzut sprzed: ${ZRZUT:-brak}"
		return 0
	fi
	zapisz_wynik BLAD "$powod; powrót do $POPRZEDNIE też bez healthchecku"
	wyslij_alert krytyczny "Wdrożenie $STAMP: $powod. Powrót do $POPRZEDNIE TEŻ bez healthchecku: usługa leży, potrzebny człowiek. Zrzut sprzed: ${ZRZUT:-brak}"
	return 1
}

# Jedna pułapka EXIT (nie ERR): działa raz, w głównej powłoce, także gdy błąd wystąpił
# wewnątrz funkcji albo podstawienia $(...). Kod != 0 bez obsłużenia = sprzątanie wg fazy.
ZAKONCZONE=0
po_wyjsciu() {
	local kod=$1
	trap - EXIT
	[[ $kod != 0 && $ZAKONCZONE == 0 ]] || exit "$kod"
	# w obsłudze błędu każdy krok ma się wykonać, nawet gdy poprzedni (np. alert) zawiódł
	set +e
	blad "wdrożenie przerwane w fazie '$FAZA' (kod $kod)"
	local powod=${OSTATNI_BLAD:+ Powód: $OSTATNI_BLAD.}
	case $FAZA in
		przygotowanie | budowa | zrzut)
			# nic na żywo nie zostało dotknięte; niedokończone wydanie usuwamy
			if [[ -n $REL && -d $REL && $(aktywne_wydanie) != "$(basename "$REL")" ]]; then
				rm -rf "$REL" "$ESP_ROOT/shared/cache/next/$(basename "$REL")"
			fi
			zapisz_wynik BLAD "$FAZA"
			wyslij_alert uwaga "Wdrożenie $STAMP przerwane w fazie '$FAZA' (produkcja bez zmian, aktywne: ${POPRZEDNIE:-brak}).$powod"
			;;
		migracje)
			ostrzezenie "migracje nie przeszły. Każdy plik jest w transakcji, ale pliki PRZED błędnym są już w bazie."
			if [[ -n $POPRZEDNIE ]]; then
				ostrzezenie "wznawiam workera na dotychczasowym wydaniu ($POPRZEDNIE)"
				systemctl start midrev-esp-worker.service || blad "worker nie wstał: systemctl status midrev-esp-worker"
			fi
			zapisz_wynik BLAD migracje
			wyslij_alert krytyczny "Wdrożenie $STAMP: migracje nie przeszły.$powod Aktywne dalej: ${POPRZEDNIE:-brak}. Sprawdź schema_migrations; zrzut sprzed: ${ZRZUT:-brak}"
			;;
		przelaczenie | healthcheck)
			automatyczny_powrot "błąd w fazie $FAZA"
			;;
		*)
			zapisz_wynik BLAD "$FAZA"
			wyslij_alert uwaga "Wdrożenie $STAMP: błąd w fazie '$FAZA' (aktywne: $(aktywne_wydanie)).$powod"
			;;
	esac
	# brak alertu (wyslij_alert != 0) został już zalogowany jako błąd; kod wyjścia i tak != 0
	exit "$kod"
}
trap 'po_wyjsciu $?' EXIT

# uruchom_jako_aplikacja KATALOG POLECENIE...
# Ten sam użytkownik, ten sam plik env i te same wyłączenia co unity (systemd-run),
# więc migracja widzi dokładnie to środowisko, co worker. Kod wyjścia przechodzi dalej.
uruchom_jako_aplikacja() {
	local kat=$1
	shift
	systemd-run --quiet --wait --pipe --collect --service-type=exec \
		-p User="$APP_USER" -p Group="$APP_USER" \
		-p WorkingDirectory="$kat" \
		-p EnvironmentFile="$ESP_ENV_FILE" \
		-p UnsetEnvironment="MIDREV_SANDBOX SMTP_HOSTY_DEWELOPERSKIE" \
		-p PrivateTmp=yes -p NoNewPrivileges=yes \
		/usr/bin/env NODE_ENV=production "$@"
}

# jako_budowniczy POLECENIE...: npm ci / next build BEZ sekretów produkcji w środowisku
# (nic z production.env nie może trafić do artefaktów buildu).
jako_budowniczy() {
	local kat=$1
	shift
	runuser -u "$APP_USER" -- env -i -C "$kat" PATH="$NODE_DIR:/usr/bin:/bin" HOME="$APP_HOME" \
		NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false "$@"
}

healthcheck() {
	local koniec=$((SECONDS + HEALTH_TIMEOUT_S)) kod=000 restarty0
	restarty0=$(systemctl show -p NRestarts --value midrev-esp-worker.service)
	while ((SECONDS < koniec)); do
		if systemctl is-active --quiet midrev-esp-web.service && systemctl is-active --quiet midrev-esp-worker.service; then
			kod=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$HEALTH_URL") || kod=000
			if [[ $kod == 200 ]]; then
				# worker ma przeżyć chwilę po starcie (pad przy starcie = pętla restartów)
				sleep 10
				if systemctl is-active --quiet midrev-esp-worker.service && \
					[[ $(systemctl show -p NRestarts --value midrev-esp-worker.service) == "$restarty0" ]]; then
					return 0
				fi
				blad "worker restartuje się po starcie"
				return 1
			fi
		fi
		sleep 3
	done
	blad "healthcheck $HEALTH_URL nie odpowiedział 200 w ${HEALTH_TIMEOUT_S}s (ostatni kod: $kod)"
	return 1
}

przelacz_na() {
	local cel=$1
	ln -sfn "$RELEASES/$cel" "$ESP_ROOT/.current.nowy"
	mv -Tf "$ESP_ROOT/.current.nowy" "$CURRENT"
	log "current -> $cel"
}

# Panel sam (bez workera) odpowiada na /logowanie: to sprawdzenie, że nowy kod w ogóle
# wstał, ZANIM worker nowego wydania zacznie brać zadania z kolejki (wysyłka!).
panel_wstal() {
	local koniec=$((SECONDS + HEALTH_TIMEOUT_S)) kod=000
	while ((SECONDS < koniec)); do
		kod=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$PANEL_URL") || kod=000
		[[ $kod == 200 ]] && return 0
		sleep 2
	done
	blad "panel nie odpowiedział 200 na $PANEL_URL w ${HEALTH_TIMEOUT_S}s (ostatni kod: $kod)"
	return 1
}

# Kolejność: worker stop -> panel restart -> panel odpowiada -> worker start.
# Worker nowego wydania rusza dopiero, gdy panel nowego wydania działa; pełny healthcheck
# (/api/zdrowie wymaga heartbeatu workera) jest po starcie workera.
restart_uslug() {
	systemctl stop midrev-esp-worker.service || return 1
	systemctl restart midrev-esp-web.service || return 1
	panel_wstal || return 1
	systemctl start midrev-esp-worker.service || return 1
}

# ---------------------------------------------------------------------------
if [[ $TRYB == rollback ]]; then
	FAZA=rollback-reczny
	[[ -n $POPRZEDNIE ]] || zgin "brak aktywnego wydania"
	if [[ -z $CEL_ROLLBACK ]]; then
		# najnowsze starsze wydanie, które kiedyś przeszło healthcheck (nie nieudane)
		CEL_ROLLBACK=""
		while read -r w; do
			[[ -f $RELEASES/$w/.wdrozone-ok ]] && CEL_ROLLBACK=$w
		done < <(wydania | awk -v a="$POPRZEDNIE" '$0 < a')
	fi
	[[ -n $CEL_ROLLBACK && -d $RELEASES/$CEL_ROLLBACK ]] || zgin "brak wydania do powrotu (${CEL_ROLLBACK:-żadne starsze udane})"
	[[ -f $RELEASES/$CEL_ROLLBACK/.wdrozone-ok ]] || ostrzezenie "$CEL_ROLLBACK nigdy nie przeszło healthchecku (wskazane ręcznie)"
	log "ROLLBACK $POPRZEDNIE -> $CEL_ROLLBACK (migracje NIE są cofane)"
	przelacz_na "$CEL_ROLLBACK"
	REL=$RELEASES/$CEL_ROLLBACK
	if restart_uslug && healthcheck; then
		ZAKONCZONE=1
		zapisz_wynik OK "rollback z $POPRZEDNIE"
		log "rollback OK"
		wyslij_alert uwaga "Rollback: $POPRZEDNIE -> $CEL_ROLLBACK, healthcheck OK. Migracje nie zostały cofnięte."
		exit 0
	fi
	ZAKONCZONE=1
	blad "rollback do $CEL_ROLLBACK nie przeszedł healthchecku: wracam na $POPRZEDNIE"
	przelacz_na "$POPRZEDNIE"
	if restart_uslug && healthcheck; then
		zapisz_wynik BLAD "rollback do $CEL_ROLLBACK nieudany, przywrócono $POPRZEDNIE"
		wyslij_alert krytyczny "Rollback $POPRZEDNIE -> $CEL_ROLLBACK: healthcheck NIE przeszedł, przywrócono $POPRZEDNIE (działa)."
	else
		zapisz_wynik BLAD "rollback do $CEL_ROLLBACK nieudany, $POPRZEDNIE też bez healthchecku"
		wyslij_alert krytyczny "Rollback $POPRZEDNIE -> $CEL_ROLLBACK nieudany i powrót do $POPRZEDNIE też bez healthchecku. Usługa leży, potrzebny człowiek."
	fi
	exit 1
fi

# ---------------------------------------------------------------------------
FAZA=przygotowanie
log "Wdrożenie $STAMP (aktywne teraz: ${POPRZEDNIE:-brak})"
wymagaj_uprawnien_600 "$ESP_ENV_FILE"
wymagaj_uprawnien_600 "$ESP_DB_ENV_FILE"
for zakazana in MIDREV_SANDBOX SMTP_HOSTY_DEWELOPERSKIE; do
	[[ -z $(czytaj_zmienna "$ESP_ENV_FILE" "$zakazana") ]] || zgin "$zakazana jest ustawione w $ESP_ENV_FILE: na produkcji zakazane"
done
for wymagana in DATABASE_URL APP_URL SECRETS_KEY SUPPRESSION_HASH_KEY ALERT_WEBHOOK_URL; do
	[[ -n $(czytaj_zmienna "$ESP_ENV_FILE" "$wymagana") ]] || zgin "brak $wymagana w $ESP_ENV_FILE"
done
db_gotowa || zgin "baza nie odpowiada (docker ps; docker logs $ESP_DB_CONTAINER)"
sprawdz_zgodnosc_bazy
WOLNE_MB=$(df -Pm "$ESP_ROOT" | awk 'NR==2 {print $4}')
((WOLNE_MB >= MIN_WOLNE_MB)) || zgin "za mało miejsca: ${WOLNE_MB} MB wolne, wymagane $MIN_WOLNE_MB MB"
waliduj_node
[[ -x $NODE_DIR/node ]] || zgin "brak node w $NODE_DIR"
# unity web/worker muszą uruchamiać TEN SAM node, który zbudował wydanie (drop-in node24.conf
# na serwerze współdzielonym); inaczej produkcja wstałaby na innej wersji niż build i migracje
for u in midrev-esp-web.service midrev-esp-worker.service; do
	systemctl cat "$u" | grep -E '^ExecStart=.+' | tail -1 | grep -qE "(^|[= ])${NODE_DIR//./\\.}/node( |$)" ||
		zgin "$u uruchamia inny node niż NODE_DIR=$NODE_DIR (sprawdź drop-in w /etc/systemd/system/$u.d/)"
done

BAZA=$(db_nazwa)
SCHEMAT_JEST=$(db_psql "$BAZA" "select to_regclass('public.campaigns') is not null")
if [[ $SCHEMAT_JEST == t ]]; then
	W_TOKU=$(db_psql "$BAZA" "select (select count(*) from campaigns where status = 'sending') + (select count(*) from messages where current_state in ('claimed', 'sending'))")
	if ((W_TOKU > 0)); then
		if [[ $WYMUS == 1 ]]; then
			ostrzezenie "wysyłka w toku ($W_TOKU), wdrażam mimo to (--wymus-w-trakcie-wysylki)"
		else
			zgin "wysyłka w toku ($W_TOKU kampanii/wiadomości w sending). Poczekaj albo --wymus-w-trakcie-wysylki (README 5.3)"
		fi
	fi
fi

# --- kod ---
FAZA=budowa
REL=$RELEASES/$STAMP
[[ ! -e $REL ]] || zgin "$REL już istnieje"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$REL"
case $TRYB in
	ref)
		[[ -d $REPO ]] || zgin "brak klonu $REPO (README 4.2: git clone --mirror)"
		git --git-dir="$REPO" fetch --prune --quiet origin
		SHA=$(git --git-dir="$REPO" rev-parse --verify --quiet "$REF^{commit}") || zgin "nie ma takiej rewizji: $REF"
		git --git-dir="$REPO" archive --format=tar "$SHA" | runuser -u "$APP_USER" -- tar -x -C "$REL"
		printf '%s %s\n' "$SHA" "$REF" >"$REL/REVISION"
		;;
	archiwum)
		[[ -f $ARCHIWUM ]] || zgin "brak pliku $ARCHIWUM"
		runuser -u "$APP_USER" -- tar -xzf - -C "$REL" <"$ARCHIWUM"
		printf 'archiwum %s sha256:%s\n' "$(basename "$ARCHIWUM")" "$(sha256sum "$ARCHIWUM" | cut -d' ' -f1)" >"$REL/REVISION"
		;;
esac
for f in package.json package-lock.json scripts/migrate.ts src/jobs/worker.ts migrations; do
	[[ -e $REL/$f ]] || zgin "wydanie nie ma $f: to nie jest kod midrev-esp albo archiwum jest niepełne"
done
[[ ! -e $REL/var ]] || zgin "archiwum zawiera katalog var/ (dane!); przerwane"
# aplikacja poza sandboksem odmawia startu z plikami .env* w katalogu (walidacja-startowa.ts);
# tu łapiemy to przed buildem, a nie po przełączeniu
for plik_env in .env .env.local .env.production .env.production.local; do
	[[ ! -e $REL/$plik_env ]] || zgin "archiwum zawiera $plik_env; przerwane (środowisko tylko z production.env)"
done
log "kod: $(cat "$REL/REVISION")"

log "npm ci (pełne: tsx dla workera i migracji jest w devDependencies)"
jako_budowniczy "$REL" npm ci --no-audit --no-fund --loglevel=error
log "next build"
jako_budowniczy "$REL" npm run build
[[ -f $REL/.next/BUILD_ID ]] || zgin "build nie zostawił .next/BUILD_ID"

# --- symlinki i prawa ---
ln -s "$ESP_ROOT/shared/var" "$REL/var"
rm -rf "$REL/.next/cache"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$ESP_ROOT/shared/cache/next/$STAMP"
ln -s "$ESP_ROOT/shared/cache/next/$STAMP" "$REL/.next/cache"
# kod tylko do odczytu dla aplikacji (root:midrev-esp, bez zapisu dla grupy)
chown -R -h root:"$APP_USER" "$REL"
chmod -R u=rwX,g=rX,o= "$REL"
chown -h root:"$APP_USER" "$REL/var" "$REL/.next/cache"

# --- zrzut przed migracjami ---
FAZA=zrzut
if [[ $SCHEMAT_JEST == t && $BEZ_DUMPA == 0 ]]; then
	install -d -m 700 "$DUMP_DIR"
	ZRZUT=$DUMP_DIR/przed-$STAMP.dump
	docker exec "$ESP_DB_CONTAINER" pg_dump -U "$(db_uzytkownik)" -d "$BAZA" -Fc >"$ZRZUT.tmp"
	docker exec -i "$ESP_DB_CONTAINER" pg_restore --list <"$ZRZUT.tmp" | grep 'TABLE DATA public schema_migrations' >/dev/null ||
		zgin "zrzut przed wdrożeniem niekompletny"
	mv "$ZRZUT.tmp" "$ZRZUT"
	log "zrzut przed migracjami: $ZRZUT ($(du -h "$ZRZUT" | cut -f1))"
	find "$DUMP_DIR" -maxdepth 1 -name 'przed-*.dump' -printf '%f\n' | sort | head -n -"$ZOSTAW_DUMPOW" |
		while read -r stary; do rm -f "$DUMP_DIR/$stary"; done
fi

# --- migracje ---
FAZA=migracje
if [[ -n $POPRZEDNIE ]]; then
	log "stop workera (łagodny, do 45 s)"
	systemctl stop midrev-esp-worker.service
fi
log "migracje z nowego wydania (blokada: flock tego skryptu; migrator nie ma własnej, README 5.4)"
uruchom_jako_aplikacja "$REL" "$NODE_DIR/node" --import tsx scripts/migrate.ts

# --- przełączenie ---
FAZA=przelaczenie
przelacz_na "$STAMP"
restart_uslug

FAZA=healthcheck
if ! healthcheck; then
	ZAKONCZONE=1
	blad "healthcheck nowego wydania nie przeszedł"
	automatyczny_powrot "healthcheck nowego wydania nie przeszedł"
	exit 1
fi
zapisz_wynik OK "$(cat "$REL/REVISION")"
# znacznik: tylko wydania z udanym healthcheckiem są kandydatami do --rollback
date -u +%Y-%m-%dT%H:%M:%SZ >"$REL/.wdrozone-ok"
log "wdrożenie OK: $STAMP"
FAZA=sprzatanie

# --- sprzątanie: 5 najnowszych, nigdy aktywne i poprzednie ---
AKT=$(aktywne_wydanie)
mapfile -t WSZYSTKIE < <(wydania)
DO_USUNIECIA=$((${#WSZYSTKIE[@]} - ZOSTAW_WYDAN))
for w in "${WSZYSTKIE[@]}"; do
	((DO_USUNIECIA > 0)) || break
	[[ $w == "$AKT" || $w == "$POPRZEDNIE" ]] && continue
	log "usuwam stare wydanie $w"
	rm -rf "${RELEASES:?}/$w" "$ESP_ROOT/shared/cache/next/$w"
	DO_USUNIECIA=$((DO_USUNIECIA - 1))
done
ZAKONCZONE=1
log "gotowe. Aktywne: $AKT, poprzednie: ${POPRZEDNIE:-brak}"
