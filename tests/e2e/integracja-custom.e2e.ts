/**
 * E2E integracji „custom” (0044): strona testowa sklepu → snippet midrev.js → Client API →
 * worker → metric_events → „Sprawdź połączenie” w panelu i oś profilu.
 *
 * NIE jest częścią `npm test` (potrzebuje zbudowanego Nexta i przeglądarki). Uruchomienie:
 *   1. baza: DATABASE_URL=…/<baza>_test (TYLKO baza testowa; skrypt odmawia innej)
 *   2. next start -p 3073 z tym samym DATABASE_URL, APP_URL=http://localhost:3073, MIDREV_SANDBOX=1
 *   3. node --env-file=.env --import tsx tests/e2e/integracja-custom.e2e.ts
 *      (sam stawia stronę sklepu na :3074 i zapisuje zrzuty do E2E_ZRZUTY)
 * Playwright: PLAYWRIGHT_CORE (domyślnie /tmp/node_modules/playwright-core), Chromium: CHROMIUM.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { closePool, getPool } from "../../src/adapters/db/pool";
import { wystawTokenMx } from "../../src/adapters/token-mx";
import { przetworzZadanieKlienta } from "../../src/usecases/integracja/klient-api";
import { zapiszUstawieniaStrony } from "../../src/usecases/integracja/klucz-strony";
import { osProfilu } from "../../src/usecases/zdarzenia/odczyt";

const BAZA = process.env.DATABASE_URL ?? "";
if (!/_test(\?|$)/.test(new URL(BAZA).pathname + "")) {
  console.error("E2E tylko na bazie *_test");
  process.exit(2);
}
const APP = process.env.E2E_APP ?? "http://localhost:3073";
const PORT_SKLEPU = 3074;
const SKLEP = `http://localhost:${PORT_SKLEPU}`;
const ZRZUTY = process.env.E2E_ZRZUTY ?? "/tmp";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/tmp/node_modules/playwright-core");
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const ZGODA = "Zapisuję się na newsletter i zgadzam się na otrzymywanie wiadomości e-mail z ofertami i nowościami. Zgodę mogę wycofać w każdej chwili, klikając link w stopce wiadomości.";

function sprawdz(warunek: unknown, opis: string) {
  if (!warunek) throw new Error(`E2E: ${opis}`);
  console.log(`  ✓ ${opis}`);
}

async function przetworz(tenantId: string) {
  const { rows } = await getPool().query("select id from raw_events where tenant_id = $1 and channel = 'client' and processed_at is null order by received_at", [tenantId]);
  for (const r of rows) await przetworzZadanieKlienta(tenantId, r.id);
  return rows.length;
}

async function main() {
  const pool = getPool();
  await pool.query("delete from tenants where name = 'CUSTOM E2E'");
  await pool.query("delete from users where email = 'e2e-custom@example.test'");
  const tenantId = (await pool.query("insert into tenants (name) values ('CUSTOM E2E') returning id")).rows[0].id as string;
  const klucz = await zapiszUstawieniaStrony(tenantId, {
    domeny: [],
    ograniczOriginy: false,
    wymagajZgodyCookies: true,
    identyfikacjaZLinkow: true,
    ga4: true,
    zaladujFormularze: false,
    tekstZgody: ZGODA,
    politykaUrl: null,
  });
  const user = (await pool.query("insert into users (email, password_hash, display_name, role) values ('e2e-custom@example.test', 'x', 'E2E', 'client') returning id")).rows[0].id;
  await pool.query("insert into memberships (user_id, tenant_id, role) values ($1, $2, 'client')", [user, tenantId]);
  const tokenSesji = randomBytes(32).toString("base64url");
  await pool.query("insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')", [user, createHash("sha256").update(tokenSesji).digest("hex")]);
  console.log(`tenant ${tenantId}, klucz strony ${klucz.id}`);

  const sklep = spawn(process.execPath, [join(import.meta.dirname, "../../sandbox/sklep-custom/serwer.mjs"), String(PORT_SKLEPU)], {
    env: { ...process.env, MIDREV_SRC: `${APP}/js/v1/${klucz.id}.js` },
    stdio: "inherit",
  });
  await new Promise((r) => setTimeout(r, 600));
  const przegladarka = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
  try {
    // ── 1. sklep: przed zgodą nic, po zgodzie zdarzenia ──────────────────────────
    const ctx = await przegladarka.newContext({ userAgent: UA });
    const strona = await ctx.newPage();
    const zadania: string[] = [];
    strona.on("request", (r: { url(): string; method(): string }) => {
      if (r.url().startsWith(APP + "/client/")) zadania.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await strona.goto(`${SKLEP}/produkt.html`);
    await strona.waitForTimeout(1500);
    sprawdz(zadania.length === 0, "przed zgodą na cookies: zero żądań do /client/*");
    sprawdz((await ctx.cookies()).every((c: { name: string }) => c.name !== "__mx_id"), "przed zgodą: brak ciasteczka __mx_id");
    await strona.click("#akceptuj");
    await strona.waitForTimeout(800);
    sprawdz(zadania.includes("POST /client/events"), "po zgodzie (Consent Mode v2): Viewed Product wysłany");
    await strona.fill("#email", `e2e-${tenantId.slice(0, 8)}@example.test`);
    await strona.check("#zgoda");
    await strona.click("#newsletter button[type=submit]");
    await strona.waitForSelector("#wynik:has-text('Zapisano')");
    sprawdz(zadania.includes("POST /client/subscriptions") && zadania.includes("POST /client/profiles"), "formularz: identify (_learnq) + subskrypcja z dowodem zgody");
    await strona.click("#koszyk");
    await strona.click("#zamow");
    await strona.waitForTimeout(600);
    // ponowne wejście na kartę produktu: osoba już rozpoznana z ciasteczka
    await strona.goto(`${SKLEP}/produkt.html`);
    await strona.waitForTimeout(1200);
    await przetworz(tenantId);

    const { rows: zd } = await pool.query(
      `select m.name, p.email, e.profile_id from metric_events e join metrics m on m.tenant_id = e.tenant_id and m.id = e.metric_id
        left join profiles p on p.tenant_id = e.tenant_id and p.id = e.profile_id where e.tenant_id = $1 and e.source = 'client'`,
      [tenantId],
    );
    const nazwy = zd.map((r) => r.name);
    for (const n of ["Viewed Product", "Added to Cart", "Started Checkout", "Active on Site"]) sprawdz(nazwy.includes(n), `metric_events ma „${n}” (integracja midrev)`);
    const profilId = zd.find((r) => r.email)?.profile_id as string;
    const { rows: zgody } = await pool.query("select wording, source from consents where tenant_id = $1 and profile_id = $2 and channel = 'email'", [tenantId, profilId]);
    sprawdz(zgody[0]?.wording === ZGODA, "rejestr zgód: brzmienie klauzuli z panelu");
    const { rows: koszyk } = await pool.query("select stage from carts where tenant_id = $1 and profile_id = $2", [tenantId, profilId]);
    sprawdz(koszyk[0]?.stage === "checkout", "koszyk: etap checkout");
    const os = await osProfilu(tenantId, profilId);
    sprawdz(os.wpisy.some((w) => w.nazwa === "Viewed Product"), "oś profilu: Viewed Product");

    // ── 2. klik w mail: _mx w adresie → rozpoznanie w czystej przeglądarce ───────
    const ctx2 = await przegladarka.newContext({ userAgent: UA });
    const s2 = await ctx2.newPage();
    await s2.goto(`${SKLEP}/produkt.html?_mx=${wystawTokenMx({ tenantId, profileId: profilId })}&utm_source=newsletter`);
    await s2.waitForTimeout(500);
    sprawdz(!s2.url().includes("_mx="), "token _mx usunięty z adresu (nie trafi do GA4)");
    sprawdz(s2.url().includes("utm_source=newsletter"), "pozostałe parametry adresu zostają");
    const przed = (await pool.query("select count(*)::int as n from metric_events where tenant_id = $1 and profile_id = $2", [tenantId, profilId])).rows[0].n;
    await s2.click("#akceptuj");
    await s2.waitForTimeout(1000);
    await przetworz(tenantId);
    const po = (await pool.query("select count(*)::int as n from metric_events where tenant_id = $1 and profile_id = $2", [tenantId, profilId])).rows[0].n;
    sprawdz(po > przed, "nowa przeglądarka z _mx: zdarzenia przypisane do profilu z maila");

    // ── 3. panel: kreator + „Sprawdź połączenie” + oś profilu (zrzuty 1440 i 390) ─
    for (const [szer, wys, nazwa] of [[1440, 900, "desktop"], [390, 844, "mobile"]] as const) {
      const p = await przegladarka.newContext({ viewport: { width: szer, height: wys }, deviceScaleFactor: 1 });
      await p.addCookies([{ name: "midrev_sesja", value: tokenSesji, domain: "localhost", path: "/" }]);
      const panel = await p.newPage();
      await panel.goto(`${APP}/t/${tenantId}/sklepy/wlasna-strona`);
      await panel.waitForSelector("text=Ostatnio z Twojej strony");
      await panel.waitForSelector("text=Oglądany produkt", { timeout: 10_000 });
      sprawdz(true, `„Sprawdź połączenie” pokazuje zdarzenia (${nazwa})`);
      await panel.screenshot({ path: `${ZRZUTY}/kreator-${nazwa}.png`, fullPage: true });
      await panel.locator("#sprawdz").screenshot({ path: `${ZRZUTY}/podglad-${nazwa}.png` });
      await panel.goto(`${APP}/t/${tenantId}/sklepy`);
      await panel.screenshot({ path: `${ZRZUTY}/sklepy-${nazwa}.png` });
      if (nazwa === "desktop") {
        await panel.goto(`${APP}/t/${tenantId}/profile/${profilId}`);
        await panel.waitForSelector("text=Viewed Product");
        sprawdz(true, "oś profilu w panelu pokazuje Viewed Product");
        await panel.screenshot({ path: `${ZRZUTY}/profil-${nazwa}.png`, fullPage: true });
      }
      await p.close();
    }
    console.log("E2E OK");
  } finally {
    await przegladarka.close();
    sklep.kill();
    await closePool();
  }
}

main().catch(async (b) => {
  console.error(b);
  await closePool().catch(() => {});
  process.exit(1);
});
