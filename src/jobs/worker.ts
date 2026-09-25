import { randomBytes } from "node:crypto";
import { getPool } from "../adapters/db/pool";
import { config } from "../config";
import { przeliczAtrybucje } from "../usecases/przelicz-atrybucje";
import { przetworzZdarzenie } from "../usecases/przetworz-zdarzenie";
import { wyslijPartie, zbudujWiadomosciKampanii } from "../usecases/wysylka/wyslij-kampanie";
import { rekoncyliacjaWysylki } from "../usecases/wysylka/rekoncyliacja";
import { sprawdzProgiReputacji } from "../usecases/wysylka/reputacja";
import { domknijOdwolane, wypchnijZaplanowane } from "../usecases/wysylka/sterowanie";
import { wyslijAlert } from "./alerty";
import { dodajZadanie, domknijZadanie, odlozZadanie, odswiezHeartbeat, zajmijZadanie, type Zadanie } from "./kolejka";
import { HANDLERY_AUTOMATYZACJI } from "./handlery-automatyzacje";
import { HANDLERY_CYKLICZNE, zarejestrujCykliczne } from "./handlery-cykliczne";
import { HANDLERY_ODBICIA, ODSTEP_ODBIC_MS, zaplanujOdbicia } from "./handlery-odbicia";
import { HANDLERY_IMPORTU } from "./handlery-import";

/**
 * Worker: jedna pętla, zajmowanie pojedynczo przez SKIP LOCKED, każdy handler idempotentny
 * (dostarczenie at-least-once, AD-5). Wywołania sieciowe dzieją się POZA transakcją
 * zajmującą zadanie (AD-31): zajęcie jest własnym UPDATE-em, handler pracuje po commicie.
 */
const workerId = `worker-${randomBytes(4).toString("hex")}`;

/** Status kampanii czytany z bazy, nie z pamięci joba: przycisk w panelu działa natychmiast. */
async function statusKampanii(tenantId: string, campaignId: string): Promise<string | null> {
  const { rows } = await getPool().query(
    "select status from campaigns where tenant_id = $1 and id = $2",
    [tenantId, campaignId],
  );
  return rows[0]?.status ?? null;
}

const HANDLERY: Record<string, (z: Zadanie) => Promise<void>> = {
  ...HANDLERY_AUTOMATYZACJI,
  ...HANDLERY_CYKLICZNE,
  ...HANDLERY_ODBICIA,
  ...HANDLERY_IMPORTU,
  async wyslij_kampanie(z) {
    const campaignId = String(z.payload.campaignId);
    // Kampania mogła zostać wstrzymana albo odwołana MIĘDZY wrzuceniem joba a jego
    // podjęciem (job czeka w kolejce, a przycisk działa natychmiast). Budowa wiadomości
    // dla odwołanej kampanii utworzyłaby wiersze, które zaraz trzeba by domykać.
    const stanStartowy = await statusKampanii(z.tenant_id, campaignId);
    if (stanStartowy !== "sending") {
      console.log(`[${workerId}] kampania ${campaignId}: job pominięty, status ${stanStartowy ?? "brak kampanii"}`);
      return;
    }
    await zbudujWiadomosciKampanii(z.tenant_id, campaignId);
    let wynik;
    do {
      wynik = await wyslijPartie(z.tenant_id, { limit: config().WYSYLKA_ROZMIAR_PARTII });
      console.log(`[${workerId}] kampania ${campaignId}: wysłane ${wynik.wyslane}, odmowy ${wynik.odmowy}, błędy ${wynik.bledy}`);
      if (wynik.powodZatrzymania === "wstrzymanie_tenanta") {
        // Wysyłka CAŁEGO tenanta wstrzymana (B5). To nie jest błąd joba: ponawianie
        // niczego nie naprawi, a wyczerpane próby wysłałyby drugi alert o tej samej
        // sprawie. Kampania zostaje w 'sending' — bo to prawda o jej stanie — a nowy
        // job wchodzi w chwili ręcznego wznowienia wysyłki sklepu.
        console.warn(`[${workerId}] kampania ${campaignId}: wysyłka sklepu wstrzymana (${wynik.powodOpis ?? "bez powodu"}), job kończy się`);
        return;
      }
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

      if (wynik.wyslane > 0) {
        // B5: progi reputacji sprawdzane po KAŻDEJ partii, która coś przekazała dostawcy.
        // Kampania sypiąca odbiciami ma stanąć po jednej partii (WYSYLKA_ROZMIAR_PARTII,
        // domyślnie 100), a nie po dziesięciu tysiącach — dlatego tutaj, a nie tylko
        // w cyklicznym jobie.
        const progi = await sprawdzProgiReputacji(z.tenant_id);
        if (progi.wstrzymany) {
          console.warn(`[${workerId}] kampania ${campaignId}: progi reputacji przekroczone (${progi.powod ?? "-"}), wysyłka sklepu wstrzymana`);
          return;
        }
      }

      // B2: status kampanii sprawdzany MIĘDZY partiami. W środku partii nie wolno:
      // wiadomość już zajęta zostałaby w stanie 'claimed' bez nikogo, kto ją domknie.
      const status = await statusKampanii(z.tenant_id, campaignId);
      if (status !== "sending") {
        console.log(`[${workerId}] kampania ${campaignId}: wysyłka zatrzymana między partiami, status ${status ?? "brak kampanii"}`);
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
  async reputacja(z) {
    // Skargi i odbicia przychodzą webhookami DŁUGO po tym, jak wysyłka się skończyła —
    // wtedy żadna pętla wysyłki już nie chodzi i nie ma czego przerywać. Ten job jest
    // jedynym miejscem, które to wyłapie.
    const wynik = await sprawdzProgiReputacji(z.tenant_id);
    if (wynik.wstrzymanyTeraz) {
      console.warn(`[${workerId}] tenant ${z.tenant_id}: wysyłka wstrzymana automatycznie — ${wynik.powod}`);
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
  for (const t of rows) {
    await dodajZadanie(t.id, "rekoncyliacja", {});
    // B5: kontrola progów reputacji w tym samym rytmie. Osobny job, nie doklejka do
    // rekoncyliacji: awaria jednego nie może zabrać drugiego, a oba mają własny licznik prób.
    await dodajZadanie(t.id, "reputacja", {});
  }
}
await zaplanujRekoncyliacje().catch((b) => console.error(`[${workerId}] rekoncyliacja (start):`, b));
setInterval(() => zaplanujRekoncyliacje().catch((b) => console.error(`[${workerId}] rekoncyliacja:`, b)), 900_000);

// Skrzynka zwrotna (odbicia i skargi przez IMAP) co 5 minut per tenant, który ją ma
// skonfigurowaną (audyt 24.09, #3). Bez tego przy własnym SMTP klienta twarde odbicia
// nigdy nie trafiały do wykluczeń, a progi reputacji liczyły na pustym mianowniku.
await zaplanujOdbicia().catch((b) => console.error(`[${workerId}] odbicia (start):`, b));
setInterval(() => zaplanujOdbicia().catch((b) => console.error(`[${workerId}] odbicia:`, b)), ODSTEP_ODBIC_MS);

// B1: dispatcher zaplanowanych kampanii, co minutę. Do tej pory `scheduled_at` czytał
// wyłącznie panel, więc plan wysyłki był napisem na ekranie. Dwa workery robiące ten tik
// naraz są bezpieczne: start kampanii to jeden atomowy UPDATE ze statusu 'approved',
// a wpis do kolejki idzie w tej samej transakcji (patrz wypchnijZaplanowane).
async function tikHarmonogramu() {
  const wynik = await wypchnijZaplanowane();
  for (const u of wynik.uruchomione) {
    console.log(`[${workerId}] harmonogram: kampania ${u.campaignId} (tenant ${u.tenantId}) weszła w wysyłkę o zaplanowanej porze`);
  }
  if (wynik.przeterminowane) {
    console.warn(`[${workerId}] harmonogram: ${wynik.przeterminowane} planów przeterminowanych, alert wysłany`);
  }
  const domkniete = await domknijOdwolane();
  if (domkniete) {
    console.log(`[${workerId}] harmonogram: domknięto ${domkniete} wiadomości z kolejek odwołanych kampanii`);
  }
}
await tikHarmonogramu().catch((b) => console.error(`[${workerId}] harmonogram (start):`, b));
setInterval(() => tikHarmonogramu().catch((b) => console.error(`[${workerId}] harmonogram:`, b)), 60_000);

// Joby cykliczne agenta danych (import, sprzątanie): rejestracja tików w tym procesie.
zarejestrujCykliczne({ workerId });

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
