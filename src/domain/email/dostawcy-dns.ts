/**
 * Rozpoznanie dostawcy DNS po serwerach NS i krótka instrukcja „gdzie to wpisać".
 *
 * `kropkaNaKoncu`: czy w polu Wartość dla CNAME/MX trzeba podać nazwę zakończoną kropką.
 * Panele oparte na DirectAdmin/cPanel/BIND traktują wartość bez kropki jako WZGLĘDNĄ
 * i doklejają nazwę strefy (lekcja z Hostido 30.09: MX midrev.pl → smtp.google.com.midrev.pl,
 * poczta firmy stanęła). Dla nieznanego dostawcy podajemy kropkę: pełna nazwa z kropką jest
 * poprawna w każdym panelu, który ją przyjmuje, a pozostałe ją po prostu usuwają.
 * Cloudflare i GoDaddy kropki nie potrzebują (dodają ją same), więc jej nie pokazujemy.
 */

export interface DostawcaDns {
  klucz: string;
  nazwa: string;
  wzorce: RegExp[];
  kropkaNaKoncu: boolean;
  /** jedno, dwa zdania: gdzie w panelu jest strefa DNS */
  gdzie: string;
  link: string | null;
  /** dodatkowa pułapka tego panelu, jeśli jest */
  uwaga?: string;
  /**
   * Rekord NS dla subdomeny („jeden wpis"). Research 02.10.2026 (pomoc dostawców, linki w
   * raporcie 08-delegacja-ns.md): wszystkie znane panele na to pozwalają. `nsDlaSubdomeny:
   * false` = panel blokuje, kreator proponuje wtedy rekordy ręczne jako zalecane.
   */
  nsDlaSubdomeny: boolean;
  /** jeden rekord przyjmuje kilka serwerów (Google Cloud DNS); reszta: osobny wiersz na serwer */
  nsWJednymWpisie: boolean;
  /** pułapka panelu przy NS, jedno zdanie */
  nsUwaga?: string;
}

export const DOSTAWCY_DNS: readonly DostawcaDns[] = [
  {
    klucz: "hostido",
    nazwa: "Hostido",
    wzorce: [/(^|\.)hostido\.net\.pl$/],
    kropkaNaKoncu: true,
    gdzie: "Panel klienta Hostido → Twoje usługi → DirectAdmin → Zarządzanie DNS (wybierz domenę).",
    link: "https://panel.hostido.pl",
    uwaga: "Ten panel dokleja nazwę domeny do adresów bez kropki na końcu. Wartości rekordów CNAME i MX kopiuj razem z kropką; rekordy TXT wklej bez zmian.",
    nsDlaSubdomeny: true,
    nsWJednymWpisie: false,
    nsUwaga: "Wpis zadziała, jeśli domena korzysta z serwerów Hostido (ns1.hostido.net.pl).",
  },
  {
    klucz: "homepl",
    nazwa: "home.pl",
    wzorce: [/(^|\.)home\.pl$/, /(^|\.)homenet\.pl$/],
    kropkaNaKoncu: true,
    gdzie: "Panel home.pl → Domeny → wybierz domenę → Strefa DNS → Dodaj rekord.",
    link: "https://panel.home.pl",
    nsDlaSubdomeny: true,
    nsWJednymWpisie: false,
    nsUwaga: "Nie zakładaj subdomeny news jako osobnej usługi w panelu, dodaj sam rekord.",
  },
  {
    klucz: "ovh",
    nazwa: "OVHcloud",
    wzorce: [/(^|\.)ovh\.net$/, /(^|\.)ovh\.ca$/, /(^|\.)anycast\.me$/],
    kropkaNaKoncu: true,
    gdzie: "Panel OVHcloud → Web Cloud → Nazwy domen → wybierz domenę → zakładka Strefa DNS → Dodaj rekord.",
    link: "https://www.ovh.com/manager/",
    nsDlaSubdomeny: true,
    nsWJednymWpisie: false,
  },
  {
    klucz: "nazwapl",
    nazwa: "nazwa.pl",
    wzorce: [/(^|\.)nazwa\.pl$/],
    kropkaNaKoncu: true,
    gdzie: "Panel nazwa.pl → Domeny → wybierz domenę → Zarządzanie strefą DNS.",
    link: "https://admin.nazwa.pl",
    nsDlaSubdomeny: true,
    nsWJednymWpisie: false,
    nsUwaga: "Najpierw włącz „Ręczna konfiguracja DNS” dla tej domeny (przycisk „Zmień”).",
  },
  {
    klucz: "cloudflare",
    nazwa: "Cloudflare",
    wzorce: [/\.ns\.cloudflare\.com$/],
    kropkaNaKoncu: false,
    gdzie: "Cloudflare → wybierz domenę → DNS → Records → Add record.",
    link: "https://dash.cloudflare.com",
    uwaga: "Przy rekordach CNAME wyłącz pomarańczową chmurkę (ustaw „DNS only”), inaczej sprawdzenie nie przejdzie.",
    nsDlaSubdomeny: true,
    nsWJednymWpisie: false,
  },
  {
    klucz: "godaddy",
    nazwa: "GoDaddy",
    wzorce: [/(^|\.)domaincontrol\.com$/],
    kropkaNaKoncu: false,
    gdzie: "GoDaddy → Moje produkty → Domeny → wybierz domenę → DNS → Dodaj nowy rekord.",
    link: "https://dcc.godaddy.com/control/portfolio",
    nsDlaSubdomeny: true,
    nsWJednymWpisie: false,
    nsUwaga: "GoDaddy może poprosić o kod z SMS przy zapisie (ochrona domeny).",
  },
  {
    klucz: "cyberfolks",
    nazwa: "cyber_Folks",
    wzorce: [/(^|\.)cyberfolks\.pl$/, /(^|\.)cyber-folks\.pl$/],
    kropkaNaKoncu: true,
    gdzie: "Panel cyber_Folks → DirectAdmin → Zarządzanie DNS (wybierz domenę).",
    link: "https://panel.cyberfolks.pl",
    uwaga: "Ten panel dokleja nazwę domeny do adresów bez kropki na końcu. Wartości rekordów CNAME i MX kopiuj razem z kropką; rekordy TXT wklej bez zmian.",
    nsDlaSubdomeny: true,
    nsWJednymWpisie: false,
  },
  {
    klucz: "lhpl",
    nazwa: "LH.pl",
    wzorce: [/(^|\.)lh\.pl$/, /(^|\.)lh\.com\.pl$/],
    kropkaNaKoncu: true,
    gdzie: "Panel LH.pl → Domeny → wybierz domenę → Strefa DNS.",
    link: "https://panel.lh.pl",
    nsDlaSubdomeny: true,
    nsWJednymWpisie: false,
    nsUwaga: "Wpis zadziała, jeśli domena korzysta z serwerów LH.pl. W przeciwnym razie panel pozwala tylko zmienić serwery całej domeny: wtedy wpisz rekordy samodzielnie.",
  },
  {
    klucz: "google",
    nazwa: "Google Cloud DNS",
    wzorce: [/(^|\.)googledomains\.com$/],
    kropkaNaKoncu: true,
    gdzie: "Google Cloud Console → Network services → Cloud DNS → wybierz strefę → Add standard.",
    link: "https://console.cloud.google.com/net-services/dns/zones",
    nsDlaSubdomeny: true,
    nsWJednymWpisie: true,
    nsUwaga: "Jeśli domena jest w Squarespace (dawniej Google Domains): ten panel przyjmuje wpis NS dla subdomeny dopiero po wyłączeniu DNSSEC w ustawieniach domeny. Jeśli nie chcesz go wyłączać, wpisz rekordy samodzielnie (niżej).",
  },
];

export const DOSTAWCA_NIEZNANY: DostawcaDns = {
  klucz: "inny",
  nazwa: "Twój dostawca domeny",
  wzorce: [],
  kropkaNaKoncu: true,
  gdzie: "Zaloguj się tam, gdzie kupiłeś domenę albo masz hosting, i znajdź „Strefa DNS”, „Rekordy DNS” albo „Zarządzanie DNS”.",
  link: null,
  nsDlaSubdomeny: true,
  nsWJednymWpisie: false,
};

/** Dostawca po liście serwerów NS strefy (nazwy bez kropki, dowolna wielkość liter). */
export function rozpoznajDostawce(serweryNs: readonly string[]): DostawcaDns {
  const nazwy = serweryNs.map((n) => n.trim().toLowerCase().replace(/\.$/, ""));
  for (const d of DOSTAWCY_DNS) {
    if (nazwy.some((n) => d.wzorce.some((w) => w.test(n)))) return d;
  }
  return DOSTAWCA_NIEZNANY;
}

export function dostawcaPoKluczu(klucz: string | null | undefined): DostawcaDns {
  return DOSTAWCY_DNS.find((d) => d.klucz === klucz) ?? DOSTAWCA_NIEZNANY;
}
