import type pg from "pg";

/**
 * Zgody na śledzenie otwarć i kliknięć (Blok A, A5).
 *
 * To NIE jest równoległy system zgód. Czyta ten sam append-only rejestr `consents`
 * z 0004 (AD-16), tylko na innych kanałach: `email_open_tracking` i `email_click_tracking`
 * obok `email`. Dzięki temu na pytanie "na co ta osoba się zgodziła" odpowiada jedno
 * zapytanie do jednej tabeli, a nie zestawienie dwóch logów, które się rozjadą.
 *
 * Zgoda marketingowa celowo NIE jest tu liczona: jedynym wiążącym miejscem, które
 * odpowiada na pytanie "czy wolno wysłać", jest `canSendTo` (AD-9, AD-25). Dwa
 * niezależne wyliczenia tej samej rzeczy to gwarantowany rozjazd.
 */

export interface ZgodyNaSledzenie {
  otwarcia: boolean;
  klikniecia: boolean;
}

type Polityka = "dozwolone" | "wymaga_zgody";

export interface PolitykaSledzenia {
  otwarcia: Polityka;
  klikniecia: Polityka;
}

/**
 * Polityka tenanta odczytywana OSOBNO, żeby dało się ją pobrać raz na kampanię zamiast
 * raz na odbiorcę. Przy liście na dziesięć tysięcy adresów to jest różnica dziesięciu
 * tysięcy zapytań, które mówiłyby dokładnie to samo.
 */
export async function politykaSledzenia(
  klient: pg.PoolClient | pg.Pool,
  tenantId: string,
): Promise<PolitykaSledzenia | null> {
  const { rows } = await klient.query<PolitykaSledzenia>(
    `select open_tracking_default as otwarcia, click_tracking_default as klikniecia
       from tenants where id = $1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

interface WierszZgody {
  channel: string;
  state: string;
  wazna: boolean;
}

/**
 * `can_receive` w rozumieniu Klaviyo, liczone, a nie trzymane w kolumnie: kolumna
 * skłamałaby w chwili, w której wpis wygaśnie albo ktoś dopisze wycofanie.
 *
 * Dwie polityki per tenant (kolumny na `tenants` z 0014), bo to administrator danych
 * odpowiada przed swoim organem, nie my:
 *   `dozwolone`   — śledzenie działa, dopóki ktoś go JAWNIE nie wycofa. Stan dzisiejszy.
 *   `wymaga_zgody` — śledzenie wyłącznie po jawnej, niewygasłej zgodzie (CNIL, Garante).
 */
export async function zgodyNaSledzenie(
  klient: pg.PoolClient | pg.Pool,
  tenantId: string,
  profileId: string | null,
  /** polityka pobrana wcześniej; bez niej funkcja dociąga ją sama */
  politykaZWierzchu?: PolitykaSledzenia | null,
): Promise<ZgodyNaSledzenie> {
  const polityka =
    politykaZWierzchu !== undefined ? politykaZWierzchu : await politykaSledzenia(klient, tenantId);
  // Nieistniejący tenant to nie jest sytuacja "domyślnie wolno". Nic nie śledzimy.
  if (!polityka) return { otwarcia: false, klikniecia: false };

  // Wiadomość bez profilu (np. test wysyłki na adres wpisany ręcznie) nie ma czyjej
  // zgody sprawdzić. Przy polityce restrykcyjnej to znaczy "nie wolno".
  if (!profileId) {
    return {
      otwarcia: polityka.otwarcia === "dozwolone",
      klikniecia: polityka.klikniecia === "dozwolone",
    };
  }

  // distinct on: stan zgody to OSTATNI wpis w rejestrze, nigdy suma wpisów (AD-16).
  // occurred_at desc, potem recorded_at desc, bo dwa wpisy z tą samą datą zdarzenia
  // (import i formularz) rozstrzyga kolejność zapisu, a nie kolejność w tabeli.
  const { rows } = await klient.query<WierszZgody>(
    `select distinct on (channel)
            channel, state,
            (state = 'granted' and (valid_until is null or valid_until > now())) as wazna
       from consents
      where tenant_id = $1 and profile_id = $2
        and channel in ('email_open_tracking', 'email_click_tracking')
      order by channel, occurred_at desc, recorded_at desc`,
    [tenantId, profileId],
  );
  const wpisy = new Map(rows.map((r) => [r.channel, r]));

  const rozstrzygnij = (kanal: string, jak: Polityka): boolean => {
    const wpis = wpisy.get(kanal);
    if (jak === "wymaga_zgody") return wpis?.wazna === true;
    // polityka liberalna: blokuje wyłącznie jawny wpis, który NIE uprawnia
    // (wycofanie albo zgoda po terminie ważności)
    return wpis ? wpis.wazna : true;
  };

  return {
    otwarcia: rozstrzygnij("email_open_tracking", polityka.otwarcia),
    klikniecia: rozstrzygnij("email_click_tracking", polityka.klikniecia),
  };
}
