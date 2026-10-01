/**
 * Układ domeny wysyłkowej przy wysyłce platformowej i rekordy DNS do skopiowania.
 * Czysta logika (zero sieci, zero bazy) — testowana w tests/domena-platformowa.test.ts.
 *
 * Decyzje produktu (01.10.2026, „ma być banalne"):
 *   - domyślnie wysyłamy z SUBDOMENY news.<domena>: skarga na newsletter nie uderza
 *     w zwykłą pocztę firmy, a rekordy nie dotykają poczty firmowej (MX/SPF domeny głównej),
 *   - adres nadawcy: część przed @ z wpisu klienta (albo „newsletter") @ subdomena,
 *   - koperta zwrotna: bounce.<subdomena> (SPEC 2: jedna konwencja, zero decyzji klienta),
 *   - DMARC dobierany sam: subdomena dziedziczy politykę domeny głównej; dokładamy WŁASNY
 *     rekord tylko, gdy (a) nie ma żadnego (Gmail/Yahoo wymagają) albo (b) domena główna ma
 *     ścisłe dopasowanie SPF (aspf=s), przy którym koperta bounce.news nie daje wyrównania
 *     — wtedy kopia polityki z aspf=r (tak zrobiliśmy dla news.midrev.pl, 30.09).
 *     adkim=s nie przeszkadza: podpis jest dokładnie domeną nadawcy.
 */

export const PREFIKS_DOMYSLNY = "news";
export const LOKALNA_DOMYSLNA = "newsletter";

const ETYKIETA = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LOKALNA = /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/;

export interface WpisNadawcy {
  /** część adresu przed @, gdy klient wpisał adres; null = sama domena */
  lokalna: string | null;
  domena: string;
}

function domenaAscii(surowa: string): string | null {
  const d = surowa.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, "").replace(/^www\./, "");
  let ascii = "";
  try {
    ascii = d ? new URL(`http://${d}`).hostname : "";
  } catch {
    return null;
  }
  if (!ascii || ascii.length > 253 || !ascii.includes(".")) return null;
  const etykiety = ascii.split(".");
  if (!etykiety.every((e) => ETYKIETA.test(e))) return null;
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$|^xn--[a-z0-9-]+$/.test(etykiety[etykiety.length - 1])) return null;
  return ascii;
}

/** „sklep.pl", „Newsletter@Sklep.pl", „https://www.sklep.pl/" → { lokalna, domena }. */
export function rozbierzWpis(surowy: string): WpisNadawcy | null {
  const t = surowy.trim();
  if (!t || t.length > 320 || /[\s<>,;"]/.test(t)) return null;
  if (t.includes("@")) {
    const czesci = t.split("@");
    if (czesci.length !== 2) return null;
    const lokalna = czesci[0].toLowerCase();
    const domena = domenaAscii(czesci[1]);
    if (!domena || !LOKALNA.test(lokalna) || lokalna.includes("..")) return null;
    return { lokalna, domena };
  }
  const domena = domenaAscii(t);
  return domena ? { lokalna: null, domena } : null;
}

export function poprawnaLokalna(l: string): boolean {
  return LOKALNA.test(l) && !l.includes("..");
}

export function poprawnyPrefiks(p: string): boolean {
  return p === "" || p.split(".").every((e) => ETYKIETA.test(e));
}

/** Tagi rekordu DMARC (klucze małymi literami, wartości bez spacji). */
export function tagiDmarc(rekord: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of rekord.split(";")) {
    const i = c.indexOf("=");
    if (i > 0) m.set(c.slice(0, i).trim().toLowerCase(), c.slice(i + 1).trim());
  }
  return m;
}

export interface DecyzjaDmarc {
  /** rekord do wpisania pod _dmarc.<domena wysyłkowa>; null = nic nie trzeba dodawać */
  propozycja: string | null;
  /** zdanie dla klienta, bez żargonu */
  opis: string;
  /** czy domena główna ma ścisłe zasady (do raportu i testów) */
  scisly: boolean;
}

export function decyzjaDmarc(o: {
  domenaWysylkowa: string;
  strefa: string;
  /** rekord DMARC domeny głównej (strefy) albo null */
  rekordStrefy: string | null;
  /** własny rekord DMARC domeny wysyłkowej albo null */
  rekordWlasny: string | null;
}): DecyzjaDmarc {
  if (o.rekordWlasny) {
    return { propozycja: null, opis: "Zasady ochrony przed podszywaniem są już ustawione.", scisly: false };
  }
  if (!o.rekordStrefy) {
    return {
      propozycja: "v=DMARC1; p=none",
      opis: "Gmail i Yahoo wymagają rekordu ochrony przed podszywaniem. Twoja domena go nie ma, więc dodajemy najłagodniejszą wersję, która niczego nie blokuje.",
      scisly: false,
    };
  }
  const t = tagiDmarc(o.rekordStrefy);
  const scisly = (t.get("aspf") ?? "").toLowerCase() === "s";
  if (o.domenaWysylkowa === o.strefa || !scisly) {
    return { propozycja: null, opis: "Twoja domena ma już zasady ochrony przed podszywaniem i obejmą one newsletter.", scisly };
  }
  const zrodlo = (t.get("sp") ?? t.get("p") ?? "none").toLowerCase();
  const polityka = ["none", "quarantine", "reject"].includes(zrodlo) ? zrodlo : "none";
  // raporty zostawiamy tylko na adresy w tej samej domenie: zewnętrzny odbiorca raportów
  // wymaga osobnej autoryzacji po jego stronie, której dla subdomeny może nie mieć
  const rua = (t.get("rua") ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => /^mailto:[^@\s]+@([a-z0-9.-]+)$/i.test(a) && (a.toLowerCase().endsWith(`@${o.strefa}`) || a.toLowerCase().endsWith(`.${o.strefa}`)));
  return {
    propozycja: `v=DMARC1; p=${polityka}; aspf=r${rua.length ? `; rua=${rua.join(",")}` : ""}`,
    opis: "Twoja domena ma ścisłe zasady ochrony poczty. Dodajemy jeden rekord, który zachowuje je dla newslettera i pozwala przejść obu zabezpieczeniom zamiast jednego.",
    scisly,
  };
}

export interface UkladDomeny {
  strefa: string;
  domenaWysylkowa: string;
  adresNadawcy: string;
  mailFrom: string;
  /** true = wysyłka z domeny głównej (klient świadomie wyczyścił prefiks) */
  domenaGlowna: boolean;
}

/**
 * Układ z wpisu klienta. `strefa` = domena, w której są rekordy NS (zwykle domena główna).
 * Wpis już będący subdomeną strefy (mail.sklep.pl) zostaje bez zmian, a prefiks jest
 * dokładany tylko do domeny głównej.
 */
export function zaproponujUklad(o: { wpis: WpisNadawcy; strefa: string; prefiks?: string; lokalna?: string }): UkladDomeny | null {
  const { wpis, strefa } = o;
  if (wpis.domena !== strefa && !wpis.domena.endsWith(`.${strefa}`)) return null;
  const prefiks = (o.prefiks ?? PREFIKS_DOMYSLNY).trim().toLowerCase().replace(/\.+$/, "");
  if (!poprawnyPrefiks(prefiks)) return null;
  const domenaWysylkowa = wpis.domena === strefa ? (prefiks ? `${prefiks}.${strefa}` : strefa) : wpis.domena;
  if (domenaWysylkowa.length > 240) return null;
  const lokalna = (o.lokalna ?? wpis.lokalna ?? LOKALNA_DOMYSLNA).trim().toLowerCase();
  if (!poprawnaLokalna(lokalna)) return null;
  return {
    strefa,
    domenaWysylkowa,
    adresNadawcy: `${lokalna}@${domenaWysylkowa}`,
    mailFrom: `bounce.${domenaWysylkowa}`,
    domenaGlowna: domenaWysylkowa === strefa,
  };
}

// ── Rekordy ──────────────────────────────────────────────────────────────────

export type KluczRekordu = "podpis1" | "podpis2" | "podpis3" | "zwroty_mx" | "zwroty_spf" | "ochrona";

export interface RekordPlatformowy {
  klucz: KluczRekordu;
  /** nazwa względem strefy, tak jak wpisuje się ją w panelu („@" = sama domena) */
  nazwa: string;
  nazwaPelna: string;
  typ: "CNAME" | "MX" | "TXT";
  /** wartość do skopiowania (z kropką na końcu, gdy panel tego wymaga) */
  wartosc: string;
  /** wartość kanoniczna do porównań (bez kropki) */
  oczekiwana: string;
  priorytet?: number;
  /** po co jest rekord, zwykłymi słowami */
  poCo: string;
}

export function nazwaWzgledna(pelna: string, strefa: string): string {
  if (pelna === strefa) return "@";
  return pelna.endsWith(`.${strefa}`) ? pelna.slice(0, -(strefa.length + 1)) : pelna;
}

export function rekordyPlatformowe(o: {
  domenaWysylkowa: string;
  strefa: string;
  tokeny: readonly string[];
  strefaPodpisu: string;
  mailFrom: string;
  region: string;
  dmarcPropozycja: string | null;
  kropkaNaKoncu: boolean;
}): RekordPlatformowy[] {
  const k = (v: string) => (o.kropkaNaKoncu ? `${v}.` : v);
  const rekordy: RekordPlatformowy[] = o.tokeny.slice(0, 3).map((t, i) => {
    const pelna = `${t}._domainkey.${o.domenaWysylkowa}`;
    const cel = `${t}.${o.strefaPodpisu}`;
    return {
      klucz: (["podpis1", "podpis2", "podpis3"] as const)[i],
      nazwa: nazwaWzgledna(pelna, o.strefa),
      nazwaPelna: pelna,
      typ: "CNAME",
      wartosc: k(cel),
      oczekiwana: cel,
      poCo: `Podpis Twoich maili (${i + 1} z 3). Skrzynki odbiorców sprawdzają nim, że mail naprawdę jest od Ciebie.`,
    };
  });
  const feedback = `feedback-smtp.${o.region}.amazonses.com`;
  rekordy.push(
    {
      klucz: "zwroty_mx",
      nazwa: nazwaWzgledna(o.mailFrom, o.strefa),
      nazwaPelna: o.mailFrom,
      typ: "MX",
      wartosc: k(feedback),
      oczekiwana: feedback,
      priorytet: 10,
      poCo: "Adres zwrotny. Na niego wracają maile, których nie dało się doręczyć, a my sami usuwamy martwe adresy z listy.",
    },
    {
      klucz: "zwroty_spf",
      nazwa: nazwaWzgledna(o.mailFrom, o.strefa),
      nazwaPelna: o.mailFrom,
      typ: "TXT",
      wartosc: "v=spf1 include:amazonses.com ~all",
      oczekiwana: "v=spf1 include:amazonses.com ~all",
      poCo: "Pozwolenie na wysyłkę z adresu zwrotnego. Bez niego część skrzynek odrzuca maile.",
    },
  );
  if (o.dmarcPropozycja) {
    const pelna = `_dmarc.${o.domenaWysylkowa}`;
    rekordy.push({
      klucz: "ochrona",
      nazwa: nazwaWzgledna(pelna, o.strefa),
      nazwaPelna: pelna,
      typ: "TXT",
      wartosc: o.dmarcPropozycja,
      oczekiwana: o.dmarcPropozycja,
      poCo: "Zasady ochrony przed podszywaniem. Gmail i Yahoo wymagają ich od nadawców newsletterów.",
    });
  }
  return rekordy;
}

/** Porównanie nazwy z DNS z oczekiwaną; wykrywa doklejoną nazwę strefy (Hostido). */
export function porownajCel(znaleziona: string, oczekiwana: string, strefa: string): "ok" | "doklejona_strefa" | "inna" {
  const z = znaleziona.trim().toLowerCase().replace(/\.$/, "");
  const e = oczekiwana.toLowerCase();
  if (z === e) return "ok";
  if (z === `${e}.${strefa}`) return "doklejona_strefa";
  return "inna";
}
