import { randomBytes } from "node:crypto";
import { getPool } from "../adapters/db/pool";
import { przeliczAtrybucje } from "../usecases/przelicz-atrybucje";
import { przetworzZdarzenie } from "../usecases/przetworz-zdarzenie";
import { wyslijPartie, zbudujWiadomosciKampanii } from "../usecases/wysylka/wyslij-kampanie";
import { rekoncyliacjaWysylki } from "../usecases/wysylka/rekoncyliacja";
import { wyslijAlert } from "./alerty";
import { dodajZadanie, domknijZadanie, odlozZadanie, odswiezHeartbeat, zajmijZadanie, type Zadanie } from "./kolejka";
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
        // Limit dobowy NIE jest błędem: ten job domyka się normalnie, a kampanię
        // przejmuje NOWY job z run_after na początku następnej doby wg zegara bazy
        // (nie serwera aplikacji). Licznik prób się nie zużywa, a kampania zostaje
        // w 'sending' — bo to prawda o jej stanie.
        const { rows } = await getPool().query(
          "select ceil(extract(epoch from (date_trunc('day', now()) + interval '1 day') - now()))::int as sek",
        );
        await dodajZadanie(z.tenant_id, "wyslij_kampanie", { campaignId }, { opoznienieSek: rows[0].sek });
        console.log(`[${workerId}] kampania ${campaignId}: limit dobowy, nowy job wznowi wysyłkę za ${rows[0].sek}s`);
        return;
      }
    } while (wynik.wyslane > 0 || wynik.odmowy > 0);
    if (wynik.bledy > 0) {
      // Partia skończyła się samymi błędami (np. SMTP leży): rzut, żeby job wrócił
      // z rosnącym odstępem. Wiadomości po błędach przejściowych czekają w queued
      // i następne podejście je podejmie — nie wolno tu oznaczyć kampanii jako sent.
      throw new Error(`wysyłka kampanii ${campaignId} zakończyła partię z ${wynik.bledy} błędami`);
    }
    // 'sent' dopiero, gdy żadna wiadomość kampanii nie jest już w drodze: wiadomość
    // w queued (wróci po błędzie przejściowym), claimed albo sending (czeka na
    // rekoncyliację) oznacza, że kampania jeszcze trwa.
    const domkniecie = await getPool().query(
      `update campaigns set status = 'sent', updated_at = now()
        where tenant_id = $1 and id = $2 and status = 'sending'
          and not exists (
            select 1 from messages m
             where m.tenant_id = $1 and m.source_type = 'campaign' and m.source_id = $2
               and m.current_state in ('queued', 'claimed', 'sending')
          )`,
      [z.tenant_id, campaignId],
    );
    if (!domkniecie.rowCount) {
      // rowCount 0 przy kampanii wciąż w 'sending' = w momencie UPDATE-u były
      // wiadomości w drodze (np. zawieszone w sending): rzut, żeby job wrócił
      // z odstępem — rekoncyliacja w międzyczasie rozstrzygnie je do held i kolejne
      // podejście domknie kampanię, zamiast zostawić ją w sending na zawsze.
      // Rozstrzyga status kampanii, nie osobny count wiadomości: count po fakcie
      // ściga się z rekoncyliacją i umiałby skłamać, że nic nie zostało.
      const { rows: kampania } = await getPool().query(
        "select status from campaigns where tenant_id = $1 and id = $2",
        [z.tenant_id, campaignId],
      );
      if (kampania[0]?.status === "sending") {
        throw new Error(`kampania ${campaignId}: wiadomości wciąż w drodze, domknięcie odłożone`);
      }
      // inny status (sent z wcześniejszego podejścia, cancelled) — nic do zrobienia
    }
  },
  async rekoncyliacja(z) {
    const wynik = await rekoncyliacjaWysylki(z.tenant_id);
    if (wynik.zawieszone) {
      console.log(`[${workerId}] rekoncyliacja tenant ${z.tenant_id}: ${wynik.zawieszone} wiadomości przeniesionych do held`);
    }
  },
  async atrybucja(z) {
    const wynik = await przeliczAtrybucje(z.tenant_id);
    console.log(`[${workerId}] atrybucja: przypisano ${wynik.przypisanych} zamówień (okno ${wynik.oknoGodzin}h)`);
  },
  async przetworz_zdarzenie(z) {
    await przetworzZdarzenie(z.tenant_id, String(z.payload.rawEventId));
  },
};

// Heartbeat (W5): zadanie w toku odświeża locked_at co minutę, żeby recovery zombie
// (15 min po locked_at) odróżniało martwy proces od handlera, który pracuje długo.
let biezaceZadanie: Zadanie | null = null;

async function tik() {
  const zadanie = await zajmijZadanie(workerId);
  if (!zadanie) return false;
  const handler = HANDLERY[zadanie.kind];
  biezaceZadanie = zadanie;
  try {
    if (!handler) throw new Error(`nieznany rodzaj zadania: ${zadanie.kind}`);
    await handler(zadanie);
    await domknijZadanie(zadanie, workerId);
  } catch (blad) {
    const tresc = blad instanceof Error ? blad.message : String(blad);
    const wyczerpane = await odlozZadanie(zadanie, tresc, workerId);
    if (wyczerpane) {
      // Alert do człowieka, nie do logu (NFR38): wyczerpane próby to utrata pracy,
      // której nikt nie ponowi automatycznie.
      await wyslijAlert(`zadanie ${zadanie.kind} (tenant ${zadanie.tenant_id}) WYCZERPAŁO PRÓBY: ${tresc}`);
    } else {
      console.error(`[${workerId}] zadanie ${zadanie.kind} odłożone: ${tresc}`);
    }
  } finally {
    biezaceZadanie = null;
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
setInterval(() => {
  const z = biezaceZadanie;
  if (!z) return;
  odswiezHeartbeat(z, workerId)
    .then((moje) => {
      if (!moje) console.warn(`[${workerId}] heartbeat: zadanie ${z.kind} nie należy już do tego workera (odzyskane jako zombie?)`);
    })
    .catch((b) => console.error(`[${workerId}] heartbeat:`, b));
}, 60_000);

// Tik automatyzacji co minutę per tenant: journeys reagują na zdarzenia (zapis z popupu,
// zamówienie) bez człowieka w pętli. Nakładanie się tików jest bezpieczne: unikalność
// messages (AD-26) i journey_runs zatrzymują duplikaty.
async function tikAutomatyzacji() {
  const { rows } = await getPool().query("select id from tenants");
  for (const t of rows) await dodajZadanie(t.id, "automatyzacje_tik", {});
}
await tikAutomatyzacji().catch((b) => console.error(`[${workerId}] tik automatyzacji (start):`, b));
setInterval(() => tikAutomatyzacji().catch((b) => console.error(`[${workerId}] tik automatyzacji:`, b)), 60_000);

// Rekoncyliacja co kwadrans per tenant (W3): wiadomości zawieszone w 'sending'
// przechodzą w 'held' i idzie alert — bez tego odbiorca po cichu wypadał z wysyłki.
async function zaplanujRekoncyliacje() {
  const { rows } = await getPool().query("select id from tenants");
  for (const t of rows) await dodajZadanie(t.id, "rekoncyliacja", {});
}
await zaplanujRekoncyliacje().catch((b) => console.error(`[${workerId}] rekoncyliacja (start):`, b));
setInterval(() => zaplanujRekoncyliacje().catch((b) => console.error(`[${workerId}] rekoncyliacja:`, b)), 900_000);

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
