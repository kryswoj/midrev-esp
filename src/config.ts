import { isIP } from "node:net";
import { z } from "zod";

/** Domyślny adres sandboxa. Poza sandboksem ZABRONIONY (patrz guard niżej). */
const APP_URL_DOMYSLNY = "http://137.74.42.199:3005";

/** Adres bez ukośnika na końcu: `https://x.pl/` dałoby w mailach `https://x.pl//u/…`. */
const adresPubliczny = z
  .string()
  .url()
  .transform((u) => u.replace(/\/+$/, ""));

/** Wartości flagi, które znaczą „tak". Wszystko inne (w tym brak) = produkcja. */
const TAK = new Set(["1", "true", "tak", "yes"]);

// Jedyne miejsce w kodzie, które dotyka process.env (AD-1, konwencje).
// Walidacja przy starcie, żeby brak zmiennej wywalał proces od razu, a nie w środku
// wysyłki do klienta. Komunikat nazywa brakującą zmienną i nigdy nie pokazuje wartości.
const schemat = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL jest wymagany"),
  SECRETS_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "SECRETS_KEY musi być 32 bajtami zapisanymi szesnastkowo (64 znaki)")
    .default("0".repeat(64)),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  /* Klucz HMAC do haszy adresow na globalnej liscie wykluczen (0022). OSOBNY od
     SECRETS_KEY: rotacja klucza szyfrowania poswiadczen nie moze po cichu uniewaznic
     zaslepek po anonimizacji RODO. Bez wartosci: klucz pochodny od SECRETS_KEY
     z ostrzezeniem w logu (sandbox), poza sandboksem wymagany. */
  SUPPRESSION_HASH_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "SUPPRESSION_HASH_KEY musi byc 32 bajtami zapisanymi szesnastkowo (64 znaki)")
    .optional(),
  /* Adres PANELU: logowanie, ciasteczko sesji, akceptacja kampanii przez klienta,
     adres dostawy webhooków sklepu. Gdy TRACKING_URL nie jest ustawiony, na nim stoi
     też wszystko, co widzi odbiorca maila. */
  APP_URL: adresPubliczny.default(APP_URL_DOMYSLNY),
  /* Opcjonalna osobna domena ŚLEDZENIA (np. https://link.midrev.pl): kliki /r, pixel
     /api/o, wypis /u i List-Unsubscribe, obrazy /o, skrypt popupów /s i jego zgłoszenia
     /api/popup. Adres panelu nie leci wtedy w każdym mailu, a domena linków trafiona na
     listę URIBL nie zabiera ze sobą panelu. Linki w wysłanych mailach żyją latami:
     ustawić RAZ, przed pierwszym obrazem i pierwszą kampanią. Brak = APP_URL. */
  TRACKING_URL: adresPubliczny.optional(),
  /* Rozmiar partii wysyłki (ile wiadomości jedno wywołanie wyslijPartie zajmuje naraz).
     Między partiami silnik sprawdza wstrzymanie tenanta, status kampanii i progi
     reputacji, więc partia to zarazem „ziarno reakcji" na wstrzymanie. 100 = kompromis
     między przepustowością (jedno pooled połączenie SMTP na partię) a tym, że kampania
     sypiąca odbiciami stanie po stu, nie po tysiącu wiadomości. */
  WYSYLKA_ROZMIAR_PARTII: z.coerce.number().int().min(1).max(1000).default(100),
  /* Serwer „domyślny" dla tenanta bez własnego SMTP. Istnieje wyłącznie pod Mailpita:
     poza sandboksem ścieżka domyślna jest zablokowana (nadawca.ts), więc te trzy
     wartości na produkcji niczego nie wysyłają. */
  SMTP_HOST: z.string().default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().default(1025),
  MAIL_FROM: z.string().default("kampanie@midrev-esp.local"),
  /* Serwery SMTP, które wolno podać w panelu MIMO blokady adresów prywatnych (SSRF),
     w postaci "host:port" po przecinku, np. "127.0.0.1:1025" dla lokalnego Mailpita.
     Tylko dokładna para host:port z tej listy omija blokadę; pusta lista = tryb
     produkcyjny. Serwer z tej listy łapie pocztę lokalnie (nic nie wychodzi do
     internetu), więc wysyłka przez niego nie wymaga zweryfikowanej domeny (FR45).
     Jawna konfiguracja środowiska zamiast wyjątku ukrytego w kodzie. */
  SMTP_HOSTY_DEWELOPERSKIE: z
    .string()
    .default("")
    .transform((w) =>
      w
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    )
    .pipe(
      z.array(
        z.string().regex(/^[^\s:]+:\d{1,5}$|^\[[0-9a-f:.]+\]:\d{1,5}$/, "każda pozycja musi mieć postać host:port"),
      ),
    ),
  /* Tryb sandboxa (dev, testy). JAWNA flaga zamiast NODE_ENV: `next start` ustawia
     NODE_ENV sam, a worker (`node src/jobs/worker.ts`) nie, więc guard oparty na
     NODE_ENV nie działał dokładnie w procesie, który wkleja adresy do maili.
     Brak flagi = produkcja: każdy proces, który nie powie wprost „jestem sandboksem",
     dostaje pełne guardy. */
  MIDREV_SANDBOX: z
    .string()
    .optional()
    .transform((w) => TAK.has(String(w ?? "").trim().toLowerCase())),
  /* Skąd brać adres klienta do limitów (logowanie, popup) za reverse proxy:
       ostatni-xff — OSTATNI wpis X-Forwarded-For (Caddy nadpisuje XFF adresem klienta,
                     nginx z proxy_add_x_forwarded_for dopisuje go na końcu; pierwszy
                     wpis podaje klient i da się go sfałszować),
       x-real-ip   — nagłówek X-Real-IP ustawiany przez proxy,
       brak        — proxy nie ma: nagłówkom nie ufamy wcale (limit per IP wspólny). */
  TRUSTED_PROXY: z.enum(["ostatni-xff", "x-real-ip", "brak"]).optional(),
  /* Opcjonalny token do SZCZEGÓŁÓW healthchecku (/api/zdrowie?szczegoly=1 z nagłówkiem
     Authorization: Bearer <token>): głębokość kolejki, liczba held. Bez tokenu trasa
     podaje wyłącznie stan (ok/blad), bo jest publiczna. openssl rand -hex 32 */
  ZDROWIE_TOKEN: z.string().min(32, "ZDROWIE_TOKEN musi mieć co najmniej 32 znaki").optional(),
  /* Ponowne wejscie do automatyzacji ("za kazdym razem", "po uplywie czasu"), AD-41.
     Wlaczac DOPIERO po migracji 0036 (osobne wydanie, >= 7 dni po 0035). Kod i tak
     sprawdza w bazie, ze stare unikalnosci zniknely; sama flaga ich nie zdejmie. */
  /* Funkcje automatyzacji zapisywane w grafie v2: filtr wyzwalacza i metryki spoza
     wbudowanych (popup, zamowienie). Stary kod (sprzed tego wydania) nie czyta v2, wiec
     wlaczac PO weryfikacji wydania, gdy rollback kodu nie jest juz planowany. Do tego czasu
     wszystko zapisuje sie w v1 (grafDoZapisu), a rollback jest bezpieczny. */
  MIDREV_GRAF_V2: z
    .string()
    .optional()
    .transform((w) => TAK.has(String(w ?? "").trim().toLowerCase())),
  MIDREV_PONOWNE_WEJSCIE: z
    .string()
    .optional()
    .transform((w) => TAK.has(String(w ?? "").trim().toLowerCase())),
  NODE_ENV: z.string().optional(),
});

export type Konfiguracja = z.infer<typeof schemat>;

/** Host adresu jest gołym IP albo nazwą lokalną — takich adresów nie wkleja się do maili. */
function hostLokalnyAlboIp(adres: string): boolean {
  const host = new URL(adres).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    isIP(host) !== 0 ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  );
}

/**
 * Walidacja środowiska BEZ pamięci podręcznej: czysta funkcja, którą testy wołają
 * z dowolnym zestawem zmiennych. Rzuca z nazwą zmiennej, nigdy z jej wartością.
 */
export function zbudujKonfiguracje(env: Record<string, string | undefined>): Konfiguracja {
  const wynik = schemat.safeParse(env);
  if (!wynik.success) {
    const brakujace = wynik.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Konfiguracja niekompletna — ${brakujace}`);
  }
  const k = wynik.data;
  const blad = (tresc: string) => new Error(`Konfiguracja niebezpieczna — ${tresc}`);

  // Sandbox na buildzie produkcyjnym to wyłączone guardy tam, gdzie są potrzebne.
  // Ten jeden warunek patrzy na NODE_ENV, bo tylko zawęża (nigdy nie luzuje) guardy.
  if (k.MIDREV_SANDBOX && k.NODE_ENV === "production") {
    throw blad("MIDREV_SANDBOX nie może być ustawiony przy NODE_ENV=production");
  }
  if (k.MIDREV_SANDBOX) return k;

  // ── Poniżej: wszystko, co nie jest jawnym sandboksem ──────────────────────────
  // Lista serwerów deweloperskich omija blokadę SSRF i blokadę domeny (FR45). Poza
  // sandboksem to dziura, a nie wygoda, więc proces odmawia startu.
  if (k.SMTP_HOSTY_DEWELOPERSKIE.length > 0) {
    throw blad("SMTP_HOSTY_DEWELOPERSKIE musi być puste poza sandboksem (MIDREV_SANDBOX)");
  }
  // Domyślny klucz z samych zer jest wygodą sandboxa. Poza nim szyfruje realne
  // poświadczenia (sklepy, hasła SMTP klientów), więc wyciek bazy = wyciek haseł.
  if (/^0+$/.test(k.SECRETS_KEY)) {
    throw blad("SECRETS_KEY nie może być domyślnym kluczem poza sandboksem (openssl rand -hex 32)");
  }
  if (!k.SUPPRESSION_HASH_KEY || /^0+$/.test(k.SUPPRESSION_HASH_KEY)) {
    throw blad("SUPPRESSION_HASH_KEY jest wymagany poza sandboksem i nie może być zerami");
  }
  if (k.SUPPRESSION_HASH_KEY.toLowerCase() === k.SECRETS_KEY.toLowerCase()) {
    throw blad("SUPPRESSION_HASH_KEY musi być inny niż SECRETS_KEY");
  }
  // Alert, którego nikt nie dostaje, to log, którego nikt nie czyta (NFR38): wstrzymanie
  // wysyłki przez progi reputacji albo held po awarii ma dotrzeć do człowieka.
  if (!k.ALERT_WEBHOOK_URL) {
    throw blad("ALERT_WEBHOOK_URL jest wymagany poza sandboksem (kanał techniczny na Discordzie/Slacku)");
  }
  // Zaufanie do nagłówków proxy musi być DECYZJĄ operatora: domyślne „ostatni-xff" przy
  // aplikacji wystawionej bez proxy oddawałoby klientowi wybór licznika limitu logowania.
  // „brak" (nie ufam nagłówkom) wyłączałby limit prób logowania per IP (review Codeksa r2):
  // produkcja stoi za proxy i ma powiedzieć, jak ono podaje adres klienta.
  if (!k.TRUSTED_PROXY || k.TRUSTED_PROXY === "brak") {
    throw blad("TRUSTED_PROXY jest wymagany poza sandboksem: ostatni-xff (Caddy/nginx przed aplikacją) albo x-real-ip");
  }
  if (!/^https:\/\//i.test(k.ALERT_WEBHOOK_URL)) {
    throw blad("ALERT_WEBHOOK_URL musi zaczynać się od https:// poza sandboksem");
  }
  // Linki w mailach (klik, wypis, pixel, obrazy) i ciasteczko sesji stoją na APP_URL
  // i TRACKING_URL. Gołe IP po http to filtr antyspamowy na każdym mailu, a RFC 8058
  // wymaga HTTPS dla wypisu jednym kliknięciem.
  const adresy: [string, string | undefined][] = [
    ["APP_URL", k.APP_URL],
    ["TRACKING_URL", k.TRACKING_URL],
  ];
  if (k.APP_URL === APP_URL_DOMYSLNY) {
    throw blad("APP_URL musi być ustawione jawnie poza sandboksem (domyślny adres sandboxa jest zabroniony)");
  }
  for (const [nazwa, adres] of adresy) {
    if (adres === undefined) continue;
    if (!/^https:\/\//i.test(adres)) throw blad(`${nazwa} musi zaczynać się od https:// poza sandboksem`);
    if (hostLokalnyAlboIp(adres)) throw blad(`${nazwa} nie może wskazywać na adres IP ani nazwę lokalną poza sandboksem`);
    const u = new URL(adres);
    if (u.pathname !== "/" && u.pathname !== "") throw blad(`${nazwa} ma być samym adresem hosta, bez ścieżki`);
    if (u.search || u.hash || u.username || u.password) throw blad(`${nazwa} nie może mieć parametrów, kotwicy ani danych logowania`);
  }
  return k;
}

let zbuforowana: Konfiguracja | undefined;

export function config(): Konfiguracja {
  if (zbuforowana) return zbuforowana;
  zbuforowana = zbudujKonfiguracje(process.env);
  return zbuforowana;
}

/** Czy proces działa w jawnym trybie sandboxa (MIDREV_SANDBOX=1). */
export function trybSandbox(): boolean {
  return config().MIDREV_SANDBOX;
}

/**
 * Adres, pod którym odbiorca maila widzi NASZE trasy: kliki, pixel, wypis, obrazy,
 * skrypt popupów. TRACKING_URL, a bez niego APP_URL. Panel i akceptacja kampanii
 * zostają na APP_URL.
 */
export function adresSledzenia(): string {
  const k = config();
  return k.TRACKING_URL ?? k.APP_URL;
}

/**
 * Opis konfiguracji do logu startowego: nazwy hostów i tryb, BEZ sekretów i bez
 * adresu bazy (w DATABASE_URL jest hasło).
 */
export function opisKonfiguracji(): string {
  const k = config();
  const host = (a: string) => new URL(a).host;
  return [
    `tryb=${k.MIDREV_SANDBOX ? "sandbox" : "produkcja"}`,
    `panel=${host(k.APP_URL)}`,
    `sledzenie=${host(adresSledzenia())}`,
    `alerty=${k.ALERT_WEBHOOK_URL ? "webhook" : "tylko log"}`,
    `proxy=${k.TRUSTED_PROXY ?? "ostatni-xff (sandbox)"}`,
  ].join(" ");
}
