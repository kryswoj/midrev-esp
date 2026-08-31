// Dane demonstracyjne dla modulow marketingowych: zgody, listy, segmenty, kampanie,
// wykluczenia. Skrypt jednorazowy, nie czesc produktu.
import { getPool, closePool } from "../src/adapters/db/pool";
import { listaTenantow, utworzListe, utworzSegment, utworzKampanie } from "../src/adapters/db/repozytoria";

const pool = getPool();
const tenant = (await listaTenantow())[0];
if (!tenant) throw new Error("Brak tenanta - najpierw scripts/zasiej-demo.ts");
console.log("tenant:", tenant.name);

// 1. Zgody. UWAGA: zgoda marketingowa NIE wynika z faktu zakupu. W prawdziwym wdrozeniu
// pochodzi z pola zgody w checkoucie sklepu i przenosi sie razem z data i trescia klauzuli.
// Tutaj odtwarzamy to, co przyszloby z Woo przy migracji.
const { rows: profile } = await pool.query(
  `select p.id, p.email, min(o.occurred_at) as pierwsze
     from profiles p join orders o on o.tenant_id = p.tenant_id and o.profile_id = p.id
    where p.tenant_id = $1 group by p.id, p.email order by p.email`,
  [tenant.id],
);

const KLAUZULA = "Chcę otrzymywać informacje o nowościach i promocjach na podany adres e-mail.";
let zgody = 0;
for (const [i, p] of profile.entries()) {
  await pool.query(
    `insert into consents (tenant_id, profile_id, channel, state, source, wording, occurred_at)
     values ($1, $2, 'email', 'granted', 'checkout_woocommerce', $3, $4)`,
    [tenant.id, p.id, KLAUZULA, p.pierwsze],
  );
  zgody++;
  // jedna osoba wycofuje zgode pozniej - stan liczy sie z OSTATNIEGO wpisu, nie z kolumny
  if (i === profile.length - 1) {
    await pool.query(
      `insert into consents (tenant_id, profile_id, channel, state, source, wording, occurred_at)
       values ($1, $2, 'email', 'withdrawn', 'link_wypisania', null, now() - interval '9 days')`,
      [tenant.id, p.id],
    );
  }
}
console.log("zgody:", zgody, "(w tym jedno wycofanie)");

// 2. Wykluczenia tenanta: wypisanie i skarga. Oba jako wpisy, nie kasowanie wierszy.
// dwa RÓŻNE adresy: jeden wypisał się sam, drugi zgłosił spam u dostawcy
const wypisany = profile.at(-2)?.email ?? "ewa.dabrowska@example.test";
const zglosilSpam = profile.at(-1)?.email ?? "tomasz.zielinski@example.test";
await pool.query(
  `insert into tenant_suppressions (tenant_id, email, action, reason, actor, occurred_at)
   values ($1, $2, 'suppressed', 'wypisanie jednym kliknięciem', 'odbiorca', now() - interval '9 days'),
          ($1, $3, 'suppressed', 'zgłoszenie spamu u dostawcy', 'webhook dostawcy', now() - interval '3 days')`,
  [tenant.id, wypisany, zglosilSpam],
);
console.log("wykluczenia tenanta: 2");

// 3. Listy
const newsletter = await utworzListe(tenant.id, "Newsletter", "Zapisy ze stopki sklepu i z checkoutu");
await pool.query(
  `insert into list_members (tenant_id, list_id, profile_id, source)
   select $1, $2, p.id, 'import_woocommerce' from profiles p where p.tenant_id = $1
   on conflict do nothing`,
  [tenant.id, newsletter],
);
await utworzListe(tenant.id, "Klienci VIP", "Ręcznie pielęgnowana lista do ofert przedpremierowych");
console.log("listy: 2");

// 4. Segmenty - zamkniety zestaw regul fazy 1
await utworzSegment(tenant.id, "Kupili w ostatnich 90 dniach", [{ typ: "kupil_w_ostatnich", dni: 90 }]);
await utworzSegment(tenant.id, "Uśpieni: brak zakupu od 180 dni", [{ typ: "nie_kupil_od", dni: 180 }]);
await utworzSegment(tenant.id, "Wydali powyżej 500 zł", [
  { typ: "wydal_powyzej", kwotaMinor: 50000 },
  { typ: "ma_zgode", kanal: "email" },
]);
await utworzSegment(tenant.id, "Powracający: min. 3 zamówienia", [{ typ: "liczba_zamowien_min", ile: 3 }]);
console.log("segmenty: 4");

// 5. Kampanie w szkicu
const k1 = await utworzKampanie(tenant.id, "Wrześniowa wyprzedaż", "Ostatnie sztuki z letniej kolekcji");
const k2 = await utworzKampanie(tenant.id, "Powrót do pielęgnacji", "Twoja skóra po lecie potrzebuje innego kremu");
const { rows: segmenty } = await pool.query(
  "select id, name from segments where tenant_id = $1 order by created_at",
  [tenant.id],
);
await pool.query(
  `insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id)
   values ($1, $2, 'include', 'segment', $3), ($1, $2, 'exclude', 'segment', $4)`,
  [tenant.id, k1, segmenty[0].id, segmenty[1].id],
);
await pool.query(
  "update campaigns set status = 'awaiting_approval', scheduled_at = now() + interval '2 days' where id = $1",
  [k1],
);
await pool.query(
  `insert into campaign_audience (tenant_id, campaign_id, mode, source_type, source_id)
   values ($1, $2, 'include', 'segment', $3)`,
  [tenant.id, k2, segmenty[1].id],
);
console.log("kampanie: 2");

await closePool();
