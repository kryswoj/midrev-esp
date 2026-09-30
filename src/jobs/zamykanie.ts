/**
 * Stan „proces się zamyka" (SIGTERM/SIGINT workera). Osobny moduł, bo czytają go dwa
 * miejsca bez wzajemnej zależności: pętla workera (przestaje zajmować zadania) i pętla
 * wysyłki partii (`wyslijPartie` kończy bieżącą wiadomość i oddaje resztę partii do
 * kolejki). Flaga jest jednokierunkowa: zamykanego procesu nie da się „odwołać".
 *
 * Dlaczego partia nie leci do końca: przy stu wiadomościach i wolnym SMTP to minuty,
 * a systemd po TimeoutStopSec wysyła SIGKILL. Zabicie w połowie rozmowy SMTP zostawia
 * wiadomość w `sending` (held + ręczne wyjaśnianie). Wiadomość w `claimed` jest
 * bezpieczna do oddania: dostawca nie był dla niej wołany (patrz partycje.ts,
 * odzyskajZombie), więc oddanie jej do `queued` nie grozi podwójną wysyłką (AD-26).
 */
let zamykanie = false;
const sluchacze = new Set<() => void>();

export function czyZamykanie(): boolean {
  return zamykanie;
}

export function oglosZamykanie(): void {
  if (zamykanie) return;
  zamykanie = true;
  for (const s of sluchacze) {
    try {
      s();
    } catch {
      // słuchacz nie może zatrzymać zamykania
    }
  }
}

/** Rejestruje reakcję na zamykanie (np. przerwanie drzemki pętli). Zwraca wyrejestrowanie. */
export function naZamykanie(s: () => void): () => void {
  sluchacze.add(s);
  return () => sluchacze.delete(s);
}

/** Drzemka przerywana zamykaniem: pusty worker nie czeka 2 s na SIGTERM. */
export function drzemka(ms: number): Promise<void> {
  if (zamykanie) return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(() => {
      wyrejestruj();
      r();
    }, ms);
    const wyrejestruj = naZamykanie(() => {
      clearTimeout(t);
      wyrejestruj();
      r();
    });
  });
}

/** WYŁĄCZNIE testy: przywrócenie stanu między przypadkami w jednym procesie vitest. */
export function zresetujZamykanieDlaTestow(): void {
  zamykanie = false;
  sluchacze.clear();
}
