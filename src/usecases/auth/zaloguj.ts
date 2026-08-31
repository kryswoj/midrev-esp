import {
  utworzSesje,
  usunWygasleSesjeUzytkownika,
  uzytkownikPoEmailu,
} from "../../adapters/db/auth";
import { zweryfikujHaslo } from "./hasla";
import { przekroczonyLimit, wyczyscLimit, zanotujPorazke } from "./limiter";
import { nowyTokenSesji, zahaszujToken, WAZNOSC_SESJI_DNI } from "./sesja";

export type WynikLogowania =
  | { ok: true; token: string; wygasa: Date }
  | { ok: false; blad: string };

// Jeden komunikat na oba przypadki (zly adres, zle haslo): rozrozniony komunikat
// zamienia formularz logowania w wyrocznie istnienia kont.
const ODMOWA: WynikLogowania = { ok: false, blad: "Nieprawidłowy adres albo hasło" };

const ZA_DUZO_PROB: WynikLogowania = {
  ok: false,
  blad: "Za dużo nieudanych prób logowania. Spróbuj ponownie za kwadrans.",
};

// prog per konto ostrzejszy niz per adres IP: za jednym NAT-em pracuje wielu
// ludzi, ale nikt nie myli hasla do JEDNEGO konta dziesiec razy w kwadrans
const MAKS_PROB_KONTO = 10;
const MAKS_PROB_IP = 30;

// Hash-atrapa do weryfikacji, gdy konto nie istnieje: bez niej brak konta konczy
// sie odpowiedzia w mikrosekundy, a istniejace konto w ~150 ms scryptu, i czas
// odpowiedzi zdradza, ktore adresy maja konta (ten sam kanal, co rozrozniony
// komunikat, tylko mierzony stoperem). STALA, nie liczona w request path -
// atrapa generowana leniwie robila na zimnym procesie dwa scrypty zamiast
// jednego i sama stawala sie sygnalem czasowym (znalezisko z review).
// Hash losowego, wyrzuconego hasla; parametry identyczne z zahaszujHaslo.
const HASZ_ATRAPY =
  "scrypt$17$8$1$K8d7ppWHRXryvQtzVsggHw$XayoqS3w4HPJPeSij0rGVzr5ns9udXOTMq3CY9b_lEFnIsQ1DN7pAEBW6hvKnKASFpMMT5ZrGmKEHq2o_CDBtQ";

/**
 * Logowanie (Story 1.4). Zwraca token w postaci jawnej DOKLADNIE RAZ - trafia
 * do ciasteczka HttpOnly i nigdzie indziej. Baza dostaje wylacznie jego hash.
 * `klientIp` sluzy tylko limitowi prob; brak (testy, brak proxy) znaczy brak
 * limitu per IP, limit per konto dziala zawsze.
 */
export async function zaloguj(
  email: string,
  haslo: string,
  klientIp?: string,
): Promise<WynikLogowania> {
  const kluczKonta = "konto:" + email.trim().toLowerCase();
  const kluczIp = klientIp ? "ip:" + klientIp : null;

  // limit sprawdzany PRZED scryptem: odmowa ma kosztowac mikrosekundy,
  // inaczej sam limiter nie chroni przed DoS-em na pamiec i threadpool
  if (przekroczonyLimit(kluczKonta, MAKS_PROB_KONTO)) return ZA_DUZO_PROB;
  if (kluczIp && przekroczonyLimit(kluczIp, MAKS_PROB_IP)) return ZA_DUZO_PROB;

  const uzytkownik = await uzytkownikPoEmailu(email);
  if (!uzytkownik) {
    // ta sama praca, co dla istniejacego konta - wyrownanie czasu odpowiedzi
    await zweryfikujHaslo(haslo, HASZ_ATRAPY);
    zanotujPorazke(kluczKonta);
    if (kluczIp) zanotujPorazke(kluczIp);
    return ODMOWA;
  }

  const poprawne = await zweryfikujHaslo(haslo, uzytkownik.password_hash);
  if (!poprawne) {
    zanotujPorazke(kluczKonta);
    if (kluczIp) zanotujPorazke(kluczIp);
    return ODMOWA;
  }

  wyczyscLimit(kluczKonta);

  // token generowany ZAWSZE od nowa po uwierzytelnieniu, nigdy przyjmowany
  // z zewnatrz - to zamyka fixation: atakujacy nie moze podrzucic ofierze
  // wlasnego identyfikatora sesji przed zalogowaniem
  const token = nowyTokenSesji();
  const wygasa = new Date(Date.now() + WAZNOSC_SESJI_DNI * 24 * 60 * 60 * 1000);
  await usunWygasleSesjeUzytkownika(uzytkownik.id);
  await utworzSesje(uzytkownik.id, zahaszujToken(token), wygasa);

  return { ok: true, token, wygasa };
}
