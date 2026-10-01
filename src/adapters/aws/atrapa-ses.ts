import { createHash } from "node:crypto";
import { BladAws, TYPY_ZDARZEN, type PortSes, type PortSns, type TozsamoscSes } from "../../domain/email/ses";

/**
 * Atrapy SES i SNS w pamięci: testy (zawsze) i sandbox z SES_ATRAPA=1 (kreator, zrzuty
 * ekranu). Żadnej sieci. Tokeny DKIM deterministyczne z nazwy domeny, więc test może
 * policzyć oczekiwane rekordy.
 */

export function tokenyAtrapy(domena: string): string[] {
  return [1, 2, 3].map((i) => createHash("sha256").update(`${domena}:${i}`).digest("hex").slice(0, 32).replace(/[0-9]/g, (c) => "abcdefghij"[Number(c)]));
}

export class AtrapaSes implements PortSes {
  readonly region: string;
  readonly tozsamosci = new Map<string, TozsamoscSes>();
  readonly zestawy = new Map<string, Record<string, string>>();
  readonly cele = new Map<string, { nazwa: string; topicArn: string; typy: string[] }[]>();
  readonly tenanty = new Set<string>();
  readonly powiazania: { tenant: string; arn: string }[] = [];
  readonly wywolania: string[] = [];
  /** następne wywołanie danej operacji rzuci tym błędem (raz) */
  readonly bledy = new Map<string, BladAws>();

  constructor(region = "eu-north-1") {
    this.region = region;
  }

  #sprawdz(op: string) {
    this.wywolania.push(op);
    const b = this.bledy.get(op);
    if (b) {
      this.bledy.delete(op);
      throw b;
    }
  }

  async utworzTozsamosc(domena: string, o: { configurationSet: string | null; tagi: Record<string, string> }): Promise<TozsamoscSes> {
    this.#sprawdz("utworzTozsamosc");
    if (this.tozsamosci.has(domena)) throw new BladAws("AlreadyExists", 400, `SES: tożsamość ${domena} już istnieje`);
    const t: TozsamoscSes = {
      domena,
      gotowaDoWysylki: false,
      status: "PENDING",
      dkimStatus: "PENDING",
      dkimTokeny: tokenyAtrapy(domena),
      strefaPodpisu: "dkim.amazonses.com",
      dkimDlugoscKlucza: "RSA_2048_BIT",
      mailFromDomena: null,
      mailFromStatus: null,
      configurationSet: o.configurationSet,
      typBledu: null,
      tagi: { ...o.tagi },
    };
    this.tozsamosci.set(domena, t);
    return { ...t, dkimTokeny: [...t.dkimTokeny], tagi: { ...t.tagi } };
  }

  async odczytajTozsamosc(domena: string): Promise<TozsamoscSes | null> {
    this.#sprawdz("odczytajTozsamosc");
    const t = this.tozsamosci.get(domena);
    return t ? { ...t, dkimTokeny: [...t.dkimTokeny], tagi: { ...t.tagi } } : null;
  }

  async ustawMailFrom(domena: string, mailFromDomena: string): Promise<void> {
    this.#sprawdz("ustawMailFrom");
    const t = this.tozsamosci.get(domena);
    if (!t) throw new BladAws("NotFound", 404, "SES: brak tożsamości");
    t.mailFromDomena = mailFromDomena;
    t.mailFromStatus = "PENDING";
  }

  async utworzConfigurationSet(nazwa: string, tagi: Record<string, string>): Promise<void> {
    this.#sprawdz("utworzConfigurationSet");
    if (!this.zestawy.has(nazwa)) this.zestawy.set(nazwa, { ...tagi });
  }

  async ustawConfigurationSetTozsamosci(domena: string, nazwa: string): Promise<void> {
    this.#sprawdz("ustawConfigurationSetTozsamosci");
    const t = this.tozsamosci.get(domena);
    if (!t) throw new BladAws("NotFound", 404, "SES: brak tożsamości");
    t.configurationSet = nazwa;
  }

  async celeZdarzen(configurationSet: string) {
    this.#sprawdz("celeZdarzen");
    return (this.cele.get(configurationSet) ?? []).map((c) => ({ ...c, wlaczony: true }));
  }

  async dodajCelZdarzen(configurationSet: string, nazwa: string, topicArn: string): Promise<void> {
    this.#sprawdz("dodajCelZdarzen");
    const lista = (this.cele.get(configurationSet) ?? []).filter((c) => c.nazwa !== nazwa);
    lista.push({ nazwa, topicArn, typy: [...TYPY_ZDARZEN] });
    this.cele.set(configurationSet, lista);
  }

  async utworzTenanta(nazwa: string): Promise<void> {
    this.#sprawdz("utworzTenanta");
    this.tenanty.add(nazwa);
  }

  async powiazZasobZTenantem(tenant: string, arn: string): Promise<void> {
    this.#sprawdz("powiazZasobZTenantem");
    if (!this.powiazania.some((p) => p.tenant === tenant && p.arn === arn)) this.powiazania.push({ tenant, arn });
  }

  /** test: przestawienie stanu tożsamości (np. po „wpisaniu" rekordów przez klienta) */
  ustaw(domena: string, zmiana: Partial<TozsamoscSes>) {
    const t = this.tozsamosci.get(domena);
    if (!t) throw new Error(`atrapa: brak ${domena}`);
    Object.assign(t, zmiana);
  }
}

export class AtrapaSns implements PortSns {
  readonly tematy = new Map<string, Record<string, string>>();
  readonly subskrypcje: { topicArn: string; endpoint: string }[] = [];
  readonly bledy = new Map<string, BladAws>();
  constructor(
    private readonly region = "eu-north-1",
    private readonly konto = "509758189751",
  ) {}

  #sprawdz(op: string) {
    const b = this.bledy.get(op);
    if (b) {
      this.bledy.delete(op);
      throw b;
    }
  }

  async utworzTemat(nazwa: string, atrybuty: Record<string, string>): Promise<string> {
    this.#sprawdz("utworzTemat");
    const arn = `arn:aws:sns:${this.region}:${this.konto}:${nazwa}`;
    this.tematy.set(arn, { ...(this.tematy.get(arn) ?? {}), ...atrybuty });
    return arn;
  }

  async ustawAtrybutTematu(topicArn: string, nazwa: string, wartosc: string): Promise<void> {
    this.#sprawdz("ustawAtrybutTematu");
    this.tematy.set(topicArn, { ...(this.tematy.get(topicArn) ?? {}), [nazwa]: wartosc });
  }

  async subskrybujHttps(topicArn: string, endpoint: string): Promise<string> {
    this.#sprawdz("subskrybujHttps");
    if (!this.subskrypcje.some((s) => s.topicArn === topicArn && s.endpoint === endpoint)) this.subskrypcje.push({ topicArn, endpoint });
    return "pending confirmation";
  }
}
