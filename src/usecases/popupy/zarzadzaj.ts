import { z } from "zod";
import { getPool } from "../../adapters/db/pool";

// Zarzadzanie popupami z panelu i odczyt konfiguracji dla skryptu on-site (Epik F).
// SQL lokalnie zamiast w repozytoria.ts z tego samego powodu co w zglos-popup.ts:
// praca rownolegla, wspolne pliki nietykalne; po scaleniu do przeniesienia (AD-18).

export interface Popup {
  id: string;
  tenant_id: string;
  name: string;
  headline: string;
  body_text: string;
  button_text: string;
  discount_code: string | null;
  rules: { delay_seconds?: number };
  active: boolean;
  created_at: Date;
}

export interface WierszPopupu extends Popup {
  /** ile zgloszen przyszlo przez ten popup, liczone z events 'popup.submitted' */
  zgloszen: number;
}

export async function popupyTenanta(tenantId: string): Promise<WierszPopupu[]> {
  const { rows } = await getPool().query<WierszPopupu>(
    `select p.id, p.tenant_id, p.name, p.headline, p.body_text, p.button_text,
            p.discount_code, p.rules, p.active, p.created_at,
            (select count(*)::int from events e
              where e.tenant_id = p.tenant_id
                and e.event_type = 'popup.submitted'
                and e.payload->>'popup_id' = p.id::text) as zgloszen
       from popups p
      where p.tenant_id = $1
      order by p.created_at desc`,
    [tenantId],
  );
  return rows;
}

// Tresci popupu trafiaja do skryptu ladowanego na cudzych stronach, wiec dlugosc
// jest czescia kontraktu: bez limitow jedna sciana tekstu robi z popupu
// nieuzywalny, wielosetkilobajtowy skrypt (znalezisko review).
const schematPopupu = z.object({
  name: z.string().trim().min(1).max(120),
  headline: z.string().trim().min(1).max(200),
  bodyText: z.string().trim().min(1).max(1000),
  buttonText: z.string().trim().min(1).max(80),
  discountCode: z.string().trim().min(1).max(60).nullable(),
  delaySeconds: z.number(),
});

export async function utworzPopup(
  tenantId: string,
  daneWejsciowe: {
    name: string;
    headline: string;
    bodyText: string;
    buttonText: string;
    discountCode: string | null;
    delaySeconds: number;
  },
): Promise<string> {
  const dane = schematPopupu.parse(daneWejsciowe);
  // delay ograniczony do sensownego zakresu juz tutaj, bo trafia do setTimeout
  // w przegladarce odbiorcy: ujemny albo absurdalnie dlugi psuje popup po cichu
  const delay = Math.min(Math.max(Math.round(dane.delaySeconds), 0), 600);
  const { rows } = await getPool().query(
    `insert into popups (tenant_id, name, headline, body_text, button_text, discount_code, rules)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      tenantId,
      dane.name,
      dane.headline,
      dane.bodyText,
      dane.buttonText,
      dane.discountCode,
      JSON.stringify({ delay_seconds: delay }),
    ],
  );
  return rows[0].id as string;
}

/**
 * Wlacza albo wylacza popup. Predykat tenant_id, zeby id z cudzego tenanta nic
 * nie zrobilo. Zwraca, czy COKOLWIEK sie zmienilo: wywolujacy nie ma prawa
 * raportowac sukcesu po UPDATE, ktory nie trafil w zaden wiersz (znalezisko
 * review; ten sam blad co klamiace liczniki backfilli).
 */
export async function ustawAktywnosc(
  tenantId: string,
  popupId: string,
  aktywny: boolean,
): Promise<boolean> {
  const wynik = await getPool().query(
    "update popups set active = $3 where tenant_id = $1 and id = $2",
    [tenantId, popupId, aktywny],
  );
  return (wynik.rowCount ?? 0) > 0;
}

/**
 * Najnowszy aktywny popup tenanta - to jego konfiguracje skrypt on-site wstrzykuje
 * na strone sklepu. "Najnowszy" jest swiadomym rozstrzygnieciem: gdy operator
 * wlaczy dwa popupy naraz, wygrywa ostatnio utworzony, zamiast losowego.
 */
export async function aktywnyPopup(tenantId: string): Promise<Popup | null> {
  const { rows } = await getPool().query<Popup>(
    `select id, tenant_id, name, headline, body_text, button_text, discount_code, rules, active, created_at
       from popups
      where tenant_id = $1 and active
      order by created_at desc
      limit 1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

/**
 * Konfiguracja popupu dla publicznego GET. Tylko aktywne popupy i BEZ kodu
 * rabatowego: kod dostaje sie dopiero po zostawieniu adresu, inaczej kazdy
 * moglby go wyciagnac z odpowiedzi bez zapisu.
 */
export async function popupPubliczny(popupId: string): Promise<Omit<Popup, "discount_code"> | null> {
  const { rows } = await getPool().query<Popup>(
    `select id, tenant_id, name, headline, body_text, button_text, rules, active, created_at
       from popups
      where id = $1 and active`,
    [popupId],
  );
  return rows[0] ?? null;
}
