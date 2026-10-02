import { getPool } from "../../adapters/db/pool";
import { czyHostDeweloperski } from "../../adapters/email/bezpieczny-host";
import { adresSledzenia, config } from "../../config";
import { linkiSledzone, prawdziweLinki, przykladoweDane, przykladyWHtml, wczytajDokument } from "../../domain/email/bloki";
import { policzOdbiorcow, type RozbicieOdbiorcow } from "../policz-odbiorcow";
import { odczytajSerwer, type WidokSerwera } from "../wysylka-konfiguracja/serwer";
import { zlozWiadomosc } from "../wysylka/renderuj";
import { renderujDokument } from "./render-blokow";
import { brakujaceObrazy } from "../obrazy/biblioteka";

/**
 * Lista kontrolna przed wysyłką (B4). Twarda bramka: każdy punkt w stanie `blad`
 * blokuje „Wyślij teraz" i planowanie — na ekranie ORAZ w akcji serwera.
 *
 * Każdy punkt jest sprawdzany na prawdziwych danych, nie na deklaracjach:
 *  - link: to, co faktycznie przepisze silnik (`href="http(s)://…"` w `content.html`),
 *  - stopka z wypisem: wynik PRAWDZIWEGO `zlozWiadomosc` na tej treści,
 *  - domena: stan z modułu „Wysyłka i domeny" (`odczytajSerwer`), tą samą logiką,
 *    której używa wybór nadawcy przed partią (`nadawca.ts`), ale bez łączenia się
 *    z serwerem — lista ma się liczyć przy każdym wejściu na stronę.
 */

export type StanPunktu = "ok" | "blad" | "uwaga";
export type KrokKreatora = "odbiorcy" | "tresc" | "ustawienia" | "przeglad";

export interface PunktListy {
  klucz: "temat" | "odbiorcy" | "tresc" | "link" | "wypis" | "adres" | "domena" | "jakosc" | "obrazy" | "przyklady";
  etykieta: string;
  stan: StanPunktu;
  opis: string;
  krok: KrokKreatora;
  /** napis przycisku, który usuwa brak („Dodaj link", „Uzupełnij adres firmy"); bez niego „Popraw" */
  akcja?: string;
}

export type StanDomeny =
  | { rodzaj: "zweryfikowana"; domena: string; adres: string }
  | { rodzaj: "deweloperski"; domena: string | null; adres: string }
  | { rodzaj: "niezweryfikowana"; domena: string; status: string }
  | { rodzaj: "serwer-niesprawdzony"; host: string; port: number }
  | { rodzaj: "adres-poza-domena"; adres: string; domena: string }
  | { rodzaj: "brak" };

const NAZWY_STATUSU: Record<string, string> = {
  pending: "czeka na pierwsze sprawdzenie",
  partial: "część rekordów niepoprawna",
  failed: "rekordy niepoprawne",
};

export function stanDomeny(serwer: WidokSerwera | null, systemowy: { host: string; port: number; od: string; deweloperskie: readonly string[] }): StanDomeny {
  if (!serwer) {
    // Bez własnego serwera silnik wysyła serwerem systemowym z adresu MAIL_FROM. Dopuszczamy
    // to wyłącznie wtedy, gdy serwer systemowy jest jawnie deweloperski (Mailpit): nic nie
    // wychodzi wtedy do internetu. W produkcji kampania bez zweryfikowanej domeny klienta
    // nie przechodzi listy kontrolnej.
    if (czyHostDeweloperski(systemowy.host, systemowy.port, systemowy.deweloperskie)) {
      return { rodzaj: "deweloperski", domena: null, adres: systemowy.od };
    }
    return { rodzaj: "brak" };
  }
  if (!serwer.polaczenieSprawdzoneAt) return { rodzaj: "serwer-niesprawdzony", host: serwer.host, port: serwer.port };
  if (serwer.adresNadawcy.split("@")[1] !== serwer.domenaNadawcy) {
    return { rodzaj: "adres-poza-domena", adres: serwer.adresNadawcy, domena: serwer.domenaNadawcy };
  }
  if (serwer.deweloperski) return { rodzaj: "deweloperski", domena: serwer.domenaNadawcy, adres: serwer.adresNadawcy };
  if (serwer.statusDomeny !== "verified") {
    return { rodzaj: "niezweryfikowana", domena: serwer.domenaNadawcy, status: serwer.statusDomeny };
  }
  return { rodzaj: "zweryfikowana", domena: serwer.domenaNadawcy, adres: serwer.adresNadawcy };
}

/**
 * Linki do sklepu, które odbiorca naprawdę zobaczy i które silnik przepisze na śledzone:
 * prawdziwe `<a href>` (nie tekst w komentarzu czy atrybucie) z adresem, który łapie wzorzec
 * `przepiszLinki` — czyli `href="http(s)://…"` w podwójnym cudzysłowie.
 */
export function linkiDoSledzenia(html: string): string[] {
  return linkiSledzone(html);
}

export function ocenGotowosc(wej: {
  temat: string | null;
  docelowo: number;
  kandydaci: number;
  html: string;
  maStopkeZWypisem: boolean;
  domena: StanDomeny;
  uwagiTresci: string[];
  /**
   * Adres pocztowy nadawcy ze stopki (0029). `undefined` = nie oceniamy (wołający bez
   * dostępu do ustawień konta); prawdziwa lista kontrolna przekazuje go ZAWSZE.
   */
  adresPocztowy?: string | null;
  /** przykładowe dane z dawnych szablonów zostawione w treści (`przykladoweDane`) */
  przyklady?: string[];
}): PunktListy[] {
  const punkty: PunktListy[] = [];
  const temat = (wej.temat ?? "").trim();
  punkty.push({
    klucz: "temat",
    etykieta: "Temat wiadomości",
    stan: temat ? "ok" : "blad",
    opis: temat ? `„${temat}"` : "Brak tematu — bez niego mail nie wyjdzie.",
    krok: "ustawienia",
    akcja: "Dodaj temat",
  });
  punkty.push({
    klucz: "odbiorcy",
    etykieta: "Odbiorcy",
    stan: wej.docelowo > 0 ? "ok" : "blad",
    opis:
      wej.docelowo > 0
        ? `${wej.docelowo} po sprawdzeniu zgód i wykluczeń (z ${wej.kandydaci} kandydatów).`
        : wej.kandydaci > 0
          ? `Wybrane źródła mają ${wej.kandydaci} kandydatów, ale nikt nie przechodzi sprawdzenia zgód i wykluczeń.`
          : "Nie wybrano żadnej listy ani segmentu.",
    krok: "odbiorcy",
    akcja: "Wybierz odbiorców",
  });
  const maTresc = wej.html.replace(/<style[\s\S]*?<\/style>|<[^>]*>|&nbsp;|\s/gi, "").length > 0 || /<img\s/i.test(wej.html);
  const maSkrypt = /<script\b/i.test(wej.html);
  punkty.push({
    klucz: "tresc",
    etykieta: "Treść",
    stan: maTresc && !maSkrypt ? "ok" : "blad",
    opis: maSkrypt
      ? "W treści jest kod skryptu. Skrzynki go blokują, a filtry antyspamowe karzą za niego. Usuń go z bloku „Własny HTML”."
      : maTresc
        ? "Treść zapisana."
        : "Treść jest pusta — zbuduj maila w kroku Treść.",
    krok: "tresc",
    akcja: "Otwórz edytor",
  });
  const linki = linkiDoSledzenia(wej.html);
  punkty.push({
    klucz: "link",
    etykieta: "Link w treści",
    stan: linki.length ? "ok" : "blad",
    opis: linki.length
      ? `${linki.length} ${linki.length === 1 ? "link prowadzi" : "linki prowadzą"} do strony, kliknięcia policzymy (pierwszy: ${linki[0]}).`
      : "W mailu nie ma żadnego linku do strony. Odbiorca nie ma dokąd przejść, a my nie policzymy kliknięć ani sprzedaży.",
    krok: "tresc",
    akcja: "Dodaj link",
  });
  punkty.push({
    klucz: "wypis",
    etykieta: "Stopka z wypisem",
    stan: wej.maStopkeZWypisem ? "ok" : "blad",
    opis: wej.maStopkeZWypisem
      ? "Pod każdym mailem dodajemy stopkę z linkiem do wypisania się jednym kliknięciem."
      : "W mailu nie ma działającego linku do wypisania się — taka wysyłka byłaby niezgodna z prawem. Sprawdź blok „Własny HTML”.",
    krok: "przeglad",
  });
  if (wej.adresPocztowy !== undefined) {
    const adres = (wej.adresPocztowy ?? "").trim();
    punkty.push({
      klucz: "adres",
      etykieta: "Adres firmy w stopce",
      stan: adres ? "ok" : "blad",
      opis: adres
        ? `Stopka podaje adres firmy: ${adres.split(/\r?\n/).join(", ")}.`
        : "W stopce brakuje adresu firmy. Wymaga go prawo i Gmail, a bez niego maile częściej lądują w spamie. Wpisujesz go raz, w ustawieniach konta.",
      krok: "ustawienia",
      akcja: "Uzupełnij adres firmy",
    });
  }
  if (wej.przyklady?.length) {
    punkty.push({
      klucz: "przyklady",
      etykieta: "Przykładowe dane w treści",
      stan: "blad",
      opis: `W mailu zostały dane z szablonu: ${wej.przyklady.join(", ")}. Odbiorca wziąłby je za prawdziwe. Zastąp je swoimi albo usuń blok.`,
      krok: "tresc",
      akcja: "Popraw w edytorze",
    });
  }
  const d = wej.domena;
  punkty.push({
    klucz: "domena",
    etykieta: "Domena wysyłkowa",
    stan: d.rodzaj === "zweryfikowana" || d.rodzaj === "deweloperski" ? "ok" : "blad",
    opis:
      d.rodzaj === "zweryfikowana"
        ? `${d.domena} potwierdzona. Maile wyjdą od ${d.adres}.`
        : d.rodzaj === "deweloperski"
          ? `Konto testowe: poczta nie wychodzi do prawdziwych skrzynek, więc domeny nie trzeba potwierdzać. Nadawca: ${d.adres}.`
          : d.rodzaj === "niezweryfikowana"
            ? `Domena ${d.domena}: ${NAZWY_STATUSU[d.status] ?? d.status}. Sprawdź ją w ustawieniach wysyłki.`
            : d.rodzaj === "serwer-niesprawdzony"
              ? `Serwer poczty ${d.host} nie przeszedł testu połączenia. Przetestuj go w ustawieniach wysyłki.`
              : d.rodzaj === "adres-poza-domena"
                ? `Adres nadawcy ${d.adres} nie należy do domeny ${d.domena}. Popraw go w ustawieniach wysyłki.`
                : "Konto nie ma jeszcze potwierdzonej domeny, z której wychodzą maile.",
    krok: "ustawienia",
    akcja: "Ustaw domenę",
  });
  if (wej.uwagiTresci.length) {
    punkty.push({
      klucz: "jakosc",
      etykieta: "Uwagi do treści",
      stan: "uwaga",
      opis: wej.uwagiTresci.slice(0, 4).join(" ") + (wej.uwagiTresci.length > 4 ? ` (i ${wej.uwagiTresci.length - 4} więcej)` : ""),
      krok: "tresc",
      akcja: "Popraw w edytorze",
    });
  }
  return punkty;
}

export async function listaKontrolnaKampanii(
  tenantId: string,
  campaignId: string,
  gotowe: { odbiorcy?: RozbicieOdbiorcow } = {},
): Promise<{ punkty: PunktListy[]; gotowa: boolean }> {
  const pool = getPool();
  const { rows } = await pool.query(
    `select c.subject, c.preheader, c.content, t.name as sklep,
            t.sender_company_name, t.sender_postal_address, t.sender_tax_id
       from campaigns c join tenants t on t.id = c.tenant_id
      where c.tenant_id = $1 and c.id = $2`,
    [tenantId, campaignId],
  );
  const kampania = rows[0];
  if (!kampania) return { punkty: [], gotowa: false };
  const html = String((kampania.content as any)?.html ?? "");
  const [odbiorcy, serwer] = await Promise.all([
    gotowe.odbiorcy ?? policzOdbiorcow(tenantId, campaignId),
    odczytajSerwer(tenantId),
  ]);

  // Stopka z wypisem sprawdzana na PRAWDZIWYM złożeniu wiadomości, z tokenem-wartownikiem.
  const wartownik = "lista-kontrolna-wypis";
  const zlozona = zlozWiadomosc({
    trescHtml: html,
    clickToken: "lista-kontrolna",
    unsubscribeToken: wartownik,
    nazwaSklepu: String(kampania.sklep ?? ""),
    nadawca: { firma: kampania.sender_company_name, adres: kampania.sender_postal_address, nip: kampania.sender_tax_id },
    sledzOtwarcia: false,
  });
  // Nie wystarczy, że napis jest w źródle: link wypisu musi być PRAWDZIWYM znacznikiem <a>,
  // a nie tekstem połkniętym przez niedomknięty <style>, komentarz albo atrybut z treści.
  const maStopkeZWypisem = prawdziweLinki(zlozona.html).includes(`${adresSledzenia()}/u/${wartownik}`);

  const { dokument, zrodlo } = wczytajDokument(kampania.content);
  const uwagiTresci = zrodlo === "bloki" ? renderujDokument(dokument, { preheader: kampania.preheader }).uwagi : [];

  const punkty = ocenGotowosc({
    temat: kampania.subject,
    docelowo: odbiorcy.docelowo,
    kandydaci: odbiorcy.kandydaci,
    html,
    maStopkeZWypisem,
    domena: stanDomeny(serwer, {
      host: config().SMTP_HOST,
      port: config().SMTP_PORT,
      od: config().MAIL_FROM,
      deweloperskie: config().SMTP_HOSTY_DEWELOPERSKIE,
    }),
    uwagiTresci,
    adresPocztowy: kampania.sender_postal_address ?? null,
    // kampania z samym HTML-em (bez bloków) też bywa ze starego szablonu: sprawdzamy tekst
    przyklady: zrodlo === "bloki" ? przykladoweDane(dokument) : przykladyWHtml(html),
  });
  // Obraz z biblioteki usunięty po wstawieniu do szkicu (usuwanie ze szkiców jest dozwolone)
  // dałby w mailu ikonę zepsutego obrazka. Twarda bramka, jak reszta punktów „blad".
  const brakObrazow = await brakujaceObrazy(tenantId, html);
  if (brakObrazow > 0) {
    punkty.push({
      klucz: "obrazy",
      etykieta: "Obrazy z biblioteki",
      stan: "blad",
      opis: `${brakObrazow === 1 ? "Jeden obraz wstawiony" : `${brakObrazow} obrazy wstawione`} z biblioteki już w niej nie ${brakObrazow === 1 ? "istnieje" : "istnieją"} — u odbiorcy byłby pusty prostokąt. Wstaw obraz ponownie w kroku Treść.`,
      krok: "tresc",
      akcja: "Wstaw obraz",
    });
  }
  return { punkty, gotowa: punkty.every((p) => p.stan !== "blad") };
}
