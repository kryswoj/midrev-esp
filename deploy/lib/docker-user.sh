#!/usr/bin/env bash
# Reguły DOCKER-USER: ruch przychodzący z interfejsu zewnętrznego do kontenerów jest
# odrzucany, z wyjątkiem odpowiedzi na połączenia zainicjowane przez kontener
# (pobieranie obrazów, DNS itp.). Idempotentne: najpierw usuwa własne reguły
# (rozpoznawane po komentarzu), potem wstawia je na początek łańcucha.
#
# Uruchamiane przez midrev-esp-docker-user.service po każdym starcie Dockera
# (Docker odtwarza łańcuch DOCKER-USER, ale go nie czyści).
set -euo pipefail

IF=${1:-}
[[ -n $IF ]] || { echo "użycie: $0 <interfejs-zewnętrzny>, np. eth0" >&2; exit 2; }
ip link show "$IF" >/dev/null 2>&1 || { echo "interfejs $IF nie istnieje" >&2; exit 1; }
KOMENTARZ=midrev-esp-docker-user

zastosuj() {
	local ipt=$1
	command -v "$ipt" >/dev/null 2>&1 || return 0
	# łańcuch tworzy Docker; jeśli go jeszcze nie ma (Docker bez iptables), tworzymy pusty
	if ! "$ipt" -w -S DOCKER-USER >/dev/null 2>&1; then
		"$ipt" -w -N DOCKER-USER
	fi
	# usuń wcześniejsze własne reguły (pętla, bo -D usuwa jedno wystąpienie)
	while "$ipt" -w -D DOCKER-USER -i "$IF" -m conntrack --ctstate RELATED,ESTABLISHED \
		-m comment --comment "$KOMENTARZ" -j RETURN 2>/dev/null; do :; done
	while "$ipt" -w -D DOCKER-USER -i "$IF" -m comment --comment "$KOMENTARZ" -j DROP 2>/dev/null; do :; done
	"$ipt" -w -I DOCKER-USER 1 -i "$IF" -m conntrack --ctstate RELATED,ESTABLISHED \
		-m comment --comment "$KOMENTARZ" -j RETURN
	"$ipt" -w -I DOCKER-USER 2 -i "$IF" -m comment --comment "$KOMENTARZ" -j DROP
	echo "$ipt: DOCKER-USER zablokowany dla ruchu przychodzącego z $IF"
}

zastosuj iptables
# IPv6: Docker domyślnie nie włącza IPv6 dla sieci; jeśli łańcuch istnieje, też go domykamy
if ip6tables -w -S DOCKER-USER >/dev/null 2>&1; then
	zastosuj ip6tables
fi
