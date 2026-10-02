# midrev-esp: runbook produkcji (osobny VPS)

Pakiet wdrożeniowy własnego ESP MidRev: panel Next 16 (`next start`), worker Node
(`tsx src/jobs/worker.ts`), Postgres 18 w Dockerze, Caddy z automatycznym TLS.

- Panel: **`esp.midrev.pl`** (cały panel, webhooki sklepów, akceptacja kampanii).
- Śledzenie: **`link.midrev.pl`**. Tylko trasy odbiorcy: `/r`, `/u`, `/api/o`, `/o`, `/s`,
  `/api/popup`. Wszystko inne dostaje 404 od Caddy.
- Wysyłka: Amazon SES przez SMTP z `news.midrev.pl` (konfiguracja w panelu, raport 03).

Kroki oznaczone **WYMAGA ZGODY KRYSTIANA** zmieniają coś na żywym systemie, w DNS albo
na koncie z kosztami. Każdy taki krok przechodzi procedurę z `AGENTS.md`: co zmieniam,
dlaczego, promień rażenia, jak cofnąć. Potem czekasz na „tak”. Zgoda obejmuje jedną
operację, nie całą sesję.

---

## Spis

1. [Co jest w katalogu](#1-co-jest-w-katalogu)
2. [Zakup VPS i provisioning](#2-zakup-vps-i-provisioning)
3. [Sekrety i pliki env](#3-sekrety-i-pliki-env)
4. [DNS i pierwsze uruchomienie](#4-dns-i-pierwsze-uruchomienie)
5. [Aktualizacja wersji i rollback](#5-aktualizacja-wersji-i-rollback)
6. [Backup i odtworzenie](#6-backup-i-odtworzenie)
7. [Awarie](#7-awarie)
8. [Zmiany konfiguracji serwera](#8-zmiany-konfiguracji-serwera)
9. [Aktualizacje systemu i reboot](#9-aktualizacje-systemu-i-reboot)
10. [Zależności od kodu aplikacji](#10-zależności-od-kodu-aplikacji)

---

## 1. Co jest w katalogu

| Plik | Rola |
|---|---|
| `provision.sh` | Idempotentne przygotowanie świeżego Debiana 12/13 (root) |
| `deploy.sh` | Wdrożenie wydania, auto-rollback, `--rollback`, `--lista` |
| `docker-compose.prod.yml` | Wyłącznie Postgres 18 (127.0.0.1:5432, `unless-stopped`) |
| `Caddyfile` | `esp.` i `link.` z TLS Let's Encrypt, nadpisywanie XFF, limity ciała |
| `systemd/*.service`, `*.timer` | web, worker, backup (codziennie), healthcheck (co 5 min), DOCKER-USER |
| `backup/backup.sh`, `backup/restore.sh` | Zrzut, próbne odtworzenie, szyfrowanie age, rclone off-site, retencja |
| `monitoring/healthcheck.sh`, `monitoring.md` | Healthcheck z alertem i opis zewnętrznego monitoringu |
| `lib/wspolne.sh`, `lib/docker-user.sh` | Wspólne funkcje, reguły DOCKER-USER |
| `production.env.example`, `db.env.example`, `backup.env.example` | Szablony env, same nazwy i komendy generowania |

Układ na serwerze:

```
/srv/midrev-esp/
├── ops/                  kopia deploy/ (z niej korzystają unity i timery; odświeża ją provision.sh)
├── repo.git/             klon --mirror repozytorium (źródło dla deploy.sh --ref)
├── releases/<UTC>/       wydania: kod root:midrev-esp, tylko do odczytu dla aplikacji
│   ├── var -> /srv/midrev-esp/shared/var
│   └── .next/cache -> /srv/midrev-esp/shared/cache/next/<UTC>
├── current -> releases/<UTC>
├── shared/env/           root 700: production.env, db.env, backup.env, rclone.conf (600)
├── shared/var/{obrazy,importy}   midrev-esp 700 (wspólne dla panelu i workera)
└── wdrozenia.log
/var/backups/midrev-esp/  staging, lokalne (2 szyfrogramy), przed-wdrozeniem (3 zrzuty)
/var/lib/midrev-esp-backup/ostatni-ok   znacznik ostatniego udanego backupu
```

---

## 2. Zakup VPS i provisioning

### 2.1 Zakup — WYMAGA ZGODY KRYSTIANA (koszt stały)

- OVH (to samo konto co dziś: panel do PTR i snapshotów) albo Hetzner (DE). Region UE.
- 2 vCPU, 4 GB RAM, 40–80 GB SSD, **Debian 12 lub 13**, IPv4 (IPv6 opcjonalnie).
- Przy zakupie klucz SSH (ed25519) zamiast hasła.
- Snapshot/backup dostawcy raz w tygodniu: tak (to druga warstwa, nie zamiennik backupu z sekcji 6).
- Cofnięcie: usunięcie VPS w panelu dostawcy, dopóki nie ma na nim danych.

### 2.2 Kod na serwer

Repo `midrev-esp` nie ma dziś zdalnego remote'a (raport 01). Dwie drogi:

- **Docelowo (`--ref`)**: prywatne repo na GitHubie (push robi Krystian). Na serwerze
  deploy key tylko do odczytu:
  ```bash
  ssh-keygen -t ed25519 -f /root/.ssh/midrev-esp-deploy -N ''      # publiczny do GitHub > Deploy keys (read-only)
  cat >>/root/.ssh/config <<'EOF'
  Host github-midrev-esp
    HostName github.com
    User git
    IdentityFile /root/.ssh/midrev-esp-deploy
    IdentitiesOnly yes
  EOF
  git clone --mirror github-midrev-esp:<org>/midrev-esp.git /srv/midrev-esp/repo.git
  ```
- **Na start (`--archiwum`)**: archiwum z maszyny deweloperskiej, z **zacommitowanego** stanu:
  ```bash
  # na maszynie deweloperskiej (git archive bierze tylko pliki z commita: bez .env, var/, node_modules)
  git -C clients/midrev/midrev-esp archive --format=tar.gz -o /tmp/midrev-esp-<sha>.tar.gz <sha>
  scp /tmp/midrev-esp-<sha>.tar.gz root@<IP>:/root/
  ```
  Niezacommitowane pliki (np. migracja 0028/0029) do archiwum nie trafią. To celowe.

### 2.3 Provisioning — WYMAGA ZGODY KRYSTIANA (pierwsze uruchomienie na nowym serwerze)

```bash
# na serwerze, jako root, z rozpakowanego kodu (wystarczy sam katalog deploy/)
mkdir -p /root/midrev-esp-src && tar -xzf /root/midrev-esp-<sha>.tar.gz -C /root/midrev-esp-src
bash /root/midrev-esp-src/deploy/provision.sh
```

Co robi (każdy krok sprawdza stan i robi tylko brakujące):
- pakiety bazowe, `age`, `rclone`, `jq`, strefa czasowa UTC,
- swap 2 GB (`/swapfile`, `vm.swappiness=10`), journald 1 GB / 30 dni,
- `unattended-upgrades` tylko dla poprawek bezpieczeństwa Debiana, **bez automatycznego rebootu**,
- użytkownik systemowy `midrev-esp` (bez powłoki), katalogi z sekcji 1,
- Docker CE z oficjalnego repo, `/etc/docker/daemon.json` z `"ip": "127.0.0.1"` (domyślny
  adres publikacji portów), unit `midrev-esp-docker-user` (DROP ruchu z internetu do kontenerów
  w łańcuchu DOCKER-USER). Porty Dockera omijają ufw: te dwie warstwy to zabezpieczenie,
- Node 24 (NodeSource, przypięty), Caddy (oficjalne repo) i instalacja `Caddyfile` po walidacji,
- ufw: tylko SSH (limit), 80/tcp, 443/tcp+udp; fail2ban dla sshd,
- SSH tylko kluczem, **jeśli** znajdzie `authorized_keys` (inaczej ostrzega i hasła zostają),
- unity systemd, web i worker włączone do autostartu, ale jeszcze nieuruchomione.

Po provisioningu: `bash /srv/midrev-esp/ops/provision.sh --sprawdz` (raport bez zmian).
Kontrola z **innej** maszyny, że baza nie jest publiczna: `nc -vz <IP> 5432` ma dać timeout
albo „refused”.

---

## 3. Sekrety i pliki env

Wszystkie pliki w `/srv/midrev-esp/shared/env/`, **root:root 600**. `deploy.sh` i
`backup.sh` odmówią pracy przy innych prawach. Żaden z tych plików nie trafia do gita.

### 3.1 `db.env`

```bash
cd /srv/midrev-esp/shared/env
install -m 600 -o root -g root /srv/midrev-esp/ops/db.env.example db.env
openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-40     # wklej jako POSTGRES_PASSWORD
```

### 3.2 `production.env`

```bash
install -m 600 -o root -g root /srv/midrev-esp/ops/production.env.example production.env
openssl rand -hex 32     # SECRETS_KEY
openssl rand -hex 32     # SUPPRESSION_HASH_KEY (inny!)
openssl rand -hex 32     # API_KEY_PEPPER (inny niż oba!)
```
W `DATABASE_URL` to samo hasło co w `db.env`. `ALERT_WEBHOOK_URL`: webhook kanału
technicznego na Discordzie (https). `MIDREV_SANDBOX` i `SMTP_HOSTY_DEWELOPERSKIE` na
produkcji **nie istnieją** (unity je usuwają, `deploy.sh` odmawia, aplikacja odmawia startu).

`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (`openssl rand -base64 32`) jest **opcjonalny**, ale
zalecany: z nim akcje formularzy, których kod się nie zmienił, mają to samo ID po
wdrożeniu, więc karta otwarta przed deployem dalej zapisuje (bez niego każdy build losuje
klucz i po deployu stara karta dostaje „Server action not found”). `deploy.sh` podaje go
do `next build` przez stdin i nie wypisuje. Wpisanie albo zmiana wartości: **za zgodą
Krystiana** (zmiana zmiennej produkcyjnej).

### 3.3 Klucze poza serwerem (MUSI być zrobione przed pierwszym mailem)

Do menedżera haseł (np. 1Password/Bitwarden, sejf „midrev-esp prod”), **osobno od backupu**:

| Co | Po co | Utrata oznacza |
|---|---|---|
| `SECRETS_KEY` | odszyfrowanie haseł SMTP/IMAP i kluczy sklepów w bazie | ponowne wpisanie wszystkich poświadczeń w panelu |
| `SUPPRESSION_HASH_KEY` | hasze wykluczeń i nagrobków RODO | nagrobki RODO nie rozpoznają adresów; osoba po art. 17 może wrócić importem |
| `API_KEY_PEPPER` | hasze kluczy API tenantów (n8n, serwery klientów) | wszystkie klucze API przestają działać; klienci generują nowe w Ustawieniach i wklejają w n8n |
| klucz prywatny age backupu | odszyfrowanie kopii | **backup bezużyteczny** |
| klucz podpisu backupu (`backup-hmac.key`, 64 hex) | `restore.sh --na-produkcje` sprawdza, że kopia pochodzi z naszego backupu | `--na-produkcje` odmawia; kopię nadal da się odtworzyć do bazy testowej i przenieść ręcznie (wolniej, pod presją czasu) |
| hasło bazy | dostęp do bazy po odtworzeniu serwera | do odtworzenia (nowe hasło przy restore), mniejsza szkoda |
| hasło operatora `krystian@midrev.pl` | panel | reset przez `scripts/ustaw-haslo.ts` |
| **poświadczenia magazynu off-site** (B2: keyID + applicationKey i nazwa bucketu; Storage Box: host, login, hasło/klucz SSH; Google Drive: konto i sposób ponownej autoryzacji) oraz treść sekcji remote z `rclone.conf` | pobranie kopii po utracie CAŁEGO serwera | klucz age bez dostępu do bucketu jest bezużyteczny |
| dane logowania do panelu dostawcy VPS i do Hostido (DNS) | nowy serwer, przepięcie `esp.`/`link.` | brak możliwości odtworzenia usług pod tymi samymi adresami |

Backup (sekcja 6) **celowo nie zawiera** `production.env`: kradzież bucketu nie może dać
jednocześnie bazy i klucza do poświadczeń w niej.

### 3.4 `backup.env`, klucz age, rclone

```bash
# NA LAPTOPIE (nie na serwerze):
age-keygen -o midrev-esp-backup.key        # plik -> menedżer haseł, potem skasować z dysku
age-keygen -y midrev-esp-backup.key        # klucz publiczny age1...

# NA SERWERZE:
cd /srv/midrev-esp/shared/env
echo 'age1...' > backup-recipients.txt && chmod 644 backup-recipients.txt
install -m 600 /dev/null backup-hmac.key && openssl rand -hex 32 > backup-hmac.key   # kopia do menedżera haseł
install -m 600 -o root -g root /srv/midrev-esp/ops/backup.env.example backup.env
rclone config --config /srv/midrev-esp/shared/env/rclone.conf   # remote na zewnętrzny magazyn
chmod 600 rclone.conf
```

Magazyn off-site (**WYMAGA ZGODY KRYSTIANA**: nowe konto/koszt, dane osobowe w szyfrogramie):
Backblaze B2 (bucket prywatny, region EU Central), Hetzner Storage Box (sftp) albo Google
Drive konta firmowego. Dowolny backend rclone. Domyślnie `RETENCJA_ZDALNA=0`: klucz
aplikacyjny **bez prawa usuwania** plus reguła cyklu życia bucketu (np. `daily/` 15 dni,
`weekly/` 60 dni). Wtedy ktoś z rootem na serwerze nie skasuje kopii. `RETENCJA_ZDALNA=1`
(skrypt sam kasuje stare kopie po liczbie) tylko tam, gdzie magazyn nie ma reguł cyklu życia.

Na koniec: `bash /srv/midrev-esp/ops/provision.sh` jeszcze raz. Uruchomi Postgresa
i włączy timery backupu i healthchecku, kiedy zobaczy pliki env.

---

## 4. DNS i pierwsze uruchomienie

### 4.1 Rekordy w Hostido — WYMAGA ZGODY KRYSTIANA

Strefa `midrev.pl` jest w Hostido (ns1-3.hostido.net.pl). Nie ma do niej API w repo,
rekordy wpisuje się ręcznie w edytorze strefy. **Przed edycją: zrzut ekranu całej strefy.**
Apex, `www`, `MX`, SPF apexu i `google._domainkey` zostają bez zmian.

Etap 1: panel i śledzenie (potrzebne do wystawienia certyfikatów):

| # | Nazwa | Typ | Wartość | TTL | Po co |
|---|---|---|---|---|---|
| 1 | `esp.midrev.pl` | A | IPv4 nowego VPS | 3600 | panel |
| 2 | `link.midrev.pl` | A | IPv4 nowego VPS | 3600 | kliki, pixel, wypis, obrazy, popupy |
| 1a/2a | jw. | AAAA | IPv6 VPS (tylko jeśli ufw i Caddy mają IPv6; domyślnie tak) | 3600 | opcjonalnie |

Etap 2: SES dla `news.midrev.pl` (wartości CNAME **generuje SES** po utworzeniu tożsamości,
nie zgadywać; szczegóły i kolejność w raporcie 03, sekcja 7):

| # | Nazwa | Typ | Wartość | Po co |
|---|---|---|---|---|
| 3 | `{token1}._domainkey.news.midrev.pl` | CNAME | `{token1}.dkim.amazonses.com` | Easy DKIM |
| 4 | `{token2}._domainkey.news.midrev.pl` | CNAME | `{token2}.dkim.amazonses.com` | Easy DKIM |
| 5 | `{token3}._domainkey.news.midrev.pl` | CNAME | `{token3}.dkim.amazonses.com` | Easy DKIM |
| 6 | `bounce.news.midrev.pl` | MX | `10 feedback-smtp.eu-north-1.amazonses.com` | custom MAIL FROM, **dokładnie jeden MX** |
| 7 | `bounce.news.midrev.pl` | TXT | `"v=spf1 include:amazonses.com ~all"` | SPF koperty |
| 8 | `_dmarc.news.midrev.pl` | TXT | `"v=DMARC1; p=quarantine; adkim=s; aspf=r; rua=mailto:dmarc@midrev.pl; fo=1"` | SPF relaxed, DKIM ścisły, raporty |
| 9 | `news.midrev.pl` | TXT | `google-site-verification=…` (konsola Admin Workspace) | alias domeny w Workspace |
| 10 | `news.midrev.pl` | MX | `1 smtp.google.com` | skrzynka zwrotna `newsletter@news.midrev.pl` |
| 11 | `news.midrev.pl` | TXT | `"v=spf1 include:_spf.google.com ~all"` | opcjonalny |
| 12 | `_dmarc.midrev.pl` (**zmiana**) | TXT | dopisać `rua=mailto:dmarc@midrev.pl` do obecnego `v=DMARC1; p=quarantine; adkim=s; aspf=s;` | raporty apexu; literówka psuje DMARC poczty Workspace, osobna zgoda |

Cofnięcie: usunięcie dodanych rekordów, dla #12 przywrócenie dokładnie obecnej wartości.
Kontrola: `host -t A esp.midrev.pl 1.1.1.1`, `host -t A link.midrev.pl 1.1.1.1`.

Opcjonalnie (panel OVH/Hetzner): PTR IP serwera na `esp.midrev.pl`. Nie jest potrzebny do
wysyłki przez SES, porządkuje tylko reverse DNS.

### 4.2 Pierwsze wdrożenie — WYMAGA ZGODY KRYSTIANA

Czysta, pusta baza produkcyjna (nie kopia dev: zgody z seedu, domena „zweryfikowana” przez
Mailpita, historia sandboxu; raport 02).

```bash
# 1. baza działa i jest lokalna
docker ps --filter name=midrev-esp-prod-db
ss -ltn | grep 5432            # tylko 127.0.0.1:5432

# 2. wdrożenie (build, migracje od 0001 na pustej bazie, start usług, healthcheck)
/srv/midrev-esp/ops/deploy.sh --archiwum /root/midrev-esp-<sha>.tar.gz
#   albo: /srv/midrev-esp/ops/deploy.sh --ref <tag|sha>

# 3. pierwszy administrator: hasło wypisane RAZ -> od razu do menedżera haseł
systemd-run --quiet --wait --pipe --collect -p User=midrev-esp -p Group=midrev-esp \
  -p WorkingDirectory=/srv/midrev-esp/current \
  -p EnvironmentFile=/srv/midrev-esp/shared/env/production.env \
  /usr/bin/env NODE_ENV=production /usr/bin/node --import tsx scripts/zasiej-operatora.ts
#   BEZ argumentu (hasło w argumencie ląduje w historii powłoki i w `ps`)

# 4. TLS: pierwsze wejście wystawi certyfikaty (DNS z 4.1 musi już wskazywać serwer)
curl -sI https://esp.midrev.pl/logowanie | head -1          # 200
curl -sI https://link.midrev.pl/logowanie | head -1         # 404 (panel NIE jest pod link.)
curl -s  https://esp.midrev.pl/api/zdrowie                  # 200

# 5. alert testowy (ma dojść na kanał techniczny)
bash -c '. /srv/midrev-esp/ops/lib/wspolne.sh; wyslij_alert info "test alertu z produkcji"'
```

Potem w panelu (kolejność z raportu 02): tenant **MidRev** (formularz na stronie głównej) →
serwer SMTP SES (tryb „przekaźnik”, koperta `bounce.news.midrev.pl`) → domena `news.midrev.pl`
→ skrzynka zwrotna → limit dobowy wg rampy z raportu 03 → popup na midrev.pl → flow
powitalny → mail testowy do Gmaila i Outlooka i sprawdzenie nagłówków (`dkim=pass`,
`spf=pass`, `dmarc=pass`, otwarcie widoczne w raporcie).

Pierwszy backup ręcznie i od razu próba odtworzenia (6.3), **przed** pierwszą kampanią:
```bash
systemctl start midrev-esp-backup.service && journalctl -u midrev-esp-backup -n 30
```

---

## 5. Aktualizacja wersji i rollback

### 5.1 Wdrożenie — WYMAGA ZGODY KRYSTIANA (każde)

```bash
/srv/midrev-esp/ops/deploy.sh --ref v0.2.0            # z klonu repo.git (git fetch)
/srv/midrev-esp/ops/deploy.sh --archiwum /root/midrev-esp-<sha>.tar.gz
/srv/midrev-esp/ops/deploy.sh --lista                 # wydania, aktywne oznaczone *
```

Przebieg `deploy.sh`:
1. blokada `flock`: drugie wdrożenie w tym samym czasie dostaje odmowę,
2. kontrole: prawa env 600, brak `MIDREV_SANDBOX` i `SMTP_HOSTY_DEWELOPERSKIE`, wymagane
   zmienne, baza odpowiada, ≥ 3 GB wolnego, **brak wysyłki w toku** (kampania `sending`
   albo wiadomości `claimed`/`sending`; obejście `--wymus-w-trakcie-wysylki`),
3. nowy katalog `releases/<UTC>`, kod, `npm ci` **pełne** (z devDependencies: worker i
   migracje chodzą przez `tsx`, build potrzebuje TypeScriptu i Tailwinda) i `next build`
   jako `midrev-esp`, **bez** zmiennych z `production.env` (sekrety nie mogą trafić do
   artefaktów buildu); jedyny wyjątek to opcjonalny `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
   (sekcja 3.2), który Next z założenia wkompilowuje. Plik `REVISION` (SHA albo sha256
   archiwum) powstaje przed buildem: `next.config.ts` robi z niego `deploymentId` (pełne
   przeładowanie zamiast miękkiej nawigacji, gdy karta ma inną wersję niż serwer) i wersję
   dla `/api/wersja`, na której strażnik w panelu pokazuje pasek „Jest nowa wersja panelu”,
4. symlinki `var` i `.next/cache`, kod na własność root (aplikacja nie zmieni własnego kodu),
5. zrzut bazy przed migracjami do `/var/backups/midrev-esp/przed-wdrozeniem/` (3 ostatnie),
6. łagodny stop workera (SIGTERM, do 45 s), migracje z **nowego** wydania
   (`systemd-run` z tym samym użytkownikiem i plikiem env co unity),
7. atomowe przełączenie `current`, restart **panelu**, sprawdzenie, że nowy panel odpowiada
   (`/logowanie` = 200), dopiero potem start **workera** nowego wydania (worker bierze
   zadania z kolejki, więc rusza jako ostatni),
8. healthcheck: oba unity aktywne, `GET /api/zdrowie` = 200 w 120 s, worker bez restartu
   przez 10 s po starcie,
9. porażka healthchecku = **automatyczny powrót** `current` do poprzedniego wydania
   i restart; alert na kanał techniczny,
10. sprzątanie: zostaje 5 najnowszych wydań (aktywne i poprzednie nigdy nie są kasowane).

Wynik każdego przebiegu: `/srv/midrev-esp/wdrozenia.log` i alert przy błędzie.

### 5.2 Rollback — WYMAGA ZGODY KRYSTIANA

```bash
/srv/midrev-esp/ops/deploy.sh --rollback                     # do poprzedniego wydania
/srv/midrev-esp/ops/deploy.sh --rollback 20261003T101500Z    # do wskazanego
```

Bez argumentu wybierane jest najnowsze starsze wydanie, które kiedyś przeszło healthcheck
(znacznik `.wdrozone-ok`). Jeśli rollback nie przejdzie healthchecku, skrypt wraca na
wydanie, z którego startował.

**Rollback i auto-rollback NIE cofają migracji.** Stary kod chodzi na nowym schemacie. Dlatego:
- migracje piszemy addytywnie (nowe kolumny z wartością domyślną, nowe tabele; bez
  `drop`/`rename` w tym samym wydaniu, które przestaje ich używać),
- jeśli migracja była niekompatybilna ze starym kodem, jedyna droga to odtworzenie zrzutu
  sprzed wdrożenia (`przed-wdrozeniem/przed-<UTC>.dump`, procedura 6.4, **WYMAGA ZGODY**)
  i utrata zapisów od chwili wdrożenia,
- migracja, która padła w połowie: każdy plik jest w osobnej transakcji, więc pliki
  **przed** błędnym są w bazie, błędny nie. `deploy.sh` wznawia workera na starym
  wydaniu. Sprawdź `select filename from schema_migrations order by 1 desc limit 5`.

### 5.3 Kiedy wdrażać

- Poza oknem wysyłki (nie w trakcie kampanii, nie w godzinie zaplanowanej kampanii).
- Nie w piątek po południu. Po wdrożeniu 15 minut obserwacji:
  `journalctl -fu midrev-esp-worker -u midrev-esp-web`.

### 5.4 Blokada migracji

`scripts/migrate.ts` **nie ma** `pg_advisory_lock` (sprawdzone 28.09). `deploy.sh`
chroni przed dwoma wdrożeniami naraz na tym serwerze (`flock`), ale nie przed ręcznym
`npm run migrate` uruchomionym obok. Zasada: migracje na produkcji wyłącznie przez
`deploy.sh`. Zadanie dla kodu: `select pg_advisory_lock(<stała>)` na początku `main()`
w `migrate.ts` (sekcja 10).

---

## 6. Backup i odtworzenie

### 6.1 Co i jak (timer `midrev-esp-backup.timer`, codziennie ok. 02:30 UTC)

1. `pg_dump -Fc` przez `docker exec` (spójny zrzut),
2. weryfikacja: rozmiar ≥ próg, `pg_restore --list`, ≥ 40 tabel, dane tabel
   `schema_migrations`, `consents`, `suppressions`, `tenant_suppressions`,
3. **próbne odtworzenie** każdego zrzutu do bazy `<baza>_backup_check` w tym samym
   kontenerze i porównanie liczby wierszy tabel kontrolnych z produkcją; baza próbna
   jest usuwana,
4. `tar` katalogu `shared/var/obrazy` (`var/importy` to przejściowe CSV z danymi osobowymi,
   do kopii nie idą),
5. manifest (SHA-256, liczby wierszy, rewizja kodu, wersja Postgresa),
6. szyfrowanie **age kluczem publicznym**; klucz prywatny istnieje tylko poza serwerem,
   plus podpis HMAC-SHA256 (`<plik>.sig`): age daje poufność, nie pochodzenie; bez podpisu
   ktoś z prawem zapisu do bucketu mógłby podrzucić „najnowszy backup”,
7. `rclone` do `<remote>/daily/`, pierwsza kopia tygodnia ISO także do `weekly/`,
   kontrola rozmiaru po stronie zdalnej,
8. retencja: domyślnie reguła cyklu życia bucketu (`RETENCJA_ZDALNA=0`, 3.4); przy
   `RETENCJA_ZDALNA=1` skrypt kasuje **po liczbie**: 14 dziennych, 8 tygodniowych (zepsuty
   backup nie wyczyści starych kopii); pliki o innych nazwach w buckecie nie są ruszane,
9. znacznik `/var/lib/midrev-esp-backup/ostatni-ok`, alert „info” przy każdej kopii
   tygodniowej (raz w tygodniu), alert „krytyczny” z powodem przy **każdym** błędzie.

Kopia na tym samym dysku (`/var/backups/midrev-esp/lokalne`, 2 szyfrogramy) służy tylko
wygodzie. Backupem jest kopia zdalna.

Ręcznie: `systemctl start midrev-esp-backup.service; journalctl -u midrev-esp-backup -n 50`.

### 6.2 Czego backup nie ma

- `production.env`, kluczy aplikacji, klucza age: menedżer haseł (3.3),
- danych sprzed ostatniego backupu (RPO 24 h). Przy klientach agencji: WAL archiving
  (pgBackRest) albo zrzut co godzinę.

### 6.3 Test odtworzenia (raz w miesiącu, bez zgody: nie dotyka produkcji)

```bash
# klucz prywatny tylko na czas testu, w RAM
install -m 600 /dev/null /dev/shm/age.key && nano /dev/shm/age.key      # wklej z menedżera haseł
/srv/midrev-esp/ops/backup/restore.sh --klucz /dev/shm/age.key --najnowszy
shred -u /dev/shm/age.key
docker exec midrev-esp-prod-db dropdb -U midrev_esp midrev_esp_restore_test
```

`restore.sh` odtwarza do **nowej** bazy `midrev_esp_restore_test` (albo `--baza <nowa>`),
bierze z bucketu tylko pliki tej instancji (`midrev-esp-<przyrostek>-<UTC>.tar.age`),
sprawdza podpis HMAC (gdy klucz podpisu jest na serwerze albo podany `--klucz-podpisu`),
waliduje archiwum obrazów (tylko zwykłe pliki pod `obrazy/`, bez linków i `..`),
sprawdza SHA-256 z manifestu, liczby wierszy (muszą się zgadzać dokładnie) i rozpakowuje
obrazy do osobnego katalogu. Odmawia: bazy produkcyjnej bez `--na-produkcje`, istniejącej
bazy innej niż domyślna testowa, baz systemowych, klucza publicznego zamiast prywatnego.
Raz na kwartał ten sam test na **świeżej** maszynie (np. VPS na godzinę albo lokalna
maszyna wirtualna), bez niczego ze starego serwera: provisioning (sekcja 2), pliki env
i `rclone.conf` odtworzone **wyłącznie z menedżera haseł** (sekcja 3.3), `restore.sh
--najnowszy`. To jedyny test, który sprawdza, że da się wstać po utracie całego VPS.

### 6.4 Odtworzenie produkcji — WYMAGA ZGODY KRYSTIANA

Tylko gdy baza produkcyjna jest utracona albo uszkodzona. Skrypt:
- wymaga poprawnego podpisu HMAC kopii,
- sprawdza, że manifest backupu dotyczy tej samej bazy (`POSTGRES_DB`) i że `DATABASE_URL`
  aplikacji wskazuje tę bazę,
- robi zrzut bezpieczeństwa obecnego stanu (`przed-restore-<UTC>.dump`),
- odtwarza backup do bazy **obok** (`midrev_esp_prod_nowa_<utc>`) i weryfikuje liczby wierszy,
- rozpakowuje obrazy do nowego katalogu obok (`shared/var/.obrazy-nowe-<UTC>`),
- dopiero potem zamienia nazwy: obecna produkcja → `midrev_esp_prod_przed_restore_<utc>`
  (nie jest usuwana), odtworzona → `midrev_esp_prod`. Błąd przed zamianą zostawia
  produkcję nietkniętą.
Na nowym serwerze (pusta baza z `POSTGRES_DB`) działa tak samo.

```bash
systemctl stop midrev-esp-worker midrev-esp-web
/srv/midrev-esp/ops/backup/restore.sh --klucz /dev/shm/age.key --najnowszy \
  --baza midrev_esp_prod --na-produkcje            # na nowym serwerze dodatkowo: --klucz-podpisu /dev/shm/hmac.key
#   wymaga roota, terminala, wpisania nazwy bazy i słowa NADPISUJE; odmawia, gdy web/worker działają
```

Po odtworzeniu, **przed** startem workera:
1. **Wypisy z luki.** Każdy, kto wypisał się po chwili backupu, jest w logu Caddy
   `/var/log/caddy/link.midrev.pl.access.log` (POST i GET na `/u/<token>`, 30 dni).
   Tokeny z luki trzeba zamapować na adresy (tabela `messages` sprzed awarii może nie mieć
   tych wiadomości: wtedy adresy z logów SES/skrzynki) i wprowadzić wypisy ręcznie w panelu.
   Wysłanie maila komuś, kto się wypisał, to naruszenie, nie usterka.
2. `deploy.sh --lista`: czy aktywne wydanie pasuje do schematu z backupu (rewizja w manifeście).
   Jeśli kod jest nowszy: `deploy.sh` z tą samą wersją uruchomi brakujące migracje.
3. `systemctl start midrev-esp-web`, sprawdzenie panelu, potem `systemctl start midrev-esp-worker`.

Obrazy: skrypt przenosi obecny `shared/var/obrazy` do `obrazy.przed-restore-<UTC>` i
rozpakowuje te z backupu.

---

## 7. Awarie

Odczyt (logi, statusy, SELECT-y) wolno zawsze. Restart, stop, zapis do bazy: **WYMAGA ZGODY**.

### 7.1 Worker padł albo restartuje się w kółko

```bash
systemctl status midrev-esp-worker
journalctl -u midrev-esp-worker -n 200 --no-pager
systemctl show -p NRestarts midrev-esp-worker
```
Typowe przyczyny:
- **Konfiguracja** („Konfiguracja niebezpieczna / niekompletna”): popraw `production.env`
  (**WYMAGA ZGODY**), potem `systemctl restart midrev-esp-worker`.
- **Baza niedostępna**: `docker ps`, `docker logs midrev-esp-prod-db --tail 100`.
  Kontener ma `restart: unless-stopped`; jeśli stoi, `docker compose -f
  /srv/midrev-esp/ops/docker-compose.prod.yml up -d` (**WYMAGA ZGODY**).
- **Partycje kolejki** (`create table ... partition of` przy starcie, raport 02 P1-8):
  worker stał dłużej niż 3 dni i joby wpadły do `jobs_default`.
  `select count(*), min(created_at) from jobs_default;` Naprawa to przeniesienie wierszy
  w transakcji (detach default, create, insert-select, attach): zapis do bazy,
  **WYMAGA ZGODY** i przeglądu Codeksem.
- **Pamięć** (`MemoryMax`, OOM w `journalctl -k`): `systemctl show -p MemoryPeak midrev-esp-worker`.

Po nowym wdrożeniu, które zepsuło workera: `deploy.sh --rollback` (**WYMAGA ZGODY**).

### 7.2 Kolejka rośnie

```sql
-- docker exec -it midrev-esp-prod-db psql -U midrev_esp -d midrev_esp_prod
select status, count(*), min(run_after) from jobs where created_at > now() - interval '3 days' group by 1;
select kind, count(*) from jobs where status = 'pending' and run_after < now() - interval '10 minutes' group by 1 order by 2 desc;
select kind, attempts, left(last_error, 200), created_at from jobs where status = 'failed' and created_at > now() - interval '1 day' order by created_at desc limit 20;
select id, name, sending_paused_at, sending_pause_reason from tenants where sending_paused_at is not null;
select count(*) from jobs_default;   -- > 0 = alarm (P1-8)
```
- Worker żyje, ale nie nadąża: sprawdź `WYSYLKA_ROZMIAR_PARTII` i limity dobowe tenantów.
  Drugiego workera nie uruchamiaj (tik automatyzacji mnoży się per proces, raport 02 P2-10).
- `pending` z przeszłym `run_after` i brak postępu: worker stoi → 7.1.
- Tenant wstrzymany (`sending_paused_at`): to decyzja progów reputacji (odbicia/skargi).
  Najpierw przyczyna, wznowienie w panelu dopiero po zrozumieniu.

### 7.3 Wiadomości `held`

`held` = wiadomość była w `sending`, gdy proces zginął, i nie wiadomo, czy wyszła. System
jej nie ponawia (ochrona przed podwójną wysyłką). Panelu dla `held` jeszcze nie ma.

```sql
select tenant_id, source_type, source_id, count(*), min(created_at), max(created_at)
  from messages where current_state = 'held' group by 1, 2, 3;
select count(*) from messages where current_state in ('claimed', 'sending') and claimed_at < now() - interval '15 minutes';
```
Rozstrzygnięcie: sprawdź w SES (zdarzenia wysyłki / logi) albo w skrzynce testowej, czy
mail wyszedł. Zmiana stanu to `UPDATE` produkcji: **WYMAGA ZGODY**, pojedynczo, z kontrolą
tożsamości wiadomości (lista kontrolna z `AGENTS.md`, punkt 8). W razie wątpliwości lepiej
nie wysłać niż wysłać dwa razy.

### 7.4 Panel nie działa, a worker tak

`systemctl status midrev-esp-web`, `journalctl -u midrev-esp-web -n 100`,
`curl -s http://127.0.0.1:3100/api/zdrowie`. Caddy: `systemctl status caddy`,
`journalctl -u caddy -n 100` (certyfikaty, DNS). Linki w mailach (`link.`) zależą od tego
samego procesu Next: panel leży = kliki i wypisy też. Wypis nie może czekać: priorytet.

### 7.5 Backup nie przyszedł / alert „Backup NIEUDANY”

`journalctl -u midrev-esp-backup -n 100`. Alert zawiera krok i powód. Najczęściej: rclone
(token, miejsce w buckecie), baza, dysk. Po naprawie `systemctl start midrev-esp-backup`.
Healthcheck ostrzega, gdy ostatni udany backup jest starszy niż 26 h.

---

## 8. Zmiany konfiguracji serwera

Każda zmiana na działającej produkcji **WYMAGA ZGODY KRYSTIANA**:

| Zmiana | Jak | Cofnięcie |
|---|---|---|
| `Caddyfile` | edycja w repo → `caddy validate --config deploy/Caddyfile --adapter caddyfile` → `provision.sh` (waliduje, kopiuje, `reload`; stara wersja zostaje jako `Caddyfile.przed-<UTC>`) | skopiować `Caddyfile.przed-*` i `systemctl reload caddy` |
| unity systemd | edycja w repo → `provision.sh` (daemon-reload) → restart danej usługi | poprzednia wersja z gita + provision |
| `production.env` | edycja pliku (600) → `systemctl restart midrev-esp-worker midrev-esp-web` | kopia pliku przed zmianą (`cp -a production.env production.env.przed-<data>`) |
| Postgres (wersja/parametry) | `docker compose -f /srv/midrev-esp/ops/docker-compose.prod.yml pull && up -d` w oknie bez wysyłki, **po** udanym backupie | poprzedni tag obrazu; główna wersja (18→19) tylko przez dump/restore |
| hasło bazy | `ALTER ROLE midrev_esp PASSWORD ...` + `db.env` + `DATABASE_URL` + restart | stare hasło |

Nowa trasa odbiorcy w aplikacji (dopisana do `src/trasy-publiczne.ts`) wymaga dopisania do
`@odbiorca` w `Caddyfile`, inaczej pod `link.` dostanie 404.

---

## 9. Aktualizacje systemu i reboot

- Poprawki bezpieczeństwa Debiana instalują się same (bez rebootu).
- Docker, containerd, Caddy, Node (repozytoria zewnętrzne): **raz w miesiącu ręcznie**,
  `apt update && apt list --upgradable`, potem `apt upgrade` w oknie bez wysyłki,
  **WYMAGA ZGODY** (aktualizacja Dockera restartuje kontener bazy).
- Reboot pod nowe jądro (`/var/run/reboot-required`): w oknie bez wysyłki, **WYMAGA ZGODY**.
  Po reboocie: `systemctl status midrev-esp-web midrev-esp-worker caddy`,
  `docker ps`, `curl -s http://127.0.0.1:3100/api/zdrowie`,
  `iptables -S DOCKER-USER | grep midrev-esp`.

---

## 10. Zależności od kodu aplikacji

Pakiet zakłada następujące elementy kodu (stan 28.09 wieczór, równoległa praca w `src/`):

| Zależność | Gdzie | Stan 28.09 | Co jeśli brak |
|---|---|---|---|
| `GET /api/zdrowie` (200/503, baza + heartbeat workera) | `src/app/api/zdrowie` | na liście tras publicznych, trasa w budowie | `deploy.sh` nie przejdzie healthchecku i zrobi rollback; healthcheck.timer alarmuje |
| `MIDREV_SANDBOX` jako jedyny przełącznik sandboxa | `src/config.ts` | jest | — |
| `TRACKING_URL` (domena śledzenia) | `src/config.ts` | jest | linki w mailach na `esp.` (Caddy na `link.` nieużywany) |
| `ALERT_WEBHOOK_URL` wymagany i https poza sandboksem | `src/config.ts` | jest | — |
| `TRUSTED_PROXY` (domyślnie `ostatni-xff`) | `src/config.ts` | jest | Caddy nadpisuje XFF, więc `ostatni-xff` i `x-real-ip` są poprawne |
| Łagodne zamknięcie workera na SIGTERM (< 45 s) | `src/jobs/worker.ts` | w budowie | po 45 s SIGKILL, wiadomość w `sending` → `held` po 15 min |
| `pg_advisory_lock` w migratorze | `scripts/migrate.ts` | **brak** (stan 28.09 wieczór) | dwa równoległe `migrate` = czerwony deploy; chroni `flock` w `deploy.sh` |
| `var/` liczony od `process.cwd()` | `obrazy/pliki.ts`, `import-klaviyo/pliki.ts` | jest | `deploy.sh` robi symlink `var -> shared/var`; cwd procesu to fizyczny katalog wydania (sprawdzone) |
| `next build` bez sekretów w środowisku | cała aplikacja | przechodzi (raport 02) | build się wyłoży: nie dawać sekretów do buildu, poprawić kod |
| `.next/cache` zapisywalny | Next | symlink do `shared/cache/next/<wydanie>` | reszta `.next` jest tylko do odczytu: ewentualne zapisy ISR poza `cache/` Next loguje jako ostrzeżenie; sprawdzić w journalu po pierwszym wdrożeniu (`EROFS`, `EACCES`) |

## 11. Serwer współdzielony (stan 30.09.2026: produkcja na VPS 137.74.42.199)

- Systemowy `/usr/bin/node` to v20, więc ESP używa izolowanego Node 24 w `/opt/node-24/bin`.
  Unity mają drop-iny `/etc/systemd/system/midrev-esp-{web,worker}.service.d/node24.conf`
  z `ExecStart` na `/opt/node-24/bin/node`. Wdrożenie: `NODE_DIR=/opt/node-24/bin deploy.sh ...`
  (skrypt odmówi, gdy node < 24 albo gdy unity uruchamiają inny node niż `NODE_DIR`).
- `provision.sh` NIE był uruchamiany (ruszałby ufw, daemon.json Dockera i DOCKER-USER innych projektów).
  Baza: `DB_PORT=5434 docker compose -f /srv/midrev-esp/ops/docker-compose.prod.yml up -d`.
- Caddy: bloki esp./link. dopisane do istniejącego /etc/caddy/Caddyfile (cloudcli, studio, crm).
