import { getPool } from "../../adapters/db/pool";
import {
  klasyfikujOdbicieSes,
  klasyfikujOdpowiedzSmtp,
  klasyfikujSkarge,
  type Klasyfikacja,
} from "../../domain/email/klasyfikacja";
import { zapiszZdarzenie, type TypZdarzeniaWiadomosci } from "./wyslij-kampanie";

/**
 * Zdarzenia zaraportowane przez dostawcę: dostarczenie, odbicie, skarga, odrzucenie
 * treści (Blok A, A2).
 *
 * To jest wejście dla handlera webhooka (SNS przy SES — Blok D) i dla każdego innego
 * dostawcy. Handler ma robić dokładnie trzy rzeczy: sprawdzić podpis, sparsować payload
 * i zawołać tę funkcję. Klasyfikacja, decyzja o wykluczeniu adresu i zapis muszą być
 * TUTAJ, a nie w handlerze, żeby dwóch dostawców nie klasyfikowało tego samego inaczej.
 *
 * Wiadomość odnajdywana jest po identyfikatorze u dostawcy (indeks `messages_provider_id_idx`
 * z 0014) i ZAWSZE w obrębie tenanta: zdarzenie podszyte pod cudzy identyfikator nie ma
 * jak trafić w wiadomość innego sklepu.
 */

export type ZgloszenieDostawcy =
  | { rodzaj: "delivered"; kiedy: Date; smtpResponse?: string }
  | {
      rodzaj: "bounce";
      kiedy: Date;
      /** `Permanent` | `Transient` | `Undetermined` w nazewnictwie SES */
      bounceType: string;
      bounceSubType: string;
      diagnosticCode?: string;
    }
  | { rodzaj: "complaint"; kiedy: Date; complaintFeedbackType?: string; complaintSubType?: string }
  /** odrzucenie po stronie dostawcy, zanim mail poszedł dalej (SES: `Reject`, `Bad content`) */
  | { rodzaj: "reject"; kiedy: Date; powod: string }
  /** surowa odpowiedź SMTP z raportu zwrotnego, gdy dostawca nie daje własnej klasyfikacji */
  | { rodzaj: "bounce_smtp"; kiedy: Date; odpowiedz: string };

export interface WynikZgloszenia {
  zapisane: boolean;
  messageId?: string;
  typZdarzenia?: TypZdarzeniaWiadomosci;
  klasyfikacja?: Klasyfikacja;
  powodOdrzucenia?: "brak_wiadomosci" | "nie_jest_skarga" | "brak_daty_zdarzenia";
}

function przygotuj(zgloszenie: ZgloszenieDostawcy): {
  typ: TypZdarzeniaWiadomosci;
  klasyfikacja?: Klasyfikacja;
  payload: Record<string, unknown>;
} | null {
  switch (zgloszenie.rodzaj) {
    case "delivered":
      return { typ: "delivered", payload: { smtpResponse: zgloszenie.smtpResponse ?? null } };
    case "bounce": {
      const k = klasyfikujOdbicieSes(
        zgloszenie.bounceType,
        zgloszenie.bounceSubType,
        zgloszenie.diagnosticCode,
      );
      return {
        typ: k.typZdarzenia,
        klasyfikacja: k,
        payload: { bounceType: zgloszenie.bounceType, bounceSubType: zgloszenie.bounceSubType },
      };
    }
    case "bounce_smtp": {
      const k = klasyfikujOdpowiedzSmtp(zgloszenie.odpowiedz, "bounced");
      return { typ: k.typZdarzenia, klasyfikacja: k, payload: { odpowiedz: zgloszenie.odpowiedz } };
    }
    case "complaint": {
      const k = klasyfikujSkarge(zgloszenie.complaintFeedbackType, zgloszenie.complaintSubType);
      // `not-spam` NIE jest skargą (IANA). Zdarzenie nie powstaje, bo podbiłoby licznik
      // skarg i potrafiłoby wstrzymać zdrowego nadawcę.
      if (!k) return null;
      return {
        typ: "complained",
        klasyfikacja: k,
        payload: {
          complaintFeedbackType: zgloszenie.complaintFeedbackType ?? null,
          complaintSubType: zgloszenie.complaintSubType ?? null,
        },
      };
    }
    case "reject":
      return {
        typ: "dropped",
        klasyfikacja: {
          typZdarzenia: "dropped",
          klasa: null,
          kategoria: "content",
          kodSmtp: null,
          powodDostawcy: zgloszenie.powod,
          // odrzucenie treści to problem MAILA, nie adresu; wykluczenie odbiorcy byłoby
          // karaniem przypadkowej osoby za nasz załącznik
          wykluczAdres: false,
          liczySieDoWskaznika: false,
        },
        payload: { powod: zgloszenie.powod },
      };
  }
}

export async function zapiszZgloszenieDostawcy(
  tenantId: string,
  identyfikator: { providerId: string } | { messageId: string },
  zgloszenie: ZgloszenieDostawcy,
  opcje: {
    /** patrz OpcjeZdarzenia.wykluczenieGlobalne; domyślnie true (webhook dostawcy = zaufany) */
    wykluczenieGlobalne?: boolean;
  } = {},
): Promise<WynikZgloszenia> {
  if (!(zgloszenie.kiedy instanceof Date) || Number.isNaN(zgloszenie.kiedy.getTime())) {
    return { zapisane: false, powodOdrzucenia: "brak_daty_zdarzenia" };
  }

  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    "providerId" in identyfikator
      ? "select id from messages where tenant_id = $1 and provider_id = $2"
      : "select id from messages where tenant_id = $1 and id = $2",
    [tenantId, "providerId" in identyfikator ? identyfikator.providerId : identyfikator.messageId],
  );
  const messageId = rows[0]?.id;
  if (!messageId) return { zapisane: false, powodOdrzucenia: "brak_wiadomosci" };

  const przygotowane = przygotuj(zgloszenie);
  if (!przygotowane) return { zapisane: false, messageId, powodOdrzucenia: "nie_jest_skarga" };

  const klient = await pool.connect();
  try {
    await klient.query("begin");
    // Data zdarzenia to data OD DOSTAWCY (AD-10), nie chwila, w której webhook do nas
    // dotarł. Powiadomienie potrafi przyjść z godzinnym opóźnieniem, a raport
    // dostarczalności liczony po dacie zapisu pokazałby szczyt odbić, którego nie było.
    await zapiszZdarzenie(klient, tenantId, messageId, przygotowane.typ, {
      kiedy: zgloszenie.kiedy,
      payload: przygotowane.payload,
      klasyfikacja: przygotowane.klasyfikacja,
      wykluczenieGlobalne: opcje.wykluczenieGlobalne,
    });
    await klient.query("commit");
  } catch (blad) {
    await klient.query("rollback").catch(() => {});
    throw blad;
  } finally {
    klient.release();
  }

  return {
    zapisane: true,
    messageId,
    typZdarzenia: przygotowane.typ,
    klasyfikacja: przygotowane.klasyfikacja,
  };
}
