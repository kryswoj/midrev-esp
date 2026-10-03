// Sprzatanie resztek testow w bazie DEWELOPERSKIEJ (midrev_esp).
//
// Do 25.09 testy chodzily na tej samej bazie co serwer :3005 i worker, wiec zostawialy
// w panelu smieciowych tenantow. Od teraz testy maja wlasna baze (midrev_esp_test), a ten
// skrypt usuwa to, co zostalo po starych przebiegach.
//
//   npm run sprzatnij-resztki-testow                 # podglad (domyslnie), niczego nie zmienia
//   npm run sprzatnij-resztki-testow -- --wykonaj    # usuwa tenanty z listy podgladu
//
// Usuwa WYLACZNIE tenanty, ktorych nazwa w calosci pasuje do jawnej listy WZORCE (dokladne
// nazwy z tests/*.test.ts). Tenant demo NIGDY nie jest usuwany, niezaleznie od nazwy.
// Kampanie i profile wewnatrz tenanta demo sa tylko RAPORTOWANE. --wykonaj: tylko lokalna
// baza midrev_esp (inna wylacznie jawnie: --baza=<nazwa>).
import pg from "pg";

const TENANT_DEMO = "01a043a1-472a-7769-a85f-a919ca2395fd";

/** Jedyna baza, na ktorej wolno --wykonaj (inna tylko jawnie: --baza=<nazwa>). */
const BAZA_DEV = "midrev_esp";

/**
 * DOKLADNE nazwy tenantow zakladanych przez tests/*.test.ts (wyrazenia regularne Postgresa,
 * zakotwiczone na calej nazwie). Celowo nie same prefiksy: "POP " pasowaloby tez do
 * prawdziwego tenanta nazwanego np. "POP Sklep". Nowy tenant w testach = nowa pozycja tutaj.
 */
const WZORCE = [
  "^ATR0018 [a-z][a-z -]*( [AB])?$",
  "^AuthTest tenant [AB]$",
  "^AUT tenant$",
  "^CDP (Tenant [AB]|Sklep Testowy( 2| Anon| Case| Delete)?)$",
  "^CUSTOM (A|B|E2E)$",
  "^CYKLICZNE A$",
  "^DSN (tenant|obcy)$",
  "^DUPL (tenant|obcy)$",
  "^EDYT (tenant|obcy)$",
  "^FLOW tenant$",
  "^HARM tenant$",
  "^IMP tenant [ABC]$",
  "^IMPORT PELNY [AB]$",
  "^LST [AB]$",
  "^M0002 tenant (glowny|obcy|do skasowania)$",
  "^OBRAZY (tenant|obcy)$",
  "^ODB (tenant|obcy)$",
  "^ONB tenant [AB]$",
  "^POP tenant [AB]$",
  "^POPK tenant [AB]$",
  "^PROFLISTA (A|B)$",
  "^PROFIL [AB]$",
  "^PRZ Sklep <&>$",
  "^REP tenant$",
  "^RODO PELNE (A|B|Obcy)$",
  "^SEGMENTY REGULY (A|Obcy)$",
  "^SKLEPY (Woo|CISZA Tenant)$",
  "^TRA tenant$",
  "^WEBHOOKI KLIENT (Baza|Woo)$",
  "^WKF tenant [AB]$",
  "^WKS tenant$",
  "^WYP Sklep <Zażółć> & Spółka$",
  "^WYS tenant$",
  "^ZAANG (tenant|obcy)$",
  "^ZAWEB (tenant|obcy)$",
] as const;

const argumenty = process.argv.slice(2);
const wykonaj = argumenty.includes("--wykonaj");
const bazaJawna = argumenty.find((a) => a.startsWith("--baza="))?.slice("--baza=".length);
if (wykonaj && argumenty.includes("--podglad")) {
  console.error("Podaj albo --podglad, albo --wykonaj, nie oba.");
  process.exit(2);
}

function opisBazy(adres: string) {
  const url = new URL(adres);
  return { host: url.hostname, nazwa: decodeURIComponent(url.pathname.replace(/^\/+/, "")) };
}

/** Kandydaci: pasuja do wzorca, nie demo. Ten sam predykat w podgladzie i w DELETE. */
const SQL_KANDYDACI = `
  select t.id, t.name, t.created_at,
         (select count(*) from profiles p where p.tenant_id = t.id) as profile,
         (select count(*) from campaigns c where c.tenant_id = t.id) as kampanie,
         (select count(*) from stores s where s.tenant_id = t.id) as sklepy,
         (select count(*) from memberships m where m.tenant_id = t.id) as czlonkowie,
         (select w from unnest($1::text[]) w where t.name ~ w limit 1) as wzorzec
    from tenants t
   where t.id <> $2 and exists (select 1 from unnest($1::text[]) w where t.name ~ w)
   order by t.created_at`;

async function main() {
  const adres = process.env.DATABASE_URL;
  if (!adres) throw new Error("Brak DATABASE_URL (uruchom przez npm run, ktory czyta .env).");
  const baza = opisBazy(adres);
  const lokalna = ["localhost", "127.0.0.1", "::1"].includes(baza.host);
  console.log(`Baza: ${baza.nazwa} @ ${baza.host}   tryb: ${wykonaj ? "WYKONAJ" : "podglad"}`);
  if (wykonaj && (!lokalna || process.env.NODE_ENV === "production")) {
    throw new Error("Odmowa: --wykonaj dziala wylacznie na lokalnym sandboxie, nie na zdalnej ani produkcyjnej bazie.");
  }
  // Produkcja moze stac na tym samym VPS-ie z Postgresem na localhost i baza o tej samej
  // nazwie: „lokalna" to za malo. Kasowanie wymaga JAWNEJ flagi sandboxa (review Codeksa r1),
  // ktorej srodowisko produkcyjne nie ma i miec nie moze (config.ts odmawia startu).
  if (wykonaj && !["1", "true", "tak", "yes"].includes(String(process.env.MIDREV_SANDBOX ?? "").trim().toLowerCase())) {
    throw new Error("Odmowa: --wykonaj wymaga MIDREV_SANDBOX=1 w srodowisku (tylko sandbox deweloperski).");
  }
  if (wykonaj && baza.nazwa !== (bazaJawna ?? BAZA_DEV)) {
    throw new Error(
      `Odmowa: --wykonaj dziala na bazie "${BAZA_DEV}", a DATABASE_URL wskazuje "${baza.nazwa}". ` +
        `Inna baza tylko jawnie: --baza=${baza.nazwa}`,
    );
  }

  const klient = new pg.Client({ connectionString: adres });
  await klient.connect();
  try {
    type Kandydat = {
      id: string; name: string; created_at: Date; profile: string; kampanie: string; sklepy: string; czlonkowie: string; wzorzec: string;
    };
    const { rows: kandydaci } = await klient.query<Kandydat>(SQL_KANDYDACI, [WZORCE, TENANT_DEMO]);

    console.log(`\nTenanty testowe do usuniecia: ${kandydaci.length}`);
    for (const t of kandydaci) {
      console.log(
        `  ${t.id}  "${t.name}"  (wzorzec ${t.wzorzec}, ${t.created_at.toISOString().slice(0, 10)}): ` +
          `profile ${t.profile}, kampanie ${t.kampanie}, sklepy ${t.sklepy}, czlonkowie ${t.czlonkowie}`,
      );
    }
    const suma = (k: "profile" | "kampanie" | "sklepy") => kandydaci.reduce((s, t) => s + Number(t[k]), 0);
    if (kandydaci.length) console.log(`  razem: profile ${suma("profile")}, kampanie ${suma("kampanie")}, sklepy ${suma("sklepy")}`);

    // --- tylko raport: to, czego skrypt NIE rusza ---
    const { rows: inne } = await klient.query<{ id: string; name: string }>(
      `select id, name from tenants t
        where t.id <> $1 and not exists (select 1 from unnest($2::text[]) w where t.name ~ w)
        order by created_at`,
      [TENANT_DEMO, WZORCE],
    );
    console.log(`\nTenanty spoza listy wzorcow (NIE usuwane): ${inne.length}`);
    for (const t of inne) console.log(`  ${t.id}  "${t.name}"`);

    const demo = await klient.query<{ name: string }>("select name from tenants where id = $1", [TENANT_DEMO]);
    console.log(`\nTenant demo ${TENANT_DEMO} ("${demo.rows[0]?.name ?? "BRAK"}") - chroniony, tylko raport:`);
    const kampanieTestowe = await klient.query<{ name: string; status: string }>(
      `select name, status from campaigns where tenant_id = $1 and name ~* '^(test|tmp|e2e)' order by created_at`,
      [TENANT_DEMO],
    );
    console.log(`  kampanie wygladajace na testowe: ${kampanieTestowe.rowCount}`);
    for (const k of kampanieTestowe.rows) console.log(`    "${k.name}" [${k.status}]`);
    const profile = await klient.query<{ wszystkie: string; example_test: string }>(
      `select count(*) as wszystkie, count(*) filter (where email ilike '%@example.test') as example_test
         from profiles where tenant_id = $1`,
      [TENANT_DEMO],
    );
    console.log(`  profile: ${profile.rows[0].wszystkie}, w tym @example.test: ${profile.rows[0].example_test} (seed demo)`);
    const profilePozaDemo = await klient.query<{ n: string }>(
      "select count(*) as n from profiles where tenant_id <> $1 and email ilike '%@example.test'",
      [TENANT_DEMO],
    );
    console.log(`\nProfile @example.test poza demo: ${profilePozaDemo.rows[0].n}`);
    const uzytkownicy = await klient.query<{ email: string }>(
      `select email from users where email ilike 'auth-test-%' or email ilike '%@example.test' order by email`,
    );
    console.log(`Uzytkownicy panelu z testow (auth-test-*, @example.test): ${uzytkownicy.rowCount}`);
    for (const u of uzytkownicy.rows) console.log(`  ${u.email}`);

    if (!wykonaj) {
      console.log("\nPodglad - niczego nie zmieniono. Usuniecie: npm run sprzatnij-resztki-testow -- --wykonaj");
      return;
    }
    if (!kandydaci.length) {
      console.log("\nNic do usuniecia.");
      return;
    }

    const ids = kandydaci.map((t) => t.id);
    if (ids.includes(TENANT_DEMO)) throw new Error("Odmowa: tenant demo na liscie do usuniecia.");
    await klient.query("begin");
    try {
      // wybor jeszcze raz W TRANSAKCJI, z blokada wierszy: usuwamy dokladnie to, co pokazal
      // podglad i co NADAL pasuje do wzorca; kazda roznica = wycofanie, nie zgadywanie
      const { rows: teraz } = await klient.query<{ id: string }>(
        `select t.id from tenants t
          where t.id = any($3::uuid[]) and t.id <> $2
            and exists (select 1 from unnest($1::text[]) w where t.name ~ w)
          for update`,
        [WZORCE, TENANT_DEMO, ids],
      );
      if (teraz.length !== ids.length) {
        throw new Error(`Rozjazd: podglad pokazal ${ids.length} tenantow, w transakcji pasuje ${teraz.length}. Wycofuje.`);
      }
      const usuniete = await klient.query(
        `delete from tenants t
          where t.id = any($3::uuid[]) and t.id <> $2
            and exists (select 1 from unnest($1::text[]) w where t.name ~ w)`,
        [WZORCE, TENANT_DEMO, ids],
      );
      // odczyt zwrotny: licznik z faktycznego stanu bazy, nie z liczby prob
      const zostalo = await klient.query<{ n: string }>(
        "select count(*) as n from tenants where id = any($1::uuid[])",
        [ids],
      );
      const demoJest = await klient.query("select 1 from tenants where id = $1", [TENANT_DEMO]);
      if (usuniete.rowCount !== ids.length || Number(zostalo.rows[0].n) !== 0 || demoJest.rowCount !== demo.rowCount) {
        throw new Error(
          `Rozjazd: oczekiwano ${ids.length} usunietych, delete zwrocil ${usuniete.rowCount}, ` +
            `zostalo ${zostalo.rows[0].n}. Wycofuje.`,
        );
      }
      await klient.query("commit");
      console.log(`\nUsunieto tenantow: ${usuniete.rowCount} (odczyt zwrotny: zostalo 0, demo nietkniete).`);
    } catch (blad) {
      await klient.query("rollback");
      throw blad;
    }
  } finally {
    await klient.end();
  }
}

main().catch((blad) => {
  console.error(blad instanceof Error ? blad.message : blad);
  process.exit(1);
});
