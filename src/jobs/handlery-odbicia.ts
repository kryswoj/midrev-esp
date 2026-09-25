import { getPool } from "../adapters/db/pool";
import { BladImap } from "../adapters/email/imap";
import { pobierzOdbicia } from "../usecases/wysylka/odbicia";
import { zaladujSkrzynke, zapiszPrzebiegSkrzynki } from "../usecases/wysylka-konfiguracja/skrzynka-zwrotna";
import { wyslijAlert } from "./alerty";
import { dodajZadanie, type Zadanie } from "./kolejka";

/**
 * Handler `odbicia`: jeden przebieg skrzynki zwrotnej tenanta (IMAP → parser DSN/ARF →
 * zdarzenia odbić i skarg). Rejestrowany w worker.ts, planowany co 5 minut per tenant.
 *
 * Idempotentny: kursor UID + unikalność bounce_reports + unikalność zdarzeń. Dwa tiki
 * naraz są bezpieczne, ale i tak nie kolejkujemy drugiego, gdy pierwszy jeszcze czeka
 * albo trwa (skrzynka z 10 tys. maili po awarii nie ma dostać dziesięciu jobów).
 */

export const ODSTEP_ODBIC_MS = 5 * 60_000;

export const HANDLERY_ODBICIA: Record<string, (z: Zadanie) => Promise<void>> = {
  async odbicia(z) {
    const s = await zaladujSkrzynke(z.tenant_id);
    // brak konfiguracji albo hasła = nic do zrobienia; to nie jest błąd joba
    if (!s) return;
    if (!s.polaczenieSprawdzone) {
      // Niesprawdzona skrzynka (po zmianie ustawień) nie jest czytana — jak niesprawdzony
      // serwer SMTP nie wysyła. Zapisujemy powód do panelu, bez alertu i bez ponowień.
      await zapiszPrzebiegSkrzynki(z.tenant_id, { blad: "Skrzynka nie przeszła testu połączenia po ostatniej zmianie. Ustawienia → Wysyłka i domeny → „Testuj skrzynkę”." });
      return;
    }
    try {
      const p = await pobierzOdbicia(z.tenant_id, s.klient, s.kursor);
      await zapiszPrzebiegSkrzynki(z.tenant_id, { uidvalidity: p.uidvalidity, ostatniUid: p.ostatniUid, blad: null });
      if (p.przejrzane > 0) {
        console.log(
          `[odbicia] tenant ${z.tenant_id}: przejrzane ${p.przejrzane}, zapisane ${p.zapisane}, bez wiadomości ${p.bezWiadomosci}, nie-odbicia ${p.nieOdbicia}, pominięte ${p.pominiete}${p.zostalo ? ", w skrzynce zostało więcej" : ""}`,
        );
      }
      if (p.zostalo) {
        // reszta bez czekania na następny tik, ale nadal jeden job naraz
        await dodajZadanie(z.tenant_id, "odbicia", {}, { opoznienieSek: 5 });
      }
    } catch (blad) {
      // Komunikat błędu z adaptera nigdy nie zawiera hasła (adapter tego pilnuje);
      // do panelu idzie zdanie dla człowieka, do alertu to samo.
      const opis = blad instanceof BladImap ? blad.message : `Odczyt skrzynki nie powiódł się: ${String((blad as Error)?.message ?? blad).replace(/[\r\n]+/g, " ").slice(0, 300)}`;
      await zapiszPrzebiegSkrzynki(z.tenant_id, { blad: opis });
      if (blad instanceof BladImap && (blad.kod === "logowanie" || blad.kod === "tls" || blad.kod === "host")) {
        // konfiguracja, nie sieć: ponawianie nic nie da, człowiek musi poprawić dane
        await wyslijAlert(`skrzynka zwrotna tenanta ${z.tenant_id} (${s.host}:${s.port}) nie działa: ${opis}`);
        return;
      }
      throw blad;
    } finally {
      await s.klient.zamknij().catch(() => {});
    }
  },
};

/** Tik planujący: po jednym jobie na tenanta ze skonfigurowaną, sprawdzoną skrzynką. */
export async function zaplanujOdbicia(): Promise<number> {
  const { rows } = await getPool().query<{ tenant_id: string }>(
    `select c.tenant_id from tenant_smtp_configs c
      where c.bounce_imap_host is not null and c.bounce_imap_password_encrypted is not null
        and not exists (
          select 1 from jobs j
           where j.tenant_id = c.tenant_id and j.kind = 'odbicia' and j.status in ('pending', 'running')
        )`,
  );
  for (const w of rows) await dodajZadanie(w.tenant_id, "odbicia", {});
  return rows.length;
}
