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
  },
  {
    klucz: "homepl",
    nazwa: "home.pl",
    wzorce: [/(^|\.)home\.pl$/, /(^|\.)homenet\.pl$/],
    kropkaNaKoncu: true,
    gdzie: "Panel home.pl → Domeny → wybierz domenę → Strefa DNS → Dodaj rekord.",
    link: "https://panel.home.pl",
  },
  {
    klucz: "ovh",
    nazwa: "OVHcloud",
    wzorce: [/(^|\.)ovh\.net$/, /(^|\.)ovh\.ca$/, /(^|\.)anycast\.me$/],
    kropkaNaKoncu: true,
    gdzie: "Panel OVHcloud → Web Cloud → Nazwy domen → wybierz domenę → zakładka Strefa DNS → Dodaj rekord.",
    link: "https://www.ovh.com/manager/",
  },
  {
    klucz: "nazwapl",
    nazwa: "nazwa.pl",
    wzorce: [/(^|\.)nazwa\.pl$/],
    kropkaNaKoncu: true,
    gdzie: "Panel nazwa.pl → Domeny → wybierz domenę → Zarządzanie strefą DNS.",
    link: "https://admin.nazwa.pl",
  },
  {
    klucz: "cloudflare",
    nazwa: "Cloudflare",
    wzorce: [/\.ns\.cloudflare\.com$/],
    kropkaNaKoncu: false,
    gdzie: "Cloudflare → wybierz domenę → DNS → Records → Add record.",
    link: "https://dash.cloudflare.com",
    uwaga: "Przy rekordach CNAME wyłącz pomarańczową chmurkę (ustaw „DNS only”), inaczej sprawdzenie nie przejdzie.",
  },
  {
    klucz: "godaddy",
    nazwa: "GoDaddy",
    wzorce: [/(^|\.)domaincontrol\.com$/],
    kropkaNaKoncu: false,
    gdzie: "GoDaddy → Moje produkty → Domeny → wybierz domenę → DNS → Dodaj nowy rekord.",
    link: "https://dcc.godaddy.com/control/portfolio",
  },
  {
    klucz: "cyberfolks",
    nazwa: "cyber_Folks",
    wzorce: [/(^|\.)cyberfolks\.pl$/, /(^|\.)cyber-folks\.pl$/],
    kropkaNaKoncu: true,
    gdzie: "Panel cyber_Folks → DirectAdmin → Zarządzanie DNS (wybierz domenę).",
    link: "https://panel.cyberfolks.pl",
    uwaga: "Ten panel dokleja nazwę domeny do adresów bez kropki na końcu. Wartości rekordów CNAME i MX kopiuj razem z kropką; rekordy TXT wklej bez zmian.",
  },
  {
    klucz: "lhpl",
    nazwa: "LH.pl",
    wzorce: [/(^|\.)lh\.pl$/, /(^|\.)lh\.com\.pl$/],
    kropkaNaKoncu: true,
    gdzie: "Panel LH.pl → Domeny → wybierz domenę → Strefa DNS.",
    link: "https://panel.lh.pl",
  },
  {
    klucz: "google",
    nazwa: "Google Cloud DNS",
    wzorce: [/(^|\.)googledomains\.com$/],
    kropkaNaKoncu: true,
    gdzie: "Google Cloud Console → Network services → Cloud DNS → wybierz strefę → Add standard.",
    link: "https://console.cloud.google.com/net-services/dns/zones",
  },
];

export const DOSTAWCA_NIEZNANY: DostawcaDns = {
  klucz: "inny",
  nazwa: "Twój dostawca domeny",
  wzorce: [],
  kropkaNaKoncu: true,
  gdzie: "Zaloguj się tam, gdzie kupiłeś domenę albo masz hosting, i znajdź „Strefa DNS”, „Rekordy DNS” albo „Zarządzanie DNS”.",
  link: null,
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
