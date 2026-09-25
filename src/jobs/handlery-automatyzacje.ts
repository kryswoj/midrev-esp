import { uruchomAutomatyzacje } from "../usecases/automatyzacje/przetworz-zdarzenia";
import { wyslijAlert } from "./alerty";
import type { Zadanie } from "./kolejka";

/**
 * Handlery automatyzacji do wpiecia w mape HANDLERY workera (worker.ts nalezy do
 * innego wlasciciela, wiec eksportujemy mape zamiast edytowac go tutaj).
 *
 * Handler jest idempotentny (at-least-once, AD-5): ponowione zadanie niczego nie
 * dubluje. Wejscie do flow chroni unikalnosc (tenant, flow, profil), przejscie
 * uczestnika blokada wiersza `for update skip locked` w jednej transakcji z zapisem
 * nowego wezla i wiadomosci, wiadomosc unikalnosc AD-26, a wysylka SKIP LOCKED.
 */
export const HANDLERY_AUTOMATYZACJI: Record<string, (z: Zadanie) => Promise<void>> = {
  async automatyzacje_tik(z) {
    const wynik = await uruchomAutomatyzacje(z.tenant_id);
    // log mowi wprost, co licza liczniki: wyslijPartie oprozne CALA kolejke tenanta,
    // wiec "wyslane" moze obejmowac tez zalegle wiadomosci kampanii, nie tylko
    // zbudowane w tym tiku (licznik ma mowic prawde, nie wygladac dobrze)
    console.log(
      `[automatyzacje] tenant ${z.tenant_id}: wejścia ${wynik.wejscia}, przesunięci ${wynik.przesunieci}, błędy uczestników ${wynik.bledyUczestnikow}, ` +
        `zbudowane maile ${wynik.zbudowane}; partia z całej kolejki tenanta: wysłane ${wynik.wysylka.wyslane}, ` +
        `odmowy ${wynik.wysylka.odmowy}, błędy ${wynik.wysylka.bledy}`,
    );
    // Anomalia ma trafic do czlowieka, nie do logu: przerwana sciezka osoby, segment,
    // ktorego nie da sie policzyc, blad silnika na uczestniku.
    for (const tresc of wynik.alerty) await wyslijAlert(tresc, { poziom: "uwaga", tenantId: z.tenant_id });
    if (wynik.wysylka.powodZatrzymania === "limit_dobowy") {
      // limit dobowy NIE jest bledem (FR52): tik domyka sie normalnie, a nastepny
      // przychodzi za minute i tak. Rzut zuzywalby proby joba i po wyczerpaniu
      // budzil czlowieka alertem o czyms, co jest zwyklym stanem konca doby.
      console.log(`[automatyzacje] tenant ${z.tenant_id}: limit dobowy wyczerpany, reszta wyjdzie po północy`);
    }
  },
};
