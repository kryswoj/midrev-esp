import { isIP } from "node:net";
import { config, type Konfiguracja } from "../config";

/**
 * Adres klienta do LIMITÓW (prób logowania, zgłoszeń z popupu) za reverse proxy.
 *
 * Dotąd limit brał PIERWSZY wpis `X-Forwarded-For`. Ten wpis podaje klient: nginx
 * z `proxy_add_x_forwarded_for` DOPISUJE prawdziwy adres na końcu, więc atakujący
 * z nagłówkiem `X-Forwarded-For: <losowy>` dostawał przy każdej próbie nowy licznik
 * i limit per IP przestawał istnieć (limit per konto zostawał).
 *
 * Źródło wybiera operator (TRUSTED_PROXY), zgodnie z tym, co robi JEGO proxy:
 *   ostatni-xff — OSTATNI wpis XFF, czyli adres, który zobaczyło nasze (jedyne) proxy.
 *                 Caddy domyślnie nie ufa przychodzącemu XFF i ustawia go na adres
 *                 klienta (jeden wpis), nginx dopisuje go na końcu — w obu przypadkach
 *                 ostatni wpis to prawda. Domyślne.
 *   x-real-ip   — nagłówek X-Real-IP (nginx: `proxy_set_header X-Real-IP $remote_addr`).
 *   brak        — aplikacja stoi bez proxy: nagłówkom nie ufamy wcale; wszyscy klienci
 *                 dzielą jeden licznik (lepsze to niż licznik, który klient sam wybiera).
 *
 * Zwraca null, gdy adresu nie da się odczytać jednoznacznie. Wołający decyduje, co
 * wtedy (wspólny kubełek „nieznane").
 */
export function adresKlienta(
  naglowki: Headers,
  // poza sandboksem config wymaga jawnej wartości; w sandboksie (dev za Caddy/bez) domyślnie ostatni-xff
  tryb: NonNullable<Konfiguracja["TRUSTED_PROXY"]> = config().TRUSTED_PROXY ?? "ostatni-xff",
): string | null {
  let surowy: string | null | undefined;
  if (tryb === "ostatni-xff") {
    const wpisy = (naglowki.get("x-forwarded-for") ?? "").split(",").map((w) => w.trim()).filter(Boolean);
    surowy = wpisy[wpisy.length - 1];
  } else if (tryb === "x-real-ip") {
    surowy = naglowki.get("x-real-ip");
  } else {
    return null;
  }
  const kandydat = surowy?.trim();
  if (!kandydat) return null;
  // forma "[::1]:443" i "1.2.3.4:5678" z części proxy: samo IP
  const koniec = kandydat.indexOf("]");
  let ip = kandydat.startsWith("[") && koniec !== -1 ? kandydat.slice(1, koniec) : kandydat;
  if (!isIP(ip) && /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  return isIP(ip) ? ip : null;
}
