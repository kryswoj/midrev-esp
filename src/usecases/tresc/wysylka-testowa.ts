import { randomBytes, randomUUID } from "node:crypto";
import { getPool } from "../../adapters/db/pool";
import { zlozWiadomosc } from "../wysylka/renderuj";
import { wyslijPartie } from "../wysylka/wyslij-kampanie";

/**
 * Wysyłka testowa kampanii. Idzie DOKŁADNIE tą samą ścieżką co wysyłka właściwa: ta sama
 * funkcja składająca (`zlozWiadomosc`), ta sama kolejka, ten sam wybór nadawcy i dostawcy.
 *
 * Wynik mówi prawdę o TEJ wiadomości, a nie o partii: `wyslijPartie` opróżnia kolejkę
 * tenanta od najstarszych, więc „wysłano 5" nie znaczy, że wyszedł nasz test. Po partii
 * czytamy stan wiersza testu i dopiero z niego budujemy komunikat. Blokadę nadawcy
 * (FR45, niesprawdzony serwer), wstrzymanie sklepu i limit dobowy zgłaszamy wprost —
 * wcześniej panel pisał „Test wysłany" także wtedy, gdy nic nie wyszło.
 */

const ADRES = /^[^@\s<>,;"()\[\]\\]+@[^@\s<>,;"()\[\]\\]+\.[^@\s<>,;"()\[\]\\]+$/;

export type WynikTestu = { ok: true; komunikat: string } | { ok: false; blad: string };

export async function wyslijTestKampanii(tenantId: string, campaignId: string, adresSurowy: string): Promise<WynikTestu> {
  const adres = adresSurowy.trim();
  if (!adres) return { ok: false, blad: "Podaj adres, na który ma pójść test." };
  if (adres.length > 320 || !ADRES.test(adres)) return { ok: false, blad: `„${adres}" nie wygląda na adres e-mail.` };

  const pool = getPool();
  const { rows } = await pool.query(
    `select c.subject, c.content, t.name as sklep,
            t.sender_company_name, t.sender_postal_address, t.sender_tax_id from campaigns c
      join tenants t on t.id = c.tenant_id where c.tenant_id = $1 and c.id = $2`,
    [tenantId, campaignId],
  );
  const kampania = rows[0];
  if (!kampania) return { ok: false, blad: "Nie znaleziono kampanii." };
  const html = String((kampania.content as any)?.html ?? "");
  if (!kampania.subject || !html.trim()) return { ok: false, blad: "Uzupełnij temat i treść przed testem." };

  // source_id losowy, żeby każdy test był osobną wiadomością
  const clickToken = randomBytes(18).toString("base64url");
  const unsubToken = randomBytes(18).toString("base64url");
  // Linki w teście BEZ przepisywania (review Codeksa, P2): trasa /r obsługuje tylko
  // wiadomości kampanii i automatyzacji, więc śledzony link z testu prowadziłby na stronę
  // główną panelu zamiast do sklepu. Stopka z wypisem, nadawca i kolejka — bez zmian.
  const { html: pelny } = zlozWiadomosc({
    trescHtml: html,
    clickToken,
    unsubscribeToken: unsubToken,
    nazwaSklepu: kampania.sklep,
    nadawca: { firma: kampania.sender_company_name, adres: kampania.sender_postal_address, nip: kampania.sender_tax_id },
    sledzKlikniecia: false,
  });
  const { rows: wstawione } = await pool.query(
    `insert into messages (tenant_id, profile_id, source_type, source_id, email, subject, body_html, click_token, unsubscribe_token)
     values ($1, null, 'test', $2, $3, $4, $5, $6, $7) returning id`,
    [tenantId, randomUUID(), adres, `[TEST] ${kampania.subject}`, pelny, clickToken, unsubToken],
  );
  const idTestu = wstawione[0].id as string;
  const partia = await wyslijPartie(tenantId, { limit: 5 });

  // Najpierw stan TEJ wiadomości: równoległy worker mógł ją wysłać, nawet jeśli nasza
  // partia się zatrzymała (review Codeksa, P2).
  const { rows: stan } = await pool.query(
    "select current_state from messages where tenant_id = $1 and id = $2",
    [tenantId, idTestu],
  );
  const s = String(stan[0]?.current_state ?? "");
  if (s === "sent" || s === "delivered") return { ok: true, komunikat: `Test wysłany na ${adres}.` };
  if (s === "sending" || s === "claimed") {
    // wynik nieznany (np. timeout u dostawcy): NIE piszemy „nie przyjął", bo ponowienie
    // mogłoby dać duplikat
    return {
      ok: false,
      blad: "Nie wiadomo jeszcze, czy dostawca przyjął test (brak potwierdzenia). Sprawdź skrzynkę, zanim wyślesz ponownie.",
    };
  }

  if (partia.powodZatrzymania === "blokada_nadawcy") {
    return {
      ok: false,
      blad: `Test NIE wyszedł — wysyłka tego konta jest zablokowana: ${partia.powodOpis ?? "blokada nadawcy"} Wiadomość testowa czeka w kolejce i wyjdzie po usunięciu blokady.`,
    };
  }
  if (partia.powodZatrzymania === "wstrzymanie_tenanta") {
    return {
      ok: false,
      blad: `Test NIE wyszedł — wysyłka sklepu jest wstrzymana${partia.powodOpis ? `: ${partia.powodOpis}` : ""}. Wiadomość testowa czeka w kolejce.`,
    };
  }
  if (partia.powodZatrzymania === "limit_dobowy") {
    return { ok: false, blad: "Test NIE wyszedł — konto wyczerpało dzisiejszy limit wysyłki. Wiadomość testowa czeka w kolejce do jutra." };
  }
  if (s === "queued") {
    return {
      ok: false,
      blad: "Test czeka w kolejce — przed nim są starsze wiadomości tego konta. Wyjdzie w następnej partii workera.",
    };
  }
  return { ok: false, blad: `Test nie wyszedł — dostawca odrzucił wiadomość (stan: ${s || "nieznany"}). Sprawdź serwer w Ustawieniach → Wysyłka i domeny.` };
}
