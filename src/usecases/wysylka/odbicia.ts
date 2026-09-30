import type { Pool, PoolClient } from "pg";
import { getPool } from "../../adapters/db/pool";
import { BladImap, type SkrzynkaZwrotna } from "../../adapters/email/imap";
import { parsujRaportZwrotny, type RaportZwrotny } from "../../domain/email/dsn";
import { zapiszZgloszenieDostawcy, type WynikZgloszenia } from "./zdarzenia-dostawcy";

/**
 * Ingest odbić i skarg ze skrzynki zwrotnej klienta (Blok D, audyt 24.09 #3).
 *
 * Tor jest ten sam co dla webhooka dostawcy: parser → dopasowanie do wiadomości →
 * `zapiszZgloszenieDostawcy` (klasyfikacja, wykluczenie adresu, zdarzenie). Ten plik NIE
 * klasyfikuje odbić sam — od tego jest `klasyfikujOdpowiedzSmtp` w domenie, dokładnie
 * ta, której używa adapter SMTP przy odmowie na RCPT TO. Dwa źródła, jedna klasyfikacja.
 *
 * Dopasowanie, w kolejności pewności (audyt 28.09: SES nadpisuje Message-ID):
 *   1. nasz nagłówek `X-MidRev-Message-Id` w kopii nagłówków oryginału = `messages.id`,
 *   2. Message-ID oryginału nadany przez DOSTAWCĘ: lewa strona = `messages.provider_message_id`
 *      (SES: `<id@eu-central-1.amazonses.com>`, id z odpowiedzi „250 Ok <id>"),
 *   3. Message-ID oryginału = `messages.provider_id` (nasz `<id@domena>`), albo jego
 *      lewa strona = `messages.id` (gdyby dostawca przepisał prawą),
 *   4. adres odbiorcy: OSTATNIA wiadomość do tego adresu przekazana dostawcy w ciągu
 *      30 dni (raport bez kopii nagłówków — część starych MTA tak robi).
 * Zawsze w obrębie tenanta: skrzynka jest tenanta, więc raport też.
 *
 * Idempotencja: `bounce_reports` unikalne per (tenant, UIDVALIDITY, UID); zdarzenie
 * unikalne per (message_id, event_type). Przebieg przerwany w połowie nie zapisze
 * niczego dwa razy.
 */

export interface WynikRaportu {
  rodzaj: RaportZwrotny["rodzaj"];
  /** 'zapisane' | 'brak_wiadomosci' | 'pominiete' | 'nie_odbicie' | 'brak_daty' | 'opoznienie' | 'blad' */
  wynik: string;
  adres: string | null;
  messageIdOryginalu: string | null;
  messageId: string | null;
  dopasowanie: SposobDopasowania | null;
  typZdarzenia: string | null;
  klasa: string | null;
  kodSmtp: string | null;
  kiedy: Date | null;
  temat: string;
}

export type SposobDopasowania = "naglowek" | "id_dostawcy" | "message_id" | "adres";

const OKNO_DOPASOWANIA_PO_ADRESIE_DNI = 30;

/** Ile raport może „wyprzedzać" nasz zegar (rozjazd zegarów MTA), zanim uznamy datę za bzdurę. */
const TOLERANCJA_PRZYSZLOSCI_MS = 60 * 60_000;

/**
 * Data raportu ZE ŹRÓDŁA, ale nie z przyszłości (triaż A, P3): nagłówek Date ustawia
 * nadawca raportu, a skrzynka zwrotna jest publiczna. Zdarzenie datowane na 2030 rok
 * wisiałoby w oknie wskaźników reputacji latami. Data dalej niż godzinę przed nami
 * jest przycinana do chwili odczytu; data z przeszłości zostaje nietknięta.
 */
export function przytnijDateRaportu(kiedy: Date | null, teraz = new Date()): Date | null {
  if (!kiedy) return null;
  return kiedy.getTime() > teraz.getTime() + TOLERANCJA_PRZYSZLOSCI_MS ? teraz : kiedy;
}

async function dopasuj(
  tenantId: string,
  klucze: { naszId: string | null; messageIdOryginalu: string | null },
  adres: string | null,
): Promise<{ messageId: string; jak: SposobDopasowania; email: string } | null> {
  const pool = getPool();
  // Każde zapytanie w obrębie tenanta (skrzynka jest tenanta): cudzy identyfikator
  // w sfałszowanym raporcie nie ma jak trafić w wiadomość innego konta.
  if (klucze.naszId) {
    const { rows } = await pool.query<{ id: string; email: string }>(
      "select id, email from messages where tenant_id = $1 and id = $2::uuid",
      [tenantId, klucze.naszId],
    );
    if (rows[0]) return { messageId: rows[0].id, jak: "naglowek", email: rows[0].email };
  }
  const mid = klucze.messageIdOryginalu;
  if (mid) {
    const lewaStrona = /^<(.+)@[^@<>]+>$/.exec(mid)?.[1] ?? null;
    if (lewaStrona) {
      const { rows } = await pool.query<{ id: string; email: string }>(
        `select id, email from messages where tenant_id = $1 and provider_message_id = $2
          order by coalesce(handed_off_at, created_at) desc limit 50`,
        [tenantId, lewaStrona],
      );
      if (rows.length === 1) return { messageId: rows[0].id, jak: "id_dostawcy", email: rows[0].email };
      if (rows.length > 1) {
        // Identyfikator dostawcy NIEJEDNOZNACZNY (np. krótkie ID kolejki Postfixa po
        // latach). Rozstrzyga wyłącznie adres odbiorcy WŚRÓD tych kandydatów; bez
        // jednoznacznego trafienia nie przyklejamy raportu do niczego — zejście do
        // „ostatniej wiadomości na adres" mogłoby wskazać inną, też prawdziwą wiadomość.
        const naAdres = adres ? rows.filter((r) => r.email.trim().toLowerCase() === adres.trim().toLowerCase()) : [];
        if (naAdres.length === 1) return { messageId: naAdres[0].id, jak: "id_dostawcy", email: naAdres[0].email };
        return null;
      }
    }
    const { rows } = await pool.query<{ id: string; email: string }>(
      "select id, email from messages where tenant_id = $1 and provider_id = $2 limit 1",
      [tenantId, mid],
    );
    if (rows[0]) return { messageId: rows[0].id, jak: "message_id", email: rows[0].email };
    const lewa = /^<([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i.exec(mid);
    if (lewa) {
      const { rows: poId } = await pool.query<{ id: string; email: string }>(
        "select id, email from messages where tenant_id = $1 and id = $2::uuid",
        [tenantId, lewa[1]],
      );
      if (poId[0]) return { messageId: poId[0].id, jak: "message_id", email: poId[0].email };
    }
  }
  if (adres) {
    // po adresie: tylko wiadomości, które faktycznie wyszły (sent/delivered) i tylko
    // świeże; raport o mailu sprzed pół roku nie ma do czego się przykleić
    const { rows } = await pool.query<{ id: string; email: string }>(
      `select id, email from messages
        where tenant_id = $1 and lower(btrim(email)) = $2
          and current_state in ('sent', 'delivered')
          and coalesce(handed_off_at, created_at) > now() - make_interval(days => $3::int)
        order by coalesce(handed_off_at, created_at) desc
        limit 1`,
      [tenantId, adres.trim().toLowerCase(), OKNO_DOPASOWANIA_PO_ADRESIE_DNI],
    );
    if (rows[0]) return { messageId: rows[0].id, jak: "adres", email: rows[0].email };
  }
  return null;
}

/**
 * Jeden surowy mail ze skrzynki → zero, jeden albo kilka wyników (DSN potrafi nieść
 * kilku odbiorców; u nas każda wiadomość ma jednego, więc zwykle jeden).
 */
export async function przetworzRaport(
  tenantId: string,
  surowy: string,
  opcje: { dataZapasowa?: Date | null } = {},
): Promise<{ raport: RaportZwrotny; wyniki: WynikRaportu[] }> {
  const raport = parsujRaportZwrotny(surowy);
  const kiedy = przytnijDateRaportu(raport.kiedy ?? opcje.dataZapasowa ?? null);
  const baza = (o: Partial<WynikRaportu>): WynikRaportu => ({
    rodzaj: raport.rodzaj,
    wynik: "pominiete",
    adres: null,
    messageIdOryginalu: raport.messageIdOryginalu,
    messageId: null,
    dopasowanie: null,
    typZdarzenia: null,
    klasa: null,
    kodSmtp: null,
    kiedy,
    temat: raport.temat,
    ...o,
  });

  if (raport.rodzaj === "nie_odbicie") return { raport, wyniki: [baza({ wynik: "nie_odbicie" })] };

  const wyniki: WynikRaportu[] = [];
  for (const o of raport.odbiorcy) {
    if (!kiedy) {
      wyniki.push(baza({ adres: o.adres, wynik: "brak_daty" }));
      continue;
    }
    // DSN o sukcesie/przekazaniu dalej (NOTIFY=SUCCESS) — nie jest odbiciem
    if (raport.rodzaj === "dsn" && (o.akcja === "relayed" || o.akcja === "expanded")) {
      wyniki.push(baza({ adres: o.adres, wynik: "pominiete" }));
      continue;
    }
    // Heurystyka bez kodu rozszerzonego: „550" gdzieś w treści to za mało, żeby
    // wykluczyć żywy adres. Zapisujemy w rejestrze raportów, nie w zdarzeniach.
    if (raport.rodzaj === "heurystyka" && !o.status) {
      wyniki.push(baza({ adres: o.adres, wynik: "pominiete", kodSmtp: null }));
      continue;
    }
    const dop = await dopasuj(tenantId, { naszId: raport.naszIdOryginalu, messageIdOryginalu: raport.messageIdOryginalu }, o.adres);
    if (!dop) {
      wyniki.push(baza({ adres: o.adres, wynik: "brak_wiadomosci", kiedy }));
      continue;
    }

    // Skrzynka zwrotna jest PUBLICZNA: każdy może na nią napisać. Raport, który nie
    // dowodzi tożsamości wiadomości (brak Message-ID = dopasowanie po samym adresie, albo
    // heurystyka bez DSN), nie ma prawa wykluczyć adresu całej platformie. Wykluczenie
    // sklepowe zostaje: jest widoczne w rejestrze raportów i odwracalne z panelu.
    // Opóźnienie (Action: delayed, 4.x.x) to NIE jest wynik dostarczenia: serwer dalej
    // próbuje i za godzinę albo trzy dni przyśle raport końcowy. Zapis `bounced` byłby
    // stanem terminalnym (ranga 3), a zdarzenie jest unikalne per (message_id, typ), więc
    // późniejsze finalne 5.1.1 przepadłoby w konflikcie i adres nie zostałby wykluczony
    // (triaż A, P2 #3). Opóźnienie idzie wyłącznie do rejestru raportów.
    // Tylko prawdziwy DSN z jawnym `Action: delayed` (review A2 #6). Heurystyka nadaje
    // „delayed" każdemu 4xx, a ostateczne raporty qmaila/Exima („giving up", „retry
    // timeout exceeded") niosą właśnie 4xx — te idą dalej jako odbicie.
    if (raport.rodzaj === "dsn" && o.akcja === "delayed") {
      wyniki.push(baza({ adres: o.adres, wynik: "opoznienie", messageId: dop.messageId, dopasowanie: dop.jak, kodSmtp: o.status ?? null, kiedy }));
      continue;
    }

    // Dowód tożsamości wiadomości = dowolny klucz poza samym adresem, ORAZ adresat raportu
    // zgodny z adresem tej wiadomości. Nagłówki (X-MidRev-Message-Id, Message-ID) zna
    // każdy odbiorca ze swojej kopii maila; sfałszowany raport z cudzym Final-Recipient
    // nie może więc dać wykluczenia GLOBALNEGO (sklepowe zostaje: odwracalne z panelu).
    // brak adresata w raporcie = brak dowodu (review Codeksa r2): tylko wykluczenie sklepowe
    const adresZgodny = Boolean(o.adres) && o.adres!.trim().toLowerCase() === dop.email.trim().toLowerCase();
    const zaufany = dop.jak !== "adres" && raport.pewnosc === "wysoka" && adresZgodny;
    const opcjeZapisu = { wykluczenieGlobalne: zaufany };
    let zapis: WynikZgloszenia;
    if (raport.rodzaj === "arf") {
      zapis = await zapiszZgloszenieDostawcy(tenantId, { messageId: dop.messageId }, {
        rodzaj: "complaint",
        kiedy,
        complaintFeedbackType: raport.typSkargi ?? "abuse",
      }, opcjeZapisu);
    } else if (o.akcja === "delivered") {
      zapis = await zapiszZgloszenieDostawcy(tenantId, { messageId: dop.messageId }, {
        rodzaj: "delivered",
        kiedy,
        smtpResponse: o.diagnostyka ?? undefined,
      }, opcjeZapisu);
    } else {
      // Tekst dla klasyfikatora: diagnostyka serwera odbiorcy, a gdy jej brak — sam
      // Status (RFC 3463), który klasyfikator czyta jako kod rozszerzony. Status idzie
      // NA POCZĄTKU, żeby to on (a nie liczba w treści diagnostyki) decydował o klasie.
      const odpowiedz = [o.status, o.diagnostyka].filter(Boolean).join(" ").trim() || "brak kodu";
      zapis = await zapiszZgloszenieDostawcy(tenantId, { messageId: dop.messageId }, {
        rodzaj: "bounce_smtp",
        kiedy,
        odpowiedz,
      }, opcjeZapisu);
    }
    wyniki.push(
      baza({
        adres: o.adres,
        wynik: zapis.zapisane ? "zapisane" : zapis.powodOdrzucenia ?? "pominiete",
        messageId: dop.messageId,
        dopasowanie: dop.jak,
        typZdarzenia: zapis.typZdarzenia ?? null,
        klasa: zapis.klasyfikacja?.klasa ?? null,
        kodSmtp: zapis.klasyfikacja?.kodSmtp ?? o.status ?? null,
        kiedy,
      }),
    );
  }
  if (wyniki.length === 0) wyniki.push(baza({ wynik: "pominiete" }));
  return { raport, wyniki };
}

export interface PodsumowanieOdbic {
  uidvalidity: number;
  przejrzane: number;
  zapisane: number;
  bezWiadomosci: number;
  nieOdbicia: number;
  pominiete: number;
  /** wiadomości pominięte po błędzie (wpis `blad` w rejestrze), przebieg poszedł dalej */
  bledy: number;
  ostatniUid: number;
  /** true, gdy w skrzynce zostało więcej niż limit na przebieg */
  zostalo: boolean;
}

/** Ile wiadomości maksymalnie na jeden przebieg: reszta wejdzie w następnym tiku (5 min). */
export const MAKS_NA_PRZEBIEG = 200;

/**
 * Pełny przebieg dla tenanta: otwarcie skrzynki, nieprzeczytane od kursora, per mail
 * parsowanie + zapis + wpis do `bounce_reports` + oznaczenie jako przeczytany. Maile,
 * które NIE są raportami (odpowiedzi ludzi), zostają nieprzeczytane — skrzynka zwrotna
 * bywa tą samą skrzynką, na którą odpisują klienci sklepu.
 */
export async function pobierzOdbicia(
  tenantId: string,
  skrzynka: SkrzynkaZwrotna,
  kursor: { uidvalidity: number | null; ostatniUid: number | null },
  opcje: {
    maksNaPrzebieg?: number;
    /**
     * Kursor PRZYROSTOWY (triaż A, P2 #7): wołane po każdej obsłużonej wiadomości.
     * Przebieg przerwany w połowie (timeout, restart workera) nie zaczyna wtedy od
     * początku partii, a trująca wiadomość nie trzyma kursora w miejscu.
     */
    zapiszKursor?: (uidvalidity: number, ostatniUid: number) => Promise<void>;
  } = {},
): Promise<PodsumowanieOdbic> {
  const pool = getPool();
  const maks = opcje.maksNaPrzebieg ?? MAKS_NA_PRZEBIEG;
  const { uidvalidity } = await skrzynka.otworz();
  // Zmiana UIDVALIDITY = skrzynka odtworzona, stare UID-y nic nie znaczą: kursor od zera
  const od = kursor.uidvalidity === uidvalidity ? (kursor.ostatniUid ?? 0) : 0;
  const uidy = await skrzynka.nieprzeczytaneOd(od);
  const doPrzejrzenia = uidy.slice(0, maks);

  const p: PodsumowanieOdbic = {
    uidvalidity,
    przejrzane: 0,
    zapisane: 0,
    bezWiadomosci: 0,
    nieOdbicia: 0,
    pominiete: 0,
    bledy: 0,
    ostatniUid: od,
    zostalo: uidy.length > maks,
  };

  for (const uid of doPrzejrzenia) {
    // druga warstwa idempotencji: raport już przetworzony (crash przed STORE \Seen)
    const { rows: juz } = await pool.query(
      "select kind, outcome from bounce_reports where tenant_id = $1 and imap_uidvalidity = $2 and imap_uid = $3",
      [tenantId, uidvalidity, uid],
    );
    if (juz[0]) {
      if (juz[0].kind !== "nie_odbicie" && juz[0].outcome !== "blad") await skrzynka.oznaczPrzeczytane(uid);
    } else {
      await przetworzJedna(tenantId, skrzynka, uidvalidity, uid, p);
    }
    p.ostatniUid = Math.max(p.ostatniUid, uid);
    await opcje.zapiszKursor?.(uidvalidity, p.ostatniUid);
  }
  return p;
}

/**
 * Jedna wiadomość ze skrzynki.
 *
 * Granica „wadliwej wiadomości" (review A2 #4): jako `blad` w rejestrze kończą się
 * WYŁĄCZNIE wyjątki z przetworzenia i zapisu (zepsuty MIME, dane, których baza nie
 * przyjmie, np. bajt NUL). Błąd pobrania z serwera (`skrzynka.pobierz`, każdy BladImap)
 * dotyczy SESJI — „NO [LIMIT]", „[UNAVAILABLE]", limit transferu Gmaila — i przerywa
 * przebieg BEZ przesuwania kursora za tę wiadomość: inaczej do 200 poprawnych DSN
 * dostawało `blad`, kursor je mijał i twarde odbicia nie trafiały do wykluczeń.
 * Wiadomość z błędem zostaje nieprzeczytana, żeby człowiek mógł ją obejrzeć.
 */
async function przetworzJedna(
  tenantId: string,
  skrzynka: SkrzynkaZwrotna,
  uidvalidity: number,
  uid: number,
  p: PodsumowanieOdbic,
): Promise<void> {
  const pool = getPool();
  // poza try: błąd pobrania przerywa przebieg (sesja, nie wiadomość)
  const mail = await skrzynka.pobierz(uid);
  if (!mail) return;
  p.przejrzane++;
  let rodzaj: RaportZwrotny["rodzaj"] | null = null;
  let oznaczyc = false;
  try {
    const { raport, wyniki } = await przetworzRaport(tenantId, mail.surowy, { dataZapasowa: mail.dataSerwera });
    rodzaj = raport.rodzaj;
    const glowny = wyniki[0];
    await pool.query(
      `insert into bounce_reports
         (tenant_id, imap_uidvalidity, imap_uid, original_message_id, matched_message_id, matched_by,
          recipient, kind, outcome, event_type, bounce_class, smtp_code, subject, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (tenant_id, imap_uidvalidity, imap_uid) do nothing`,
      [
        tenantId, uidvalidity, uid, raport.messageIdOryginalu, glowny.messageId, glowny.dopasowanie,
        glowny.adres, raport.rodzaj, glowny.wynik, glowny.typZdarzenia, glowny.klasa, glowny.kodSmtp,
        raport.temat.slice(0, 500),
        // data ZE ŹRÓDŁA; gdy raport nie ma daty — INTERNALDATE serwera; zapis wymaga jakiejś
        glowny.kiedy ?? przytnijDateRaportu(mail.dataSerwera) ?? new Date(),
      ],
    );
    for (const w of wyniki) {
      if (w.wynik === "zapisane") p.zapisane++;
      else if (w.wynik === "brak_wiadomosci") p.bezWiadomosci++;
      else if (w.wynik === "nie_odbicie") p.nieOdbicia++;
      else p.pominiete++;
    }
    oznaczyc = raport.rodzaj !== "nie_odbicie";
  } catch (blad) {
    p.bledy++;
    const opis = String((blad as Error)?.message ?? blad).replace(/[\r\n\x00]+/g, " ").slice(0, 300);
    console.error(`[odbicia] tenant ${tenantId}: wiadomość UID ${uid} (UIDVALIDITY ${uidvalidity}) pominięta po błędzie: ${opis}`);
    // Wpis bez tematu i adresu: to one bywają przyczyną (np. bajt NUL, którego Postgres
    // nie przyjmie w tekście). Rodzaj z parsera, gdy do niego doszło.
    await pool.query(
      `insert into bounce_reports (tenant_id, imap_uidvalidity, imap_uid, kind, outcome, received_at)
       values ($1, $2, $3, $4, 'blad', $5)
       on conflict (tenant_id, imap_uidvalidity, imap_uid) do nothing`,
      [tenantId, uidvalidity, uid, rodzaj ?? "nie_odbicie", przytnijDateRaportu(mail.dataSerwera) ?? new Date()],
    );
    return;
  }
  // STORE osobno (review A2 #5): raport jest już zapisany i policzony, więc odmowa
  // oznaczenia nie może zamienić go w „błąd". Zerwana sesja przerywa przebieg (następne
  // pobranie i tak by padło); odmowa samego STORE zostawia wiadomość nieprzeczytaną —
  // przy ponownym przejściu rejestr (UIDVALIDITY+UID) pozwoli ją oznaczyć bez ponownego zapisu.
  if (oznaczyc) {
    try {
      await skrzynka.oznaczPrzeczytane(uid);
    } catch (blad) {
      if (blad instanceof BladImap && (blad.kod === "polaczenie" || blad.kod === "timeout")) throw blad;
      console.warn(`[odbicia] tenant ${tenantId}: UID ${uid} zapisany, ale serwer nie oznaczył go jako przeczytany: ${String((blad as Error)?.message ?? blad).slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// RODO: rejestr raportów trzyma adres z DSN i temat, więc podlega art. 15 i 17
// ---------------------------------------------------------------------------

export interface RaportDoEksportu {
  kiedy: Date;
  adres: string | null;
  rodzaj: string;
  wynik: string;
  typZdarzenia: string | null;
  klasa: string | null;
  kodSmtp: string | null;
  temat: string | null;
}

/**
 * Raporty dotyczące osoby (art. 15): po dopasowanej wiadomości (messages.profile_id)
 * i po adresie odbiorcy z raportu. Wołane z eksportu profilu w profil-rodo.ts, w tej
 * samej transakcji (`przez`), żeby eksport był spójny z resztą.
 */
export async function eksportujOdbicia(
  tenantId: string,
  profileId: string,
  email: string | null,
  przez: Pool | PoolClient = getPool(),
): Promise<RaportDoEksportu[]> {
  const { rows } = await przez.query(
    `select b.received_at, b.recipient, b.kind, b.outcome, b.event_type, b.bounce_class, b.smtp_code, b.subject
       from bounce_reports b
       left join messages m on m.tenant_id = b.tenant_id and m.id = b.matched_message_id
      where b.tenant_id = $1
        and (m.profile_id = $2 or ($3::text is not null and lower(btrim(b.recipient)) = lower(btrim($3))))
      order by b.received_at`,
    [tenantId, profileId, email],
  );
  return rows.map((r) => ({
    kiedy: r.received_at,
    adres: r.recipient,
    rodzaj: r.kind,
    wynik: r.outcome,
    typZdarzenia: r.event_type,
    klasa: r.bounce_class,
    kodSmtp: r.smtp_code,
    temat: r.subject,
  }));
}

/**
 * Anonimizacja (art. 17): adres i temat z raportów tej osoby zastąpione zaślepką
 * (temat bywa spersonalizowany). Wiersz zostaje, bo liczniki dostarczalności i kursor
 * IMAP (unikalność UID) mają dalej działać. Zwraca liczbę zmienionych wierszy do
 * kontroli zwrotnej w transakcji RODO.
 */
export async function anonimizujOdbicia(
  tenantId: string,
  profileId: string,
  email: string | null,
  przez: Pool | PoolClient = getPool(),
): Promise<number> {
  const wynik = await przez.query(
    `update bounce_reports b
        set recipient = case when b.recipient is null then null else 'usuniety@rodo.invalid' end,
            subject = case when b.subject is null then null else '[usunięto]' end,
            original_message_id = null
      where b.tenant_id = $1
        and (
          exists (select 1 from messages m where m.tenant_id = b.tenant_id and m.id = b.matched_message_id and m.profile_id = $2)
          or ($3::text is not null and lower(btrim(b.recipient)) = lower(btrim($3)))
        )
        and (b.recipient is distinct from 'usuniety@rodo.invalid' or b.subject is distinct from '[usunięto]' or b.original_message_id is not null)`,
    [tenantId, profileId, email],
  );
  return wynik.rowCount ?? 0;
}

/** Ile raportów tej osoby wciąż niesie adres albo temat — do kontroli zwrotnej po anonimizacji (ma być 0). */
export async function pozostaleDaneOdbic(
  tenantId: string,
  profileId: string,
  email: string | null,
  przez: Pool | PoolClient = getPool(),
): Promise<number> {
  const { rows } = await przez.query(
    `select count(*)::int as ile from bounce_reports b
      where b.tenant_id = $1
        and (
          exists (select 1 from messages m where m.tenant_id = b.tenant_id and m.id = b.matched_message_id and m.profile_id = $2)
          or ($3::text is not null and lower(btrim(b.recipient)) = lower(btrim($3)))
        )
        and (b.recipient not in ('usuniety@rodo.invalid') or b.subject is distinct from '[usunięto]' or b.original_message_id is not null)`,
    [tenantId, profileId, email],
  );
  return rows[0]?.ile ?? 0;
}
