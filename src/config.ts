import { z } from "zod";

/** Domyślny adres sandboxa. Na produkcji jest ZABRONIONY (patrz guard niżej). */
const APP_URL_DOMYSLNY = "http://137.74.42.199:3005";

// Jedyne miejsce w kodzie, które dotyka process.env (AD-1, konwencje).
// Walidacja przy starcie, żeby brak zmiennej wywalał proces od razu, a nie w środku
// wysyłki do klienta. Komunikat nazywa brakującą zmienną i nigdy nie pokazuje wartości.
const schemat = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL jest wymagany"),
  SECRETS_KEY: z
    .string()
    .length(64, "SECRETS_KEY musi być 32 bajtami zapisanymi szesnastkowo (64 znaki)")
    .default("0".repeat(64)),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  /* Klucz HMAC do haszy adresow na globalnej liscie wykluczen (0022). OSOBNY od
     SECRETS_KEY: rotacja klucza szyfrowania poswiadczen nie moze po cichu uniewaznic
     zaslepek po anonimizacji RODO. Bez wartosci: klucz pochodny od SECRETS_KEY
     z ostrzezeniem w logu (sandbox), na produkcji wymagany. */
  SUPPRESSION_HASH_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "SUPPRESSION_HASH_KEY musi byc 32 bajtami zapisanymi szesnastkowo (64 znaki)")
    .optional(),
  /* Publiczny adres aplikacji: na nim stoją linki w mailach (klik, wypisanie, akceptacja).
     Link w mailu musi działać u odbiorcy, nie na localhost. */
  APP_URL: z.string().url().default(APP_URL_DOMYSLNY),
  /* Rozmiar partii wysyłki (ile wiadomości jedno wywołanie wyslijPartie zajmuje naraz).
     Między partiami silnik sprawdza wstrzymanie tenanta, status kampanii i progi
     reputacji, więc partia to zarazem „ziarno reakcji" na wstrzymanie. 100 = kompromis
     między przepustowością (jedno pooled połączenie SMTP na partię) a tym, że kampania
     sypiąca odbiciami stanie po stu, nie po tysiącu wiadomości. */
  WYSYLKA_ROZMIAR_PARTII: z.coerce.number().int().min(1).max(1000).default(100),
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
  NODE_ENV: z.string().optional(),
});

let zbuforowana: z.infer<typeof schemat> | undefined;

export function config() {
  if (zbuforowana) return zbuforowana;
  const wynik = schemat.safeParse(process.env);
  if (!wynik.success) {
    const brakujace = wynik.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Konfiguracja niekompletna — ${brakujace}`);
  }
  // Lista serwerów deweloperskich omija blokadę SSRF i blokadę domeny (FR45). Na
  // produkcji to byłaby dziura, a nie wygoda, więc proces odmawia startu zamiast
  // ostrzegać w logu, którego nikt nie czyta.
  if (wynik.data.NODE_ENV === "production" && wynik.data.SMTP_HOSTY_DEWELOPERSKIE.length > 0) {
    throw new Error("Konfiguracja niebezpieczna — SMTP_HOSTY_DEWELOPERSKIE nie może być ustawione przy NODE_ENV=production");
  }
  // Domyślny klucz z samych zer jest wygodą sandboxa. Na produkcji szyfruje nim realne
  // poświadczenia (sklepy, hasła SMTP klientów), więc wyciek bazy = wyciek haseł.
  if (wynik.data.NODE_ENV === "production" && /^0+$/.test(wynik.data.SECRETS_KEY)) {
    throw new Error("Konfiguracja niebezpieczna — SECRETS_KEY nie może być domyślnym kluczem przy NODE_ENV=production");
  }
  if (wynik.data.NODE_ENV === "production" && (!wynik.data.SUPPRESSION_HASH_KEY || /^0+$/.test(wynik.data.SUPPRESSION_HASH_KEY))) {
    throw new Error("Konfiguracja niebezpieczna — SUPPRESSION_HASH_KEY jest wymagany i nie może być zerami przy NODE_ENV=production");
  }
  // Linki w mailach (klik, wypisanie, pixel, akceptacja) i ciasteczko sesji stoją na
  // APP_URL. Domyślne gołe IP po http na produkcji to filtr antyspamowy na każdym mailu
  // i sesja panelu bez TLS — proces ma odmówić startu, a nie wysłać pierwszą kampanię
  // z takimi linkami.
  if (wynik.data.NODE_ENV === "production") {
    if (wynik.data.APP_URL === APP_URL_DOMYSLNY) {
      throw new Error("Konfiguracja niebezpieczna — APP_URL musi być ustawione jawnie przy NODE_ENV=production (domyślny adres sandboxa jest zabroniony)");
    }
    if (!/^https:\/\//i.test(wynik.data.APP_URL)) {
      throw new Error("Konfiguracja niebezpieczna — APP_URL musi zaczynać się od https:// przy NODE_ENV=production");
    }
  }
  zbuforowana = wynik.data;
  return zbuforowana;
}
