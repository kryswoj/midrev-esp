import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { closePool, getPool } from "../src/adapters/db/pool";
import { KlauzulaNieaktualna, przyjmijZgloszenie } from "../src/usecases/popupy/zglos-popup";
import { aktywnyPopup, popupPubliczny, ustawAktywnosc, utworzPopup, wersjeKlauzuli, zmienKlauzule } from "../src/usecases/popupy/zarzadzaj";
import { GET as skryptGET } from "../src/app/s/[tenantId]/route";
import { POST as zgloszeniePOST } from "../src/app/api/popup/[popupId]/route";

// Fala 1 UX, pkt 4 (P0 prawny, 0041): tekst zgody pokazany w popupie = tekst zapisany jako
// dowod w consents; wersjonowanie; checkbox wymagany po stronie serwera; lista docelowa.

const KLAUZULA_1 = "Zapisuję się na newsletter Sklepu Kłos i zgadzam się na e-maile z ofertami. Zgodę mogę wycofać.";
const KLAUZULA_2 = "Chcę dostawać nowości Sklepu Kłos e-mailem (maks. 2 w tygodniu). Wypiszę się jednym kliknięciem.";

describe("Popup: klauzula zgody i lista (0041)", () => {
  let tenantA: string;
  let tenantB: string;
  let listaA: string;
  let listaB: string;
  let popupA: string;
  let popupB: string;
  const pool = () => getPool();

  beforeAll(async () => {
    await pool().query("delete from tenants where name like 'POPK tenant %'");
    tenantA = (await pool().query("insert into tenants (name, sender_company_name) values ('POPK tenant A', 'Sklep Kłos') returning id")).rows[0].id;
    tenantB = (await pool().query("insert into tenants (name) values ('POPK tenant B') returning id")).rows[0].id;
    listaA = (await pool().query("insert into lists (tenant_id, name) values ($1, 'Newsletter') returning id", [tenantA])).rows[0].id;
    listaB = (await pool().query("insert into lists (tenant_id, name) values ($1, 'Cudza') returning id", [tenantB])).rows[0].id;
    popupA = await utworzPopup(tenantA, {
      name: "POPK powitalny", headline: "-10%", bodyText: "Zostaw adres.", buttonText: "Zapisz", discountCode: null, delaySeconds: 0,
      consentWording: KLAUZULA_1, privacyUrl: "https://sklep.example/polityka", listId: listaA,
    });
    popupB = await utworzPopup(tenantB, { name: "POPK cudzy", headline: "H", bodyText: "B", buttonText: "OK", discountCode: null, delaySeconds: 0 });
    await ustawAktywnosc(tenantA, popupA, true);
    await ustawAktywnosc(tenantB, popupB, true);
  });

  afterAll(async () => {
    await pool().query("delete from tenants where name like 'POPK tenant %'");
    await closePool();
  });

  it("utworzenie: wersja 1 z podanym tekstem i adresem polityki; domyślna klauzula ma nazwę firmy z konta", async () => {
    const v = await wersjeKlauzuli(tenantA, popupA);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ version: 1, wording: KLAUZULA_1, privacy_url: "https://sklep.example/polityka", superseded_at: null });
    const b = await wersjeKlauzuli(tenantB, popupB);
    expect(b[0].wording).toContain("newsletter POPK tenant B");
    // cudzy tenant nie widzi wersji
    expect(await wersjeKlauzuli(tenantB, popupA)).toEqual([]);
  });

  it("skrypt on-site pokazuje DOKŁADNIE tekst wersji, niezaznaczone pole i odsyła numer wersji", async () => {
    const odp = await skryptGET(new NextRequest(`http://test/s/${tenantA}`), { params: Promise.resolve({ tenantId: tenantA }) });
    const js = await odp.text();
    expect(odp.headers.get("X-Script-Version")).toBe("1.1.0");
    // konfiguracja jako JSON: tekst 1:1 (z polskimi znakami)
    expect(js).toContain(JSON.stringify(KLAUZULA_1).slice(1, -1));
    expect(js).toContain('"consentVersion":1');
    expect(js).toContain("zgoda.checked = false");
    expect(js).toContain("wersjaKlauzuli: K.consentVersion");
    // regex adresu polityki przetrwal szablon (bez zjedzonych ukosnikow)
    expect(js).toContain("/^https?:\\/\\//i");
    const pub = await popupPubliczny(popupA);
    expect(pub?.consent_wording).toBe(KLAUZULA_1);
  });

  it("zgłoszenie bez zaznaczonej zgody jest odrzucane przez serwer (trasa i use-case)", async () => {
    const zap = (cialo: unknown) => zgloszeniePOST(
      new NextRequest(`http://test/api/popup/${popupA}`, { method: "POST", body: JSON.stringify(cialo), headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } }),
      { params: Promise.resolve({ popupId: popupA }) },
    );
    for (const cialo of [{ email: "popk-bez@example.test" }, { email: "popk-bez@example.test", zgoda: false, wersjaKlauzuli: 1 }, { email: "popk-bez@example.test", zgoda: "true", wersjaKlauzuli: 1 }]) {
      const odp = await zap(cialo);
      expect(odp.status).toBe(400);
      expect((await odp.json()).blad).toBe("brak_zgody");
    }
    await expect(przyjmijZgloszenie(popupA, { email: "popk-bez@example.test" } as never)).rejects.toThrow(/bez zgody/);
    const { rows } = await pool().query("select count(*)::int as ile from profiles where tenant_id = $1 and email = 'popk-bez@example.test'", [tenantA]);
    expect(rows[0].ile).toBe(0);
  });

  it("zapis: dowód = pełny tekst wyświetlonej wersji + wskazanie wersji; osoba na liście ze źródłem formularz:<id>", async () => {
    const w = await przyjmijZgloszenie(popupA, { email: "popk-ala@example.test", zgoda: true, wersjaKlauzuli: 1 });
    expect(w).not.toBeNull();
    const { rows: z } = await pool().query(
      `select c.wording, c.method_detail, c.source, v.version, v.popup_id
         from consents c join popup_consent_versions v on v.tenant_id = c.tenant_id and v.id = c.popup_consent_version_id
        where c.tenant_id = $1 and c.profile_id = $2`,
      [tenantA, w!.profileId],
    );
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ wording: KLAUZULA_1, version: 1, popup_id: popupA, source: "popup:POPK powitalny" });
    expect(z[0].method_detail).toBe(`formularz ${popupA}, wersja klauzuli 1, polityka prywatności: https://sklep.example/polityka`);
    const { rows: m } = await pool().query("select source, added_at from list_members where tenant_id = $1 and list_id = $2 and profile_id = $3", [tenantA, listaA, w!.profileId]);
    expect(m).toHaveLength(1);
    expect(m[0].source).toBe(`formularz:${popupA}`);
    // drugi zapis nie dubluje czlonkostwa (nie odpala powitania drugi raz)
    await przyjmijZgloszenie(popupA, { email: "popk-ala@example.test", zgoda: true, wersjaKlauzuli: 1 });
    const { rows: m2 } = await pool().query("select added_at from list_members where tenant_id = $1 and list_id = $2 and profile_id = $3", [tenantA, listaA, w!.profileId]);
    expect(m2).toHaveLength(1);
    expect(new Date(m2[0].added_at).getTime()).toBe(new Date(m[0].added_at).getTime());
  });

  it("zmiana tekstu = nowa wersja; stara wersja niezmienna; zgłoszenie ze starą (świeżo zastąpioną) wersją dostaje JEJ tekst", async () => {
    const r = await zmienKlauzule(tenantA, popupA, { consentWording: KLAUZULA_2, privacyUrl: "https://sklep.example/polityka", listId: listaA });
    expect(r).toEqual({ ok: true, wersja: 2, nowaWersja: true });
    const bezZmian = await zmienKlauzule(tenantA, popupA, { consentWording: KLAUZULA_2, privacyUrl: "https://sklep.example/polityka", listId: listaA });
    expect(bezZmian).toEqual({ ok: true, wersja: 2, nowaWersja: false });
    const v = await wersjeKlauzuli(tenantA, popupA);
    expect(v.map((x) => [x.version, x.wording, x.superseded_at === null])).toEqual([[2, KLAUZULA_2, true], [1, KLAUZULA_1, false]]);
    expect((await aktywnyPopup(tenantA))?.consent_wording).toBe(KLAUZULA_2);
    // wersja jest dowodem: baza nie pozwala zmienic jej tresci
    await expect(pool().query("update popup_consent_versions set wording = 'podmiana tekstu zgody po fakcie' where tenant_id = $1 and popup_id = $2 and version = 1", [tenantA, popupA])).rejects.toThrow(/niezmienna/);

    const stara = await przyjmijZgloszenie(popupA, { email: "popk-stara@example.test", zgoda: true, wersjaKlauzuli: 1 });
    const nowa = await przyjmijZgloszenie(popupA, { email: "popk-nowa@example.test", zgoda: true, wersjaKlauzuli: 2 });
    const tekst = async (pid: string) => (await pool().query("select wording from consents where tenant_id = $1 and profile_id = $2", [tenantA, pid])).rows[0].wording;
    expect(await tekst(stara!.profileId)).toBe(KLAUZULA_1);
    expect(await tekst(nowa!.profileId)).toBe(KLAUZULA_2);
  });

  it("wersja nieznana, cudza albo zastąpiona dawno temu: odmowa 409, bez profilu", async () => {
    await expect(przyjmijZgloszenie(popupA, { email: "popk-x@example.test", zgoda: true, wersjaKlauzuli: 99 })).rejects.toBeInstanceOf(KlauzulaNieaktualna);
    // wersja zastapiona ponad 24 h temu: tworzymy wersje 3 i cofamy w czasie zastapienie wersji 2
    // (trigger pilnuje niezmiennosci, wiec na czas tego jednego UPDATE w tescie jest wylaczony)
    await zmienKlauzule(tenantA, popupA, { consentWording: KLAUZULA_1 + " Wersja trzecia.", privacyUrl: "", listId: listaA });
    await pool().query("alter table popup_consent_versions disable trigger popup_consent_versions_niezmienne");
    try {
      await pool().query("update popup_consent_versions set superseded_at = now() - interval '2 days' where tenant_id = $1 and popup_id = $2 and version = 2", [tenantA, popupA]);
    } finally {
      await pool().query("alter table popup_consent_versions enable trigger popup_consent_versions_niezmienne");
    }
    await expect(przyjmijZgloszenie(popupA, { email: "popk-x@example.test", zgoda: true, wersjaKlauzuli: 2 })).rejects.toBeInstanceOf(KlauzulaNieaktualna);
    // numer wersji istniejacy tylko u innego popupu (A ma wersje 3, B nie) nie pasuje do B
    await expect(przyjmijZgloszenie(popupB, { email: "popk-x@example.test", zgoda: true, wersjaKlauzuli: 3 })).rejects.toBeInstanceOf(KlauzulaNieaktualna);
    const odp = await zgloszeniePOST(
      new NextRequest(`http://test/api/popup/${popupA}`, { method: "POST", body: JSON.stringify({ email: "popk-x@example.test", zgoda: true, wersjaKlauzuli: 2 }), headers: { "content-type": "application/json" } }),
      { params: Promise.resolve({ popupId: popupA }) },
    );
    expect(odp.status).toBe(409);
    expect((await odp.json()).blad).toBe("formularz_zmieniony");
    const { rows } = await pool().query("select count(*)::int as ile from profiles where tenant_id = any($1::uuid[]) and email = 'popk-x@example.test'", [[tenantA, tenantB]]);
    expect(rows[0].ile).toBe(0);
  });

  it("lista z innego tenanta jest odrzucana (izolacja), usunięcie listy zdejmuje ją z popupu", async () => {
    const r = await zmienKlauzule(tenantA, popupA, { consentWording: KLAUZULA_2, privacyUrl: "", listId: listaB });
    expect(r).toEqual({ ok: false, blad: "Wybrana lista nie istnieje." });
    await expect(utworzPopup(tenantA, { name: "POPK zly", headline: "H", bodyText: "B", buttonText: "OK", discountCode: null, delaySeconds: 0, listId: listaB })).rejects.toThrow(/nie istnieje/);
    // cudzy tenant nie zmieni klauzuli
    expect(await zmienKlauzule(tenantB, popupA, { consentWording: KLAUZULA_2, privacyUrl: "", listId: null })).toEqual({ ok: false, blad: "Nie znaleziono takiego formularza." });
    await pool().query("delete from lists where tenant_id = $1 and id = $2", [tenantA, listaA]);
    const { rows } = await pool().query("select tenant_id, list_id from popups where id = $1", [popupA]);
    expect(rows[0]).toEqual({ tenant_id: tenantA, list_id: null });
  });

  it("popupu z wersjami klauzuli nie da się usunąć (dowód zgody), tenant usuwa się w całości", async () => {
    await expect(pool().query("delete from popups where tenant_id = $1 and id = $2", [tenantA, popupA])).rejects.toThrow(/popup_consent_versions/);
    expect((await wersjeKlauzuli(tenantA, popupA)).length).toBeGreaterThan(0);
  });

  it("popup bez klauzuli (np. utworzony przez stary kod po rollbacku) nie wyświetla się w sklepie", async () => {
    const { rows } = await pool().query(
      "insert into popups (tenant_id, name, headline, body_text, button_text, active, created_at) values ($1, 'POPK stary', 'H', 'B', 'OK', true, now() + interval '1 minute') returning id",
      [tenantB],
    );
    expect((await aktywnyPopup(tenantB))?.id).toBe(popupB);
    expect(await popupPubliczny(rows[0].id)).toBeNull();
  });
});
