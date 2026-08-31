import { uruchomAutomatyzacje } from "../usecases/automatyzacje/przetworz-zdarzenia";
import type { Zadanie } from "./kolejka";

/**
 * Handlery automatyzacji do wpiecia w mape HANDLERY workera (worker.ts nalezy do
 * innego wlasciciela, wiec eksportujemy mape zamiast edytowac go tutaj).
 *
 * Handler jest idempotentny (at-least-once, AD-5): ponowione zadanie niczego nie
 * dubluje, bo uruchomAutomatyzacje opiera sie o journey_runs i unikalnosc
 * wiadomosci z AD-26, a sama wysylka o SKIP LOCKED.
 */
export const HANDLERY_AUTOMATYZACJI: Record<string, (z: Zadanie) => Promise<void>> = {
  async automatyzacje_tik(z) {
    const wynik = await uruchomAutomatyzacje(z.tenant_id);
    // log mowi wprost, co licza liczniki: wyslijPartie oprozne CALA kolejke tenanta,
    // wiec "wyslane" moze obejmowac tez zalegle wiadomosci kampanii, nie tylko
    // zbudowane w tym tiku (licznik ma mowic prawde, nie wygladac dobrze)
    console.log(
      `[automatyzacje] tenant ${z.tenant_id}: zbudowane w tym tiku ${wynik.zbudowane}; ` +
        `partia z calej kolejki tenanta: wysłane ${wynik.wysylka.wyslane}, ` +
        `odmowy ${wynik.wysylka.odmowy}, błędy ${wynik.wysylka.bledy}`,
    );
    if (wynik.wysylka.powodZatrzymania === "limit_dobowy") {
      // limit dobowy NIE jest bledem (FR52): tik domyka sie normalnie, a nastepny
      // przychodzi za minute i tak. Rzut zuzywalby proby joba i po wyczerpaniu
      // budzil czlowieka alertem o czyms, co jest zwyklym stanem konca doby.
      console.log(`[automatyzacje] tenant ${z.tenant_id}: limit dobowy wyczerpany, reszta wyjdzie po polnocy`);
    }
  },
};
