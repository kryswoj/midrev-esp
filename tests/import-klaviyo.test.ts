import { mkdir, writeFile, rm, copyFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../src/adapters/db/pool";
import { czytajCsv, poleCsv, wierszCsv } from "../src/usecases/import-klaviyo/csv";
import { rozpoznajKolumny, rozpoznajKolumnySupresji, sprawdzMapowanie } from "../src/usecases/import-klaviyo/mapowanie";
import { przeanalizujPlik } from "../src/usecases/import-klaviyo/analiza";
import { odkazNazwePliku, sciezkaPliku } from "../src/usecases/import-klaviyo/pliki";
import { parsujDate, parsujZgode, normalizujWiersz } from "../src/usecases/import-klaviyo/wiersz";
import { policzPlan } from "../src/usecases/import-klaviyo/podglad";
import { wykonajImport } from "../src/usecases/import-klaviyo/wykonaj";
import { anonimizujWImporcie, pominSupresje, przebieg, utworzPrzebieg, zapiszMapowanie, zapiszMapowanieSupresji, zapiszPlan, zapiszPlikSupresji, zlecStart } from "../src/usecases/import-klaviyo/zadania";
import { plikIstnieje } from "../src/usecases/import-klaviyo/pliki";
import { canSendTo } from "../src/usecases/wysylka/can-send-to";
import { HANDLERY_IMPORTU } from "../src/jobs/handlery-import";
import { v7 as uuidv7 } from "uuid";
import { join, dirname, isAbsolute } from "node:path";

// Wykonywalna specyfikacja importu z Klaviyo (audyt #1). Parser jest testowany na
// sznurkach, a caly przebieg na prawdziwej bazie sandboxa (AD-20) i prawdziwych
// plikach fixtures/klaviyo. Kazda regula z zadania ma tu swoj test: zgoda tylko z data,
// supresja globalna wygrywa z plikiem, idempotencja, izolacja tenantow.

const FIX = join(import.meta.dirname, "fixtures", "klaviyo");

async function zTekstu(tekst: string) {
  const rekordy = [];
  for await (const r of czytajCsv(Readable.from([Buffer.from(tekst, "utf8")]))) rekordy.push(r);
  return rekordy;
}

describe("parser CSV (RFC 4180)", () => {
  it("BOM, CRLF, cudzysłowy, przecinek i nowa linia w polu, podwojony cudzysłów", async () => {
    const r = await zTekstu('\ufeffEmail,Name\r\na@x.pl,"Kowalska, Anna"\r\nb@x.pl,"Wójcik ""Tomek"""\r\nc@x.pl,"linia 1\nlinia 2"\r\n');
    expect(r.map((x) => x.pola)).toEqual([
      ["Email", "Name"],
      ["a@x.pl", "Kowalska, Anna"],
      ["b@x.pl", 'Wójcik "Tomek"'],
      ["c@x.pl", "linia 1\nlinia 2"],
    ]);
    expect(r.map((x) => x.linia)).toEqual([1, 2, 3, 4]);
  });

  it("numer linii uwzględnia łamania wewnątrz pola; puste linie są pomijane; ostatni rekord bez końca linii", async () => {
    const r = await zTekstu('a,b\n1,"x\ny"\n\n2,z');
    expect(r.map((x) => [x.linia, x.pola])).toEqual([[1, ["a", "b"]], [2, ["1", "x\ny"]], [5, ["2", "z"]]]);
  });

  it("znak wielobajtowy przecięty granicą kawałka nie psuje się", async () => {
    const tekst = "Email,Imię\na@x.pl,Zażółć gęślą jaźń\n";
    const bufor = Buffer.from(tekst, "utf8");
    const kawalki = [bufor.subarray(0, 15), bufor.subarray(15, 16), bufor.subarray(16)];
    const rekordy = [];
    for await (const r of czytajCsv(Readable.from(kawalki))) rekordy.push(r);
    expect(rekordy[1].pola[1]).toBe("Zażółć gęślą jaźń");
  });

  it("wykrywa średnik jako separator z polskiego Excela", async () => {
    const r = await zTekstu("Email;Imię\na@x.pl;Anna\n");
    expect(r[1].pola).toEqual(["a@x.pl", "Anna"]);
  });

  it("pole dłuższe niż limit oznacza rekord błędem zamiast rosnąć w pamięci", async () => {
    const r = await zTekstu(`a,b\n1,${"x".repeat(5000)}\n`);
    expect(r[1].blad).toMatch(/dłuższe/);
    expect(r[1].pola[1].length).toBe(4096);
  });

  it("eksport: escapuje formuły i cudzysłowy (CSV injection)", () => {
    expect(poleCsv("=cmd|'/C calc'!A0")).toBe(`'=cmd|'/C calc'!A0`);
    expect(poleCsv("=1+1,x")).toBe(`"'=1+1,x"`);
    expect(poleCsv("+48600")).toBe("'+48600");
    expect(poleCsv("-anna@x.pl")).toBe("'-anna@x.pl");
    expect(poleCsv("@handle")).toBe("'@handle");
    expect(poleCsv('Wójcik "Tomek"')).toBe('"Wójcik ""Tomek"""');
    expect(wierszCsv(["a", "b,c", null])).toBe('a,"b,c",\r\n');
  });
});

describe("mapowanie i normalizacja", () => {
  it("rozpoznaje nagłówki Klaviyo", () => {
    const m = rozpoznajKolumny(["Email", "First Name", "Last Name", "Phone Number", "Email Marketing Consent", "Email Marketing Consent Timestamp", "Source", "Email Suppressions", "City", "Shopify Tags", "Profile ID", "SMS Marketing Consent"]);
    expect(m).toEqual(["email", "imie", "nazwisko", "telefon", "zgoda", "zgoda_data", "zrodlo", "supresja", "wlasciwosc", "wlasciwosc", "pomin", "pomin"]);
    expect(rozpoznajKolumnySupresji(["Email", "Reason", "Timestamp"])).toEqual(["email", "powod", "data"]);
    expect(rozpoznajKolumnySupresji(["Email"])).toEqual(["email"]);
  });

  it("ostrzega przy imporcie bez zgody, blokuje bez e-maila i przy podwójnym przypisaniu", () => {
    expect(sprawdzMapowanie(["email", "imie"], ["Email", "First Name"]).ostrzezenia[0]).toMatch(/NIE nada nikomu zgody/);
    expect(sprawdzMapowanie(["imie"], ["First Name"]).bledy[0]).toMatch(/adresem e-mail/);
    expect(sprawdzMapowanie(["email", "email"], ["Email", "E-mail"]).bledy[0]).toMatch(/2 kolumn/);
    expect(sprawdzMapowanie(["email", "zgoda"], ["Email", "Consent"]).ostrzezenia[0]).toMatch(/nie ma daty zgody/);
  });

  it("daty ze źródła: formaty Klaviyo, ISO, dzień; przyszłość i śmieci odrzucone", () => {
    expect(parsujDate("2024-03-05 14:22:10")?.toISOString()).toBe("2024-03-05T14:22:10.000Z");
    expect(parsujDate("2023-11-20T09:15:00+02:00")?.toISOString()).toBe("2023-11-20T07:15:00.000Z");
    expect(parsujDate("2024-01-02")?.toISOString()).toBe("2024-01-02T00:00:00.000Z");
    expect(parsujDate("05.03.2024")?.toISOString()).toBe("2024-03-05T00:00:00.000Z");
    expect(parsujDate("2099-01-01")).toBeNull();
    expect(parsujDate("wczoraj")).toBeNull();
    expect(parsujDate("")).toBeNull();
  });

  it("zgoda bez daty NIE daje granted; UNSUBSCRIBED to wypis; nieznana wartość to błąd wiersza", () => {
    const n = ["Email", "Email Marketing Consent", "Email Marketing Consent Timestamp"];
    const m = rozpoznajKolumny(n);
    const bezDaty = normalizujWiersz(2, ["a@x.pl", "SUBSCRIBED", ""], m, n);
    expect(bezDaty.ok && bezDaty.wiersz.zgoda).toBe("none");
    expect(bezDaty.ok && bezDaty.wiersz.uwagi[0]).toMatch(/bez daty/);
    const zla = normalizujWiersz(3, ["a@x.pl", "SUBSCRIBED", "kiedyś"], m, n);
    expect(zla.ok).toBe(false);
    const wypis = normalizujWiersz(4, ["a@x.pl", "UNSUBSCRIBED", "2024-01-01"], m, n);
    expect(wypis.ok && wypis.wiersz.zgoda).toBe("unsubscribed");
    const dziwna = normalizujWiersz(5, ["a@x.pl", "maybe", "2024-01-01"], m, n);
    expect(!dziwna.ok && dziwna.powod).toMatch(/nierozpoznana/);
    expect(parsujZgode("Never subscribed")).toBe("none");
    expect(normalizujWiersz(6, [" A@X.PL ", "", ""], m, n)).toMatchObject({ ok: true, wiersz: { email: "A@X.PL", klucz: "a@x.pl" } });
  });

  it("nazwa pliku od użytkownika nie ma jak stać się ścieżką", () => {
    expect(odkazNazwePliku("../../.env")).toBe(".env");
    expect(odkazNazwePliku("C:\\Users\\x\\..\\lista.csv")).toBe("lista.csv");
    expect(odkazNazwePliku("")).toBe("plik.csv");
    expect(sciezkaPliku("01a043a1-472a-7769-a85f-a919ca2395fd", "01a043a1-472a-7769-a85f-a919ca2395fe", "profiles")).toMatch(/var\/importy\/01a043a1-472a-7769-a85f-a919ca2395fd\/01a043a1-472a-7769-a85f-a919ca2395fe-profiles\.csv$/);
    expect(() => sciezkaPliku("../x", "y", "profiles")).toThrow();
  });
});

describe("import z Klaviyo na prawdziwej bazie", () => {
  let tenantA: string;
  let tenantB: string;
  let tenantC: string;
  let listaA: string;
  const pliki: string[] = [];

  async function przygotujPrzebieg(tenantId: string, opcje: { supresje: "plik" | "sam-email" | "pomin"; listId?: string | null; plik?: string }) {
    const id = uuidv7();
    const zrodlo = opcje.plik && isAbsolute(opcje.plik) ? opcje.plik : join(FIX, opcje.plik ?? "lista-eksport.csv");
    const cel = sciezkaPliku(tenantId, id, "profiles");
    await mkdir(dirname(cel), { recursive: true });
    await copyFile(zrodlo, cel);
    pliki.push(cel);
    const a = await przeanalizujPlik(cel);
    if ("blad" in a) throw new Error(a.blad);
    await utworzPrzebieg(tenantId, { id, fileName: "lista-eksport.csv", fileSize: 1, rowCount: a.wierszy, headers: a.naglowki, sample: a.probka, mapping: rozpoznajKolumny(a.naglowki), createdBy: "test@example.test", listId: opcje.listId ?? null });
    await zapiszMapowanie(tenantId, id, rozpoznajKolumny(a.naglowki), opcje.listId ?? null);
    if (opcje.supresje === "pomin") {
      await pominSupresje(tenantId, id);
    } else {
      const celS = sciezkaPliku(tenantId, id, "suppressions");
      await copyFile(join(FIX, opcje.supresje === "plik" ? "supresje-eksport.csv" : "supresje-sam-email.csv"), celS);
      pliki.push(celS);
      const as = await przeanalizujPlik(celS);
      if ("blad" in as) throw new Error(as.blad);
      const m = rozpoznajKolumnySupresji(as.naglowki);
      await zapiszPlikSupresji(tenantId, id, { fileName: "s.csv", fileSize: 1, rowCount: as.wierszy, headers: as.naglowki, sample: as.probka, mapping: m });
      await zapiszMapowanieSupresji(tenantId, id, m);
    }
    const job = (await przebieg(tenantId, id))!;
    const plan = await policzPlan(tenantId, job);
    await zapiszPlan(tenantId, id, plan as unknown as Record<string, unknown>);
    return { id, plan };
  }

  beforeAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'IMP %'");
    await pool.query("delete from suppressions where email like '%@example.test'");
    const a = await pool.query("insert into tenants (name) values ('IMP tenant A') returning id");
    const b = await pool.query("insert into tenants (name) values ('IMP tenant B') returning id");
    tenantA = a.rows[0].id;
    tenantB = b.rows[0].id;
    tenantC = (await pool.query("insert into tenants (name) values ('IMP tenant C') returning id")).rows[0].id;
    const l = await pool.query("insert into lists (tenant_id, name) values ($1, 'IMP lista') returning id", [tenantA]);
    listaA = l.rows[0].id;
    // globalna supresja z INNEGO sklepu: adres spalony odbiciem gdzie indziej
    await pool.query("insert into suppressions (email, reason) values ('anna.kowalska@example.test', 'twarde odbicie u innego klienta')");
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from tenants where name like 'IMP %'");
    await pool.query("delete from suppressions where email like '%@example.test'");
    for (const p of pliki) await rm(p, { force: true });
    await closePool();
  });

  it("podgląd liczy efekty uboczne przed zapisem i nic nie zapisuje", async () => {
    const pool = getPool();
    const { plan } = await przygotujPrzebieg(tenantA, { supresje: "plik", listId: listaA });
    expect(plan.wierszy).toBe(10);
    expect(plan.bledy).toBe(1); // zle-bez-malpy
    expect(plan.duplikaty).toBe(1); // anna drugi raz
    expect(plan.unikalne).toBe(8);
    expect(plan.nowe).toBe(8);
    // kandydaci do zgody: anna (globalna supresja!), jan, tomasz (supresja Klaviyo -> none),
    // formula, katarzyna (w pliku supresji jako unsubscribed) -> zgode dostana: jan, formula
    expect(plan.naSupresjiGlobalnej).toBe(1);
    expect(plan.wPlikuSupresji).toBe(1);
    expect(plan.zeZgoda).toBe(2);
    expect(plan.zgodaBezDaty).toBe(1); // marta
    expect(plan.wypisani).toBe(1); // ewa
    expect(plan.supresjaKlaviyo).toBe(1); // tomasz
    expect(plan.doListy).toBe(8);
    expect(plan.supresje?.unikalne).toBe(6);
    expect(plan.supresje?.bledy).toBe(1);
    expect(plan.supresje?.wgRodzaju).toEqual({ wypis: 2, reczne: 1, skarga: 1, odbicie: 1, nieprawidlowy: 1 });
    expect(plan.probka.length).toBe(10);
    const { rows } = await pool.query("select count(*)::int as n from profiles where tenant_id = $1", [tenantA]);
    expect(rows[0].n).toBe(0);
  });

  it("wykonanie: profile, zgody tylko z datą, supresja globalna wygrywa, wypisy i skargi, lista; liczniki z odczytu zwrotnego", async () => {
    const pool = getPool();
    const { id, plan } = await przygotujPrzebieg(tenantA, { supresje: "plik", listId: listaA });
    expect(await zlecStart(tenantA, id)).toBe(true);
    const { rows: joby } = await pool.query("select payload, status from jobs where tenant_id = $1 and kind = 'import_klaviyo' order by created_at desc limit 1", [tenantA]);
    expect(joby[0].payload.jobId).toBe(id);
    // handler wolany wprost (worker innego wlasciciela nie zna jeszcze tego rodzaju)
    await HANDLERY_IMPORTU.import_klaviyo({ id: "x", token: "t", tenant_id: tenantA, kind: "import_klaviyo", payload: { jobId: id }, attempts: 1, max_attempts: 5 });

    const job = (await przebieg(tenantA, id))!;
    expect(job.status).toBe("done");
    const l = job.counters as any;
    expect(l.profileNowe).toBe(8);
    expect(l.zgodyNadane).toBe(2);
    expect(l.pominieteGlobalnie).toBe(1);
    // katarzyna: plik supresji zapisuje sie PRZED profilami, wiec w wykonaniu wpada do
    // "wykluczeni w sklepie" (rejestr), a nie "w pliku supresji"; plan liczyl ja jako
    // wPlikuSupresji, bo rejestr byl wtedy pusty - suma obu jest ta sama
    expect(l.pominieteWSklepie + l.pominietePlikSupresji).toBe(plan.wykluczeniWSklepie + plan.wPlikuSupresji);
    expect(l.pominieteWSklepie + l.pominietePlikSupresji).toBe(1);
    expect(l.odczyt.zgodyZTegoPrzebiegu).toBe(2);
    expect(l.odczyt.profileWBazie).toBe(8);
    expect(l.odczyt.naLiscieZTegoPrzebiegu).toBe(8);
    expect(l.odczyt.naLiscieRazem).toBe(8);
    expect(l.supresje.globalneZapisane).toBe(3); // skarga, odbicie, nieprawidlowy
    expect(l.supresje.lokalneZapisane).toBe(3); // ewa, tomasz, katarzyna
    expect(job.error_count).toBe(2); // zle-bez-malpy + bez-malpy w supresjach
    // plan == wynik
    expect(l.zgodyNadane).toBe(plan.zeZgoda);
    expect(l.profileNowe + l.profileZaktualizowane).toBe(plan.unikalne);

    // zgoda: data ZE ZRODLA, source import, method_detail klaviyo + zrodlo z pliku, import_job_id
    const { rows: zgody } = await pool.query(
      `select p.email, c.state, c.source, c.method_detail, c.occurred_at, c.import_job_id
         from consents c join profiles p on p.id = c.profile_id where c.tenant_id = $1 order by p.email`,
      [tenantA],
    );
    expect(zgody.map((z) => [z.email, z.state, z.source, z.method_detail])).toEqual([
      ["=cmd|calc@example.test", "granted", "import", "klaviyo"],
      ["Jan.Nowak@Example.test", "granted", "import", "klaviyo: Shopify Checkout"],
      ["ewa.wisniewska@example.test", "withdrawn", "import", "klaviyo: Klaviyo Form: Footer"],
    ]);
    const jan = zgody.find((z) => z.email.startsWith("Jan"))!;
    expect(new Date(jan.occurred_at).toISOString()).toBe("2023-11-20T09:15:00.000Z");
    expect(jan.import_job_id).toBe(id);
    // anna: profil jest, zgody NIE ma mimo SUBSCRIBED w pliku (supresja globalna wygrywa)
    const { rows: anna } = await pool.query("select id, first_name, properties from profiles where tenant_id = $1 and email = 'anna.kowalska@example.test'", [tenantA]);
    expect(anna[0].first_name).toBe("Anna");
    expect(anna[0].properties).toEqual({ City: "Warszawa", "Shopify Tags": "vip, newsletter" });
    expect((await canSendTo(pool, tenantA, anna[0].id)).powod).toBe("wykluczenie_globalne");
    // jan przechodzi bramke wysylki
    const { rows: janP } = await pool.query("select id from profiles where tenant_id = $1 and lower(email) = 'jan.nowak@example.test'", [tenantA]);
    expect(await canSendTo(pool, tenantA, janP[0].id)).toEqual({ wolno: true });
    // katarzyna: w pliku profili SUBSCRIBED, w pliku supresji wypisana -> bramka odmawia
    const { rows: kat } = await pool.query("select id from profiles where tenant_id = $1 and email = 'katarzyna.dabrowska@example.test'", [tenantA]);
    expect((await canSendTo(pool, tenantA, kat[0].id)).powod).toBe("wykluczenie_sklepu");
    // wykluczenia: powod i data z pliku, aktor = przebieg
    const { rows: wyk } = await pool.query("select email, reason, actor, occurred_at from tenant_suppressions where tenant_id = $1 order by email, reason", [tenantA]);
    // ewa jest w OBU plikach z tym samym (adres, powod, data): jeden wpis, nie dwa
    expect(wyk.map((w) => [w.email, w.reason])).toEqual([
      ["ewa.wisniewska@example.test", "wypisanie w Klaviyo"],
      ["katarzyna.dabrowska@example.test", "wypisanie w Klaviyo"],
      ["tomasz.wojcik@example.test", "supresja e-mail w Klaviyo"],
      ["tomasz.wojcik@example.test", "wykluczenie ręczne w Klaviyo"],
    ]);
    expect(wyk.every((w) => w.actor === `import:${id}`)).toBe(true);
    expect(new Date(wyk.find((w) => w.email.startsWith("katarzyna"))!.occurred_at).toISOString()).toBe("2024-09-09T09:09:09.000Z");
    const { rows: glob } = await pool.query("select email, reason, email_hash from suppressions where email in ('skarga@example.test','odbicie@example.test','zly@example.test') order by email");
    expect(glob.map((g) => g.reason)).toEqual(["twarde odbicie w Klaviyo", "zgłoszenie spamu w Klaviyo", "nieprawidłowy adres w Klaviyo"]);
    expect(glob.every((g) => typeof g.email_hash === "string" && g.email_hash.length === 64)).toBe(true);
    // bledy z numerem linii pliku
    const { rows: bledy } = await pool.query("select file, line_no, email, reason from import_job_errors where tenant_id = $1 and job_id = $2 order by file, line_no", [tenantA, id]);
    expect(bledy).toEqual([
      { file: "profiles", line_no: 8, email: "zle-bez-malpy", reason: "nieprawidłowy adres e-mail" },
      { file: "suppressions", line_no: 8, email: "bez-malpy", reason: "nieprawidłowy adres e-mail" },
    ]);
    // po zakonczeniu: probki wyczyszczone, pliki skasowane (dane osobowe nie leza poza sciezka RODO)
    expect(job.sample).toEqual([]);
    expect(job.suppression_sample).toBeNull();
    expect(await plikIstnieje(sciezkaPliku(tenantA, id, "profiles"))).toBe(false);
    expect(await plikIstnieje(sciezkaPliku(tenantA, id, "suppressions"))).toBe(false);
  });

  it("RODO: anonimizacja zamienia adres w raporcie błędów i w próbkach otwartych przebiegów", async () => {
    const pool = getPool();
    // otwarty przebieg z probka zawierajaca adres
    const { id: otwarty } = await przygotujPrzebieg(tenantA, { supresje: "pomin" });
    expect((await przebieg(tenantA, otwarty))!.sample.some((w) => w.includes("piotr.zielinski@example.test"))).toBe(true);
    await pool.query("insert into import_job_errors (tenant_id, job_id, file, line_no, email, reason) values ($1, $2, 'profiles', 99, 'Piotr.Zielinski@example.test', 'test')", [tenantA, otwarty]);
    const wynik = await anonimizujWImporcie(tenantA, "piotr.zielinski@example.test");
    expect(wynik.bledy).toBe(1);
    // co najmniej ten przebieg; wczesniejsze testy moga zostawic inne otwarte przebiegi A
    expect(wynik.probki).toBeGreaterThanOrEqual(1);
    const po = (await przebieg(tenantA, otwarty))!;
    expect(po.sample.flat().some((k) => k.toLowerCase().includes("piotr.zielinski"))).toBe(false);
    expect(po.sample.flat().filter((k) => k.startsWith("anonimizowano:")).length).toBe(1);
    const { rows } = await pool.query("select email from import_job_errors where tenant_id = $1 and job_id = $2 and line_no = 99", [tenantA, otwarty]);
    expect(rows[0].email).toMatch(/^anonimizowano:[0-9a-f]{16}$/);
    // drugi raz: nic do zmiany
    expect(await anonimizujWImporcie(tenantA, "piotr.zielinski@example.test")).toEqual({ bledy: 0, probki: 0 });
    // inny tenant nie zostal dotkniety (adres w probce B, jesli jest, zostaje)
    expect(await anonimizujWImporcie(tenantB, "piotr.zielinski@example.test")).toEqual({ bledy: 0, probki: 0 });
  });

  it("idempotencja: ten sam plik drugi raz nie dubluje zgód, członkostw ani wykluczeń", async () => {
    const pool = getPool();
    const przed = async () => {
      const c = await pool.query("select count(*)::int as n from consents where tenant_id = $1", [tenantA]);
      const m = await pool.query("select count(*)::int as n from list_members where tenant_id = $1", [tenantA]);
      const t = await pool.query("select count(*)::int as n from tenant_suppressions where tenant_id = $1", [tenantA]);
      const g = await pool.query("select count(*)::int as n from suppressions where email like '%@example.test'");
      const p = await pool.query("select count(*)::int as n from profiles where tenant_id = $1", [tenantA]);
      return [c.rows[0].n, m.rows[0].n, t.rows[0].n, g.rows[0].n, p.rows[0].n];
    };
    const stanPrzed = await przed();
    const { id } = await przygotujPrzebieg(tenantA, { supresje: "plik", listId: listaA });
    await zlecStart(tenantA, id);
    await wykonajImport(tenantA, id);
    expect(await przed()).toEqual(stanPrzed);
    const l = (await przebieg(tenantA, id))!.counters as any;
    expect(l.zgodyNadane).toBe(0);
    expect(l.zgodyJuzByly).toBe(2);
    expect(l.profileNowe).toBe(0);
    expect(l.profileZaktualizowane).toBe(8);
    expect(l.doListyDodane).toBe(0);
    expect(l.odczyt.zgodyZTegoPrzebiegu).toBe(0);
    // zamkniety przebieg nie daje sie uruchomic drugi raz
    expect(await wykonajImport(tenantA, id)).toBeNull();
  });

  it("plik supresji z samą kolumną Email: każdy adres to wypis ze sklepu z datą importu", async () => {
    const pool = getPool();
    const { id, plan } = await przygotujPrzebieg(tenantB, { supresje: "sam-email" });
    expect(plan.supresje?.wgRodzaju.wypis).toBe(2);
    expect(plan.supresje?.bezDaty).toBe(2);
    await zlecStart(tenantB, id);
    await wykonajImport(tenantB, id);
    const { rows } = await pool.query("select email, reason from tenant_suppressions where tenant_id = $1 and email like 'wypis%' order by email", [tenantB]);
    expect(rows).toEqual([
      { email: "wypis1@example.test", reason: "wypisanie w Klaviyo" },
      { email: "wypis2@example.test", reason: "wypisanie w Klaviyo" },
    ]);
    // drugi import tego samego pliku bez dat: data przebiegu jest inna, a wpisow nie przybywa
    const { id: drugi } = await przygotujPrzebieg(tenantB, { supresje: "sam-email" });
    await zlecStart(tenantB, drugi);
    await wykonajImport(tenantB, drugi);
    const { rows: po } = await pool.query("select count(*)::int as n from tenant_suppressions where tenant_id = $1 and email like 'wypis%'", [tenantB]);
    expect(po[0].n).toBe(2);
  });

  it("izolacja tenantów: import u B nie widzi przebiegów, list ani wykluczeń A; wypisy A nie blokują B", async () => {
    const pool = getPool();
    const { rows: obceJoby } = await pool.query("select id from import_jobs where tenant_id = $1", [tenantA]);
    expect(await przebieg(tenantB, obceJoby[0].id)).toBeNull();
    // lista tenanta A nie moze byc celem importu u C (FK zlozony z 0004): partia jest
    // jedna transakcja, wiec profile z tej partii tez sie wycofuja
    const { id } = await przygotujPrzebieg(tenantC, { supresje: "pomin" });
    await pool.query("update import_jobs set options = options || $2::jsonb where tenant_id = $1 and id = $3", [tenantC, JSON.stringify({ listId: listaA }), id]);
    await zlecStart(tenantC, id);
    await expect(wykonajImport(tenantC, id)).rejects.toThrow();
    const poBledzie = (await przebieg(tenantC, id))!;
    expect(poBledzie.status).toBe("failed");
    expect(poBledzie.sample).toEqual([]);
    expect(await plikIstnieje(sciezkaPliku(tenantC, id, "profiles"))).toBe(true); // plik zostaje do ponowienia
    const { rows: czlonkowieA } = await pool.query("select count(*)::int as n from list_members where list_id = $1 and tenant_id <> $2", [listaA, tenantA]);
    expect(czlonkowieA[0].n).toBe(0);
    expect((await pool.query("select count(*)::int as n from profiles where tenant_id = $1", [tenantC])).rows[0].n).toBe(0);
    // ponowienie po naprawie (at-least-once) domyka przebieg bez duplikatow
    await pool.query("update import_jobs set options = options - 'listId' where tenant_id = $1 and id = $2", [tenantC, id]);
    const ponowienie = await wykonajImport(tenantC, id);
    expect(ponowienie).not.toBeNull();
    expect((await przebieg(tenantC, id))!.status).toBe("done");
    expect((await pool.query("select count(*)::int as n from profiles where tenant_id = $1", [tenantC])).rows[0].n).toBe(8);
    expect((ponowienie as any).profileNowe).toBe(8);
    expect(await plikIstnieje(sciezkaPliku(tenantC, id, "profiles"))).toBe(false);
    // katarzyna wypisana u A dostaje zgode u B (wykluczenie sklepu jest lokalne)
    const { id: id2 } = await przygotujPrzebieg(tenantB, { supresje: "pomin" });
    const job2 = (await przebieg(tenantB, id2))!;
    expect(job2.options.supresjePominiete).toBe(true);
    await zlecStart(tenantB, id2);
    await wykonajImport(tenantB, id2);
    const { rows: kat } = await pool.query("select id from profiles where tenant_id = $1 and email = 'katarzyna.dabrowska@example.test'", [tenantB]);
    expect(await canSendTo(pool, tenantB, kat[0].id)).toEqual({ wolno: true });
    // ale anna (globalna) nadal zablokowana takze u B
    const { rows: anna } = await pool.query("select id from profiles where tenant_id = $1 and email = 'anna.kowalska@example.test'", [tenantB]);
    expect((await canSendTo(pool, tenantB, anna[0].id)).powod).toBe("wykluczenie_globalne");
  });

  it("plik bez kolumny zgody: profile wchodzą, nikt nie dostaje zgody", async () => {
    const pool = getPool();
    const tmp = join(FIX, "..", "..", "..", "var", "importy", "tmp-bez-zgody.csv");
    await mkdir(dirname(tmp), { recursive: true });
    await writeFile(tmp, "Email,First Name\nbezzgody1@example.test,A\nbezzgody2@example.test,B\n");
    pliki.push(tmp);
    const { id, plan } = await przygotujPrzebieg(tenantB, { supresje: "pomin", plik: tmp });
    expect(plan.zeZgoda).toBe(0);
    expect(plan.unikalne).toBe(2);
    await zlecStart(tenantB, id);
    await wykonajImport(tenantB, id);
    const { rows } = await pool.query("select count(*)::int as n from consents c join profiles p on p.id = c.profile_id where p.tenant_id = $1 and p.email like 'bezzgody%'", [tenantB]);
    expect(rows[0].n).toBe(0);
  });
});
