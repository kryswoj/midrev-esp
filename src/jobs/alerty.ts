import { config } from "../config";

/**
 * Alert do czlowieka (NFR38). `console.error` w logu workera nikogo nie budzi,
 * wiec kazdy alert idzie tez POST-em na ALERT_WEBHOOK_URL, jesli jest ustawiony.
 * Awaria webhooka nie moze przewrocic wysylki: alert jest efektem ubocznym,
 * nie czescia transakcji, dlatego blad wysylki alertu jest tylko logowany.
 */
export async function wyslijAlert(tresc: string) {
  console.error(`[alert] ${tresc}`);
  const url = config().ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tresc, kiedy: new Date().toISOString() }),
    });
  } catch (blad) {
    console.error(`[alert] webhook nie przyjal alertu:`, blad);
  }
}
