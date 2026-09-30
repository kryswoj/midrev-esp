// Testowy odbiornik webhookow WooCommerce. Nie jest to plik testowy (brak *.test.ts).
//
// Po co: sandboxowy Woo dostarcza webhooki pod APP_URL. Dawniej byl to serwer dev :3005,
// ktory pisze do bazy DEWELOPERSKIEJ, wiec zdarzenie nigdy nie trafiloby do bazy testowej
// (a ping przy zakladaniu webhooka dostawalby 404 "nieznany sklep"). Tutaj stawiamy na czas
// pliku testow maly serwer HTTP z TYM SAMYM handlerem trasy co produkcja
// (src/app/api/webhooks/woo/[storeId]/route.ts) - bez zmian w kodzie produkcyjnym. Handler
// uzywa getPool() procesu testow, wiec pisze do bazy testowej.
//
// Adres: bramka dockera 172.22.0.1 (jedyny host, ktory mu-plugin sandboxa uznaje za
// zewnetrzny) i port 3015, dopuszczony w sandbox/woo/mu-sandbox-ssl.php obok 3005.
import { createServer, type Server } from "node:http";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/webhooks/woo/[storeId]/route";

/**
 * Testy czekajace na DOSTAWE webhooka ze sklepu wymagaja, zeby kontener Woo dosiegnal
 * 172.22.0.1:3015. Na VPS-ie ufw wpuszcza z sieci dockera tylko porty z listy (3005 tak,
 * 3015 nie), wiec bez jednorazowej reguly firewalla dostawa nie dojdzie. Dlatego te testy
 * ida tylko jawnie: `npm run test:woo` (ustawia TEST_WOO_DOSTAWA=1). Opis w AGENTS.md.
 */
export const DOSTAWA_WEBHOOKOW = process.env.TEST_WOO_DOSTAWA === "1";

export const HOST_ODBIORNIKA = process.env.TEST_WEBHOOK_HOST || "172.22.0.1";
export const PORT_ODBIORNIKA = Number(process.env.TEST_WEBHOOK_PORT || 3015);
export const ADRES_ODBIORNIKA = `http://${HOST_ODBIORNIKA}:${PORT_ODBIORNIKA}`;

const TRASA = /^\/api\/webhooks\/woo\/([^/?#]+)\/?$/;

export interface Odbiornik {
  /** Liczba zadan, ktore doszly do handlera (diagnostyka, gdy webhook nie dociera). */
  przyjete: () => number;
  zamknij: () => Promise<void>;
}

export async function uruchomOdbiornikWebhookow(): Promise<Odbiornik> {
  let licznik = 0;
  const serwer: Server = createServer(async (zadanie, odpowiedz) => {
    try {
      const sciezka = new URL(zadanie.url ?? "/", ADRES_ODBIORNIKA).pathname;
      const trafienie = TRASA.exec(sciezka);
      if (zadanie.method !== "POST" || !trafienie) {
        odpowiedz.writeHead(404).end("brak trasy");
        return;
      }
      licznik += 1;
      const kawalki: Buffer[] = [];
      for await (const kawalek of zadanie) kawalki.push(kawalek as Buffer);
      const naglowki = new Headers();
      for (const [klucz, wartosc] of Object.entries(zadanie.headers)) {
        if (wartosc === undefined) continue;
        naglowki.set(klucz, Array.isArray(wartosc) ? wartosc.join(", ") : wartosc);
      }
      const wynik = await POST(
        new NextRequest(new URL(zadanie.url!, ADRES_ODBIORNIKA), {
          method: "POST",
          headers: naglowki,
          body: Buffer.concat(kawalki),
        }),
        { params: Promise.resolve({ storeId: decodeURIComponent(trafienie[1]) }) },
      );
      odpowiedz.writeHead(wynik.status, { "content-type": wynik.headers.get("content-type") ?? "text/plain" });
      odpowiedz.end(Buffer.from(await wynik.arrayBuffer()));
    } catch (blad) {
      console.error("[odbiornik-webhookow] handler rzucil:", blad);
      if (!odpowiedz.headersSent) odpowiedz.writeHead(500);
      odpowiedz.end("blad");
    }
  });

  await new Promise<void>((ok, nie) => {
    serwer.once("error", (blad: NodeJS.ErrnoException) => {
      nie(
        new Error(
          `[odbiornik-webhookow] nie moge nasluchiwac na ${ADRES_ODBIORNIKA} (${blad.code}). ` +
            (blad.code === "EADDRINUSE"
              ? "Port zajety - czy rownolegle leci drugi przebieg testow Woo?"
              : "Czy dziala siec dockera sandboxa Woo (bramka 172.22.0.1)?"),
        ),
      );
    });
    serwer.listen(PORT_ODBIORNIKA, HOST_ODBIORNIKA, () => ok());
  });

  return {
    przyjete: () => licznik,
    zamknij: () =>
      new Promise<void>((ok) => {
        serwer.closeAllConnections();
        serwer.close(() => ok());
      }),
  };
}
