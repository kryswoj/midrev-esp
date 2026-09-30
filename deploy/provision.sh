#!/usr/bin/env bash
# midrev-esp: przygotowanie ŚWIEŻEGO serwera Debian 12/13 pod produkcję ESP.
#
# Uruchamiać jako root z katalogu repo (albo rozpakowanego archiwum), np.:
#   sudo bash deploy/provision.sh
#
# Idempotentny: każdy krok sprawdza stan i robi tylko to, czego brakuje. Można
# uruchamiać ponownie po zmianach w deploy/ (odświeża /srv/midrev-esp/ops, unity,
# Caddyfile). Uwaga: ponowne uruchomienie na DZIAŁAJĄCEJ produkcji przeładowuje Caddy
# i systemd, więc wtedy WYMAGA ZGODY KRYSTIANA (README, sekcja 8).
#
# Czego skrypt NIE robi (celowo, to kroki z decyzją człowieka):
#  - nie tworzy plików z sekretami (production.env, db.env, backup.env),
#  - nie uruchamia panelu ani workera (nie ma jeszcze wydania),
#  - nie włącza timera backupu, dopóki nie ma backup.env i klucza publicznego age,
#  - nie wyłącza logowania hasłem SSH, jeśli nie znajdzie żadnego klucza SSH.
#
# Opcje:
#   --bez-caddy-reload   zainstaluj Caddyfile, ale nie przeładowuj Caddy
#   --sprawdz            tylko raport stanu, nic nie zmienia

set -euo pipefail

SKRYPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ESP_ROOT=/srv/midrev-esp
OPS=$ESP_ROOT/ops
APP_USER=midrev-esp
APP_HOME=/var/lib/midrev-esp
BACKUP_DIR=/var/backups/midrev-esp
NODE_MAJOR=24
SWAP_PLIK=/swapfile
SWAP_ROZMIAR_MB=2048

CADDY_RELOAD=1
TYLKO_SPRAWDZ=0
for a in "$@"; do
	case $a in
		--bez-caddy-reload) CADDY_RELOAD=0 ;;
		--sprawdz) TYLKO_SPRAWDZ=1 ;;
		-h | --help) sed -n '2,25p' "$0"; exit 0 ;;
		*) echo "nieznana opcja: $a" >&2; exit 2 ;;
	esac
done

krok() { printf '\n==> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
uwaga() { printf '    UWAGA: %s\n' "$*" >&2; }
zgin() { printf 'BŁĄD: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
krok "Sprawdzenia wstępne"
[[ $(id -u) == 0 ]] || zgin "uruchom jako root (sudo bash $0)"
[[ -r /etc/os-release ]] || zgin "brak /etc/os-release"
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == debian ]] || zgin "to nie jest Debian (ID=${ID:-?})"
case ${VERSION_ID:-} in
	12 | 13) ok "Debian $VERSION_ID ($VERSION_CODENAME)" ;;
	*) zgin "obsługiwany Debian 12 lub 13, jest ${VERSION_ID:-?}" ;;
esac
ARCH=$(dpkg --print-architecture)
[[ $ARCH == amd64 || $ARCH == arm64 ]] || zgin "architektura $ARCH nieobsługiwana"
for f in Caddyfile docker-compose.prod.yml deploy.sh backup/backup.sh backup/restore.sh \
	monitoring/healthcheck.sh lib/wspolne.sh lib/docker-user.sh systemd/midrev-esp-web.service; do
	[[ -f $SKRYPT_DIR/$f ]] || zgin "brak $SKRYPT_DIR/$f (uruchom z katalogu repo: bash deploy/provision.sh)"
done
ZEWN_IF=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}')
[[ -n $ZEWN_IF ]] || zgin "nie wykryto interfejsu zewnętrznego (ip route get 1.1.1.1)"
ok "interfejs zewnętrzny: $ZEWN_IF"

if [[ $TYLKO_SPRAWDZ == 1 ]]; then
	krok "Raport stanu (--sprawdz)"
	id "$APP_USER" 2>/dev/null || echo "    brak użytkownika $APP_USER"
	command -v docker >/dev/null && docker --version
	command -v node >/dev/null && node --version
	command -v caddy >/dev/null && caddy version
	ufw status verbose 2>/dev/null || true
	swapon --show
	ss -ltnp
	exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt_zainstaluj() {
	local brak=() p
	for p in "$@"; do
		dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep 'install ok installed' >/dev/null || brak+=("$p")
	done
	if ((${#brak[@]})); then
		apt-get install -y --no-install-recommends "${brak[@]}"
		ok "zainstalowano: ${brak[*]}"
	else
		ok "już są: $*"
	fi
}

# ---------------------------------------------------------------------------
krok "Pakiety bazowe"
apt-get update -q
apt_zainstaluj ca-certificates curl gnupg jq git rsync ufw fail2ban python3-systemd \
	unattended-upgrades apt-listchanges age rclone iptables util-linux openssl

# ---------------------------------------------------------------------------
krok "Strefa czasowa systemu: UTC (aplikacja liczy strefę sama; logi w UTC)"
if [[ $(timedatectl show -p Timezone --value 2>/dev/null) != UTC ]]; then
	timedatectl set-timezone UTC
	ok "ustawiono UTC"
else
	ok "już UTC"
fi

# ---------------------------------------------------------------------------
krok "Swap ${SWAP_ROZMIAR_MB} MB"
if swapon --show=NAME --noheadings | grep -x "$SWAP_PLIK" >/dev/null; then
	ok "swap $SWAP_PLIK aktywny"
else
	if [[ ! -f $SWAP_PLIK ]]; then
		fallocate -l "${SWAP_ROZMIAR_MB}M" "$SWAP_PLIK" || dd if=/dev/zero of="$SWAP_PLIK" bs=1M count="$SWAP_ROZMIAR_MB" status=none
		chmod 600 "$SWAP_PLIK"
		mkswap "$SWAP_PLIK" >/dev/null
	fi
	swapon "$SWAP_PLIK"
	ok "swap włączony"
fi
grep -qE "^${SWAP_PLIK}[[:space:]]" /etc/fstab || { echo "$SWAP_PLIK none swap sw 0 0" >>/etc/fstab; ok "wpis w /etc/fstab"; }
cat >/etc/sysctl.d/60-midrev-esp.conf <<'EOF'
# midrev-esp: swap jako bufor bezpieczeństwa, nie jako pamięć robocza
vm.swappiness = 10
EOF
sysctl -q -p /etc/sysctl.d/60-midrev-esp.conf

# ---------------------------------------------------------------------------
krok "journald: limity i retencja (logi workera zawierają dane osobowe: max 30 dni)"
mkdir -p /etc/systemd/journal.conf.d
cat >/etc/systemd/journal.conf.d/60-midrev-esp.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=1G
SystemKeepFree=2G
MaxRetentionSec=30day
MaxFileSec=1week
EOF
systemctl restart systemd-journald
ok "journald: 1 GB, 30 dni"

# ---------------------------------------------------------------------------
krok "unattended-upgrades (tylko poprawki bezpieczeństwa Debiana, BEZ automatycznego rebootu)"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat >/etc/apt/apt.conf.d/52midrev-esp-unattended <<'EOF'
// Reboot świadomie, w oknie bez wysyłki (README, sekcja 9). Docker, Caddy i Node
// z repozytoriów zewnętrznych NIE aktualizują się same: restart Dockera w trakcie
// kampanii to restart bazy.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || uwaga "nie udało się włączyć unattended-upgrades.service"
ok "skonfigurowane"

# ---------------------------------------------------------------------------
krok "Użytkownik systemowy $APP_USER"
if id "$APP_USER" >/dev/null 2>&1; then
	ok "istnieje"
else
	useradd --system --user-group --home-dir "$APP_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"
	ok "utworzony (bez powłoki, home $APP_HOME na cache npm)"
fi
chmod 750 "$APP_HOME"

# ---------------------------------------------------------------------------
krok "Katalogi"
install -d -o root -g root -m 755 "$ESP_ROOT" "$ESP_ROOT/releases" "$ESP_ROOT/shared" "$OPS"
install -d -o root -g root -m 700 "$ESP_ROOT/shared/env"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$ESP_ROOT/shared/var" \
	"$ESP_ROOT/shared/var/obrazy" "$ESP_ROOT/shared/var/importy" \
	"$ESP_ROOT/shared/cache" "$ESP_ROOT/shared/cache/next"
install -d -o root -g root -m 700 "$BACKUP_DIR" "$BACKUP_DIR/staging" "$BACKUP_DIR/lokalne" "$BACKUP_DIR/przed-wdrozeniem"
# znacznik ostatniego udanego backupu czyta healthcheck (użytkownik aplikacji): bez sekretów
install -d -o root -g root -m 755 /var/lib/midrev-esp-backup
ok "$ESP_ROOT/{releases,shared/{env,var,cache},ops}, $BACKUP_DIR"

# ---------------------------------------------------------------------------
krok "Docker CE (oficjalne repozytorium)"
install -d -m 755 /etc/apt/keyrings
if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
	curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
	chmod 644 /etc/apt/keyrings/docker.asc
fi
echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $VERSION_CODENAME stable" \
	>/etc/apt/sources.list.d/docker.list
# Debianowe docker.io/podman-docker kolidują z docker-ce
for p in docker.io docker-doc docker-compose podman-docker containerd runc; do
	if dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep 'install ok installed' >/dev/null; then
		zgin "zainstalowany pakiet $p koliduje z docker-ce; usuń go ręcznie i uruchom ponownie"
	fi
done
apt-get update -q
apt_zainstaluj docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Domyślny adres publikacji portów = 127.0.0.1. Nawet `ports: ["5432:5432"]` bez adresu
# nie wystawi wtedy bazy na świat. Plus rotacja logów kontenerów.
DAEMON_JSON=/etc/docker/daemon.json
DAEMON_NOWY=$(jq -n '{ip: "127.0.0.1", "log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "5"}}')
if [[ -f $DAEMON_JSON ]]; then
	if ! jq -e '.ip == "127.0.0.1"' "$DAEMON_JSON" >/dev/null 2>&1; then
		zgin "$DAEMON_JSON istnieje i nie ma \"ip\": \"127.0.0.1\"; popraw ręcznie (nie nadpisuję cudzej konfiguracji)"
	fi
	ok "daemon.json ma ip=127.0.0.1"
else
	printf '%s\n' "$DAEMON_NOWY" >"$DAEMON_JSON"
	systemctl restart docker
	ok "daemon.json zapisany, docker zrestartowany"
fi
systemctl enable --now docker.service containerd.service >/dev/null

# ---------------------------------------------------------------------------
krok "Node.js $NODE_MAJOR (NodeSource)"
if [[ ! -s /etc/apt/keyrings/nodesource.gpg ]]; then
	curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
	chmod 644 /etc/apt/keyrings/nodesource.gpg
fi
echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" \
	>/etc/apt/sources.list.d/nodesource.list
cat >/etc/apt/preferences.d/nodesource <<'EOF'
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
EOF
apt-get update -q
apt_zainstaluj nodejs
NODE_WERSJA=$(node --version)
[[ $NODE_WERSJA == v$NODE_MAJOR.* ]] || zgin "node $NODE_WERSJA, oczekiwany v$NODE_MAJOR (sprawdź pin /etc/apt/preferences.d/nodesource)"
[[ -x /usr/bin/node ]] || zgin "brak /usr/bin/node (unity systemd wołają tę ścieżkę)"
ok "node $NODE_WERSJA, npm $(npm --version)"

# ---------------------------------------------------------------------------
krok "Caddy (oficjalne repozytorium)"
if [[ ! -s /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
	curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg
fi
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
chmod 644 /etc/apt/sources.list.d/caddy-stable.list
apt-get update -q
apt_zainstaluj caddy

# ---------------------------------------------------------------------------
krok "Firewall ufw: tylko SSH, 80, 443"
SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')
SSH_PORT=${SSH_PORT:-22}
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw limit "$SSH_PORT/tcp" comment 'ssh' >/dev/null
ufw allow 80/tcp comment 'http (ACME + przekierowanie)' >/dev/null
ufw allow 443/tcp comment 'https' >/dev/null
ufw allow 443/udp comment 'http3' >/dev/null
ufw --force enable >/dev/null
ok "ufw aktywny (SSH na $SSH_PORT)"
# reguły spoza listy tylko zgłaszamy, nie kasujemy (mogą być czyjąś świadomą decyzją)
INNE=$(ufw status | awk 'NR>4 && $0 !~ /^(22|80|443|'"$SSH_PORT"')(\/(tcp|udp))?( \(v6\))? / && NF' || true)
[[ -z $INNE ]] || uwaga "ufw ma dodatkowe reguły, sprawdź: $INNE"

krok "DOCKER-USER: ruch z internetu do kontenerów zablokowany"
cat >/etc/default/midrev-esp-firewall <<EOF
# interfejs zewnętrzny (wykryty przez provision.sh: ip route get 1.1.1.1)
ZEWN_IF=$ZEWN_IF
EOF

# ---------------------------------------------------------------------------
krok "fail2ban dla sshd"
cat >/etc/fail2ban/jail.d/midrev-esp.local <<EOF
[sshd]
enabled = true
backend = systemd
port = $SSH_PORT
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable fail2ban >/dev/null
systemctl restart fail2ban
ok "fail2ban aktywny"

# ---------------------------------------------------------------------------
krok "SSH: logowanie tylko kluczem"
KLUCZE=0
for plik in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
	[[ -s $plik ]] && grep -qE '^(ssh-|ecdsa-|sk-)' "$plik" && KLUCZE=1
done
if [[ $KLUCZE == 1 ]]; then
	cat >/etc/ssh/sshd_config.d/60-midrev-esp.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
X11Forwarding no
MaxAuthTries 4
EOF
	sshd -t || zgin "konfiguracja sshd niepoprawna (sshd -t); nic nie przeładowano"
	systemctl reload ssh 2>/dev/null || systemctl reload sshd
	ok "hasła wyłączone (klucz SSH znaleziony)"
else
	uwaga "nie znaleziono żadnego authorized_keys: logowanie hasłem ZOSTAJE. Dodaj klucz i uruchom ponownie."
fi

# ---------------------------------------------------------------------------
krok "Narzędzia operacyjne -> $OPS"
rsync -a --delete --chown=root:root --chmod=D755,F644 \
	--exclude '*.example.local' "$SKRYPT_DIR/" "$OPS/"
chmod 755 "$OPS/deploy.sh" "$OPS/provision.sh" "$OPS/backup/backup.sh" "$OPS/backup/restore.sh" \
	"$OPS/monitoring/healthcheck.sh" "$OPS/lib/docker-user.sh"
ok "skopiowane (to są wersje, których używają unity i timery)"

krok "Unity systemd"
for u in "$OPS"/systemd/*.service "$OPS"/systemd/*.timer; do
	install -m 644 -o root -g root "$u" /etc/systemd/system/
done
systemctl daemon-reload
systemctl enable --now midrev-esp-docker-user.service >/dev/null
iptables -S DOCKER-USER | grep midrev-esp-docker-user >/dev/null || zgin "reguły DOCKER-USER nie zostały założone"
ok "DOCKER-USER: $(iptables -S DOCKER-USER | grep -c midrev-esp-docker-user) reguły"
systemctl enable midrev-esp-web.service midrev-esp-worker.service >/dev/null
ok "web i worker włączone do autostartu (nie uruchomione: brak wydania / env)"

# ---------------------------------------------------------------------------
krok "Caddyfile"
install -d -o caddy -g caddy -m 750 /var/log/caddy
if ! caddy validate --config "$OPS/Caddyfile" --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
	cat /tmp/caddy-validate.log >&2
	zgin "Caddyfile nie przeszedł walidacji; /etc/caddy/Caddyfile bez zmian"
fi
if ! cmp -s "$OPS/Caddyfile" /etc/caddy/Caddyfile; then
	[[ -f /etc/caddy/Caddyfile ]] && cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.przed-$(date -u +%Y%m%d%H%M%S)"
	install -m 644 -o root -g root "$OPS/Caddyfile" /etc/caddy/Caddyfile
	if [[ $CADDY_RELOAD == 1 ]]; then
		systemctl enable --now caddy >/dev/null
		systemctl reload caddy
		ok "Caddyfile zainstalowany i przeładowany (certyfikaty wystawią się, gdy DNS wskaże ten serwer)"
	else
		ok "Caddyfile zainstalowany, BEZ przeładowania (--bez-caddy-reload)"
	fi
else
	ok "Caddyfile bez zmian"
fi

# ---------------------------------------------------------------------------
krok "Pliki środowiska"
for f in production.env db.env backup.env backup-hmac.key rclone.conf; do
	cel=$ESP_ROOT/shared/env/$f
	if [[ -f $cel ]]; then
		chown root:root "$cel"
		chmod 600 "$cel"
		ok "$f jest (prawa wymuszone na 600 root)"
	else
		uwaga "brak $cel: utwórz z $OPS/$f.example (README, sekcja 3)"
	fi
done

if [[ -f $ESP_ROOT/shared/env/db.env ]]; then
	krok "Postgres (docker compose)"
	docker compose -f "$OPS/docker-compose.prod.yml" up -d
	for _ in $(seq 1 30); do
		stan=$(docker inspect -f '{{.State.Health.Status}}' midrev-esp-prod-db 2>/dev/null || echo brak)
		[[ $stan == healthy ]] && break
		sleep 2
	done
	[[ ${stan:-} == healthy ]] || zgin "Postgres nie jest healthy (stan: ${stan:-?}); docker logs midrev-esp-prod-db"
	ok "Postgres healthy"
fi

if [[ -f $ESP_ROOT/shared/env/production.env ]]; then
	systemctl enable --now midrev-esp-healthcheck.timer >/dev/null
	ok "healthcheck.timer włączony"
fi
if [[ -f $ESP_ROOT/shared/env/backup.env ]]; then
	systemctl enable --now midrev-esp-backup.timer >/dev/null
	ok "backup.timer włączony"
fi

# ---------------------------------------------------------------------------
krok "Kontrola końcowa"
if ss -ltnH | awk '{print $4}' | grep -E ':5432$' | grep -vE '^127\.0\.0\.1:' >/dev/null; then
	zgin "port 5432 słucha na adresie innym niż 127.0.0.1!"
fi
ok "5432 tylko na 127.0.0.1 (albo jeszcze nie działa)"
ss -ltnH | awk '{print "    nasłuch:", $4}'
echo
echo "Gotowe. Dalej: README.md, sekcja 3 (pliki env) i 4 (pierwsze wdrożenie)."
