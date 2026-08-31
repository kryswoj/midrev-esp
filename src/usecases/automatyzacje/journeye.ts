import { getPool } from "../../adapters/db/pool";

/**
 * Slownik wyzwalaczy jest zamkniety celowo: trigger_event trafia 1:1 do zapytania
 * po tabeli events, wiec dowolny tekst z formularza bylby cichym "journey, ktory
 * nigdy nie rusza". Nowy wyzwalacz = swiadomy wpis tutaj, nie literowka operatora.
 */
export const TRIGGERY: Record<string, string> = {
  "popup.submitted": "zapis z popupu",
  "order.created": "złożone zamówienie",
};

export interface Journey {
  id: string;
  name: string;
  trigger_event: string;
  delay_minutes: number;
  subject: string;
  content: { html?: string };
  active: boolean;
  active_since: string | null;
  created_at: string;
  wyslane: number;
}

export async function journeyeTenanta(tenantId: string): Promise<Journey[]> {
  // licznik z message_events 'sent', nie z current_state: bounce nadpisuje stan,
  // a mail, ktory sie odbil, WYSZEDL i ma sie liczyc jako wyslany
  const { rows } = await getPool().query(
    `select j.id, j.name, j.trigger_event, j.delay_minutes, j.subject, j.content,
            j.active, j.active_since, j.created_at,
            (select count(*)::int
               from messages m
               join message_events e on e.tenant_id = m.tenant_id and e.message_id = m.id
              where m.tenant_id = j.tenant_id and m.source_type = 'journey'
                and m.source_id = j.id and e.event_type = 'sent') as wyslane
       from journeys j
      where j.tenant_id = $1
      order by j.created_at desc`,
    [tenantId],
  );
  return rows as Journey[];
}

export async function utworzJourney(
  tenantId: string,
  dane: { name: string; triggerEvent: string; delayMinutes: number; subject: string; html: string },
): Promise<{ ok: true; id: string } | { ok: false; blad: string }> {
  if (!TRIGGERY[dane.triggerEvent]) return { ok: false, blad: "Nieznany wyzwalacz" };
  if (!dane.name.trim()) return { ok: false, blad: "Automatyzacja musi mieć nazwę" };
  if (!dane.subject.trim()) return { ok: false, blad: "Automatyzacja musi mieć temat" };
  if (!dane.html.trim()) return { ok: false, blad: "Automatyzacja musi mieć treść" };
  // limity dlugosci: to input z formularza idacy wprost do bazy i do maili,
  // wiec bez capa jeden wklejony plik potrafi rozdac megabajtowe wiersze
  if (dane.name.length > 200) return { ok: false, blad: "Nazwa jest za długa (max 200 znaków)" };
  if (dane.subject.length > 500) return { ok: false, blad: "Temat jest za długi (max 500 znaków)" };
  if (dane.html.length > 200_000) return { ok: false, blad: "Treść jest za długa (max 200 tys. znaków)" };
  // niefinitywne opoznienie to ODMOWA, nie ciche zero: "1e309 minut" zamienione
  // na wysylke natychmiastowa byloby najgorszym mozliwym domyslem (review, runda 2)
  if (!Number.isFinite(dane.delayMinutes) || dane.delayMinutes < 0) {
    return { ok: false, blad: "Opóźnienie musi być liczbą minut, zero lub więcej" };
  }
  // sufit 30 dni: delay to odstep "chwile po zdarzeniu", nie kampania cykliczna
  const delay = Math.min(Math.trunc(dane.delayMinutes), 43_200);

  const { rows } = await getPool().query(
    `insert into journeys (tenant_id, name, trigger_event, delay_minutes, subject, content)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, name) do nothing
     returning id`,
    [tenantId, dane.name.trim(), dane.triggerEvent, delay, dane.subject.trim(), JSON.stringify({ html: dane.html })],
  );
  if (!rows[0]) return { ok: false, blad: "Automatyzacja o tej nazwie już istnieje" };
  return { ok: true, id: rows[0].id };
}

/**
 * Ustawienie aktywnosci na STAN DOCELOWY, nie negacja: podwojny submit albo retry
 * server action z "not active" konczylby stanem odwrotnym do intencji operatora
 * (znalezisko z review). Przy przejsciu w aktywnosc ustawia active_since = now():
 * od tej chwili journey widzi tylko zdarzenia POZNIEJSZE, wiec wlaczenie po
 * tygodniu przerwy nie ostrzeliwuje ludzi ze zdarzen sprzed aktywacji.
 */
export async function przelaczJourney(
  tenantId: string,
  journeyId: string,
  docelowa: boolean,
): Promise<boolean | null> {
  const { rows } = await getPool().query(
    `update journeys
        set active = $3,
            active_since = case when $3::boolean and not active then now() else active_since end
      where tenant_id = $1 and id = $2
      returning active`,
    [tenantId, journeyId, docelowa],
  );
  return rows[0]?.active ?? null;
}

/**
 * Gotowce. HTML jest punktem startu do edycji przez operatora, dlatego link do
 * sklepu to jawny placeholder do podmiany, a nie zgadywany adres.
 */
export const SZABLONY: Record<
  string,
  { name: string; triggerEvent: string; delayMinutes: number; subject: string; html: string }
> = {
  welcome: {
    name: "Powitanie po zapisie",
    triggerEvent: "popup.submitted",
    delayMinutes: 0,
    subject: "Witaj! Dobrze, że jesteś",
    html: [
      "<p>Cześć!</p>",
      "<p>Dziękujemy za zapis. Od teraz będziesz pierwszą osobą, która dowie się o nowościach i promocjach.</p>",
      "<p>Na dobry początek zajrzyj do sklepu i zobacz, co przygotowaliśmy:</p>",
      '<p><a href="https://TWOJ-SKLEP.example.pl">Zobacz sklep</a></p>',
      "<p>Do zobaczenia w skrzynce!</p>",
    ].join("\n"),
  },
  postpurchase: {
    name: "Podziękowanie po zakupie",
    triggerEvent: "order.created",
    delayMinutes: 60,
    subject: "Dziękujemy za zamówienie",
    html: [
      "<p>Cześć!</p>",
      "<p>Dziękujemy za zakup. Zamówienie jest już u nas i zajmujemy się nim od razu.</p>",
      "<p>Zanim paczka dotrze, zobacz, co klienci najczęściej dobierają do tego zamówienia:</p>",
      '<p><a href="https://TWOJ-SKLEP.example.pl/polecane">Zobacz polecane produkty</a></p>',
      "<p>Gdyby cokolwiek było niejasne, po prostu odpisz na tę wiadomość.</p>",
    ].join("\n"),
  },
};
