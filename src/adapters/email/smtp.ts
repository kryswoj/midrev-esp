import { createConnection } from "node:net";
import type { DostawcaWysylki, Wiadomosc, WynikWysylki } from "../../domain/email/port";

/**
 * Minimalny klient SMTP bez zależności, pod lokalny Mailpit (bez TLS i bez auth).
 * To NIE jest adapter produkcyjny: produkcja idzie przez API dostawcy (SES), a ten
 * adapter istnieje po to, żeby cała ścieżka wysyłki, od bramki canSendTo po nagłówek
 * List-Unsubscribe, była realna i testowalna lokalnie.
 */

function czekajNaOdpowiedz(socket: import("node:net").Socket, oczekiwany: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let bufor = "";
    const naDane = (dane: Buffer) => {
      bufor += dane.toString("utf8");
      // odpowiedź wieloliniowa kończy się linią "NNN " (spacja po kodzie, nie myślnik)
      const linie = bufor.split("\r\n").filter(Boolean);
      const ostatnia = linie[linie.length - 1];
      if (ostatnia && /^\d{3} /.test(ostatnia)) {
        socket.off("data", naDane);
        if (ostatnia.startsWith(oczekiwany)) resolve(bufor);
        else reject(new Error(`SMTP: oczekiwano ${oczekiwany}, dostano: ${ostatnia}`));
      }
    };
    socket.on("data", naDane);
    socket.once("error", reject);
  });
}

/**
 * Adres w komendzie SMTP i w nagłówku jest DANYMI UŻYTKOWNIKA. Bez tej walidacji
 * adres z wstrzykniętym CRLF pozwala dopisać własne komendy SMTP albo nagłówki
 * (znalezisko z review). Odrzucamy, nie czyścimy: adres z CR/LF to atak, nie literówka.
 */
function sprawdzAdres(adres: string): string {
  const czysty = adres.trim();
  if (!czysty || /[\r\n<>\x00-\x1f\s]/.test(czysty) || !czysty.includes("@")) {
    throw new Error(`SMTP: adres odrzucony jako niebezpieczny lub niepoprawny`);
  }
  return czysty;
}

/** Nagłówek z polskimi znakami musi iść jako encoded-word, inaczej klient pocztowy pokaże krzaki. */
function zakodujNaglowek(tekst: string): string {
  return /^[\x20-\x7e]*$/.test(tekst)
    ? tekst
    : `=?UTF-8?B?${Buffer.from(tekst, "utf8").toString("base64")}?=`;
}

export class AdapterSmtp implements DostawcaWysylki {
  readonly nazwa = "smtp-mailpit";
  #host: string;
  #port: number;

  constructor(host = "127.0.0.1", port = 1025) {
    this.#host = host;
    this.#port = port;
  }

  async wyslij(w: Wiadomosc): Promise<WynikWysylki> {
    const od = sprawdzAdres(w.od);
    const doAdres = sprawdzAdres(w.do);
    const socket = createConnection({ host: this.#host, port: this.#port });
    socket.setTimeout(10_000, () => socket.destroy(new Error("SMTP: przekroczony czas")));
    try {
      await czekajNaOdpowiedz(socket, "220");
      socket.write("EHLO midrev-esp.local\r\n");
      await czekajNaOdpowiedz(socket, "250");
      socket.write(`MAIL FROM:<${od}>\r\n`);
      await czekajNaOdpowiedz(socket, "250");
      socket.write(`RCPT TO:<${doAdres}>\r\n`);
      await czekajNaOdpowiedz(socket, "250");
      socket.write("DATA\r\n");
      await czekajNaOdpowiedz(socket, "354");

      // Treść w base64: zdejmuje problem dot-stuffingu i ośmiobitowych znaków naraz.
      const tresc = Buffer.from(w.html, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
      const messageId = `<${w.idempotencyKey}@midrev-esp>`;
      const naglowki = [
        `From: ${w.odNazwa ? `${zakodujNaglowek(w.odNazwa)} ` : ""}<${od}>`,
        `To: <${doAdres}>`,
        `Subject: ${zakodujNaglowek(w.temat)}`,
        `Message-ID: ${messageId}`,
        `Date: ${new Date().toUTCString()}`,
        // RFC 8058: wypisanie jednym kliknięciem, obsłużone przez POST bez żadnej strony pośredniej
        `List-Unsubscribe: <${w.adresWypisania}>`,
        `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
        `MIME-Version: 1.0`,
        `Content-Type: text/html; charset=utf-8`,
        `Content-Transfer-Encoding: base64`,
      ].join("\r\n");

      socket.write(naglowki + "\r\n\r\n" + tresc + "\r\n.\r\n");
      const potwierdzenie = await czekajNaOdpowiedz(socket, "250");
      socket.write("QUIT\r\n");
      // Mailpit nie zwraca własnego identyfikatora w odpowiedzi SMTP, więc identyfikatorem
      // u dostawcy jest Message-ID, który sami kontrolujemy przez idempotencyKey.
      return { providerId: messageId, ...(potwierdzenie ? {} : {}) };
    } finally {
      socket.end();
      socket.destroy();
    }
  }
}
