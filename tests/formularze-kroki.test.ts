import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { closePool, getPool } from "../src/adapters/db/pool";
import { wystawToken } from "../src/adapters/token-formularza";
import {
  dodajKrok,
  dozwolonyBlok,
  duplikujKrok,
  nowyBlok,
  problemyPublikacji,
  przeniesKrok,
  schematDefinicji,
  usunKrok,
  wstawBlok,
  zPopupuStarego,
  type BlokTypu,
  type DefinicjaFormularza,
} from "../src/domain/formularze/model";
import { SZABLONY, szablon } from "../src/domain/formularze/szablony";
import { czyPokazac, REGULY_DOMYSLNE, type KontekstWyswietlania, type RegulyWyswietlania } from "../src/domain/formularze/wyswietlanie";
import { STYL_DOMYSLNY } from "../src/domain/formularze/model";
import {
  archiwizujFormularz,
  formularzDoEdycji,
  formularzeNaStrone,
  opublikujFormularz,
  utworzFormularz,
  zapiszSzkic,
} from "../src/usecases/popupy/formularze";
import { przyjmijKrok, przyjmijZgloszenie } from "../src/usecases/popupy/zglos-popup";
import { wynikiFormularza, zapiszWyswietlenie } from "../src/usecases/popupy/wyswietlenia";
import { ustawAktywnosc, wersjeKlauzuli } from "../src/usecases/popupy/zarzadzaj";
import { GET as skryptGET } from "../src/app/s/[tenantId]/route";
import { POST as zgloszeniePOST } from "../src/app/api/popup/[popupId]/route";
import { POST as krokPOST } from "../src/app/api/popup/[popupId]/krok/route";
import { POST as wyswietleniePOST } from "../src/app/api/popup/[popupId]/wyswietlenie/route";
import { BUDZET_SKRYPTU_B } from "../src/app/s/wersja-skryptu";
import { uruchomFormularze } from "../src/app/s/runtime-formularzy";

// Builder formularzy (0043): model kroków, reguły wyświetlania, zapis cząstkowy bez dublowania
// profili i zgód, zgoda per wersja, XSS w treści, izolacja tenantów, zdarzenia wyświetleń.

const ip = () => `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const json = (url: string, cialo: unknown, typ = "application/json") =>
  new NextRequest(url, { method: "POST", body: typeof cialo === "string" ? cialo : JSON.stringify(cialo), headers: { "content-type": typ, "x-forwarded-for": ip() } });

function kontekst(z: Partial<KontekstWyswietlania> = {}): KontekstWyswietlania {
  return { adres: "https://sklep.pl/kolekcja/buty", telefon: false, zapisany: false, zapisanyTutaj: false, nowy: true, zamknietoMs: null, terazMs: Date.UTC(2026, 9, 2, 12), ...z };
}

describe("Model formularza (czysta domena)", () => {
  const def = () => szablon("email-telefon")!.zbuduj("Sklep Kłos", STYL_DOMYSLNY);

  it("każdy szablon przechodzi schemat i nie ma problemów blokujących publikację", () => {
    for (const s of SZABLONY) {
      const d = s.zbuduj("Sklep Kłos", STYL_DOMYSLNY);
      expect(schematDefinicji.safeParse(d).success).toBe(true);
      expect(problemyPublikacji(d).filter((p) => p.wymagane)).toEqual([]);
    }
  });

  it("dodaj / duplikuj / usuń / zmień kolejność kroków", () => {
    let d = def();
    const [k1, k2] = d.kroki;
    const dod = dodajKrok(d, k1.id);
    expect(dod.def.kroki.map((k) => k.id)).toEqual([k1.id, dod.krokId, k2.id]);
    d = dod.def;
    // duplikat kroku z e-mailem NIE powiela pola e-mail ani zgody (to byłby drugi zapis)
    const dup = duplikujKrok(d, k1.id);
    const kopia = dup.def.kroki.find((k) => k.id === dup.krokId)!;
    expect(kopia.bloki.some((b) => b.typ === "email" || b.typ === "zgoda")).toBe(false);
    expect(new Set(dup.def.kroki.flatMap((k) => k.bloki.map((b) => b.id))).size).toBe(dup.def.kroki.flatMap((k) => k.bloki).length);
    const przen = przeniesKrok(d, 0, 2);
    expect(przen.kroki.map((k) => k.id)).toEqual([dod.krokId, k2.id, k1.id]);
    // ostatniego kroku nie da się usunąć
    let jeden = usunKrok(usunKrok(d, k2.id), dod.krokId);
    expect(jeden.kroki).toHaveLength(1);
    jeden = usunKrok(jeden, k1.id);
    expect(jeden.kroki).toHaveLength(1);
  });

  it("zgoda wymagana w kroku z e-mailem; drugie pole e-mail i kod poza sukcesem są blokowane", () => {
    const d = def();
    const [k1, k2] = d.kroki;
    expect(dozwolonyBlok(d, k2.id, "email").ok).toBe(false);
    expect(dozwolonyBlok(d, k2.id, "zgoda").ok).toBe(false);
    expect(dozwolonyBlok(d, k1.id, "kod").ok).toBe(false);
    expect(dozwolonyBlok(d, d.sukces.id, "kod").ok).toBe(true);
    expect(dozwolonyBlok(d, d.sukces.id, "telefon").ok).toBe(false);
    const bezZgody: DefinicjaFormularza = { ...d, kroki: d.kroki.map((k) => ({ ...k, bloki: k.bloki.filter((b) => b.typ !== "zgoda") })) };
    expect(problemyPublikacji(bezZgody).some((p) => p.wymagane && p.krokId === k1.id && /zgody/.test(p.tekst))).toBe(true);
    // zgoda w innym kroku niż e-mail
    const zgodaObok = wstawBlok(bezZgody, k2.id, nowyBlok("zgoda"));
    expect(problemyPublikacji(zgodaObok).some((p) => p.wymagane && /tym samym kroku/.test(p.tekst))).toBe(true);
    // bez e-maila w ogóle
    const bezEmaila: DefinicjaFormularza = { ...d, kroki: d.kroki.map((k) => ({ ...k, bloki: k.bloki.filter((b) => b.typ !== "email") })) };
    expect(problemyPublikacji(bezEmaila).some((p) => p.wymagane && /pole e-mail/.test(p.tekst))).toBe(true);
    // przycisk w kroku z e-mailem musi wysyłać
    const bezWyslij: DefinicjaFormularza = { ...d, kroki: d.kroki.map((k, i) => (i === 0 ? { ...k, bloki: k.bloki.map((b) => (b.typ === "przycisk" ? { ...b, akcja: "dalej" as const } : b)) } : k)) };
    expect(problemyPublikacji(bezWyslij).some((p) => p.wymagane && /Wyślij i przejdź dalej/.test(p.tekst))).toBe(true);
  });

  it("stary popup = poprawny formularz jednokrokowy ze stałymi identyfikatorami", () => {
    const d = zPopupuStarego({ headline: "H", body_text: "B", button_text: "OK", discount_code: "KOD5", rules: { delay_seconds: 7 }, consent_wording: "x".repeat(30), consent_privacy_url: null, list_id: null });
    expect(schematDefinicji.safeParse(d).success).toBe(true);
    expect(d.kroki).toHaveLength(1);
    expect(d.wyswietlanie.poSekundach).toBe(7);
    expect(d.sukces.bloki.find((b) => b.typ === "kod")).toMatchObject({ id: "s-kod", kod: "KOD5" });
    expect(zPopupuStarego({ headline: "H", body_text: "B", button_text: "OK", discount_code: null, rules: null, consent_wording: null, consent_privacy_url: null, list_id: null }).kroki[0].id).toBe("k-1");
  });
});

describe("Reguły wyświetlania (czysta funkcja, ta sama w skrypcie)", () => {
  const r = (z: Partial<RegulyWyswietlania> = {}): RegulyWyswietlania => ({ ...REGULY_DOMYSLNE, ...z });
  const przypadki: [string, RegulyWyswietlania, KontekstWyswietlania, boolean][] = [
    ["domyślnie: nowa osoba", r(), kontekst(), true],
    ["nie_subskrybenci: zapisany przez inny formularz", r(), kontekst({ zapisany: true }), false],
    ["wszyscy: zapisany też widzi", r({ komu: "wszyscy", poZapisieNigdy: false }), kontekst({ zapisany: true, zapisanyTutaj: true }), true],
    ["po zapisie nigdy", r({ komu: "wszyscy" }), kontekst({ zapisanyTutaj: true }), false],
    ["nowi: druga wizyta", r({ komu: "nowi" }), kontekst({ nowy: false }), false],
    ["zamknięty 2 dni temu, reguła 7 dni", r(), kontekst({ zamknietoMs: Date.UTC(2026, 8, 30, 12) }), false],
    ["zamknięty 8 dni temu, reguła 7 dni", r(), kontekst({ zamknietoMs: Date.UTC(2026, 8, 24, 12) }), true],
    ["0 dni: wraca od razu", r({ poZamknieciuDni: 0 }), kontekst({ zamknietoMs: Date.UTC(2026, 9, 2, 11) }), true],
    ["tylko komputer na telefonie", r({ urzadzenia: "komputer" }), kontekst({ telefon: true }), false],
    ["tylko telefon na telefonie", r({ urzadzenia: "telefon" }), kontekst({ telefon: true }), true],
    ["adres zawiera (wielkość liter bez znaczenia)", r({ adresZawiera: ["/KOLEKCJA"] }), kontekst(), true],
    ["adres nie zawiera", r({ adresZawiera: ["/blog"] }), kontekst(), false],
    ["wykluczenie wygrywa", r({ adresZawiera: ["/kolekcja"], adresWyklucz: ["buty"] }), kontekst(), false],
  ];

  it.each(przypadki)("%s", (_n, reguly, k, oczekiwane) => {
    expect(czyPokazac(reguly, k)).toBe(oczekiwane);
  });

  it("tekst funkcji wstrzykiwany do skryptu liczy to samo (samowystarczalny)", () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const zSkryptu = new Function(`return (${czyPokazac.toString()});`)() as typeof czyPokazac;
    for (const [, reguly, k, oczekiwane] of przypadki) expect(zSkryptu(reguly, k)).toBe(oczekiwane);
  });

  it("runtime skryptu nie używa innerHTML ani podobnych (treść tylko przez textContent)", () => {
    const zrodlo = uruchomFormularze.toString();
    expect(zrodlo).not.toMatch(/\.innerHTML\s*=|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(zrodlo).toMatch(/textContent/);
    expect(zrodlo).toMatch(/attachShadow/);
  });
});

describe("Formularze z krokami (0043, baza)", () => {
  let tenantA: string;
  let tenantB: string;
  let listaA: string;
  let formEmailTel: string;
  let formPytanie: string;
  let formB: string;
  const pool = () => getPool();
  const zgody = async (tenant: string, email: string) =>
    (await pool().query("select c.wording, c.popup_consent_version_id from consents c join profiles p on p.tenant_id = c.tenant_id and p.id = c.profile_id where c.tenant_id = $1 and lower(p.email) = lower($2) order by c.occurred_at", [tenant, email])).rows;

  beforeAll(async () => {
    await pool().query("delete from tenants where name like 'FORMK tenant %'");
    tenantA = (await pool().query("insert into tenants (name, sender_company_name) values ('FORMK tenant A', 'Sklep Kłos') returning id")).rows[0].id;
    tenantB = (await pool().query("insert into tenants (name) values ('FORMK tenant B') returning id")).rows[0].id;
    listaA = (await pool().query("insert into lists (tenant_id, name) values ($1, 'Newsletter') returning id", [tenantA])).rows[0].id;
    formEmailTel = await utworzFormularz(tenantA, { nazwa: "FORMK dwa kroki", szablon: "email-telefon" });
    formPytanie = await utworzFormularz(tenantA, { nazwa: "FORMK pytanie", szablon: "zainteresowania" });
    formB = await utworzFormularz(tenantB, { nazwa: "FORMK cudzy", szablon: "rabat" });
  });

  afterAll(async () => {
    await pool().query("delete from tenants where name like 'FORMK tenant %'");
    await closePool();
  });

  async function opublikuj(tenant: string, id: string, zmiana?: (d: DefinicjaFormularza) => DefinicjaFormularza) {
    const f = (await formularzDoEdycji(tenant, id))!;
    let rev = f.revision;
    if (zmiana) {
      const z = await zapiszSzkic(tenant, id, rev, zmiana(f.szkic));
      if (!z.ok) throw new Error("zapis szkicu");
      rev = z.revision;
    }
    return opublikujFormularz(tenant, id, rev);
  }

  it("szkic nie trafia na stronę i nie da się go włączyć bez publikacji", async () => {
    expect(await ustawAktywnosc(tenantA, formEmailTel, true)).toBe(false);
    expect((await formularzeNaStrone(tenantA)).map((f) => f.id)).not.toContain(formEmailTel);
  });

  it("publikacja: lista, wersja klauzuli bez zmian tekstu = ta sama wersja; skrypt bez kodu rabatowego", async () => {
    const w = await opublikuj(tenantA, formEmailTel, (d) => ({ ...d, listaId: listaA }));
    expect(w).toEqual({ ok: true, wersjaKlauzuli: 1, nowaWersja: false });
    await opublikuj(tenantA, formPytanie, (d) => ({ ...d, listaId: listaA }));
    const na = await formularzeNaStrone(tenantA);
    expect(na.map((f) => f.id).sort()).toEqual([formEmailTel, formPytanie].sort());
    const odp = await skryptGET(new NextRequest(`http://test/s/${tenantA}`), { params: Promise.resolve({ tenantId: tenantA }) });
    const js = await odp.text();
    expect(odp.headers.get("X-Script-Version")).toBe("2.0.0");
    expect(js).not.toContain("START15");
    expect(js).not.toContain(listaA);
    expect(js).toContain(formEmailTel);
  });

  it("zmiana szkicu po publikacji nie zmienia strony do kolejnej publikacji; konflikt wersji szkicu", async () => {
    const f = (await formularzDoEdycji(tenantA, formEmailTel))!;
    const zmieniony = { ...f.szkic, kroki: f.szkic.kroki.map((k, i) => (i === 0 ? { ...k, bloki: k.bloki.map((b) => (b.typ === "naglowek" ? { ...b, tekst: "SZKIC NIEOPUBLIKOWANY" } : b)) } : k)) };
    const z = await zapiszSzkic(tenantA, formEmailTel, f.revision, zmieniony);
    expect(z.ok).toBe(true);
    // stara wersja szkicu (druga karta) = konflikt, nie nadpisanie
    expect(await zapiszSzkic(tenantA, formEmailTel, f.revision, f.szkic)).toEqual({ ok: false, konflikt: true });
    const js = await (await skryptGET(new NextRequest(`http://test/s/${tenantA}`), { params: Promise.resolve({ tenantId: tenantA }) })).text();
    expect(js).not.toContain("SZKIC NIEOPUBLIKOWANY");
    expect((await formularzDoEdycji(tenantA, formEmailTel))!.niepublikowaneZmiany).toBe(true);
    // przywróć szkic = opublikowana
    const po = (await formularzDoEdycji(tenantA, formEmailTel))!;
    await zapiszSzkic(tenantA, formEmailTel, po.revision, po.opublikowana);
  });

  it("zapis cząstkowy: krok z e-mailem tworzy profil, JEDNĄ zgodę i wpis na liście; ponowienie nie dubluje", async () => {
    const zgl = "abcdefgh12345678abcdefgh";
    const cialo = { email: "formk-ala@example.test", zgoda: true, wersjaKlauzuli: 1, zgloszenie: zgl };
    const odp = await zgloszeniePOST(json(`http://test/api/popup/${formEmailTel}`, cialo), { params: Promise.resolve({ popupId: formEmailTel }) });
    expect(odp.status).toBe(200);
    const w = await odp.json();
    expect(w.ok).toBe(true);
    expect(typeof w.token).toBe("string");
    expect(Object.values(w.kody)).toEqual(["START15"]);
    // ponowienie tego samego zgłoszenia (sieć, podwójny klik)
    const drugi = await przyjmijZgloszenie(formEmailTel, cialo as never);
    expect(drugi?.powtorzone).toBe(true);
    const z = await zgody(tenantA, "formk-ala@example.test");
    expect(z).toHaveLength(1);
    const [v1] = await wersjeKlauzuli(tenantA, formEmailTel);
    expect(z[0].wording).toBe(v1.wording);
    expect(z[0].popup_consent_version_id).toBe(v1.id);
    const { rows: ev } = await pool().query(
      "select count(*)::int as ile from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id where e.tenant_id = $1 and m.name = 'Submitted Form' and e.properties->>'form_id' = $2",
      [tenantA, formEmailTel],
    );
    expect(ev[0].ile).toBe(1);
    const { rows: prof } = await pool().query("select count(*)::int as ile from profiles where tenant_id = $1 and lower(email) = 'formk-ala@example.test'", [tenantA]);
    expect(prof[0].ile).toBe(1);
    const { rows: lm } = await pool().query("select count(*)::int as ile from list_members where tenant_id = $1 and list_id = $2", [tenantA, listaA]);
    expect(lm[0].ile).toBe(1);

    // krok 2 (telefon) z tokenem: uzupełnia TEN profil, bez nowej zgody
    const f = (await formularzDoEdycji(tenantA, formEmailTel))!;
    const krok2 = f.opublikowana!.kroki[1].id;
    const k = await krokPOST(json(`http://test/api/popup/${formEmailTel}/krok`, { token: w.token, krok: krok2, telefon: "600 100 200" }), { params: Promise.resolve({ popupId: formEmailTel }) });
    expect(k.status).toBe(200);
    const { rows: p } = await pool().query("select phone from profiles where tenant_id = $1 and lower(email) = 'formk-ala@example.test'", [tenantA]);
    expect(p[0].phone).toBe("+48600100200");
    expect(await zgody(tenantA, "formk-ala@example.test")).toHaveLength(1);
    // telefon już jest: kolejny krok go nie nadpisuje
    await przyjmijKrok(formEmailTel, { token: w.token, krok: krok2, telefon: "+48 700 000 000" });
    expect((await pool().query("select phone from profiles where tenant_id = $1 and lower(email) = 'formk-ala@example.test'", [tenantA])).rows[0].phone).toBe("+48600100200");
  });

  it("token: zły podpis, cudzy formularz, krok z e-mailem albo spoza formularza = odmowa", async () => {
    const w = (await przyjmijZgloszenie(formEmailTel, { email: "formk-ola@example.test", zgoda: true, wersjaKlauzuli: 1 }))!;
    const f = (await formularzDoEdycji(tenantA, formEmailTel))!;
    const [k1, k2] = f.opublikowana!.kroki;
    expect(await przyjmijKrok(formEmailTel, { token: w.token.slice(0, -2) + "xx", krok: k2.id, telefon: "600200300" })).toEqual({ ok: false, powod: "token" });
    expect(await przyjmijKrok(formPytanie, { token: w.token, krok: k2.id, telefon: "600200300" })).toMatchObject({ ok: false });
    expect(await przyjmijKrok(formEmailTel, { token: w.token, krok: k1.id, telefon: "600200300" })).toEqual({ ok: false, powod: "krok" });
    expect(await przyjmijKrok(formEmailTel, { token: w.token, krok: "k-nieistnieje", telefon: "600200300" })).toEqual({ ok: false, powod: "krok" });
    // podpisany token z profilem innego tenanta nie zmieni cudzego profilu
    const obcy = (await pool().query("insert into profiles (tenant_id, email) values ($1, 'formk-obcy@example.test') returning id", [tenantB])).rows[0].id;
    expect(await przyjmijKrok(formEmailTel, { token: wystawToken(formEmailTel, obcy), krok: k2.id, telefon: "600200300" })).toEqual({ ok: false, powod: "token" });
    expect((await pool().query("select phone from profiles where id = $1", [obcy])).rows[0].phone).toBeNull();
  });

  it("odpowiedzi z kroku PRZED e-mailem idą z zapisem; tylko klucze i opcje z opublikowanego formularza", async () => {
    const w = await przyjmijZgloszenie(formPytanie, {
      email: "formk-pytanie@example.test",
      zgoda: true,
      wersjaKlauzuli: 1,
      pola: { Zainteresowania: ["Promocje", "Porady", "<script>"], Obce: "x", email: "podmiana@x.pl" },
    } as never);
    expect(w?.ok).toBe(true);
    const { rows } = await pool().query("select properties, email from profiles where tenant_id = $1 and id = $2", [tenantA, w!.profileId]);
    expect(rows[0].properties).toEqual({ Zainteresowania: ["Promocje", "Porady"] });
    expect(rows[0].email).toBe("formk-pytanie@example.test");
  });

  it("zmiana treści zgody przy publikacji = nowa wersja; zapis po niej ma nowy tekst, stary zostaje nietknięty", async () => {
    const NOWA = "Chcę dostawać od Sklepu Kłos e-maile z nowościami i promocjami. Wypiszę się jednym kliknięciem.";
    const w = await opublikuj(tenantA, formEmailTel, (d) => ({ ...d, kroki: d.kroki.map((k) => ({ ...k, bloki: k.bloki.map((b) => (b.typ === "zgoda" ? { ...(b as BlokTypu<"zgoda">), tekst: NOWA, adresPolityki: "https://sklep.example/polityka" } : b)) })) }));
    expect(w).toEqual({ ok: true, wersjaKlauzuli: 2, nowaWersja: true });
    const v = await wersjeKlauzuli(tenantA, formEmailTel);
    expect(v.map((x) => x.version)).toEqual([2, 1]);
    expect(v[0]).toMatchObject({ wording: NOWA, privacy_url: "https://sklep.example/polityka", superseded_at: null });
    const z = await przyjmijZgloszenie(formEmailTel, { email: "formk-v2@example.test", zgoda: true, wersjaKlauzuli: 2 });
    expect((await zgody(tenantA, "formk-v2@example.test"))[0].wording).toBe(NOWA);
    expect(z?.ok).toBe(true);
    // skrypt pokazuje tekst nowej wersji (z bazy)
    const js = await (await skryptGET(new NextRequest(`http://test/s/${tenantA}`), { params: Promise.resolve({ tenantId: tenantA }) })).text();
    expect(js).toContain(JSON.stringify({ tekst: NOWA, url: "https://sklep.example/polityka", wersja: 2 }));
  });

  it("XSS: treść z </script> i HTML-em jest w skrypcie tylko jako escapowany JSON", async () => {
    const zlo = '</script><img src=x onerror="alert(1)">\u2028';
    await opublikuj(tenantA, formPytanie, (d) => ({ ...d, kroki: d.kroki.map((k, i) => (i === 0 ? { ...k, nazwa: zlo.slice(0, 60), bloki: k.bloki.map((b) => (b.typ === "naglowek" ? { ...b, tekst: zlo } : b)) } : k)) }));
    const js = await (await skryptGET(new NextRequest(`http://test/s/${tenantA}`), { params: Promise.resolve({ tenantId: tenantA }) })).text();
    expect(js).not.toContain("</script>");
    expect(js).not.toContain("<img");
    expect(js).not.toContain("\u2028");
    expect(js).toContain("\\u003c/script>\\u003cimg src=x onerror=\\\"alert(1)\\\">");
    // skrypt parsuje się w całości (żaden fragment treści nie wyskoczył z literału)
    expect(() => new Function(js)).not.toThrow();
  });

  it("budżet rozmiaru skryptu (bez treści formularzy)", async () => {
    const js = await (await skryptGET(new NextRequest(`http://test/s/${tenantA}`), { params: Promise.resolve({ tenantId: tenantA }) })).text();
    const samKod = uruchomFormularze.toString().length + czyPokazac.toString().length;
    expect(samKod).toBeLessThan(BUDZET_SKRYPTU_B);
    expect(js.length).toBeLessThan(BUDZET_SKRYPTU_B + 40_000);
  });

  it("wyświetlenia: jedno na gościa dziennie, wyniki per krok i konwersja", async () => {
    const t = new Date();
    expect(await zapiszWyswietlenie(formEmailTel, { krok: 0, gosc: "goscabc12345" }, t)).toBe("zapisano");
    expect(await zapiszWyswietlenie(formEmailTel, { krok: 0, gosc: "goscabc12345" }, t)).toBe("powtorzone");
    expect(await zapiszWyswietlenie(formEmailTel, { krok: 0, gosc: "goscxyz99999" }, t)).toBe("zapisano");
    expect(await zapiszWyswietlenie(formEmailTel, { krok: 1, gosc: "goscabc12345" }, t)).toBe("zapisano");
    expect(await zapiszWyswietlenie(formEmailTel, { krok: 2, gosc: "goscabc12345" }, t)).toBe("zapisano"); // sukces
    expect(await zapiszWyswietlenie(formEmailTel, { krok: 9, gosc: "goscabc12345" }, t)).toBe("zly_krok");
    // trasa publiczna: text/plain (bez preflightu), zawsze 204
    const r = await wyswietleniePOST(json(`http://test/api/popup/${formEmailTel}/wyswietlenie`, { krok: 0, gosc: "goscnowy7777" }, "text/plain"), { params: Promise.resolve({ popupId: formEmailTel }) });
    expect(r.status).toBe(204);
    const w = await wynikiFormularza(tenantA, formEmailTel, 30);
    expect(w.wyswietlenia).toBe(3);
    expect(w.kroki).toEqual([{ indeks: 0, wyswietlenia: 3 }, { indeks: 1, wyswietlenia: 1 }, { indeks: 2, wyswietlenia: 1 }]);
    expect(w.zapisy).toBeGreaterThanOrEqual(3);
    expect(w.konwersja).not.toBeNull();
    // wyświetlenie nie wyzwala automatyzacji i nie ma profilu
    const { rows } = await pool().query("select m.can_trigger, e.profile_id from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id where e.tenant_id = $1 and m.name = 'Viewed Form' limit 1", [tenantA]);
    expect(rows[0]).toEqual({ can_trigger: false, profile_id: null });
  });

  it("izolacja tenantów: cudzy formularz nie istnieje dla edycji, publikacji, archiwum i wyników", async () => {
    expect(await formularzDoEdycji(tenantB, formEmailTel)).toBeNull();
    const f = (await formularzDoEdycji(tenantA, formEmailTel))!;
    expect(await zapiszSzkic(tenantB, formEmailTel, f.revision, f.szkic)).toEqual({ ok: false, blad: "Nie znaleziono takiego formularza." });
    expect(await opublikujFormularz(tenantB, formEmailTel, f.revision)).toMatchObject({ ok: false });
    expect(await archiwizujFormularz(tenantB, formEmailTel)).toBe(false);
    expect((await wynikiFormularza(tenantB, formEmailTel, 30)).wyswietlenia).toBe(0);
    expect((await formularzeNaStrone(tenantB)).map((x) => x.id)).not.toContain(formEmailTel);
    // zgłoszenie do formularza A zapisuje wyłącznie u tenanta A
    await przyjmijZgloszenie(formEmailTel, { email: "formk-iz@example.test", zgoda: true, wersjaKlauzuli: 2 });
    expect((await pool().query("select tenant_id from profiles where lower(email) = 'formk-iz@example.test'")).rows.map((r) => r.tenant_id)).toEqual([tenantA]);
    // formB (szkic) nie jest publiczny
    expect(await zapiszWyswietlenie(formB, { krok: 0, gosc: "goscabc12345" })).toBe("nie_znaleziono");
  });

  it("archiwum zdejmuje formularz ze strony, wersje klauzuli (dowód) zostają", async () => {
    expect(await archiwizujFormularz(tenantA, formPytanie)).toBe(true);
    expect((await formularzeNaStrone(tenantA)).map((f) => f.id)).not.toContain(formPytanie);
    expect((await wersjeKlauzuli(tenantA, formPytanie)).length).toBeGreaterThan(0);
    expect(await przyjmijZgloszenie(formPytanie, { email: "formk-arch@example.test", zgoda: true, wersjaKlauzuli: 1 })).toBeNull();
  });
});
