import { randomBytes } from "node:crypto";
import { getPool } from "../adapters/db/pool";
import { przeliczAtrybucje } from "../usecases/przelicz-atrybucje";
import { wyslijPartie, zbudujWiadomosciKampanii } from "../usecases/wysylka/wyslij-kampanie";
import { dodajZadanie, domknijZadanie, odlozZadanie, zajmijZadanie, type Zadanie } from "./kolejka";
import { HANDLERY_AUTOMATYZACJI } from "./handlery-automatyzacje";

/**
 * Worker: jedna pętla, zajmowanie pojedynczo przez SKIP LOCKED, każdy handler idempotentny
 * (dostarczenie at-least-once, AD-5). Wywołania sieciowe dzieją się POZA transakcją
 * zajmującą zadanie (AD-31): zajęcie jest własnym UPDATE-em, handler pracuje po commicie.
 */
const workerId = `worker-${randomBytes(4).toString("hex")}`;

const HANDLERY: Record<string, (z: Zadanie) => Promise<void>> = {
  ...HANDLERY_AUTOMATYZACJI,
  async wyslij_kampanie(z) {
    const campaignId = String(z.payload.campaignId);
    await zbudujWiadomosciKampanii(z.tenant_id, campaignId);
    let wynik;
    do {
      wynik = await wyslijPartie(z.tenant_id, { limit: 25 });
      console.log(`[${workerId}] kampania ${campaignId}: wysłane ${wynik.wyslane}, odmowy ${wynik.odmowy}, błędy ${wynik.bledy}`);
      if (wynik.powodZatrzymania === "limit_dobowy") {
        // limit dobowy: reszta wychodzi jutro; zadanie wraca do kolejki z opóźnieniem
        throw new Error("limit dobowy wyczerpany, wysyłka wznowi się po północy");
      }
    } while (wynik.wyslane > 0 || wynik.odmowy > 0);
    await getPool().query(
      `update campaigns set status = 'sent', updated_at = now()
        where tenant_id = $1 and id = $2 and status = 'sending'`,
      [z.tenant_id, campaignId],
    );
  },
  async atrybucja(z) {
    const wynik = await przeliczAtrybucje(z.tenant_id);
    console.log(`[${workerId}] atrybucja: przypisano ${wynik.przypisanych} zamówień (okno ${wynik.oknoGodzin}h)`);
  },
};

async function tik() {
  const zadanie = await zajmijZadanie(workerId);
  if (!zadanie) return false;
  const handler = HANDLERY[zadanie.kind];
  try {
    if (!handler) throw new Error(`nieznany rodzaj zadania: ${zadanie.kind}`);
    await handler(zadanie);
    await domknijZadanie(zadanie, workerId);
  } catch (blad) {
    const tresc = blad instanceof Error ? blad.message : String(blad);
    const wyczerpane = await odlozZadanie(zadanie, tresc, workerId);
    // Alert do człowieka, nie do logu (NFR38): na razie stdout workera jest kanałem,
    // docelowo webhook z config().ALERT_WEBHOOK_URL.
    console.error(`[${workerId}] zadanie ${zadanie.kind} ${wyczerpane ? "WYCZERPAŁO PRÓBY" : "odłożone"}: ${tresc}`);
  }
  return true;
}

import { odzyskajZombie, utrzymajPartycje } from "./partycje";

console.log(`[${workerId}] start, kolejka na Postgresie, SKIP LOCKED`);
// partycje na start i co godzinę: bez tego trzeciego dnia zapisy lecą do partycji-alarmu
await utrzymajPartycje();
await odzyskajZombie();
setInterval(() => utrzymajPartycje().catch((b) => console.error(`[${workerId}] partycje:`, b)), 3600_000);
setInterval(() => odzyskajZombie().catch((b) => console.error(`[${workerId}] zombie:`, b)), 300_000);

// Tik automatyzacji co minutę per tenant: journeys reagują na zdarzenia (zapis z popupu,
// zamówienie) bez człowieka w pętli. Nakładanie się tików jest bezpieczne: unikalność
// messages (AD-26) i journey_runs zatrzymują duplikaty.
async function tikAutomatyzacji() {
  const { rows } = await getPool().query("select id from tenants");
  for (const t of rows) await dodajZadanie(t.id, "automatyzacje_tik", {});
}
await tikAutomatyzacji().catch(() => {});
setInterval(() => tikAutomatyzacji().catch((b) => console.error(`[${workerId}] tik automatyzacji:`, b)), 60_000);
// prosta pętla: pracuj póki są zadania, śpij 2s gdy pusto
// eslint-disable-next-line no-constant-condition
while (true) {
  try {
    const bylo = await tik();
    if (!bylo) await new Promise((r) => setTimeout(r, 2000));
  } catch (blad) {
    console.error(`[${workerId}] błąd pętli:`, blad);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
